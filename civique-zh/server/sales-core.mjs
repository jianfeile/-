// The seller's own sales report: who brought each sale. Same runtime as unlock-core.mjs.
//
// POST /api/sales { "key": "<ADMIN_KEY>" }
// answers { ok, sales: [{ t, amount, currency, ref }], more } with one entry per paid payment, newest first.
// t is the payment time in seconds, amount is in cents, ref is the name given in a shared link (?r=name) or ''.
// No buyer details leave this function.
//
// Settings (secrets of the host): STRIPE_KEY and PAYMENT_LINK as for /api/unlock, plus
//   ADMIN_KEY     a long password (16 characters or more) only the seller knows
const enc = new TextEncoder();
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
});
const PAGES = 30;       // 100 payments a page

async function same(a, b) {            // compares two strings without telling how many characters match
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))));
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export async function handle(request, env, fetchImpl = fetch) {
  env = env || {};
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.STRIPE_KEY || !env.PAYMENT_LINK || String(env.ADMIN_KEY || '').length < 16) return json({ error: 'not_configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  if (!body || typeof body.key !== 'string' || !(await same(body.key, env.ADMIN_KEY))) return json({ error: 'forbidden' }, 403);
  try {
    const sales = [];
    let after = '', more = false;
    for (let page = 0; page < PAGES; page++) {
      const r = await fetchImpl('https://api.stripe.com/v1/checkout/sessions?limit=100&status=complete&payment_link=' + encodeURIComponent(env.PAYMENT_LINK) +
        (after ? '&starting_after=' + encodeURIComponent(after) : ''), { headers: { authorization: 'Bearer ' + env.STRIPE_KEY } });
      if (r.status !== 200) return json({ error: 'payment_service' }, 502);
      const list = await r.json(), data = list.data || [];
      for (const s of data) {
        if (!s.livemode && env.ALLOW_TEST !== '1') continue;
        if (s.payment_status !== 'paid') continue;
        const ref = /^[A-Za-z0-9_-]{1,40}$/.test(s.client_reference_id || '') ? s.client_reference_id : '';
        sales.push({ t: s.created, amount: s.amount_total || 0, currency: s.currency || 'eur', ref });
      }
      more = !!list.has_more && data.length > 0;
      if (!more) break;
      after = data[data.length - 1].id;
    }
    return json({ ok: true, sales, more });
  } catch {
    return json({ error: 'server' }, 500);
  }
}
