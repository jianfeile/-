// Usage tracking, the seller's admin page and corrections to the question bank. Needs the D1 binding DB (see store.mjs).
//
//   POST /api/sync     from the app, now and then: who this device is and how far its owner is
//   GET  /api/patches  from the app: corrections made in the admin page since the bank file was built
//   POST /api/admin    { key: ADMIN_KEY, op, ... } for the admin page
//
// Settings: DB (D1 binding), CONTENT_KEY (corrections to paid questions are encrypted with it), ADMIN_KEY.
import { codeIsValid, normCode } from './unlock-core.mjs';
import { ensure, clip, refOk, parisDay } from './store.mjs';

const enc = new TextEncoder();
const json = (obj, status = 200, extra) => new Response(JSON.stringify(obj), {
  status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }, extra || {}),
});
const MAX_BODY = 400000;
const FIELDS = { q: 'text', qz: 'text', e: 'text', o: 'four', oz: 'four' };     // what a correction may change

async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))))));
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { const b = JSON.parse(text); return b && typeof b === 'object' ? b : null; } catch { return null; }
}
const b64 = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const num = (v, max) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0);

// ---------------------------------------------------------------- /api/sync
function tidySum(x) {
  x = x && typeof x === 'object' ? x : {};
  return { seen: num(x.seen, 9999), ok: num(x.ok, 9999), miss: num(x.miss, 9999), ans: num(x.ans, 999999), pool: num(x.pool, 9999), exams: num(x.exams, 99), best: num(x.best, 99), bestN: num(x.bestN, 99) };
}
function tidyState(x) {
  x = x && typeof x === 'object' ? x : {};
  const stats = {}, days = {};
  let n = 0;
  for (const [id, s] of Object.entries(x.stats && typeof x.stats === 'object' ? x.stats : {})) {
    if (++n > 3000) break;
    if (/^[A-Za-z0-9_-]{1,16}$/.test(id) && Array.isArray(s)) stats[id] = s.slice(0, 5).map((v) => num(v, 1e13));
  }
  for (const [k, d] of Object.entries(x.days && typeof x.days === 'object' ? x.days : {})) {
    if (/^\d{4}-\d\d-\d\d$/.test(k) && Array.isArray(d)) days[k] = [num(d[0], 9999), num(d[1], 9999)];
  }
  const exams = (Array.isArray(x.exams) ? x.exams : []).slice(0, 10).map((e) => ({
    ts: num(e && e.ts, 1e13), target: clip(e && e.target, 8), mini: !!(e && e.mini), score: num(e && e.score, 99), n: num(e && e.n, 99), passAt: num(e && e.passAt, 99), secs: num(e && e.secs, 99999),
  }));
  return { stats, days, exams };
}
export async function sync(request, env, cf) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const d = await ensure(env);
  if (!d) return json({ error: 'not_configured' }, 503);
  const body = await readBody(request);
  if (!body || typeof body.device !== 'string' || !/^[a-f0-9]{16,32}$/.test(body.device)) return json({ error: 'bad_request' }, 400);
  const code = normCode(body.code);
  const buyer = !!(code && env.CONTENT_KEY && await codeIsValid(env, code));
  const id = buyer ? 'b:' + code : 'v:' + body.device, now = Date.now();
  const ref = refOk(body.ref), geo = cf || {};
  const level = /^[a-z]{2,4}$/.test(body.level || '') ? body.level : '';
  const examDate = /^\d{4}-\d\d-\d\d$/.test(body.examDate || '') ? body.examDate : '';
  const stmts = [];
  if (buyer) {
    // the same person as the visitor this device was until now: keep when they first came and who sent them, drop the visitor
    const was = await d.prepare('SELECT created, ref FROM users WHERE id = ?1').bind('v:' + body.device).first();
    if (was) {
      stmts.push(d.prepare(`INSERT INTO users (id, ref, created, last_seen) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET created = MIN(users.created, excluded.created), ref = CASE WHEN users.ref IS NULL OR users.ref = '' THEN excluded.ref ELSE users.ref END`)
        .bind(id, refOk(was.ref), was.created || now, now));
      stmts.push(d.prepare('UPDATE days SET user = ?1 WHERE user = ?2 AND day NOT IN (SELECT day FROM days WHERE user = ?1)').bind(id, 'v:' + body.device));
      stmts.push(d.prepare('DELETE FROM days WHERE user = ?1').bind('v:' + body.device));
      stmts.push(d.prepare('DELETE FROM users WHERE id = ?1').bind('v:' + body.device));
    }
  }
  stmts.push(d.prepare(`INSERT INTO users (id, ref, device, created, last_seen, country, city, ua, level, exam_date, unlocked, sum, state)
    VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    ON CONFLICT(id) DO UPDATE SET ref = CASE WHEN users.ref IS NULL OR users.ref = '' THEN excluded.ref ELSE users.ref END,
      device = excluded.device, last_seen = excluded.last_seen, country = excluded.country, city = excluded.city, ua = excluded.ua,
      level = excluded.level, exam_date = excluded.exam_date, unlocked = excluded.unlocked, sum = excluded.sum, state = excluded.state`)
    .bind(id, ref, body.device, now, clip(geo.country, 8), clip(geo.city, 80), clip(request.headers.get('user-agent') || '', 200), level, examDate,
      buyer || body.unlocked ? 1 : 0, JSON.stringify(tidySum(body.sum)), JSON.stringify(tidyState(body.state))));
  stmts.push(d.prepare('INSERT INTO days (user, day, n) VALUES (?1, ?2, 1) ON CONFLICT(user, day) DO UPDATE SET n = n + 1').bind(id, parisDay(now)));
  await d.batch(stmts);
  return json({ ok: true });
}

