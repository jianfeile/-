// Who may use the seller's pages: the admin password (ADMIN_KEY) and, when ADMIN_TOTP is set, a six-digit code from an
// authenticator app (Google Authenticator and the like). A successful sign-in gives a token good for twelve hours, so the
// code is asked once and not on every click.
//   ADMIN_KEY    the password: 16 characters or more, or 8 or more when ADMIN_TOTP is set
// With the database bound, eight wrong tries within fifteen minutes close the door for the rest of those fifteen minutes.
//
// A remembered device: after a full sign-in the seller can draw a pattern on that phone. From then on, for thirty days,
// that phone gets in with the pattern alone: the phone holds a random secret (what you have), the pattern is what you
// know. Five wrong patterns in a row forget the device, and so does changing the password.
//   ADMIN_TOTP   optional: the authenticator secret, base32 (the same text that is typed into the app)
const enc = new TextEncoder();
const HOURS = 12, TRIES = 8, WINDOW = 15 * 60000, DEVICE_DAYS = 30, PATTERN_TRIES = 5;
import { ensure } from './store.mjs';

async function digestSame(a, b) {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))));
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', out = [];
  let bits = 0, acc = 0;
  for (const ch of String(s).toUpperCase().replace(/[\s=-]/g, '')) {
    const v = A.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; }
  }
  return out.length >= 10 ? new Uint8Array(out) : null;
}
export async function totp(secret, at) {
  const keyBytes = base32(secret);
  if (!keyBytes) return null;
  const msg = new Uint8Array(8);
  let c = Math.floor(at / 30000);
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)), o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode('admin-session|' + env.ADMIN_KEY + '|' + (env.ADMIN_TOTP || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
}
// kind: 'f' after password (and authenticator code), 'd' after a pattern on a remembered device
export async function newToken(env, now = Date.now(), kind = 'f') {
  const exp = now + HOURS * 3600000;
  return { token: exp + '.' + kind + '.' + await sign(env, exp + '.' + kind), exp };
}
// { ok: true, token?, exp? } or { error: 'not_configured' | 'forbidden' | 'otp_required' | 'bad_otp' | 'expired' | 'locked' }
async function tooMany(env, now) {
  try {
    const d = await ensure(env);
    if (!d) return false;
    const r = await d.prepare('SELECT COUNT(*) AS n FROM auth_fail WHERE t > ?1').bind(now - WINDOW).first();
    return ((r || {}).n || 0) >= TRIES;
  } catch { return false; }
}
async function failed(env, now) {
  try {
    const d = await ensure(env);
    if (d) await d.batch([d.prepare('INSERT INTO auth_fail (t) VALUES (?1)').bind(now), d.prepare('DELETE FROM auth_fail WHERE t < ?1').bind(now - 24 * 3600000)]);
  } catch { /* the database is optional */ }
}
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
async function digest(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
export function patternOk(p) { return typeof p === 'string' && /^[0-8](-[0-8]){3,8}$/.test(p) && new Set(p.split('-')).size === p.split('-').length; }
const patternHash = (env, id, pattern) => digest('pattern|' + env.ADMIN_KEY + '|' + id + '|' + pattern);
// after a full sign-in: remember this device. Gives the device its number and its secret, shown once.
export async function addDevice(env, pattern, label, now = Date.now()) {
  const d = await ensure(env);
  if (!d) return { error: 'no_database' };
  if (!patternOk(pattern)) return { error: 'bad_pattern' };
  const id = hex(crypto.getRandomValues(new Uint8Array(8))), secret = hex(crypto.getRandomValues(new Uint8Array(24)));
  await d.batch([
    d.prepare('DELETE FROM devices WHERE created < ?1').bind(now - DEVICE_DAYS * 86400000),
    d.prepare('INSERT INTO devices (id, secret, pattern, label, created, last, fails) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0)').bind(id, await digest('secret|' + secret), await patternHash(env, id, pattern), String(label || '').slice(0, 80), now),
  ]);
  return { ok: true, device: id, secret, days: DEVICE_DAYS };
}
async function byDevice(body, env, now) {
  const d = await ensure(env);
  if (!d) return { error: 'forbidden' };
  if (!/^[0-9a-f]{16}$/.test(body.device) || typeof body.secret !== 'string') return { error: 'forbidden' };
  const row = await d.prepare('SELECT secret, pattern, created, fails FROM devices WHERE id = ?1').bind(body.device).first();
  if (!row || !(await digestSame(row.secret, await digest('secret|' + body.secret)))) { await failed(env, now); return { error: 'device_unknown' }; }
  if (row.created < now - DEVICE_DAYS * 86400000) { await d.prepare('DELETE FROM devices WHERE id = ?1').bind(body.device).run(); return { error: 'device_expired' }; }
  if (!patternOk(body.pattern) || !(await digestSame(row.pattern, await patternHash(env, body.device, body.pattern)))) {
    const fails = (row.fails || 0) + 1;
    if (fails >= PATTERN_TRIES) { await d.prepare('DELETE FROM devices WHERE id = ?1').bind(body.device).run(); return { error: 'device_forgotten' }; }
    await d.prepare('UPDATE devices SET fails = ?2 WHERE id = ?1').bind(body.device, fails).run();
    return { error: 'bad_pattern', left: PATTERN_TRIES - fails };
  }
  await d.prepare('UPDATE devices SET fails = 0, last = ?2 WHERE id = ?1').bind(body.device, now).run();
  return Object.assign({ ok: true }, await newToken(env, now, 'd'));
}
export async function authorize(body, env, now = Date.now()) {
  if (String(env.ADMIN_KEY || '').length < (env.ADMIN_TOTP ? 8 : 16)) return { error: 'not_configured' };
  if (body && typeof body.token === 'string' && body.token) {
    const [exp, kind, sig] = body.token.split('.');
    if (!/^\d{13}$/.test(exp || '') || !/^[fd]$/.test(kind || '') || !sig || !(await digestSame(sig, await sign(env, exp + '.' + kind)))) return { error: 'forbidden' };
    return Number(exp) > now ? { ok: true, kind, issued: Number(exp) - HOURS * 3600000 } : { error: 'expired' };
  }
  if (await tooMany(env, now)) return { error: 'locked' };
  if (body && typeof body.device === 'string' && body.device) return byDevice(body, env, now);
  if (!body || typeof body.key !== 'string' || !(await digestSame(body.key, env.ADMIN_KEY))) { if (body && body.key) await failed(env, now); return { error: 'forbidden' }; }
  if (env.ADMIN_TOTP) {
    const otp = String(body.otp || '').replace(/\s/g, '');
    if (!otp) return { error: 'otp_required' };
    let good = false;
    for (const step of [0, -1, 1]) if (/^\d{6}$/.test(otp) && otp === await totp(env.ADMIN_TOTP, now + step * 30000)) good = true;
    if (!good) { await failed(env, now); return { error: 'bad_otp' }; }
  }
  return Object.assign({ ok: true }, await newToken(env, now));
}
export const statusOf = (e) => (e === 'not_configured' ? 503 : 403);
