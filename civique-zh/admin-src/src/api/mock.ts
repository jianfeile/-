import {
  CodeItem,
  DeviceItem,
  PatchData,
  Question,
  QuestionPatch,
  RefItem,
  SaleItem,
  User,
  UserDetailResponse,
  UserState,
} from '../types';

export class ApiError extends Error {
  code: string;
  left?: number;

  constructor(code: string, left?: number) {
    super(code);
    this.code = code;
    this.left = left;
  }
}

interface MockStore {
  users: User[];
  userDetails: Record<string, { devices: number; limit: number; days: Array<{ day: string; n: number }>; state: UserState }>;
  refs: RefItem[];
  sales: SaleItem[];
  codes: CodeItem[];
  patches: QuestionPatch[];
  devices: DeviceItem[];
  questions: Question[];
  freeIds: string[];
  patternFailures: Record<string, number>;
  devicePatterns: Record<string, string>;
}

function createInitialMockStore(): MockStore {
  return {
    users: [
      {
        id: 'b:K5VREWD6PY9Z',
        login: 'lili@example.com',
        email: 'lili@example.com',
        ref: 'a7k2m',
        created: 1795600000000,
        paid_at: 1795624903000,
        last_seen: 1795700000000,
        country: 'FR',
        city: 'Paris',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0.44',
        level: 'cr',
        exam_date: '2027-01-15',
        unlocked: 1,
        days: 3,
        sum: { demo: 1, seen: 120, ok: 98, miss: 9, ans: 160, pool: 283, exams: 2, best: 34, bestN: 40 },
      },
      {
        id: 'u:+33612345678',
        login: '+33612345678',
        email: null,
        ref: 'wang',
        created: 1795650000000,
        paid_at: null,
        last_seen: 1795690000000,
        country: 'FR',
        city: 'Lyon',
        ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile',
        level: 'csp',
        exam_date: '',
        unlocked: 0,
        days: 1,
        sum: { demo: 1, seen: 14, ok: 10, miss: 3, ans: 16, pool: 230, exams: 0, best: 0, bestN: 0 },
      },
      {
        id: 'v:2d8d1ef4845c6650',
        login: '',
        email: null,
        ref: '',
        created: 1795695000000,
        paid_at: null,
        last_seen: 1795695060000,
        country: 'FR',
        city: 'Marseille',
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
        level: '',
        exam_date: '',
        unlocked: 0,
        days: 1,
        sum: { demo: 1, seen: 0, ok: 0, miss: 0, ans: 0, pool: 0, exams: 0, best: 0, bestN: 0 },
      },
    ],
    userDetails: {
      'b:K5VREWD6PY9Z': {
        devices: 2,
        limit: 5,
        days: [
          { day: '2026-11-26', n: 14 },
          { day: '2026-11-25', n: 9 },
        ],
        state: {
          stats: {
            P009: [3, 1, 0, 2, 1795690000000],
            I019: [2, 2, 1, 0, 1795690000000],
            SP01: [4, 2, 1, 1, 1795690000000],
          },
          days: {
            '2026-11-26': [40, 31],
            '2026-11-25': [80, 67],
          },
          exams: [
            { ts: 1795695000000, target: 'cr', mini: false, score: 34, n: 40, passAt: 32, secs: 1620 },
            { ts: 1795650000000, target: 'cr', mini: true, score: 7, n: 10, passAt: 8, secs: 300 },
          ],
        },
      },
      'u:+33612345678': {
        devices: 0,
        limit: 1,
        days: [{ day: '2026-11-26', n: 5 }],
        state: {
          stats: {
            P009: [2, 1, 0, 1, 1795689000000],
            I019: [1, 1, 1, 0, 1795689500000],
          },
          days: {
            '2026-11-26': [14, 10],
          },
          exams: [],
        },
      },
      'v:2d8d1ef4845c6650': {
        devices: 0,
        limit: 1,
        days: [{ day: '2026-11-26', n: 1 }],
        state: {
          stats: {},
          days: {},
          exams: [],
        },
      },
    },
    refs: [
      { code: 'a7k2m', name: '小丽（朋友圈）', pct: 25, created: 1795620000000 },
      { code: 'wang', name: '老王', pct: 50, created: 1795621000000 },
    ],
    sales: [
      { t: 1795624903, amount: 1299, currency: 'eur', ref: 'a7k2m' },
      { t: 1795600000, amount: 1299, currency: 'eur', ref: '' },
    ],
    codes: [
      {
        code: 'VEJ7-EXX2-MCK9',
        note: '送给老王',
        created: 1795623058173,
        used_at: null,
        used_by: null,
        revoked: false,
      },
      {
        code: 'K5VR-EWD6-PY9Z',
        note: '小红书活动',
        created: 1795623000000,
        used_at: 1795630000000,
        used_by: '5ca6dc1084a403ca',
        revoked: false,
      },
    ],
    patches: [
      {
        qid: 'P009',
        free: true,
        data: { qz: '下列哪个是法兰西共和国的正式象征？' },
        t: 1795700000000,
      },
    ],
    devices: [
      {
        id: 'aaaaaaaaaaaaaaaa',
        label: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0.44',
        created: 1795690000000,
        last: 1795700000000,
      },
    ],
    questions: [
      {
        id: 'P009',
        t: 'principes',
        l: ['csp', 'cr', 'nat'],
        k: 'c',
        q: 'Lequel de ces symboles représente officiellement la République française ?',
        qz: '下列哪个象征正式代表法兰西共和国？',
        o: ['Marianne', 'Le coq', 'La fleur de lys', "L'aigle impériale"],
        oz: ['玛丽安娜', '高卢雄鸡', '百合花徽', '帝国鹰徽'],
        e: '玛丽安娜是共和国的官方象征，她的半身像放在所有市政府里。高卢雄鸡很常见，但没有得到官方承认；百合花徽代表的是君主制。',
        v: [['officiellement', '正式地、官方地']],
      },
      {
        id: 'I019',
        t: 'institutions',
        l: ['csp', 'cr', 'nat'],
        k: 'c',
        q: 'Qui nomme le Premier ministre en France ?',
        qz: '在法国，由谁任命总理？',
        o: ['Le Président de la République', "Le président de l'Assemblée nationale", 'Le Sénat', 'Le Conseil constitutionnel'],
        oz: ['共和国总统', '国民议会议长', '参议院', '宪法委员会'],
        e: '根据法国第五共和国宪法第 8 条，共和国总统任命总理，并根据总理的提议任免政府其他成员。',
        v: [
          ['nommer', '任命'],
          ['Premier ministre', '总理'],
        ],
      },
      {
        id: 'SP01',
        t: 'societe',
        l: ['csp', 'cr', 'nat'],
        k: 's',
        q: "Vous venez de déménager dans une nouvelle commune. Que devez-vous faire pour pouvoir voter aux prochaines élections ?",
        qz: '您刚刚搬到一个新的市镇。为了能在下次选举中投票，您应该做什么？',
        o: [
          "M'inscrire sur les listes électorales de ma nouvelle mairie",
          'Attendre le transfert automatique par la poste',
          'Demander une autorisation à la préfecture',
          'Présenter mon bail au bureau de vote le jour du scrutin',
        ],
        oz: [
          '在新的市政府办理选民名册登记',
          '等待邮局自动转移选民信息',
          '向省政府申请许可',
          '投票当天直接带租房合同去投票站',
        ],
        e: '搬家到新市镇后，选民名册不会自动迁移，必须主动到新市政府或通过 service-public.fr 在线重新登记。',
        v: [
          ['liste électorale', '选民名册'],
          ['commune', '市镇'],
        ],
      },
    ],
    freeIds: ['P009', 'I019'],
    patternFailures: {},
    devicePatterns: {
      aaaaaaaaaaaaaaaa: '0-1-2-5-8',
    },
  };
}

