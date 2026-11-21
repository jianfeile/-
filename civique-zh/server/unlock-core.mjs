// Automatic unlocking after an online payment. Runs wherever the Web-standard Request / Response / fetch /
// crypto.subtle exist (Cloudflare Pages Functions, Node 18+ for the tests).
//
// POST /api/unlock with one of
//   { "session": "cs_live_..." }   the Checkout Session id Stripe adds to the redirect after payment
//   { "code": "XXXX-XXXX-XXXX" }   an unlock code issued here earlier (another device)
//   { "email": "buyer@example.com" } the email used at payment (lost code)
// answers { ok, code, k } where k opens data/bank.json, or { error }.
//
// Settings (secrets of the host, never in the repository):
//   STRIPE_KEY    restricted Stripe key that can only READ Checkout Sessions
//   CONTENT_KEY   the bank key, as printed by: node tools/bank.mjs key --code <a valid code>
// optional:
//   PAYMENT_LINK  plink_... id: only payments made through this link count
//   REVOKED       unlock codes that no longer work, separated by commas or spaces
//   ALLOW_TEST    "1" to accept Stripe test-mode payments (never on the public site)
//
// Codes issued here need no database: the first half comes from the payment, the second half is a
// signature of the first half made with a key derived from CONTENT_KEY.
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const enc = new TextEncoder();

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
export function normCode(s) {
  const c = String(s || '').toUpperCase().split('').filter((ch) => ALPHA.includes(ch)).join('');
  return c.length === 12 ? c : null;
}
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12);
function toAlpha(bytes, n) {
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && out.length < n) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
    if (out.length >= n) break;
  }
  return out;
}
async function signer(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('civique-code-v1:' + env.CONTENT_KEY));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async (msg) => new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
export async function codeForSession(env, sessionId) {
  const sign = await signer(env);
  const first = toAlpha(await sign('n:' + sessionId), 6);
  return first + toAlpha(await sign('c:' + first), 6);
}
export async function codeIsValid(env, code) {
  const sign = await signer(env);
  return toAlpha(await sign('c:' + code.slice(0, 6)), 6) === code.slice(6);
}
function revoked(env, code) {
  return String(env.REVOKED || '').split(/[\s,]+/).map(normCode).includes(code);
}
async function stripe(env, path, fetchImpl) {
  const r = await fetchImpl('https://api.stripe.com/v1/' + path, { headers: { authorization: 'Bearer ' + env.STRIPE_KEY } });
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
}
// 'paid' | 'pending' | 'no'
function state(s, env) {
  if (!s || s.object !== 'checkout.session') return 'no';
  if (!s.livemode && env.ALLOW_TEST !== '1') return 'no';
  if (env.PAYMENT_LINK && s.payment_link !== env.PAYMENT_LINK) return 'no';
  if (s.status !== 'complete') return s.status === 'open' ? 'pending' : 'no';
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') return 'paid';
  return 'pending';
}
async function grant(env, sessionId) {
  const code = await codeForSession(env, sessionId);
  if (revoked(env, code)) return json({ error: 'revoked' }, 403);
  return json({ ok: true, code: fmtCode(code), k: env.CONTENT_KEY });
}

export async function handle(request, env, fetchImpl = fetch) {
  env = env || {};
  const configured = !!(env.CONTENT_KEY && env.STRIPE_KEY);
  if (request.method === 'GET') return json({ ok: true, configured });
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!configured) return json({ error: 'not_configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400);
  try {
    if (typeof body.session === 'string') {
      if (!/^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(body.session)) return json({ error: 'not_found' }, 404);
      const r = await stripe(env, 'checkout/sessions/' + body.session, fetchImpl);
      if (r.status === 404) return json({ error: 'not_found' }, 404);
      if (r.status !== 200) return json({ error: 'payment_service' }, 502);
      const st = state(r.body, env);
      if (st === 'pending') return json({ error: 'pending' }, 409);
      if (st !== 'paid') return json({ error: 'not_paid' }, 402);
      return grant(env, r.body.id);
    }
    if (typeof body.code === 'string') {
      const code = normCode(body.code);
      if (!code || !(await codeIsValid(env, code))) return json({ error: 'bad_code' }, 404);
      if (revoked(env, code)) return json({ error: 'revoked' }, 403);
      return json({ ok: true, code: fmtCode(code), k: env.CONTENT_KEY });
    }
    if (typeof body.email === 'string') {
      const email = body.email.trim();
      if (!/^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email)) return json({ error: 'bad_email' }, 400);
      for (const e of [...new Set([email, email.toLowerCase()])]) {
        let q = 'checkout/sessions?limit=20&status=complete&customer_details[email]=' + encodeURIComponent(e);
        if (env.PAYMENT_LINK) q += '&payment_link=' + encodeURIComponent(env.PAYMENT_LINK);
        const r = await stripe(env, q, fetchImpl);
        if (r.status !== 200) return json({ error: 'payment_service' }, 502);
        const hit = (r.body.data || []).find((s) => state(s, env) === 'paid');
        if (hit) return grant(env, hit.id);
      }
      return json({ error: 'not_found' }, 404);
    }
    return json({ error: 'bad_request' }, 400);
  } catch {
    return json({ error: 'server' }, 500);
  }
}
