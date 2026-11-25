// The site's small database (Cloudflare D1, bound as DB): who uses the site, how far they are, and corrections to the bank.
// Everything here is optional: without the binding the site works as before and these functions do nothing.
const SCHEMA = [
  // id: "b:<12-char code>" for a buyer, "v:<device id>" for a visitor who has not paid
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, ref TEXT, device TEXT, created INTEGER, paid_at INTEGER, last_seen INTEGER,
     country TEXT, city TEXT, ua TEXT, level TEXT, exam_date TEXT, unlocked INTEGER DEFAULT 0, sum TEXT, state TEXT)`,
  `CREATE INDEX IF NOT EXISTS users_seen ON users (last_seen)`,
  `CREATE TABLE IF NOT EXISTS days (user TEXT, day TEXT, n INTEGER, PRIMARY KEY (user, day))`,
  `CREATE TABLE IF NOT EXISTS patches (qid TEXT PRIMARY KEY, free INTEGER, data TEXT, t INTEGER)`,
];
let ready = null;
export function db(env) { return env && env.DB ? env.DB : null; }
export async function ensure(env) {
  const d = db(env);
  if (!d) return null;
  if (ready !== d) { await d.batch(SCHEMA.map((s) => d.prepare(s))); ready = d; }
  return d;
}
export const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
export const refOk = (r) => (typeof r === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r) ? r : '');
export function parisDay(ms) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date(ms)); }

// a payment was confirmed: keep who paid (email), who referred them and when. Never lets a failure reach the buyer.
export async function rememberBuyer(env, code, info) {
  try {
    const d = await ensure(env);
    if (!d || !code) return;
    const now = Date.now();
    await d.prepare(`INSERT INTO users (id, email, ref, created, paid_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?4)
      ON CONFLICT(id) DO UPDATE SET email = CASE WHEN excluded.email != '' THEN excluded.email ELSE users.email END,
        ref = CASE WHEN users.ref IS NULL OR users.ref = '' THEN excluded.ref ELSE users.ref END,
        paid_at = COALESCE(users.paid_at, excluded.paid_at)`)
      .bind('b:' + code, clip(info.email, 200), refOk(info.ref), now, info.paidAt || null).run();
  } catch { /* the database is optional */ }
}
