import { STORAGE_DEVICE_KEY, STORAGE_TOKEN_KEY } from '../constants';
import { LocalDeviceCreds, Question, SaleItem } from '../types';
import { ApiError, getMockQuestions, mockAdminRequest, mockSalesRequest } from './mock';

export { ApiError } from './mock';

// Demo data only when asked for in the address (?demo=1): the live admin page always talks to the real service.
let demoMode = typeof window !== 'undefined' && /[?&]demo=1(&|$)/.test(window.location.search);
let authExpiredListener: (() => void) | null = null;

// Strictly in-memory only; never stored in localStorage/sessionStorage/cookies
let cachedQuestions: Question[] | null = null;
let cachedFreeIds: Set<string> | null = null;

export function isDemoMode(): boolean {
  return demoMode;
}

export function setDemoMode(next: boolean): void {
  demoMode = next;
  cachedQuestions = null;
  cachedFreeIds = null;
}

export function onAuthExpired(cb: () => void): () => void {
  authExpiredListener = cb;
  return () => {
    if (authExpiredListener === cb) authExpiredListener = null;
  };
}

export function getSessionToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

export function clearSessionToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function getLocalDevice(): LocalDeviceCreds | null {
  try {
    const raw = localStorage.getItem(STORAGE_DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDeviceCreds>;
    if (typeof parsed.device === 'string' && typeof parsed.secret === 'string') {
      return { device: parsed.device, secret: parsed.secret };
    }
    return null;
  } catch {
    return null;
  }
}

export function setLocalDevice(creds: LocalDeviceCreds): void {
  try {
    localStorage.setItem(STORAGE_DEVICE_KEY, JSON.stringify(creds));
  } catch {
    // ignore
  }
}

export function clearLocalDevice(): void {
  try {
    localStorage.removeItem(STORAGE_DEVICE_KEY);
  } catch {
    // ignore
  }
}

export function clearMemoryBankCache(): void {
  cachedQuestions = null;
  cachedFreeIds = null;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    if (!res.ok) throw new ApiError('server');
  }

  if (!res.ok || data.error) {
    const code = typeof data.error === 'string' ? data.error : 'server';
    const left = typeof data.left === 'number' ? data.left : undefined;
    throw new ApiError(code, left);
  }

  return data as T;
}

function handleAuthSideEffects(err: unknown, hadToken: boolean): never {
  if (err instanceof ApiError) {
    if (err.code === 'device_forgotten' || err.code === 'device_expired' || err.code === 'device_unknown') {
      clearLocalDevice();
    }
    if (err.code === 'expired' || (err.code === 'forbidden' && hadToken)) {
      clearSessionToken();
      clearMemoryBankCache();
      authExpiredListener?.();
    }
  }
  throw err;
}

export async function adminRequest<T = Record<string, unknown>>(
  op: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const token = op === 'login' ? undefined : getSessionToken() || undefined;
  const body = op === 'login' ? { op, ...payload } : { op, token, ...payload };
  const hadToken = Boolean(token);

  try {
    if (demoMode) {
      return (await mockAdminRequest(op, body)) as T;
    }
    return await postJson<T>('/api/admin', body);
  } catch (err) {
    return handleAuthSideEffects(err, hadToken);
  }
}

export async function salesRequest(): Promise<{ ok: true; more: boolean; sales: SaleItem[] }> {
  const token = getSessionToken() || '';
  const hadToken = Boolean(token);
  try {
    if (demoMode) {
      return await mockSalesRequest(token);
    }
    return await postJson<{ ok: true; more: boolean; sales: SaleItem[] }>('/api/sales', { token });
  } catch (err) {
    return handleAuthSideEffects(err, hadToken);
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

export async function loadQuestionBank(forceRefresh = false): Promise<{ qs: Question[]; freeIds: Set<string> }> {
  if (!forceRefresh && cachedQuestions && cachedFreeIds) {
    return { qs: cachedQuestions, freeIds: cachedFreeIds };
  }

  if (demoMode) {
    const mock = getMockQuestions();
    cachedQuestions = mock.qs;
    cachedFreeIds = mock.freeIds;
    return { qs: cachedQuestions, freeIds: cachedFreeIds };
  }

  // Real mode: fetch /data/free.json, /data/bank.json, and key from /api/admin
  let freeRes: Response;
  let bankRes: Response;
  try {
    [freeRes, bankRes] = await Promise.all([fetch('/data/free.json'), fetch('/data/bank.json')]);
  } catch {
    throw new ApiError('network');
  }

  if (!freeRes.ok || !bankRes.ok) {
    throw new ApiError('server');
  }

  const freeJson = (await freeRes.json()) as { qs?: Array<{ id: string }> };
  const bankJson = (await bankRes.json()) as { iv: string; ct: string };
  const freeSet = new Set<string>((freeJson.qs || []).map((item) => item.id));

  // Key is fetched into local variable only, never stored or logged
  const keyResp = await adminRequest<{ ok: true; k: string }>('key');
  const rawKeyBytes = base64ToUint8Array(keyResp.k);
  const cryptoKey = await crypto.subtle.importKey('raw', rawKeyBytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['decrypt']);
  const ivBytes = base64ToUint8Array(bankJson.iv);
  const ctBytes = base64ToUint8Array(bankJson.ct);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
    cryptoKey,
    ctBytes.buffer as ArrayBuffer,
  );
  const decoded = JSON.parse(new TextDecoder().decode(plainBuf)) as { qs: Question[] };

  cachedQuestions = decoded.qs || [];
  cachedFreeIds = freeSet;
  return { qs: cachedQuestions, freeIds: cachedFreeIds };
}

export function getCachedQuestionMap(): Map<string, Question> | null {
  if (!cachedQuestions) return null;
  const map = new Map<string, Question>();
  for (const q of cachedQuestions) map.set(q.id, q);
  return map;
}

export async function fetchQuestionBankCount(): Promise<number | null> {
  if (cachedQuestions) return cachedQuestions.length;
  if (demoMode) return getMockQuestions().qs.length;
  try {
    const res = await fetch('/data/bank.json');
    if (!res.ok) return null;
    const data = (await res.json()) as { n?: number };
    return typeof data.n === 'number' && data.n > 0 ? data.n : null;
  } catch {
    return null;
  }
}