// ---------------------------------------------------------------- /api/patches
function tidyPatch(data) {
  const out = {};
  for (const [k, kind] of Object.entries(FIELDS)) {
    const v = data ? data[k] : undefined;
    if (v === undefined) continue;
    if (kind === 'text') { if (typeof v !== 'string' || !v.trim() || v.length > 4000) return null; out[k] = v.trim(); }
    else { if (!Array.isArray(v) || v.length !== 4 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 600)) return null; out[k] = v.map((x) => x.trim()); }
  }
  return Object.keys(out).length ? out : null;
}
export async function patches(request, env) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  const d = await ensure(env);
  if (!d) return json({ ok: true, v: 0, free: {}, paid: null });
  const rows = (await d.prepare('SELECT qid, free, data, t FROM patches').all()).results || [];
  const free = {}, paid = {};
  let v = 0;
  for (const r of rows) { (r.free ? free : paid)[r.qid] = JSON.parse(r.data); v = Math.max(v, r.t); }
  let sealed = null;
  if (Object.keys(paid).length && env.CONTENT_KEY) {
    const key = await crypto.subtle.importKey('raw', unb64(env.CONTENT_KEY), { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    sealed = { iv: b64(iv), ct: b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(paid))))) };
  }
  return json({ ok: true, v, free, paid: sealed }, 200, { 'cache-control': 'public, max-age=60' });
}

// ---------------------------------------------------------------- /api/admin
const LIST = 'id, email, ref, created, paid_at, last_seen, country, city, ua, level, exam_date, unlocked, sum, (SELECT COUNT(*) FROM days WHERE days.user = users.id) AS days';
export async function admin(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (String(env.ADMIN_KEY || '').length < 16) return json({ error: 'not_configured' }, 503);
  const body = await readBody(request);
  if (!body || typeof body.key !== 'string' || !(await same(body.key, env.ADMIN_KEY))) return json({ error: 'forbidden' }, 403);
  const d = await ensure(env);
  if (!d) return json({ error: 'no_database' }, 503);
  const op = body.op;
  if (op === 'users') {
    const rows = (await d.prepare('SELECT ' + LIST + ' FROM users ORDER BY last_seen DESC LIMIT 3000').all()).results || [];
    return json({ ok: true, users: rows.map((r) => Object.assign(r, { sum: r.sum ? JSON.parse(r.sum) : null })) });
  }
  if (op === 'user') {
    const r = await d.prepare('SELECT ' + LIST + ', state FROM users WHERE id = ?1').bind(String(body.id || '')).first();
    if (!r) return json({ error: 'not_found' }, 404);
    const days = (await d.prepare('SELECT day, n FROM days WHERE user = ?1 ORDER BY day DESC LIMIT 400').bind(r.id).all()).results || [];
    return json({ ok: true, user: Object.assign(r, { sum: r.sum ? JSON.parse(r.sum) : null, state: r.state ? JSON.parse(r.state) : null }), days });
  }
  if (op === 'user-del') {          // someone asked for their record to be erased
    const id = String(body.id || '');
    await d.batch([d.prepare('DELETE FROM days WHERE user = ?1').bind(id), d.prepare('DELETE FROM users WHERE id = ?1').bind(id)]);
    return json({ ok: true });
  }
  if (op === 'key') return json({ ok: true, k: env.CONTENT_KEY || '' });         // the admin page opens the bank file with it, to show the questions
  if (op === 'patches') {
    const rows = (await d.prepare('SELECT qid, free, data, t FROM patches ORDER BY t DESC').all()).results || [];
    return json({ ok: true, patches: rows.map((r) => ({ qid: r.qid, free: !!r.free, data: JSON.parse(r.data), t: r.t })) });
  }
  if (op === 'patch-set') {
    const data = tidyPatch(body.data);
    if (typeof body.qid !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(body.qid) || !data) return json({ error: 'bad_request' }, 400);
    await d.prepare('INSERT INTO patches (qid, free, data, t) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(qid) DO UPDATE SET free = excluded.free, data = excluded.data, t = excluded.t')
      .bind(body.qid, body.free ? 1 : 0, JSON.stringify(data), Date.now()).run();
    return json({ ok: true });
  }
  if (op === 'patch-del') {
    await d.prepare('DELETE FROM patches WHERE qid = ?1').bind(String(body.qid || '')).run();
    return json({ ok: true });
  }
  return json({ error: 'bad_request' }, 400);
}
