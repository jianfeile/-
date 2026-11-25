// The site's small database (Cloudflare D1, bound as DB): who uses the site, how far they are, and corrections to the bank.
// Everything here is optional: without the binding the site works as before and these functions do nothing.
const SCHEMA = [
  // id: "b:<12-char code>" for a buyer, "u:<phone or email>" for someone who signed in, "v:<device id>" for an anonymous visitor
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, ref TEXT, device TEXT, created INTEGER, paid_at INTEGER, last_seen INTEGER,
     country TEXT, city TEXT, ua TEXT, level TEXT, exam_date TEXT, unlocked INTEGER DEFAULT 0, sum TEXT, state TEXT)`,
  `CREATE INDEX IF NOT EXISTS users_seen ON users (last_seen)`,
  `CREATE TABLE IF NOT EXISTS days (user TEXT, day TEXT, n INTEGER, PRIMARY KEY (user, day))`,
  `CREATE TABLE IF NOT EXISTS patches (qid TEXT PRIMARY KEY, free INTEGER, data TEXT, t INTEGER)`,
  // codes the seller made by hand (one device each), and any code the seller cancelled
  // the devices on which a code issued after a payment was used (a purchase is for one person: a few devices, not a crowd)
  `CREATE TABLE IF NOT EXISTS code_devices (code TEXT, device TEXT, t INTEGER, PRIMARY KEY (code, device))`,
  `CREATE TABLE IF NOT EXISTS auth_fail (t INTEGER)`,       // wrong tries at the admin door
  `CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, note TEXT, created INTEGER, used_at INTEGER, used_by TEXT, revoked INTEGER DEFAULT 0)`,
];
let ready = null;
export function db(env) { return env && env.DB ? env.DB : null; }
export async function ensure(env) {
  const d = db(env);
  if (!d) return null;
  if (ready !== d) {
    await d.batch(SCHEMA.map((s) => d.prepare(s)));
    for (const col of ['login TEXT']) { try { await d.prepare('ALTER TABLE users ADD COLUMN ' + col).run(); } catch { /* already there */ } }
    ready = d;
  }
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

export function deviceLimit(env) { const n = Math.floor(Number(env && env.DEVICE_LIMIT)); return n >= 1 && n <= 20 ? n : 3; }
// A code in the seller's list works on one device: the first that uses it. A code issued after a payment works on a few
// (DEVICE_LIMIT, 3 unless set). 'ok' | 'used' | 'limit' | 'revoked'. A request that names no device is not counted.
export async function codeGate(env, code, device) {
  try {
    const d = await ensure(env);
    if (!d) return 'ok';
    const read = () => d.prepare('SELECT used_by, revoked FROM codes WHERE code = ?1').bind(code).first();
    let row = await read();
    const dev = typeof device === 'string' && /^[a-f0-9]{16,32}$/.test(device) ? device : '';
    if (!row) {
      if (!dev) return 'ok';
      const have = (await d.prepare('SELECT device FROM code_devices WHERE code = ?1').bind(code).all()).results || [];
      if (have.some((x) => x.device === dev)) return 'ok';
      if (have.length >= deviceLimit(env)) return 'limit';
      await d.prepare('INSERT OR IGNORE INTO code_devices (code, device, t) VALUES (?1, ?2, ?3)').bind(code, dev, Date.now()).run();
      return 'ok';
    }
    if (row.revoked) return 'revoked';
    if (!row.used_by) {
      if (!dev) return 'used';
      await d.prepare('UPDATE codes SET used_by = ?2, used_at = ?3 WHERE code = ?1 AND used_by IS NULL').bind(code, dev, Date.now()).run();
      row = await read();
    }
    return row.used_by === dev ? 'ok' : 'used';
  } catch { return 'ok'; }
}