let store: MockStore = createInitialMockStore();

function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

function randomHex(len: number): string {
  const hex = '0123456789abcdef';
  return Array.from({ length: len }, () => hex[Math.floor(Math.random() * 16)]).join('');
}

export function resetMockStore(): void {
  store = createInitialMockStore();
}

export function getMockQuestions(): { qs: Question[]; freeIds: Set<string> } {
  return {
    qs: store.questions.map((q) => ({ ...q, o: [...q.o] as Question['o'], oz: [...q.oz] as Question['oz'], l: [...q.l] })),
    freeIds: new Set(store.freeIds),
  };
}

export async function mockAdminRequest(op: string, body: Record<string, unknown>): Promise<unknown> {
  // Small realistic latency
  await new Promise((r) => setTimeout(r, 140));

  if (op === 'login') {
    if (body.device && body.secret && body.pattern) {
      const devId = String(body.device);
      const pattern = String(body.pattern);
      const expected = store.devicePatterns[devId];
      if (!expected && devId !== 'aaaaaaaaaaaaaaaa') {
        throw new ApiError('device_unknown');
      }
      const targetPattern = expected || '0-1-2-5-8';
      if (pattern !== targetPattern) {
        const fails = (store.patternFailures[devId] || 0) + 1;
        store.patternFailures[devId] = fails;
        if (fails >= 5) {
          delete store.devicePatterns[devId];
          store.devices = store.devices.filter((d) => d.id !== devId);
          throw new ApiError('device_forgotten');
        }
        throw new ApiError('bad_pattern', 5 - fails);
      }
      store.patternFailures[devId] = 0;
      const dev = store.devices.find((d) => d.id === devId);
      if (dev) dev.last = Date.now();
      return { ok: true, token: `${Date.now()}.d.demo_pattern_token`, exp: Date.now() + 12 * 3600_000 };
    }

    const key = String(body.key || '');
    const otp = String(body.otp || '');
    if (!key) {
      throw new ApiError('forbidden');
    }
    if (!otp) {
      throw new ApiError('otp_required');
    }
    if (!/^\d{6}$/.test(otp)) {
      throw new ApiError('bad_otp');
    }
    return { ok: true, token: `${Date.now()}.f.demo_full_token`, exp: Date.now() + 12 * 3600_000 };
  }

  const token = String(body.token || '');
  if (!token) {
    throw new ApiError('forbidden');
  }

  switch (op) {
    case 'users': {
      return { ok: true, users: [...store.users].sort((a, b) => b.last_seen - a.last_seen) };
    }
    case 'user': {
      const id = String(body.id || '');
      const u = store.users.find((item) => item.id === id);
      if (!u) throw new ApiError('not_found');
      const detail = store.userDetails[id] || {
        devices: u.id.startsWith('b:') ? 1 : 0,
        limit: u.id.startsWith('b:') ? 5 : 1,
        days: [],
        state: { stats: {}, days: {}, exams: [] },
      };
      const resp: UserDetailResponse = {
        ok: true,
        user: { ...u, state: detail.state },
        days: detail.days,
        devices: detail.devices,
        limit: detail.limit,
      };
      return resp;
    }
    case 'user-del': {
      const id = String(body.id || '');
      store.users = store.users.filter((item) => item.id !== id);
      delete store.userDetails[id];
      return { ok: true };
    }
    case 'refs': {
      return { ok: true, refs: [...store.refs] };
    }
    case 'ref-set': {
      const name = String(body.name || '').trim();
      let code = String(body.code || '').trim();
      const pct = Number(body.pct ?? 30);
      const fresh = Boolean(body.fresh);
      if (!name || name.length > 60) throw new ApiError('bad_request');
      if (code) {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(code)) throw new ApiError('bad_code');
      } else {
        code = Math.random().toString(36).slice(2, 7);
      }
      const existingIdx = store.refs.findIndex((r) => r.code === code);
      if (fresh && existingIdx >= 0) {
        throw new ApiError('taken');
      }
      if (existingIdx >= 0) {
        store.refs[existingIdx] = { ...store.refs[existingIdx], name, pct };
      } else {
        store.refs.unshift({ code, name, pct, created: Date.now() });
      }
      return { ok: true, code };
    }
    case 'ref-del': {
      const code = String(body.code || '');
      store.refs = store.refs.filter((r) => r.code !== code);
      return { ok: true };
    }
    case 'codes': {
      return { ok: true, codes: [...store.codes] };
    }
    case 'code-new': {
      const n = Math.min(50, Math.max(1, Number(body.n || 1)));
      const note = body.note ? String(body.note).slice(0, 80) : '';
      const createdList: string[] = [];
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const c = randomCode();
        createdList.push(c);
        store.codes.unshift({
          code: c,
          note,
          created: now,
          used_at: null,
          used_by: null,
          revoked: false,
        });
      }
      return { ok: true, codes: createdList };
    }
    case 'code-reset': {
      const raw = normalizeCode(String(body.code || ''));
      if (raw.length < 8) throw new ApiError('bad_request');
      const userId = `b:${raw}`;
      if (store.userDetails[userId]) {
        store.userDetails[userId].devices = 0;
      }
      return { ok: true };
    }
    case 'code-del': {
      const raw = normalizeCode(String(body.code || ''));
      if (raw.length < 8) throw new ApiError('bad_request');
      const existing = store.codes.find((c) => normalizeCode(c.code) === raw);
      if (existing) {
        existing.revoked = true;
      } else {
        const formatted = raw.match(/.{1,4}/g)?.join('-') || raw;
        store.codes.unshift({
          code: formatted,
          note: '手动或付款码作废',
          created: Date.now(),
          used_at: null,
          used_by: null,
          revoked: true,
        });
      }
      return { ok: true };
    }
    case 'key': {
      return { ok: true, k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    }
    case 'patches': {
      return { ok: true, patches: [...store.patches] };
    }
    case 'patch-set': {
      const qid = String(body.qid || '');
      const free = Boolean(body.free);
      const data = (body.data || {}) as PatchData;
      if (!qid || Object.keys(data).length === 0) throw new ApiError('bad_request');
      const idx = store.patches.findIndex((p) => p.qid === qid);
      const next: QuestionPatch = { qid, free, data, t: Date.now() };
      if (idx >= 0) store.patches[idx] = next;
      else store.patches.unshift(next);
      return { ok: true };
    }
    case 'patch-del': {
      const qid = String(body.qid || '');
      store.patches = store.patches.filter((p) => p.qid !== qid);
      return { ok: true };
    }
    case 'devices': {
      return { ok: true, devices: [...store.devices] };
    }
    case 'device-add': {
      const parts = token.split('.');
      if (parts[1] !== 'f') {
        throw new ApiError('full_login_needed');
      }
      const pattern = String(body.pattern || '');
      const dots = pattern.split('-').filter(Boolean);
      if (dots.length < 4 || dots.length > 9) {
        throw new ApiError('bad_pattern');
      }
      const device = randomHex(16);
      const secret = randomHex(48);
      const now = Date.now();
      store.devicePatterns[device] = pattern;
      store.devices.unshift({
        id: device,
        label: navigator.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        created: now,
        last: now,
      });
      return { ok: true, device, secret, days: 30 };
    }
    case 'device-del': {
      const id = String(body.id || '');
      store.devices = store.devices.filter((d) => d.id !== id);
      delete store.devicePatterns[id];
      return { ok: true };
    }
    default:
      throw new ApiError('bad_request');
  }
}

export async function mockSalesRequest(token: string): Promise<{ ok: true; more: boolean; sales: SaleItem[] }> {
  await new Promise((r) => setTimeout(r, 420));
  if (!token) throw new ApiError('forbidden');
  return { ok: true, more: false, sales: [...store.sales] };
}
