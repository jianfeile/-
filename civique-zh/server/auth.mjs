// Who may use the seller's pages: the admin password (ADMIN_KEY) and, when ADMIN_TOTP is set, a six-digit code from an
// authenticator app (Google Authenticator and the like). A successful sign-in gives a token good for twelve hours, so the
// code is asked once and not on every click.
//   ADMIN_KEY    a long password (16 characters or more)
//   ADMIN_TOTP   optional: the authenticator secret, base32 (the same text that is typed into the app)
const enc = new TextEncoder();
const HOURS = 12;

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
export async function newToken(env, now = Date.now()) {
  const exp = now + HOURS * 3600000;
  return { token: exp + '.' + await sign(env, String(exp)), exp };
}
// { ok: true, token?, exp? } or { error: 'not_configured' | 'forbidden' | 'otp_required' | 'bad_otp' | 'expired' }
export async function authorize(body, env, now = Date.now()) {
  if (String(env.ADMIN_KEY || '').length < 16) return { error: 'not_configured' };
  if (body && typeof body.token === 'string' && body.token) {
    const [exp, sig] = body.token.split('.');
    if (!/^\d{13}$/.test(exp || '') || !sig || !(await digestSame(sig, await sign(env, exp)))) return { error: 'forbidden' };
    return Number(exp) > now ? { ok: true } : { error: 'expired' };
  }
  if (!body || typeof body.key !== 'string' || !(await digestSame(body.key, env.ADMIN_KEY))) return { error: 'forbidden' };
  if (env.ADMIN_TOTP) {
    const otp = String(body.otp || '').replace(/\s/g, '');
    if (!otp) return { error: 'otp_required' };
    let good = false;
    for (const step of [0, -1, 1]) if (/^\d{6}$/.test(otp) && otp === await totp(env.ADMIN_TOTP, now + step * 30000)) good = true;
    if (!good) return { error: 'bad_otp' };
  }
  return Object.assign({ ok: true }, await newToken(env, now));
}
export const statusOf = (e) => (e === 'not_configured' ? 503 : 403);
