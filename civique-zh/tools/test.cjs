#!/usr/bin/env node
// End-to-end checks in a real browser (Playwright + Chromium).
//   CIVIQUE_CODE=XXXX-XXXX-XXXX node tools/test.cjs [--shots <dir>]
// Without CIVIQUE_CODE the unlock checks are skipped.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const SITE = path.resolve(__dirname, '..', 'site');
const CODE = process.env.CIVIQUE_CODE || '';
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg' };

// ---- a stand-in for Stripe: the unlock function is the real one, only its calls to Stripe are answered here
const SESSIONS = {
  cs_live_PAID00000001: { livemode: true, status: 'complete', payment_status: 'paid', payment_link: 'plink_ours', customer_details: { email: 'buyer@example.com' } },
  cs_live_PROC00000001: { livemode: true, status: 'complete', payment_status: 'unpaid', payment_link: 'plink_ours', customer_details: { email: 'slow@example.com' } },
  cs_live_OTHER0000001: { livemode: true, status: 'complete', payment_status: 'paid', payment_link: 'plink_other', customer_details: { email: 'other@example.com' } },
  cs_test_PAID00000001: { livemode: false, status: 'complete', payment_status: 'paid', payment_link: 'plink_ours', customer_details: { email: 'tester@example.com' } },
};
Object.assign(SESSIONS.cs_live_PAID00000001, { created: 1795000000, amount_total: 1299, currency: 'eur', client_reference_id: 'lili-01' });
Object.assign(SESSIONS.cs_live_PROC00000001, { created: 1795000100, amount_total: 1299, currency: 'eur', client_reference_id: 'lili-01' });
Object.assign(SESSIONS.cs_live_OTHER0000001, { created: 1795000200, amount_total: 500, currency: 'eur', client_reference_id: 'wang' });
Object.assign(SESSIONS.cs_test_PAID00000001, { created: 1795000300, amount_total: 1299, currency: 'eur', client_reference_id: 'wang' });
for (const id of Object.keys(SESSIONS)) Object.assign(SESSIONS[id], { id, object: 'checkout.session' });
const ENV = { STRIPE_KEY: 'rk_live_standin', PAYMENT_LINK: 'plink_ours', CONTENT_KEY: Buffer.alloc(32, 7).toString('base64'), ADMIN_KEY: 'admin-password-0123456789' };
// more sales for the report: 120 of them, so the list comes in two pages
const MANY = {};
for (let i = 0; i < 120; i++) MANY['cs_live_MANY' + String(i).padStart(6, '0')] = { object: 'checkout.session', id: 'cs_live_MANY' + String(i).padStart(6, '0'), livemode: true, status: 'complete', payment_status: 'paid', payment_link: 'plink_ours', created: 1790000000 + i * 3600, amount_total: 1299, currency: 'eur', client_reference_id: i % 3 === 0 ? 'wang' : (i % 3 === 1 ? null : '<b>bad</b>'), customer_details: { email: 'many' + i + '@example.com' } };
let reportMany = false;
// a stand-in for Cloudflare D1, on the SQLite that comes with Node
function d1() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => Object.assign({}, r)) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? Object.assign({}, r) : null; },
  });
  return { prepare: (sql) => stmt(sql, []), batch: async (list) => { for (const x of list) await x.run(); return []; } };
}
ENV.DB = d1();
ENV.DEVICE_LIMIT = '20';          // the walk below unlocks the same purchase in many fresh browsers; the limit has its own checks
const CF = { country: 'FR', city: 'Lyon' };
async function stripeStandIn(url, opts) {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if ((opts.headers.authorization || '') !== 'Bearer ' + ENV.STRIPE_KEY) return reply(401, { error: { message: 'bad key' } });
  const u = new URL(url);
  const one = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)$/.exec(u.pathname);
  if (one) return SESSIONS[one[1]] ? reply(200, SESSIONS[one[1]]) : reply(404, { error: { message: 'no such session' } });
  if (u.pathname === '/v1/checkout/sessions') {
    const email = u.searchParams.get('customer_details[email]'), link = u.searchParams.get('payment_link'), status = u.searchParams.get('status');
    if (email === null) {                 // the sales report: every payment, newest first, 100 a page
      const all = Object.values(SESSIONS).concat(reportMany ? Object.values(MANY) : []).filter((x) => (!link || x.payment_link === link) && (!status || x.status === status)).sort((a, b) => b.created - a.created);
      const from = u.searchParams.get('starting_after') ? all.findIndex((x) => x.id === u.searchParams.get('starting_after')) + 1 : 0;
      return reply(200, { object: 'list', data: all.slice(from, from + 100), has_more: all.length > from + 100 });
    }
    const data = Object.values(SESSIONS).filter((x) => x.customer_details.email === email && (!link || x.payment_link === link) && (!status || x.status === status));
    return reply(200, { object: 'list', data });
  }
  return reply(404, {});
}
let core = null, salesCore = null, adminCore = null;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/api/sync' || p === '/api/patches' || p === '/api/admin') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const r = await adminCore[p.slice(5)](new Request('http://x' + p, { method: req.method, headers: { 'content-type': 'application/json', 'user-agent': req.headers['user-agent'] || '' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), ENV, CF);
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        });
        return;
      }
      if (p === '/api/sales') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const r = await salesCore.handle(new Request('http://x/api/sales', { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), ENV, stripeStandIn);
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        });
        return;
      }
      if (p === '/api/unlock') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const r = await core.handle(new Request('http://x/api/unlock', { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), ENV, stripeStandIn);
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        });
        return;
      }
      if (p === '/') p = '/index.html';
      const f = path.join(SITE, p);
      if (!f.startsWith(SITE) || !fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let failed = 0, passed = 0;
function check(name, ok, extra) {
  if (ok) { passed++; console.log('  ok    ' + name); } else { failed++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const free = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'free.json'), 'utf8'));
const answers = new Map(free.qs.map((q) => [q.q, q.o[0]]));
let fullCount = null;
if (CODE) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'civ-'));
  execFileSync('node', [path.join(__dirname, 'bank.mjs'), 'export', '--code', CODE, '--out', tmp]);
  const all = JSON.parse(fs.readFileSync(path.join(tmp, 'all.json'), 'utf8'));
  for (const q of all) answers.set(q.q, q.opts[0]);
  fullCount = all.length;
  fs.rmSync(tmp, { recursive: true, force: true });
  ENV.CONTENT_KEY = execFileSync('node', [path.join(__dirname, 'bank.mjs'), 'key', '--code', CODE]).toString().trim();
}

(async () => {
  core = await import(require('url').pathToFileURL(path.resolve(__dirname, '..', 'server', 'unlock-core.mjs')).href);
  salesCore = await import(require('url').pathToFileURL(path.resolve(__dirname, '..', 'server', 'sales-core.mjs')).href);
  adminCore = await import(require('url').pathToFileURL(path.resolve(__dirname, '..', 'server', 'admin-core.mjs')).href);
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const errors = [];
  async function fresh(opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, locale: 'zh-CN', serviceWorkers: 'block' }, opts || {}, { cfg: undefined }));
    // the tests describe a site with no payment link and no contact yet; the ones about those set their own
    await ctx.addInitScript((extra) => {
      let cfg;
      Object.defineProperty(window, 'CIVIQUE_CONFIG', { configurable: true, get: () => cfg, set: (v) => { cfg = Object.assign(v, { contact: '', payUrl: '', login: false }, extra); } });
    }, (opts && opts.cfg) || {});
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    return { ctx, page };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('civique.v1') || '{}'));
  async function answer(page, right) {
    const stem = (await page.locator('.stem').first().innerText()).trim();
    const good = answers.get(stem);
    if (!good) throw new Error('no answer known for: ' + stem);
    const opts = page.locator('.opts .opt');
    const n = await opts.count();
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).locator('.fr').innerText()).trim();
      if ((t === good) === right) { await opts.nth(i).click(); return; }
    }
    throw new Error('option not found');
  }

  // ---- 1. first visit, choose the card
  console.log('first visit');
  let { ctx, page } = await fresh();
  await page.goto(base);
  await page.waitForSelector('[data-a="target"]');
  check('asks which exam on first visit, with every exam the bank has', await page.locator('text=你准备申请哪一种').count() === 1 && await page.locator('[data-a="target"]').count() === Object.keys(free.meta.counts).length);
  check('no sideways scroll at 390px', await noOverflow(page));
  await shot(page, '01-choose');
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  check('home shows five themes', await page.locator('.theme').count() === 5);
  check('locked: shows the unlock offer', await page.locator('.pay').count() === 1);
  await shot(page, '02-home');

  // ---- 2. practice: right and wrong answers
  console.log('practice');
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  check('practice opens a question with 4 options', await page.locator('.opts .opt').count() === 4);
  check('no Chinese before asking', await page.locator('.stemz').count() === 0);
  await page.locator('[data-a="zh"]').click();
  check('Chinese shows on request', await page.locator('.stemz').count() === 1);
  await shot(page, '03-question');
  check('next is disabled before answering', await page.locator('[data-a="next"]').isDisabled());
  await answer(page, true);
  check('right answer is marked', await page.locator('.opt.right').count() === 1 && await page.locator('.opt.wrong').count() === 0);
  check('explanation is shown', await page.locator('.copy.good').count() === 1);
  check('no sideways scroll with explanation', await noOverflow(page));
  await shot(page, '04-right');
  await page.locator('[data-a="next"]').click();
  check('Chinese stays on for the next question', await page.locator('.stemz').count() === 1);
  await page.locator('[data-a="zh"]').click();
  check('Chinese can be switched off again', await page.locator('.stemz').count() === 0);
  await answer(page, false);
  check('wrong answer is marked with the right one', await page.locator('.opt.wrong').count() === 1 && await page.locator('.opt.right').count() === 1);
  check('explanation names the right letter', /正确答案是\s*[ABCD]/.test(await page.locator('.copy.miss .ans').innerText()) && /答错了/.test(await page.locator('.copy.miss h3').innerText()));
  await shot(page, '05-wrong');
  let st = await state(page);
  check('progress is saved', Object.keys(st.stats).length === 2);
  const kinds = st.sess.ids.map((id) => (id[0] === 'S' ? 's' : 'c'));
  check('a practice set mixes knowledge and situational questions', kinds.includes('s') && kinds.includes('c') && kinds[0] === 'c', kinds.join(''));
  await page.reload();
  await page.waitForSelector('.stem');
  check('after reload the session resumes on the same question', await page.locator('.copy.miss').count() === 1);
  // finish the set
  for (let i = 0; i < 12; i++) { await page.locator('[data-a="next"]').click(); if (await page.locator('.stem').count() === 0) break; await answer(page, true); }
  await page.waitForSelector('.hero');
  check('set summary appears', await page.locator('text=这一组做完了').count() === 1);
  await shot(page, '06-set-done');

  // ---- 3. mistakes list
  console.log('mistakes');
  await page.goto(base + '#mistakes');
  await page.waitForSelector('.qlist');
  check('the wrong question is in the mistakes list', await page.locator('.qlist .qrow').count() === 1);
  await page.locator('.qlist .qrow').first().click();
  check('mistake opens with explanation', await page.locator('.detail .copy').count() === 1);
  await shot(page, '07-mistakes');
  await page.locator('[data-a="start"][data-v="all|wrong"]').click();
  await page.waitForSelector('.qbar .back');
  await answer(page, true);
  st = await state(page);
  const wrongId = Object.keys(st.stats).find((k) => st.stats[k][3] > 0);
  check('one right answer is not enough to leave the list', !!wrongId && st.stats[wrongId][3] === 1);

  // ---- 4. trial exam (locked)
  console.log('trial exam');
  await page.goto(base + '#exam');
  await page.waitForSelector('[data-a="exam-start"]');
  await shot(page, '08-exam-intro');
  await page.locator('[data-a="exam-start"]').click();
  await page.waitForSelector('#timer');
  st = await state(page);
  check('trial exam has 10 questions', st.exam && st.exam.ids.length === 10, st.exam && String(st.exam.ids.length));
  check('exam shows no Chinese and no speech button', await page.locator('.stemz').count() === 0 && await page.locator('[data-a="zh"]').count() === 0);
  await page.goto(base + '#home');
  await page.waitForSelector('#timer');
  check('cannot leave a running exam by changing page', await page.locator('#timer').count() === 1);
  for (let i = 0; i < 10; i++) {
    await answer(page, i < 8);
    if (i === 0) { check('chosen option is highlighted, no feedback', await page.locator('.opt.sel').count() === 1 && await page.locator('.copy').count() === 0); await shot(page, '09-exam-question'); }
    if (i < 9) await page.locator('[data-a="exam-next"]').click();
  }
  await page.locator('[data-a="exam-grid"]').click();
  check('number grid shows 10 answered', await page.locator('.grid40 button.done').count() === 10);
  await shot(page, '10-exam-grid');
  await page.locator('.sheet [data-a="exam-submit"]').click();
  await page.locator('[data-a="exam-submit-yes"]').click();
  await page.waitForSelector('.verdict-line');
  check('result shows 8 / 10 and pass', (await page.locator('.big').innerText()).replace(/\s+/g, '') === '8/10' && await page.locator('.verdict-line.pass').count() === 1, await page.locator('.big').innerText());
  check('no sideways scroll on the result', await noOverflow(page));
  await shot(page, '11-result');
  await page.locator('.qlist .qrow').nth(9).click();
  check('result row opens with the explanation', await page.locator('.detail .copy.miss').count() === 1);

  // ---- 5. timer runs out
  await page.goto(base + '#exam');
  await page.locator('[data-a="exam-start"]').click();
  await page.waitForSelector('#timer');
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.exam.start = Date.now() - (s.exam.dur + 5) * 1000; localStorage.setItem('civique.v1', JSON.stringify(s)); });
  await page.reload();
  await page.waitForSelector('.verdict-line', { timeout: 5000 });
  check('exam is handed in when time runs out', await page.locator('.verdict-line.fail').count() === 1);

  // ---- 6. other pages
  console.log('other pages');
  await page.goto(base + '#words');
  await page.waitForSelector('.words');
  check('word list renders', await page.locator('.words li').count() > 3);
  check('no sideways scroll on words', await noOverflow(page));
  await shot(page, '12-words');
  await page.goto(base + '#about');
  await page.waitForSelector('.faq');
  check('about page renders', await page.locator('.faq details').count() >= 5 && await page.locator('.faq .nums li').count() === 3 && await page.locator('main .list a[href^="https://"]').count() === 5);
  await shot(page, '13-about');
  // study cards (locked)
  await page.goto(base + '#cards');
  await page.waitForSelector('main');
  if (free.cards && free.cards.length) {
    const openable = free.cards.filter((c) => !c.x).length, lockedCards = free.cards.length - openable;
    check('study cards: every card is listed', await page.locator('.kmini').count() === free.cards.length);
    await page.locator('.kmini:not(.lk)').first().click();
    check('a free study card opens with its points and the official sheet link', await page.locator('.kc .facts li').count() >= 3 && await page.locator('.kc a[href^="https://formation-civique"]').count() >= 1);
    check('no sideways scroll on an open study card', await noOverflow(page));
    await shot(page, '22-cards');
    if (lockedCards) {
      await page.locator('.kmini.lk').first().click();
      await page.locator('.kc.lk [data-a="locked"]').click();
      check('a locked study card offers to unlock', await page.locator('.sheet [data-a="goto"][data-v="unlock"]').count() === 1);
      await page.locator('.sheet [data-a="close"]').click();
    }
  } else check('study cards: says they are being prepared', await page.locator('text=正在整理中').count() === 1);
  await page.goto(base + '#recall');
  await page.waitForSelector('main');
  if (!(free.recall || []).length) check('recollections: honest empty state when none are collected', await page.locator('text=还没有收录').count() === 1);
  await shot(page, '23-recall-real');

  await page.goto(base + '#unlock');
  await page.waitForSelector('#code');
  await shot(page, '14-unlock');
  await page.fill('#code', 'ABCD-2345');
  await page.locator('#codeform button').click();
  await page.waitForSelector('.msg.bad');
  check('short code gives a clear message', /12 位/.test(await page.locator('.msg.bad').innerText()));
  await page.fill('#code', 'ABCD-2345-EFGH');
  await page.locator('#codeform button').click();
  await page.waitForFunction(() => /不对或已失效/.test((document.querySelector('.msg.bad') || {}).textContent || ''), null, { timeout: 15000 });
  check('unknown code is refused', true);
  await ctx.close();

  // ---- 7. unlock
  if (CODE) {
    console.log('unlock');
    ({ ctx, page } = await fresh());
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="cr"]').click();
    await page.goto(base + '#unlock');
    await page.fill('#code', CODE.toLowerCase().replace(/-/g, ' '));
    await page.locator('#codeform button').click();
    await page.waitForSelector('text=已解锁全部题目', { timeout: 20000 });
    check('unlock with a valid code (typed in lower case with spaces)', true);
    await shot(page, '15-unlocked');
    await page.goto(base + '#home');
    await page.waitForSelector('.themes');
    check('home says unlocked and hides the offer', await page.locator('.pay').count() === 0 && /已解锁/.test(await page.locator('.st-done').innerText()));
    if (free.cards && free.cards.length) {
      await page.goto(base + '#cards');
      await page.waitForSelector('.kmini');
      check('unlocked: every study card can be opened', await page.locator('.kmini.lk, .kc.lk, .kc [data-a="locked"]').count() === 0 && await page.locator('.kmini').count() === free.cards.length && await page.locator('.kc .facts li').count() >= 3);
      await page.goto(base + '#home');
      await page.waitForSelector('.themes');
    }
    await page.reload();
    await page.waitForSelector('.themes');
    check('still unlocked after reload', await page.locator('.pay').count() === 0);
    await page.goto(base + '#exam');
    await page.locator('[data-a="exam-start"][data-v="full"]').click();
    await page.waitForSelector('#timer');
    st = await state(page);
    const ids = st.exam.ids;
    const by = (p) => ids.filter((id) => id.startsWith(p)).length;
    check('full exam has 40 different questions', ids.length === 40 && new Set(ids).size === 40);
    check('full exam follows the official split (11 / 6 / 11 / 8 / 4, 12 situational)',
      by('P') === 5 && by('S') === 12 && by('I') === 6 && by('D') === 5 && by('H') === 8 && by('V') === 4,
      [by('P'), by('S'), by('I'), by('D'), by('H'), by('V')].join(','));
    check('timer starts at 45 minutes', /^4[45]:/.test(await page.locator('#timer').innerText()));
    if (free.meta.counts.nat) {
      await page.locator('[data-a="exam-quit"]').click();
      await page.locator('[data-a="exam-quit-yes"]').click();
      await page.goto(base + '#me');
      await page.locator('[data-a="target"][data-v="nat"]').click();
      await page.goto(base + '#exam');
      await page.locator('[data-a="exam-start"][data-v="full"]').click();
      await page.waitForSelector('#timer');
      st = await state(page);
      check('the naturalisation exam also has 40 different questions', st.exam.ids.length === 40 && new Set(st.exam.ids).size === 40, String(st.exam.ids.length));
      await page.locator('[data-a="exam-quit"]').click();
      await page.locator('[data-a="exam-quit-yes"]').click();
      await page.goto(base + '#me');
      await page.locator('[data-a="target"][data-v="cr"]').click();
      await page.goto(base + '#exam');
      await page.locator('[data-a="exam-start"][data-v="full"]').click();
      await page.waitForSelector('#timer');
    }
    for (let i = 0; i < 40; i++) { await answer(page, i % 5 !== 0); if (i < 39) await page.locator('[data-a="exam-next"]').click(); }
    await page.locator('[data-a="exam-submit"]').click();
    await page.locator('[data-a="exam-submit-yes"]').click();
    await page.waitForSelector('.verdict-line');
    check('full exam result is 32 / 40, pass', (await page.locator('.big').innerText()).replace(/\s+/g, '') === '32/40' && await page.locator('.verdict-line.pass').count() === 1, await page.locator('.big').innerText());
    await shot(page, '16-result-full');

    // history, theme sheet, restart, reset (still unlocked)
    await page.goto(base + '#exam');
    await page.waitForSelector('[data-a="exam-start"]');
    check('past results are listed', await page.locator('[data-a="result-show"]').count() === 1);
    await page.locator('[data-a="exam-start"][data-v="full"]').click();
    await page.waitForSelector('#timer');
    await page.locator('[data-a="exam-quit"]').click();
    await page.locator('[data-a="exam-quit-yes"]').click();
    await page.waitForSelector('[data-a="exam-start"]');
    st = await state(page);
    check('an abandoned exam leaves no result', st.exam === null && st.exams.length === 1);
    await page.goto(base + '#home');
    await page.waitForSelector('.themes');
    await page.locator('.theme[data-v="droits"]').click();
    await page.locator('[data-a="start"][data-v="droits|situ"]').click();
    await page.waitForSelector('.stem');
    st = await state(page);
    check('"situational only" gives only situational questions', st.sess.ids.length === 10 && st.sess.ids.every((id) => id.startsWith('SD')), st.sess.ids.join(','));
    await page.goto(base + '#home');
    await page.waitForSelector('.themes');
    const before = Object.keys((await state(page)).stats).filter((id) => /^(I)\d/.test(id)).length;
    await page.locator('.theme[data-v="institutions"]').click();
    await page.locator('[data-a="restart"]').click();
    await page.locator('[data-a="restart-yes"]').click();
    await page.waitForSelector('.stem');
    st = await state(page);
    check('restarting a theme clears only that theme', before > 0 && Object.keys(st.stats).filter((id) => /^(I)\d/.test(id)).length === 0 && Object.keys(st.stats).length > 0);
    await page.goto(base + '#me');
    await page.locator('[data-a="reset"]').click();
    await page.locator('[data-a="reset-yes"]').click();
    st = await state(page);
    check('reset clears progress but keeps the unlock', Object.keys(st.stats).length === 0 && st.exams.length === 0 && !!st.unlock);
    // the stored key no longer opens the bank, the stored code still does
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.unlock.k = btoa('x'.repeat(32)); localStorage.setItem('civique.v1', JSON.stringify(s)); });
    await page.goto(base + '#home');
    await page.reload();
    await page.waitForSelector('.themes');
    check('a changed bank key is recovered from the stored code', await page.locator('.pay').count() === 0);
    // neither the key nor the code is valid any more
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.unlock.k = btoa('x'.repeat(32)); s.unlock.code = 'ABCD-2345-EFGH'; localStorage.setItem('civique.v1', JSON.stringify(s)); });
    await page.reload();
    await page.waitForSelector('.themes');
    check('a revoked code locks the bank again and says so', await page.locator('.pay').count() === 1 && await page.locator('text=解锁码已失效').count() === 1);
    await ctx.close();

    // the bank cannot be downloaded
    ({ ctx, page } = await fresh());
    await page.goto(base + '?code=' + CODE);
    await page.waitForSelector('text=已解锁全部题目', { timeout: 20000 });
    await page.goto(base + '#home');
    await page.locator('[data-a="target"][data-v="csp"]').first().click();
    await page.waitForSelector('.themes');
    await page.route('**/data/bank.json', (r) => r.abort());
    await page.reload();
    await page.waitForSelector('.themes');
    check('without the bank file the free questions still work and a notice explains', await page.locator('text=没有加载出来').count() === 1 && await page.locator('.theme').count() === 5);
    st = await state(page);
    check('the unlock is kept for the next visit', !!st.unlock);
    await ctx.close();

    // ---- online payment: back from the payment page with the id of the payment
    console.log('online payment');
    ({ ctx, page } = await fresh());
    await page.goto(base + '?paid=cs_live_PAID00000001');
    await page.waitForSelector('text=付款成功', { timeout: 20000 });
    st = await state(page);
    const issued = st.unlock.code;
    check('a paid payment unlocks by itself and gives a code', /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(issued) && st.pending === null, issued);
    check('the payment id is removed from the address bar', !/paid=/.test(page.url()), page.url());
    check('the code is shown to the buyer', (await page.locator('.code').innerText()).trim() === issued);
    await shot(page, '20-paid');
    await page.reload();
    await page.goto(base + '#home');
    await page.locator('[data-a="target"][data-v="csp"]').first().click();
    await page.waitForSelector('.themes');
    check('still unlocked after reload, without asking the payment service again', await page.locator('.pay').count() === 0);
    await ctx.close();

    ({ ctx, page } = await fresh());
    await page.goto(base + '#unlock');
    await page.fill('#code', issued);
    await page.locator('#codeform button').click();
    await page.waitForSelector('text=已解锁全部题目', { timeout: 20000 });
    check('the issued code unlocks another device', true);
    await ctx.close();

    ({ ctx, page } = await fresh());
    await page.goto(base + '#unlock');
    check('with a server, the email recovery is folded until asked for', !(await page.locator('#mail').isVisible()));
    await page.locator('#find-code summary').click();
    await page.fill('#mail', 'nobody@example.com');
    await page.locator('#mailform button').click();
    await page.waitForSelector('#mailform .msg.bad');
    check('an unknown email finds nothing', /没有找到/.test(await page.locator('#mailform .msg.bad').innerText()));
    await page.fill('#mail', ' Buyer@Example.com ');
    await page.locator('#mailform button').click();
    await page.waitForSelector('text=已解锁全部题目', { timeout: 20000 });
    st = await state(page);
    check('the payment email recovers the same code', st.unlock.code === issued, st.unlock.code);
    await ctx.close();

    ({ ctx, page } = await fresh());
    await page.goto(base + '?paid=cs_live_PROC00000001');
    await page.waitForSelector('[data-a="pay-retry"]');
    check('a payment still being processed says so and stays locked', /处理中/.test(await page.locator('.msg.bad').first().innerText()) && !(await state(page)).unlock);
    await shot(page, '21-pending');
    await page.reload();
    await page.waitForSelector('[data-a="pay-retry"]');
    check('the pending payment is remembered after a reload', (await state(page)).pending === 'cs_live_PROC00000001');
    SESSIONS.cs_live_PROC00000001.payment_status = 'paid';
    await page.locator('[data-a="pay-retry"]').click();
    await page.waitForSelector('text=付款成功', { timeout: 20000 });
    check('"confirm again" unlocks once the payment has gone through', !!(await state(page)).unlock);
    await ctx.close();

    for (const [id, why] of [['cs_live_FORGED000001', 'an invented payment id'], ['cs_test_PAID00000001', 'a test-mode payment'], ['cs_live_OTHER0000001', 'a payment for something else']]) {
      ({ ctx, page } = await fresh());
      await page.goto(base + '?paid=' + id);
      await page.waitForSelector('.msg.bad', { timeout: 20000 });
      st = await state(page);
      check(why + ' does not unlock', !st.unlock && st.pending === null, JSON.stringify(st.unlock));
      await ctx.close();
    }
    {
      const call = async (body, env) => (await core.handle(new Request('http://x/api/unlock', { method: 'POST', body: JSON.stringify(body) }), env || ENV, stripeStandIn));
      const bare = issued.replace(/-/g, '');
      const forged = bare.slice(0, 11) + (bare[11] === '2' ? '3' : '2');
      check('a code with one wrong character is refused by the function', (await call({ code: forged })).status === 404);
      check('a revoked code is refused', (await call({ code: issued }, Object.assign({}, ENV, { REVOKED: 'AAAA-BBBB-CCCC, ' + issued }))).status === 403);
      check('the function refuses to work without its settings', (await call({ code: issued }, {})).status === 503);
      check('a wrong Stripe key is reported as a service problem, not as "unpaid"', (await call({ session: 'cs_live_PAID00000001' }, Object.assign({}, ENV, { STRIPE_KEY: 'rk_wrong' }))).status === 502);
      const leak = await (await call({ session: 'cs_live_FORGED000001' })).text();
      check('refusals never contain the bank key', !leak.includes(ENV.CONTENT_KEY));
    }

    ({ ctx, page } = await fresh());
    await page.goto(base + '?code=' + CODE);
    await page.waitForSelector('text=已解锁全部题目', { timeout: 20000 });
    check('payment redirect with ?code= unlocks', true);
    check('the code is removed from the address bar', !/code=/.test(page.url()), page.url());
    await ctx.close();
  } else console.log('unlock checks skipped (no CIVIQUE_CODE)');

  // ---- recollections: the page with data (two sessions injected into the free file)
  console.log('recollections');
  {
    const ids = free.qs.filter((q) => q.l.includes('csp')).slice(0, 3).map((q) => q.id);
    const stem = (id) => free.qs.find((q) => q.id === id);
    const item = (id) => ({ r: id, q: stem(id).q, k: stem(id).k, t: stem(id).t });
    const fake = [
      { w: '2026-10', l: 'cr', n: '知识题基本都在官方清单里。', i: [item(ids[0]), item(ids[1]), { r: 'ZZZ999', q: 'Question que cet appareil ne peut pas ouvrir ?', k: 'c', t: 'droits' }, { x: '情景题：邻居半夜吵闹，问应该怎么做', k: 's', t: 'droits' }] },
      { w: '2026-09', l: 'csp', n: '', i: [item(ids[0]), item(ids[2])] },
    ];
    ({ ctx, page } = await fresh());
    await page.route('**/data/free.json', async (route) => {
      const res = await route.fetch(); const body = await res.json(); body.recall = fake;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.goto(base + '#recall');
    await page.waitForSelector('.qlist');
    const txt = await page.locator('main').innerText();
    check('recollections are grouped by exam month, newest first', txt.indexOf('2026 年 10 月') > 0 && txt.indexOf('2026 年 10 月') < txt.indexOf('2026 年 9 月'));
    check('each exam session can be folded', await page.locator('.crow[data-a="sess"]').count() === 2);
    check('recollections say where they come from and that they are not official', /来源于网络/.test(txt) && /不是官方/.test(txt));
    check('recollections show no account, link or name', !/@|https?:\/\/(?!formation-civique)|小红书/.test(txt));
    check('questions reported twice are counted', (await page.locator('.rc-hot').innerText()).replace(/\s+/g, '') === '1提到2次以上');
    await page.locator('.qlist .qrow[data-a="open"]').first().click();
    check('a recalled question opens with the answer and the explanation', await page.locator('.detail .copy.plain').count() === 1 && await page.locator('.detail .opt.right').count() === 1);
    check('a recalled question outside the free sample is shown as locked', await page.locator('.qrow[data-a="locked"]').count() === 1);
    check('no sideways scroll on the recollections page', await noOverflow(page));
    await shot(page, '24-recall');
    await page.locator('[data-a="start"][data-v="all|recall"]').click();
    await page.waitForSelector('.qbar .back');
    st = await state(page);
    check('"practise these" starts with the most reported question', st.sess.mode === 'recall' && st.sess.ids[0] === ids[0] && st.sess.ids.length === 3, JSON.stringify(st.sess.ids));
    await ctx.close();
  }

  // ---- offline: after one visit the app opens without a network
  console.log('offline');
  ({ ctx, page } = await fresh({ serviceWorkers: 'allow' }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('.themes');
  await page.waitForTimeout(500);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('.themes', { timeout: 10000 });
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  check('the app opens and a practice set starts without a network', await page.locator('.opts .opt').count() === 4);
  await ctx.setOffline(false);
  await ctx.close();

  // ---- 8. wide screen and dark theme
  // ---- 考前一页: the free cram sheet (data/sheet.json)
  console.log('cram sheet');
  const sheet = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'sheet.json'), 'utf8'));
  const sheetItems = sheet.groups.reduce((a, g) => a.concat(g.items), []);
  const sheetText = JSON.stringify(sheet);
  check('sheet.json: 50 to 90 items, each with a key and a meaning, no addresses or links',
    sheetItems.length >= 50 && sheetItems.length <= 90 && sheetItems.every((it) => it.k && it.k.trim() && it.v && it.v.trim()) &&
    sheet.groups.every((g) => g.id && g.title && g.items.length >= 4 && g.items.length <= 8) && sheet.rule.points.length >= 4 && !/@|https?:|www\./i.test(sheetText), String(sheetItems.length));
  ({ ctx, page } = await fresh());
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="cr"]').click();
  await page.waitForSelector('.themes');
  await page.locator('.tabs a[href="#cards"]').click();
  await page.waitForSelector('.seg a[href="#sheet"]');
  await page.locator('.seg a[href="#sheet"]').click();
  await page.waitForSelector('.sh-card');
  check('the sheet opens from the switch on the cards page, free, with 速记 still highlighted',
    await page.locator('.seg a[href="#sheet"][aria-current="page"]').count() === 1 && await page.locator('.tabs a[href="#cards"][aria-current="page"]').count() === 1 &&
    await page.locator('.sheetpage .pay, .sheetpage [data-a="locked"]').count() === 0 && await page.locator('.sheetpage .foot').count() === 1 && await page.locator('.sheetpage a[href="#home"]').count() === 1);
  // a group is a card, a row of tiles or a drawing: whatever it is, its title and every key, meaning and French term are in the text of the page
  const squash = (s) => String(s).replace(/\s+/g, '');
  const shown = await page.evaluate(() => ({ text: document.querySelector('.sheetpage').textContent.replace(/\s+/g, ''), groups: [...new Set([...document.querySelectorAll('.sheetpage [data-g]')].map((e) => e.dataset.g))] }));
  const notShown = [];
  sheet.groups.forEach((g) => { [g.title].concat(...g.items.map((it) => [it.k, it.v, it.fr || ''])).forEach((x) => { if (!shown.text.includes(squash(x))) notShown.push(x); }); });
  check('every group and item of sheet.json is on the page, and the scenario rule too',
    notShown.length === 0 && JSON.stringify(shown.groups.slice().sort()) === JSON.stringify(sheet.groups.map((g) => g.id).sort()) &&
    await page.locator('.sh-rule ol li').count() === sheet.rule.points.length && (await page.locator('.sh-rule p').innerText()) === sheet.rule.lead &&
    (await page.locator('.sh-exam').innerText()).replace(/\s+/g, ' ').includes('40') && await page.locator('.sheetpage .k.hl, .tl-row .v-hl').count() === sheetItems.filter((it) => it.hl).length, notShown.join(' | '));
  check('no sideways scroll on the sheet', await noOverflow(page));
  await shot(page, '27-sheet');
  await page.goto(base + '#home');
  await page.locator('[data-a="theme"][data-v="principes"]').click();
  await page.locator('.sheet [data-a="goto"][data-v="sheet"]').click();
  await page.waitForSelector('.sh-rule');
  check('a theme with scenario questions links to the rule on the sheet', await page.locator('.veil').count() === 0);
  await ctx.close();
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base + '#sheet');
  await page.waitForSelector('.sh-card');
  check('the sheet opens directly before any exam type is chosen, no sideways scroll at 320px', await noOverflow(page) && await page.locator('.sh-card, .sh-tiles, .sh-fig[data-g]').count() === sheet.groups.length);
  await page.goto(base + '#home');
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.locator('.tabs a[href="#practice"]').click();
  await page.waitForSelector('.hub-grid a[href="#sheet"]');
  check('the practice hub links to the sheet and still fits at 320px', await noOverflow(page) && await page.evaluate(() => [...document.querySelectorAll('.hub-tile')].every((a) => a.scrollWidth <= a.clientWidth + 1)));
  await shot(page, '28-sheet-320');
  await ctx.close();

  // ---- exam date, daily goal and the readiness estimate on the home screen
  console.log('plan and readiness');
  ({ ctx, page } = await fresh({ viewport: { width: 390, height: 800 } }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  const dayIso = (n) => page.evaluate((k) => { const d = new Date(); d.setDate(d.getDate() + k); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }, n);
  const flat = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, '');
  const openCsp = free.qs.filter((q) => q.l.includes('csp'));
  const allCsp = Object.values(free.meta.counts.csp).reduce((a, m) => a + m.c + m.s, 0);
  check('a new user sees an invitation instead of a readiness number, and a default daily goal',
    await page.locator('.rd.rd-empty').count() === 1 && await page.locator('.rd-num').count() === 0 && /做几组题之后/.test(await page.locator('.rd').innerText()) && !/\d/.test(await page.locator('.rd').innerText()) &&
    await flat('.goal .num') === '0/20题' && /设日期/.test(await page.locator('.count[data-a="plan-edit"]').innerText()) && (await page.locator('.rd').innerText()).includes('估算，不是保证'), await flat('.goal'));
  check('ring, main button and readiness fit a 390x800 phone without scrolling', await page.evaluate(() => {
    const top = document.querySelector('.tabs').getBoundingClientRect().top;
    return ['.ring', '[data-a="continue"]', '.rd'].every((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= top; });
  }));
  await page.locator('[data-a="plan-edit"]').click();
  await page.locator('#examdate').fill(await dayIso(3));
  await page.locator('#planform button[type="submit"]').click();
  const goal = Math.min(openCsp.length, Math.max(10, Math.min(60, Math.ceil(openCsp.length / 3))));
  st = await state(page);
  check('setting the exam date shows the days left and a daily goal computed from the questions that are open',
    st.examDate === await dayIso(3) && await page.locator('.veil').count() === 0 && (await page.locator('.count b').innerText()).trim() === '3' && await flat('.goal .num') === '0/' + goal + '题', await flat('.goal'));
  await page.locator('.count').click();
  check('the date sheet says how much is left to master and how much is locked', (await flat('.plan-note')).includes('另有' + (allCsp - openCsp.length) + '题解锁后才能练') && await page.locator('#examdate').inputValue() === st.examDate, await flat('.plan-note'));
  await page.locator('.sheet [data-a="close"]').click();
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  await answer(page, true);
  await page.locator('[data-a="next"]').click();
  await answer(page, false);
  await page.goto(base + '#home');
  await page.waitForSelector('.themes');
  st = await state(page);
  check('answers given in practice count toward today', await flat('.goal .num') === '2/' + goal + '题' && JSON.stringify(st.days[await dayIso(0)]) === '[2,1]', await flat('.goal .num') + ' ' + JSON.stringify(st.days));
  // the estimate, computed here from the saved state: quota x (share mastered + share not mastered x 25%), knowledge and situational apart
  const known = openCsp.filter((q, i) => i % 3 !== 2);
  await page.evaluate((ids) => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.stats = {}; s.sess = null; ids.forEach((id) => { s.stats[id] = [1, 1, 1, 0, 1]; }); localStorage.setItem('civique.v1', JSON.stringify(s)); }, known.map((q) => q.id));
  await page.reload();
  await page.waitForSelector('.rd-num');
  const QUOTA = { principes: [5, 6], institutions: [6, 0], droits: [5, 6], histoire: [8, 0], societe: [4, 0] };
  let est = 0;
  for (const t of Object.keys(QUOTA)) ['c', 's'].forEach((kind, i) => {
    const total = free.meta.counts.csp[t][kind];
    const share = total ? known.filter((q) => q.t === t && q.k === kind).length / total : 0;
    est += QUOTA[t][i] * (share + (1 - share) * 0.25);
  });
  await page.locator('[data-a="rd-how"]').click();
  const rdText = await flat('.rd') + await flat('.rd-how');
  check('the readiness number is the documented estimate, labelled as an estimate and honest about locked questions',
    (await page.locator('.rd-num b').innerText()).trim() === String(Math.round(est)) && (await page.locator('.rd-state').innerText()).trim() === (Math.round(est) >= 32 ? '可以去考' : Math.round(est) >= 28 ? '接近' : '还不够') &&
    rdText.includes('估算，不是保证') && rdText.includes('按全部' + allCsp + '题算；解锁前只能练其中' + openCsp.length + '题'), rdText + ' / expected ' + est);
  check('the estimate explains how it is computed, behind a tap on the tile', /25%/.test(await page.locator('.rd-how').innerText()) && await page.locator('.rd-how li').count() === 5 && (await page.locator('.rd .bar .pass').getAttribute('style')).includes('80%') && /32/.test(await page.locator('.rd .cap').innerText()));
  await page.locator('.sheet [data-a="close"]').click();
  const weak = await page.locator('.rd-weak [data-a="start"]').getAttribute('data-v');
  await page.locator('.rd-weak [data-a="start"]').click();
  await page.waitForSelector('.stem');
  st = await state(page);
  check('the weakest theme can be practised from the estimate', st.sess.theme === weak.split('|')[0] && st.sess.ids.every((id) => !known.some((q) => q.id === id)), weak);
  // a mock exam result links to the estimate; the date can be cleared; a date in the past asks to be updated
  const past = await dayIso(-2);
  await page.evaluate((d) => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.sess = null; s.examDate = d; s.exams = [{ ts: Date.now(), target: 'csp', mini: true, score: 8, n: 10, passAt: 8, secs: 90, th: { principes: [3, 3], institutions: [2, 2], droits: [1, 2], histoire: [1, 2], societe: [1, 1] }, items: [] }]; localStorage.setItem('civique.v1', JSON.stringify(s)); }, past);
  await page.goto(base + '#result');
  await page.reload();
  await page.waitForSelector('.rd-next');
  check('the result page names the weakest theme of the exam and offers to practise it', /权利与义务/.test(await page.locator('.rd-next .rd-th').innerText()) && (await page.locator('.rd-next .rd-est b').innerText()).trim() === String(Math.round(est)) && /估算，不是保证/.test(await page.locator('.rd-next .rd-est').innerText()) && await page.locator('.rd-next [data-a="start"]').getAttribute('data-v') === 'droits|todo');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(base + '#home');
  await page.waitForSelector('.themes');
  check('a date in the past asks to be changed, and the latest mock exam sits next to the estimate', /已过/.test(await page.locator('.count.late').innerText()) && await flat('.goal .num') === '2/' + Math.min(20, openCsp.length - known.length + 1) + '题' && (await page.locator('.hero-fact b').innerText()).trim() === '8/10');
  await page.locator('.count').click();
  check('no sideways scroll at 320px with the date form open', /已经过了/.test(await page.locator('.sheet').innerText()) && await page.locator('#examdate').count() === 1 && await page.locator('#examdate').getAttribute('min') === await dayIso(0) && await noOverflow(page));
  await page.locator('.sheet [data-a="plan-clear"]').click();
  st = await state(page);
  check('the exam date can be cleared', st.examDate === '' && await page.locator('.count.late').count() === 0 && /设日期/.test(await page.locator('.count[data-a="plan-edit"]').innerText()) && await noOverflow(page));
  await shot(page, '31-home-plan-320');
  await ctx.close();

  // ---- registering for the real exam: steps and the centre finder
  console.log('do I have to take it');
  ({ ctx, page } = await fresh());
  await page.goto(base);
  await page.locator('.wl-check').click();
  await page.waitForSelector('.chk-opt');
  check('self-check is reachable from the welcome screen without choosing an exam', await page.locator('.chk-opt').count() === 5 && Object.keys(await state(page)).indexOf('target') < 0 || !(await state(page)).target);
  const pickPath = async (labels) => { await page.goto(base + '#about'); await page.goto(base + '#check'); if (await page.locator('.chk-said li').count()) await page.locator('[data-a="chk-back"][data-v="0"]').first().click(); for (const l of labels) await page.locator('.chk-opt', { hasText: l }).first().click(); await page.waitForSelector('.chk-res'); return { cls: await page.locator('.chk-res').getAttribute('class'), text: await page.locator('.chk-res').innerText() }; };
  let cr = await pickPath(['续签']);
  check('renewal: no exam', /\bno\b/.test(cr.cls) && /续签不需要/.test(cr.text), cr.text.slice(0, 60));
  cr = await pickPath(['多年居留卡', '未满 65', '学生']);
  check('student applying for a multi-year card: no exam', /\bno\b/.test(cr.cls));
  cr = await pickPath(['多年居留卡', '未满 65', '工薪', '没有']);
  check('employee who never studied in France: must take the multi-year exam', /\byes\b/.test(cr.cls) && /多年居留卡的考试/.test(cr.text) && await page.locator('[data-a="chk-go"][data-v="csp"]').count() === 1);
  cr = await pickPath(['多年居留卡', '未满 65', '私人和家庭生活', '上过']);
  check('studied in France: answer is "probably not, confirm", never a flat yes or no', /\bmaybe\b/.test(cr.cls) && /确认/.test(cr.text));
  cr = await pickPath(['十年居留卡', '已满 65']);
  check('over 65 applying for a resident card: no exam', /\bno\b/.test(cr.cls));
  cr = await pickPath(['十年居留卡', '未满 65', '住满 5 年']);
  check('five years of residence: must take the resident-card exam', /\byes\b/.test(cr.cls) && await page.locator('[data-a="chk-go"][data-v="cr"]').count() === 1);
  cr = await pickPath(['申请入籍', '以声明方式']);
  check('nationality by declaration: no exam', /\bno\b/.test(cr.cls));
  cr = await pickPath(['申请入籍', '申请入籍，或恢复']);
  check('naturalisation by decree: must take the naturalisation exam', /\byes\b/.test(cr.cls) && /入籍的考试/.test(cr.text));
  check('every answer cites an official page and says it is not legal advice', await page.locator('.chk-src a[href^="https://www.service-public.gouv.fr/"]').count() >= 1 && /不是法律意见/.test(await page.locator('main').innerText()));
  await page.locator('[data-a="chk-go"]').click();
  await page.waitForSelector('.themes');
  check('"start practising" sets the matching exam', (await state(page)).target === 'nat');
  await page.goto(base + '#check');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('[data-a="chk-back"][data-v="0"]').first().click();
  await page.locator('.chk-opt', { hasText: '多年居留卡' }).first().click();
  await page.locator('.chk-opt', { hasText: '未满 65' }).first().click();
  await page.waitForSelector('.chk-opt');
  check('no sideways scroll at 320px on the self-check', await noOverflow(page));
  await shot(page, '27-check-320');
  await ctx.close();

  // ---- 考前一页: the drawings (three powers, timeline, map), at the narrowest width
  console.log('sheet drawings');
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base + '#sheet');
  await page.waitForSelector('#fig-map .sh-svg');
  const yearOf = (it) => { const m = /^(\d{4})(?:–\d{4})?$/.exec(it.k); return m && Number(m[1]) >= 1000 && Number(m[1]) <= 2100 ? Number(m[1]) : (it.t || 0); };
  const dated = sheetItems.filter(yearOf);
  const tlRows = await page.evaluate(() => [...document.querySelectorAll('#fig-tl .tl-row')].map((g) => ({ t: Number(g.dataset.t), s: g.textContent.replace(/\s+/g, '') })));
  check('the timeline shows every dated item of the sheet, in chronological order',
    dated.length >= 12 && tlRows.length === dated.length && tlRows.every((r, i) => !i || tlRows[i - 1].t <= r.t) &&
    dated.every((it) => tlRows.some((r) => r.t === yearOf(it) && r.s.includes((it.t ? it.tl : it.k + it.v).replace(/\s+/g, '')))), JSON.stringify(tlRows.map((r) => r.t)));
  const geo = sheet.map, geoPlaces = [].concat(geo.seas, geo.lands, geo.cities, geo.rivers, geo.mounts, geo.tops, geo.isles);
  const geoNames = geoPlaces.map((l) => l.k).concat(...geo.dom.map((g) => g.items.map((it) => it.k)));
  const onMap = await page.evaluate(() => ({ land: document.querySelector('#fig-map path.v-land').getAttribute('d'), coast: document.querySelector('#fig-map path.v-coast').getAttribute('d'),
    names: [...document.querySelectorAll('#fig-map text[data-k]')].map((x) => x.dataset.k), rivers: document.querySelectorAll('#fig-map path.v-river').length }));
  check('the map has the outline of France and every geography label, each one tied to a question or a study card',
    onMap.land === geo.land && (geo.land.match(/l/g) || []).length > 150 && onMap.coast === geo.coast && onMap.rivers === geo.rivers.length && geoNames.length >= 30 &&
    geoNames.every((k) => onMap.names.includes(k)) && geoPlaces.concat(geo.dom).every((l) => /^[HI]\d{3}$|^K-CK\d-\d\d$/.test(l.s)) && JSON.stringify(geo).length < 12000,
    geoNames.filter((k) => !onMap.names.includes(k)).join(' '));
  const instText = (await page.locator('#fig-inst .sh-svg').textContent()).replace(/\s+/g, '');
  check('the three powers are drawn with 577 deputies, 348 senators and who appoints whom',
    ['577', '348', '立法权', '行政权', '司法权', '表决法律', '执行法律', '审判', '任命', '选举', 'Assembléenationale', 'Sénat'].every((x) => instText.includes(x)) && await page.locator('#fig-inst .v-arrow').count() === 3, instText);
  const figFit = await page.evaluate(() => [...document.querySelectorAll('.sh-fig .sh-svg')].map((s) => s.getBoundingClientRect()).every((r) => r.left >= 0 && r.right <= window.innerWidth && r.width > 250));
  await page.locator('#fig-map .sh-zoom').click();
  await page.waitForSelector('.veil .sh-zoomed .v-map.big');
  const zoomed = await page.evaluate(() => { const z = document.querySelector('.sh-zoomed'); return { pan: z.scrollWidth > z.clientWidth + 50, fr: z.textContent.includes('la Manche') && z.textContent.includes('Marseille') }; });
  check('no sideways scroll at 320px with the drawings; the map opens larger with the French names', figFit && await noOverflow(page) && zoomed.pan && zoomed.fr && await page.locator('.sh-fig').count() === 3, JSON.stringify([figFit, zoomed]));
  await page.locator('.sheet [data-a="close"]').click();
  await shot(page, '28b-sheet-drawings-320');
  await ctx.close();

  console.log('registration page');
  ({ ctx, page } = await fresh({ geolocation: { latitude: 45.764, longitude: 4.8357 }, permissions: ['geolocation'] }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="cr"]').click();
  await page.waitForSelector('.themes');
  await page.locator('.tabs a[href="#me"]').click();
  await page.locator('main a[href="#register"]').click();
  await page.waitForSelector('.chips .chip');
  check('registration page lists the steps and names the chosen exam', await page.locator('.steps > li').count() === 7 && await page.locator('.steps >> text=十年居留卡').count() >= 1);
  await page.locator('.step-h').nth(2).click();
  check('booking links go to the two official organisers', await page.locator('a[href="https://test-civique.fr/inscription"]').count() === 1 && await page.locator('a[href="https://francais.cci-paris-idf.fr/candidat?produit=22"]').count() === 2);
  check('no sideways scroll on the registration page', await noOverflow(page));
  await page.locator('#cq').fill('69');
  await page.waitForSelector('.centre');
  const lyon = await page.locator('.centre .ca').allInnerTexts();
  check('a département number lists only that département', lyon.length > 0 && lyon.every((t) => /\b69\d{3}\b/.test(t)), lyon.join(' | '));
  check('typing keeps the cursor in the search box', await page.evaluate(() => document.activeElement && document.activeElement.id === 'cq'));
  await page.locator('#cq').fill('巴黎');
  await page.waitForFunction(() => [...document.querySelectorAll('.centre .ca')].every((e) => /\b75\d{3}\b/.test(e.textContent)) && document.querySelectorAll('.centre').length > 0);
  check('a Chinese city name works', true);
  await page.locator('#cq').fill('zzzz');
  await page.waitForSelector('#clist .note');
  check('nothing found: says so instead of an empty list', await page.locator('.centre').count() === 0);
  await page.locator('#cq').fill('');
  await page.locator('[data-a="geo"]').click();
  await page.waitForSelector('.centre .tag');
  const kms = (await page.locator('.centre .tag').allInnerTexts()).map((t) => parseFloat(t.replace(/[^\d.]/g, '')));
  const first = await page.locator('.centre .ca').first().innerText();
  check('"use my position" sorts by distance, nearest first', kms.length === 8 && kms.every((k, i) => i === 0 || k >= kms[i - 1]) && kms[0] < 10 && /\b69\d{3}\b/.test(first), kms.join(',') + ' ' + first);
  await page.locator('[data-a="cmore"]').click();
  check('"show the rest" opens the whole list', await page.locator('.centre').count() > 200);
  check('no sideways scroll with centres listed', await noOverflow(page));
  await shot(page, '25-register');
  await ctx.close();
  ({ ctx, page } = await fresh());
  await page.goto(base + '#register');
  await page.locator('[data-a="target"]').first().waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
  await ctx.close();
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  await page.goto(base + '#register');
  await page.waitForSelector('.chips .chip');
  await page.locator('[data-a="geo"]').click();
  await page.waitForSelector('.msg.bad');
  check('position refused: explains and keeps the search usable', await page.locator('#cq').count() === 1 && (await page.locator('.msg.bad').innerText()).length > 5);
  await page.locator('[data-a="cq"]').first().click();
  await page.waitForSelector('.centre');
  check('no sideways scroll at 320px with centres and five tabs', await noOverflow(page) && await page.locator('.tabs li').count() === 5);
  await shot(page, '26-register-320');
  await ctx.close();

  console.log('welcome');
  ({ ctx, page } = await fresh({ viewport: { width: 390, height: 800 } }));
  await page.goto(base);
  await page.waitForSelector('[data-a="target"]');
  const proofNums = await page.locator('.wl-proof li b').allInnerTexts();
  check('welcome shows the bank\'s own numbers', [free.meta.total, free.meta.cards, (free.recall || []).length, free.meta.free].filter((n) => n > 0).join() === proofNums.join(), proofNums.join());
  check('welcome says the recollections are not official and keeps the disclaimer', /不是官方/.test(await page.locator('.wl-proof-wrap').innerText()) && await page.locator('.foot').count() === 1);
  check('headline, numbers, and the first question with at least two options fit a 390x800 phone without scrolling', await page.evaluate(() => { const top = document.querySelector('.tabs').getBoundingClientRect().top, o = document.querySelectorAll('.wl-try .opt'); return o.length === 4 && document.querySelector('.wl-try .stem').getBoundingClientRect().top > 0 && o[1].getBoundingClientRect().bottom <= top; }));
  check('the choice of exam comes right after the first question', await page.evaluate(() => { const n = document.querySelector('.wl-try').nextElementSibling; return !!n && n.classList.contains('wl-next') && n.querySelectorAll('[data-a="target"]').length > 0; }));
  await shot(page, '27-welcome');
  // ---- home: progress ring, theme icons, best exam result
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  const csp = Object.values(free.meta.counts.csp).reduce((a, m) => a + m.c + m.s, 0);
  check('home ring starts empty and the mastered tile shows the total from the data', await page.locator('.ring .arc').count() === 0 && (await page.locator('.ring').getAttribute('aria-label')).replace(/\s+/g, '') === '今日目标：已完成0/20题' && (await page.locator('.st-done .num').innerText()).replace(/\s+/g, '') === '0/' + csp + '题' && await page.locator('.hero-fact').count() === 0, await page.locator('.ring').getAttribute('aria-label'));
  check('each theme has an icon in its own colour and the home actions fit at 320px', await page.locator('.theme .ti svg:not(.hx)').count() === 5 && await page.locator('.hero [data-a="continue"]').count() === 1 && await page.locator('.tabs a[href="#exam"]').count() === 1 &&
    new Set(await page.locator('.theme').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))).size === 5 && await page.locator('.pagehead a.lv[href="#me"]').count() === 1 && await noOverflow(page));
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  await answer(page, true);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.exams = [{ ts: 1, target: 'csp', mini: true, score: 9, n: 10, passAt: 8, th: {}, items: [] }, { ts: 2, target: 'csp', mini: false, score: 30, n: 40, passAt: 32, th: {}, items: [] }, { ts: 3, target: 'cr', mini: false, score: 39, n: 40, passAt: 32, th: {}, items: [] }]; localStorage.setItem('civique.v1', JSON.stringify(s)); });
  await page.goto(base + '#home');
  await page.reload();
  await page.waitForSelector('.themes');
  check('home ring counts a mastered question and the best full exam of this type is shown', await page.locator('.ring .arc').count() === 1 && (await page.locator('.st-done .num b').innerText()).trim() === '1' && (await page.locator('.hero-fact b').innerText()).trim() === '30/40' && await page.locator('.hero-fact b.pass').count() === 0, await page.locator('.hero-fact').innerText());
  console.log('offer');
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base + '#cards');
  await page.waitForSelector('.kmini');
  check('the compact offer also shows before an exam is chosen', await page.locator('.pay').count() === 1 && await page.locator('.pay a[href="#unlock"]').count() === 1 && (await page.locator('.pay-facts b').first().innerText()).trim() === String(free.meta.total));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  await page.goto(base + '#unlock');
  await page.waitForSelector('.gets');
  await page.locator('#cmp summary').click();
  await page.locator('#sample summary').click();
  await page.waitForSelector('.cmp');
  {
    const csp = free.meta.counts.csp, all = Object.values(csp).reduce((n, c) => n + c.c + c.s, 0), open = free.qs.filter((q) => q.l.includes('csp')).length;
    const cells = await page.locator('.cmp tbody tr').first().locator('td b').allInnerTexts();
    check('the offer compares the free trial with the full bank, counted from the data', cells.join('|') === open + '|' + all && (await page.locator('.gets .tile b').first().innerText()).trim() === String(free.meta.total), cells.join('|'));
    const stem = (await page.locator('.offer-sample .stem').innerText()).trim(), q = free.qs.find((x) => x.q === stem);
    const rightAt = await page.locator('.offer-sample .opt').evaluateAll((els) => els.findIndex((e) => e.classList.contains('right')));
    check('the offer shows one free question as an example, with its explanation, the right answer not first', !!q && q.k === 'c' && q.l.includes('csp') && rightAt > 0 && await page.locator('.offer-sample .opt.right').count() === 1 && (await page.locator('.offer-sample .copy').innerText()).includes(q.e));
  }
  check('no sideways scroll at 320px on the unlock page', await noOverflow(page) && await page.locator('#codeform').count() === 1);
  await shot(page, '27-unlock-320');
  await ctx.close();

  // ---- the stylesheet as a whole: a block left open would silently drop every rule after it
  {
    const css = fs.readFileSync(path.join(SITE, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    check('stylesheet braces are balanced', css.split('{').length === css.split('}').length);
    ({ ctx, page } = await fresh());
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    const ring = await page.locator('.ring').first().boundingBox();
    check('home: the progress ring is drawn at its styled size', ring && ring.width > 80 && ring.width < 180, JSON.stringify(ring));
    await ctx.close();
  }

  // ---- tap a French word of a question to see what it means
  console.log('word popup');
  {
    const dict = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'dict.json'), 'utf8')).w;
    const known = (w) => dict[w.toLowerCase().replace(/’/g, "'")];
    const openQuestion = async () => {
      await page.goto(base);
      await page.locator('[data-a="target"][data-v="csp"]').click();
      await page.waitForSelector('.themes');
      await page.locator('[data-a="continue"]').click();
      await page.waitForSelector('.stem');
    };
    ({ ctx, page } = await fresh());
    await openQuestion();
    const stemText = await page.locator('.stem').innerText();
    const q = free.qs.find((x) => x.q === stemText);
    const words = await page.locator('.stem .tw').allInnerTexts();
    check('the words of the question can be tapped and its text is unchanged', !!q && words.length > 1 && await page.locator('.opt .tw').count() === 0 && await page.locator('.tw-hint').count() === 1);
    const at = words.findIndex((w) => known(w));
    await page.locator('.stem .tw').nth(Math.max(0, at)).click();
    const pop = page.locator('.tw-pop');
    check('tapping a word shows its Chinese meaning', at >= 0 && await pop.count() === 1 && (await pop.locator('.tw-w').innerText()) === words[at] && (await pop.locator('.tw-zh').innerText()) === known(words[at])[0], words[at]);
    check('the hint goes away for good after the first tap', await page.locator('.tw-hint').count() === 0 && (await state(page)).tapped === 1);
    await page.keyboard.press('Escape');
    check('Escape closes the word note', await pop.count() === 0);
    await page.locator('.opts .opt .fr').first().click();
    const shown = (await page.locator('.opt .fr').allInnerTexts()).map((t) => t.trim()).sort().join('|');
    check('tapping an option before answering still answers, and then its words can be tapped too', await page.locator('.copy').count() === 1 && !!q && shown === q.o.slice().sort().join('|') && await page.locator('.opt .tw').count() > 0);
    await page.waitForTimeout(800);       // the page scrolls to the explanation after an answer
    await page.locator('.opt .tw').first().click();
    await page.locator('.opt .tw').last().click();
    check('only one word note at a time, inside the screen', await pop.count() === 1 && (await pop.locator('.tw-w').innerText()) === (await page.locator('.opt .tw').last().innerText()) && await pop.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight; }));
    await page.goto(base + '#exam');
    await page.locator('[data-a="exam-start"]').click();
    await page.waitForSelector('#timer');
    check('no tappable words and no word note in the mock exam', await page.locator('.stem').count() === 1 && await page.locator('.tw').count() === 0 && await pop.count() === 0);
    await ctx.close();
    ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
    await page.route('**/data/dict.json', (r) => r.abort());
    await openQuestion();
    await page.locator('.stem .tw').last().click();
    check('without the dictionary file a tap says so calmly, at 320px too', await page.locator('.tw-pop .tw-none').count() === 1 && await noOverflow(page));
    await ctx.close();
  }

  // ---- the dictionary covers every word of the free questions (the full bank is checked when the dictionary is built)
  {
    const dict = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'dict.json'), 'utf8')).w;
    const re = /([A-Za-zÀ-ÿœæŒÆ]+['’])|([A-Za-zÀ-ÿœæŒÆ]+(?:-[A-Za-zÀ-ÿœæŒÆ]+)*)/g;
    const missing = new Set();
    for (const q of free.qs) for (const t of [q.q].concat(q.o)) for (const m of t.match(re) || []) { const k = m.toLowerCase().replace('’', "'"); if (!dict[k]) missing.add(k); }
    check('dictionary has every French word of the free questions', missing.size === 0, [...missing].slice(0, 8).join(' '));
  }

  // ---- a question to answer on the first screen, the price on the buttons, the bank's date, reporting a mistake
  console.log('first question, price, report');
  {
    const price = (/price:\s*'([^']*)'/.exec(fs.readFileSync(path.join(SITE, 'config.js'), 'utf8')) || [])[1] || '';
    ({ ctx, page } = await fresh({ viewport: { width: 390, height: 800 } }));
    await page.goto(base);
    await page.waitForSelector('.wl-try .opt');
    const stem = (await page.locator('.wl-try .stem').innerText()).trim(), q = free.qs.find((x) => x.q === stem);
    const shown = (await page.locator('.wl-try .opt .fr').allInnerTexts()).map((t) => t.trim());
    check('welcome: one free official question of every exam can be answered in place, options not in stored order', !!q && q.k === 'c' && Object.keys(free.meta.counts).every((lv) => q.l.includes(lv)) && shown.length === 4 && shown.slice().sort().join('|') === q.o.slice().sort().join('|') && shown[0] !== q.o[0] && await page.locator('.wl-try button.opt[data-a="demo-pick"]').count() === 4 && await page.locator('.wl-try .copy').count() === 0);
    const before = JSON.stringify(await state(page));
    await page.locator('.wl-try .opt', { hasText: q.o[1] }).click();
    await page.waitForSelector('.wl-try .copy');
    const rightText = (await page.locator('.wl-try .opt.right .fr').innerText()).trim();
    check('welcome: answering marks right and wrong and shows the Chinese translation and explanation', rightText === q.o[0] && await page.locator('.wl-try .opt.wrong').count() === 1 && (await page.locator('.wl-try .copy').innerText()).includes(q.e) && (await page.locator('.wl-try .stemz').innerText()).trim() === q.qz && await page.locator('.wl-try .stem .tw').count() > 0, rightText);
    const after = await state(page);
    check('welcome: the answer is not a practice session and is not counted', JSON.stringify(after) === before && !after.sess && Object.keys(after.stats || {}).length === 0 && !after.target);
    await page.locator('[data-a="demo-next"]').click();
    await page.waitForFunction(() => { const r = document.querySelector('[data-a="target"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= document.querySelector('.tabs').getBoundingClientRect().top; });
    check('welcome: after the answer one tap leads to the choice of exam', await page.locator('text=你准备申请哪一种').count() === 1 && await noOverflow(page));
    await shot(page, '28-welcome-answered');
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.pay');
    const payBtn = (await page.locator('.pay a[href="#unlock"]').innerText()).replace(/\s+/g, ' ');
    const payTerms = await page.locator('.pay .buy-terms').innerText();
    await page.goto(base + '#unlock');
    await page.waitForSelector('.gets');
    check('the price of config.js is written on the button of the offer, with the terms under it, and on the unlock page', price !== '' && payBtn.includes('解锁全部') && payBtn.includes(price) && /一次付款，不是订阅，长期使用/.test(payTerms) && (await page.locator('.offer-price').innerText()).includes(price) && /一次付款，不是订阅/.test(await page.locator('.offer-price').innerText()), payBtn + ' / ' + payTerms);
    check('the unlock page still says the official material is free, and when the bank was built', /官方备考资料是免费的/.test(await page.locator('.offer-honest').innerText()) && (await page.locator('.bank-asof').innerText()).includes(free.built));
    await page.goto(base + '#about');
    await page.waitForSelector('.bank-asof');
    const asof = await page.locator('.bank-asof').innerText();
    check('about: date of the bank, date the official list was read, number of questions', asof.includes('题库更新于 ' + free.built) && asof.includes('官方题目清单查阅于 ' + free.consulted) && asof.includes(String(free.meta.total)), asof);
    // no contact in the settings: the question number in a sheet, with a copy button
    await page.addInitScript(() => {
      let cfg;
      Object.defineProperty(window, 'CIVIQUE_CONFIG', { configurable: true, get: () => cfg, set: (v) => { cfg = Object.assign(v, { contact: '', payUrl: '', login: false }); } });
    });
    await page.goto(base + '#home');
    await page.reload();
    await page.waitForSelector('[data-a="continue"]');
    await page.locator('[data-a="continue"]').click();
    await page.waitForSelector('.stem');
    const qidStem = (await page.locator(".stem").first().innerText()).trim(), qid = free.qs.find((x) => x.q === qidStem).id;
    check('no report link before the answer', await page.locator('.report').count() === 0);
    await answer(page, false);
    await page.locator('.copy .report').click();
    await page.waitForSelector('.sheet');
    const sheetText = await page.locator('.sheet').innerText();
    await page.locator('[data-a="copy-id"]').click();
    await page.waitForFunction(() => document.getElementById('repmsg').textContent !== '');
    check('report without a contact: a sheet with the question number, a copy button and what to do', (await page.locator('#repid').innerText()).trim() === qid && /题号/.test(sheetText) && /把题号发给卖家，核实后会更正/.test(sheetText) && /复制|选中/.test(await page.locator('#repmsg').innerText()), sheetText.replace(/\s+/g, ' '));
    await shot(page, '29-report-sheet');
    await ctx.close();
    // an email address in the settings: one tap opens an email about this question; the pay buttons carry the price
    ({ ctx, page } = await fresh());
    await page.addInitScript(() => {
      let cfg;
      Object.defineProperty(window, 'CIVIQUE_CONFIG', { configurable: true, get: () => cfg, set: (v) => { cfg = Object.assign(v, { contact: 'aide@example.com', payUrl: 'https://pay.example.com/x', login: false }); } });
    });
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    await page.locator('[data-a="continue"]').click();
    await page.waitForSelector('.stem');
    const qid2Stem = (await page.locator(".stem").first().innerText()).trim(), qid2 = free.qs.find((x) => x.q === qid2Stem).id;
    await answer(page, true);
    const href = await page.locator('.copy a.report').getAttribute('href');
    check('report with an email contact: a mailto link with the question number in subject and body', /^mailto:aide@example\.com\?subject=/.test(href) && decodeURIComponent(href).split(qid2).length === 3 && decodeURIComponent(href).includes('哪里有问题：') && (await page.locator('.copy a.report').innerText()).includes(qid2), href);
    await page.goto(base + '#unlock');
    await page.waitForSelector('.gets');
    const payBtns = await page.locator('.buy a.btn').allInnerTexts();
    check('unlock page: one pay button, with the price on it and the terms right above it; the code form is folded until asked for', payBtns.length === 1 && payBtns.every((t) => t.includes(price)) && /一次付款，不是订阅/.test(await page.locator('.offer-terms').innerText()) && (await page.locator('.buy a.btn').first().getAttribute('href')).startsWith('https://pay.example.com/x') && !(await page.locator('#code').isVisible()), payBtns.join(' | '));
    await page.locator('#have-code summary').click();
    check('unlock page: "I already have a code" opens the form', await page.locator('#code').isVisible());
    check('unlock page: the terms of sale are one tap away and say that access is immediate with no withdrawal', await page.locator('.offer-after a[href="conditions.html"]').count() === 1 && /L221-28/.test(fs.readFileSync(path.join(SITE, 'conditions.html'), 'utf8')));
    check('no referral link, no referral name on the pay button', !/client_reference_id/.test(await page.locator('.buy a.btn').first().getAttribute('href')));
    await page.goto(base + '?r=lili-01#unlock');
    await page.reload();
    await page.waitForSelector('.gets');
    check('a link shared as ?r=name hands that name to the payment page', /[?&]client_reference_id=lili-01$/.test(await page.locator('.buy a.btn').first().getAttribute('href')), await page.locator('.buy a.btn').first().getAttribute('href'));
    await page.goto(base + '#unlock');
    await page.reload();
    await page.waitForSelector('.gets');
    check('the referral name is remembered on later visits', /client_reference_id=lili-01$/.test(await page.locator('.buy a.btn').first().getAttribute('href')));
    await page.goto(base + '?r=<script>#unlock');
    await page.reload();
    await page.waitForSelector('.gets');
    check('a malformed referral name is ignored', /client_reference_id=lili-01$/.test(await page.locator('.buy a.btn').first().getAttribute('href')));
    await page.goto(base + '#home');
    await page.reload();
    await page.waitForSelector('.tabs');
    check('the referral name is put back in the address, so a copied or re-opened link still carries it', /\?r=lili-01#home$/.test(page.url()), page.url());
    await page.goto(base + '?r=lili-01#unlock');
    await page.reload();
    await page.waitForSelector('.gets');
    await page.locator('#ref-box summary').click();
    await page.fill('#ref', 'bad code!');
    await page.locator('#refform button').click();
    await page.waitForSelector('#refform .msg.bad');
    check('a mistyped referral code is refused and the old one kept', /client_reference_id=lili-01$/.test(await page.locator('.buy a.btn').first().getAttribute('href')));
    await page.fill('#ref', 'wang');
    await page.locator('#refform button').click();
    await page.waitForSelector('#refform .msg.ok');
    check('a referral code typed by hand goes to the payment page and into the address', /client_reference_id=wang$/.test(await page.locator('.buy a.btn').first().getAttribute('href')) && /\?r=wang#unlock$/.test(page.url()), page.url());

    // ---- the seller's sales report
    {
      const ask = async (body, env, method) => salesCore.handle(new Request('http://x/api/sales', { method: method || 'POST', body: method === 'GET' ? undefined : JSON.stringify(body) }), env || ENV, stripeStandIn);
      check('sales report: no password, wrong password and GET are refused', (await ask({})).status === 403 && (await ask({ key: 'admin-password-012345678X' })).status === 403 && (await ask(null, ENV, 'GET')).status === 405);
      check('sales report: off until a long admin password is set', (await ask({ key: 'short' }, Object.assign({}, ENV, { ADMIN_KEY: 'short' }))).status === 503 && (await ask({ key: '' }, Object.assign({}, ENV, { ADMIN_KEY: '' }))).status === 503);
      let rep = await (await ask({ key: ENV.ADMIN_KEY })).json();
      check('sales report: only paid, live payments made through our link, with who referred them and nothing about the buyer', rep.ok && rep.sales.length === 2 && rep.sales.every((x) => x.ref === 'lili-01') && rep.sales[0].amount === 1299 && Object.keys(rep.sales[0]).sort().join() === 'amount,currency,ref,t', JSON.stringify(rep).slice(0, 200));
      reportMany = true;
      rep = await (await ask({ key: ENV.ADMIN_KEY })).json();
      check('sales report: reads every page, newest first, and drops malformed referrer names', rep.sales.length === 122 && !rep.more && rep.sales[0].t > rep.sales[121].t && rep.sales.filter((x) => x.ref === 'wang').length === 40 && rep.sales.filter((x) => x.ref === '').length === 80, rep.sales.length);
      await page.goto(base + 'sales.html');
      await page.fill('#k', 'nope-nope-nope-nope');
      await page.locator('#f button').click();
      await page.waitForFunction(() => document.getElementById('msg').textContent === '密码不对。');
      check('sales page: a wrong password shows nothing', !(await page.locator('#out').isVisible()));
      await page.fill('#k', ENV.ADMIN_KEY);
      await page.locator('#f button').click();
      await page.waitForSelector('#out:not([hidden])');
      await page.selectOption('#m', 'all');
      const byRows = await page.locator('#by tr').allInnerTexts();
      check('sales page: one line per referrer with count, amount and commission; sales without referrer last', byRows.length === 3 && /^wang\s+40\s+519,60 €\s+155,88 €$/.test(byRows[0].trim()) && /^lili-01\s+2\s+25,98 €\s+7,79 €$/.test(byRows[1].trim()) && /没有推荐人/.test(byRows[2]) && /—$/.test(byRows[2].trim()), byRows.join(' | '));
      await page.fill('#pc', '50');
      check('sales page: the commission follows the percentage', /259,80 €$/.test((await page.locator('#by tr').first().innerText()).trim()));
      check('sales page: no sideways scroll on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      reportMany = false;
    }
    await ctx.close();
  }

  // ---- who uses the site, the admin page, corrections to the bank
  console.log('usage, admin page, corrections');
  {
    const post = (fn, body, env) => adminCore[fn](new Request('http://x/api/' + fn, { method: 'POST', headers: { 'user-agent': 'TestPhone' }, body: JSON.stringify(body) }), env || ENV, CF);
    const adm = async (op, more) => (await post('admin', Object.assign({ key: ENV.ADMIN_KEY, op }, more || {}))).json();
    const dev = 'a1b2c3d4e5f60718';
    check('usage: nothing is kept when there is no database, and the app is told so', (await post('sync', { device: dev }, Object.assign({}, ENV, { DB: undefined }))).status === 503);
    check('usage: a report without a device number is refused', (await post('sync', { device: 'x' })).status === 400);
    const before = (await adm('users')).users;
    check('admin: the buyer of the earlier payment is listed with the payment email and who referred them', before.some((u) => u.id.startsWith('b:') && u.email === 'buyer@example.com' && u.ref === 'lili-01'), JSON.stringify(before).slice(0, 300));
    await post('sync', { device: dev, ref: 'wang', level: 'csp', examDate: '2027-01-15', sum: { seen: 12, ok: 9, miss: 2, ans: 15, pool: 234, exams: 1, best: 0, bestN: 0 }, state: { stats: { P009: [3, 1, 0, 2, 1795000000000], 'bad id!': [1] }, days: { '2026-11-25': [12, 9] }, exams: [{ ts: 1795000000000, target: 'csp', mini: true, score: 7, n: 10, passAt: 8, secs: 300, items: ['dropped'] }] } });
    await post('sync', { device: dev, ref: 'other', level: 'csp', sum: { seen: 13 }, state: { stats: { P009: [4, 2, 1, 1, 1795000001000] } } });
    let list = (await adm('users')).users, v = list.find((u) => u.id === 'v:' + dev);
    check('usage: a visitor is one line, with place, exam type, numbers, and the first referrer kept', !!v && v.country === 'FR' && v.city === 'Lyon' && v.level === 'csp' && v.ref === 'wang' && v.sum.seen === 13 && v.days === 1 && v.ua === 'TestPhone' && !('state' in v), JSON.stringify(v));
    const one = await adm('user', { id: 'v:' + dev });
    check('admin: one person opens with the record of each question, and junk in a report is dropped', one.ok && one.user.state.stats.P009[0] === 4 && !('bad id!' in one.user.state.stats) && one.days.length === 1, JSON.stringify(one).slice(0, 300));
    const code = await core.codeForSession(ENV, 'cs_live_NEWBUYER0001');
    await post('sync', { device: dev, code: code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8), level: 'csp', sum: { seen: 20 }, state: {} });
    list = (await adm('users')).users;
    const b = list.find((u) => u.id === 'b:' + code);
    check('usage: once the visitor has paid they become the buyer: same referrer, same first day, no second line', !!b && b.ref === 'wang' && b.created === v.created && b.days === 1 && !list.some((u) => u.id === 'v:' + dev) && b.unlocked === 1, JSON.stringify(b));
    await post('sync', { device: 'ffffffffffffffff', code: 'AAAA-BBBB-CCCC', level: 'cr', sum: {}, state: {} });
    check('usage: a made-up code does not make a buyer', (await adm('users')).users.some((u) => u.id === 'v:ffffffffffffffff'));
    check('admin: no password, wrong password, unknown request are refused', (await post('admin', { op: 'users' })).status === 403 && (await post('admin', { key: 'admin-password-012345678X', op: 'users' })).status === 403 && (await post('admin', { key: ENV.ADMIN_KEY, op: 'drop' })).status === 400);

    // corrections
    const freeQ = free.qs[0];
    check('corrections: an empty or malformed one is refused', (await post('admin', { key: ENV.ADMIN_KEY, op: 'patch-set', qid: freeQ.id, data: { o: ['a', 'b'] } })).status === 400 && (await post('admin', { key: ENV.ADMIN_KEY, op: 'patch-set', qid: freeQ.id, data: { zz: 'x' } })).status === 400);
    await adm('patch-set', { qid: freeQ.id, free: true, data: { qz: '改过的中文题干', hack: 'x' } });
    await adm('patch-set', { qid: 'ZZPAID1', free: false, data: { e: '付费题的新讲解' } });
    const got = await (await adminCore.patches(new Request('http://x/api/patches'), ENV)).json();
    const key = await crypto.subtle.importKey('raw', Buffer.from(ENV.CONTENT_KEY, 'base64'), { name: 'AES-GCM' }, false, ['decrypt']);
    const opened = JSON.parse(Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(got.paid.iv, 'base64') }, key, Buffer.from(got.paid.ct, 'base64'))).toString('utf8'));
    check('corrections: those of free questions are public, those of paid questions only open with the bank key', got.free[freeQ.id].qz === '改过的中文题干' && !('hack' in got.free[freeQ.id]) && !JSON.stringify(got.free).includes('付费题') && opened.ZZPAID1.e === '付费题的新讲解', JSON.stringify(got).slice(0, 200));

    // in the browser
    ({ ctx, page } = await fresh());
    await page.goto(base + '?r=lili-01');
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    await page.waitForFunction(() => /^[a-f0-9]{16}$/.test(localStorage.getItem('civique.dev') || ''));
    const myDev = await page.evaluate(() => localStorage.getItem('civique.dev'));
    for (let i = 0; i < 40 && !(await adm('users')).users.some((u) => u.id === 'v:' + myDev); i++) await page.waitForTimeout(100);
    const me = (await adm('users')).users.find((u) => u.id === 'v:' + myDev);
    check('the app reports who it is once an exam type is chosen: device number, exam type, referrer', !!me && me.level === 'csp' && me.ref === 'lili-01', JSON.stringify(me));
    await page.goto(base + '#home');
    await page.reload();
    await page.locator('[data-a="continue"]').click();
    await page.waitForSelector('.stem');
    await page.waitForFunction((t) => document.body.innerText.includes(t) || !document.querySelector('.stem'), '改过的中文题干', { timeout: 3000 }).catch(() => {});
    const shown = await page.evaluate((id) => { const s = JSON.parse(localStorage.getItem('civique.v1')); return s.sess.ids.includes(id); }, freeQ.id);
    if (shown) {
      await page.evaluate((id) => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.sess.i = s.sess.ids.indexOf(id); s.zhOn = true; localStorage.setItem('civique.v1', JSON.stringify(s)); }, freeQ.id);
      await page.reload();
      await page.waitForFunction((t) => document.body.innerText.includes(t), '改过的中文题干', { timeout: 5000 }).catch(() => {});
    }
    check('a correction made in the admin page shows in the app', !shown || (await page.locator('body').innerText()).includes('改过的中文题干'), 'question in set: ' + shown);
    await ctx.close();

    ({ ctx, page } = await fresh({ viewport: { width: 390, height: 780 } }));
    await page.goto(base + 'admin.html');
    await page.fill('#k', 'wrong-wrong-wrong-wrong');
    await page.locator('#f button').click();
    await page.waitForFunction(() => document.getElementById('msg').textContent === '密码不对。');
    check('admin page: a wrong password shows nothing', !(await page.locator('#main').isVisible()));
    await page.fill('#k', ENV.ADMIN_KEY);
    await page.locator('#f button').click();
    await page.waitForSelector('#main:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#ulist tr.pick').length > 2);
    const rowsTxt = await page.locator('#ulist').innerText();
    check('admin page: buyers by email, visitors by number, with who sent them and where they are', rowsTxt.includes('buyer@example.com') && rowsTxt.includes('访客 ' + myDev.slice(0, 6)) && rowsTxt.includes('lili-01') && rowsTxt.includes('Lyon, FR'), rowsTxt.slice(0, 300));
    await page.fill('#uq', code.slice(0, 4));
    await page.locator('#ulist tr.pick').first().click();
    await page.waitForSelector('#udetail .card');
    await page.fill('#uq', '');
    await page.fill('#uq', myDev.slice(0, 6));
    await page.locator('#ulist tr.pick').first().click();
    await page.waitForFunction(() => /各主题掌握情况/.test(document.getElementById('udetail').innerText));
    check('admin page: one person opens with themes, weak questions, exams and days', /没学明白的题/.test(await page.locator('#udetail').innerText()) && /模拟考试/.test(await page.locator('#udetail').innerText()));
    await page.locator('#udetail button.danger').click();
    check('admin page: deleting a record asks twice', (await adm('users')).users.some((u) => u.id === 'v:' + myDev));
    await page.locator('#udetail button.danger').click();
    await page.waitForFunction(() => /已删除/.test(document.getElementById('msg').textContent));
    check('admin page: a person\'s record can be erased', !(await adm('users')).users.some((u) => u.id === 'v:' + myDev));
    await page.locator('.tabs [data-tab="refs"]').click();
    const refsTxt = await page.locator('#rlist').innerText();
    check('admin page: who sent whom, paid or not', /wang/.test(refsTxt) && /lili-01/.test(refsTxt) && /未登记/.test(refsTxt) && /没有推荐人/.test(refsTxt), refsTxt);
    await page.locator('#rnew').click();
    check('referrers: a name is asked for', /先填名字/.test(await page.locator('#msg').innerText()));
    await page.fill('#rname', '小丽（朋友圈）');
    await page.fill('#rpct', '25');
    await page.locator('#rnew').click();
    await page.waitForSelector('#rmade:not([hidden])');
    const madeLink = await page.inputValue('#rlink');
    check('referrers: a link with a made-up short code is given, ready to copy', /\/\?r=[a-z2-9]{5}$/.test(madeLink), madeLink);
    await page.waitForFunction(() => (document.getElementById('pimg').getAttribute('src') || '').startsWith('data:image/png'));
    const dims = await page.evaluate(() => new Promise((ok) => { const im = new Image(); im.onload = () => ok([im.naturalWidth, im.naturalHeight]); im.src = document.getElementById('pimg').src; }));
    const qrSame = await page.evaluate((link) => { const m = window.Poster.matrix(link), n = m.length; return n >= 21 && m[0][0] && m[0][6] && m[6][0] && !m[1][1] && m[n - 1][0]; }, madeLink);
    check('poster: a new link comes with its poster (1080 × 1440) and its QR code, named in the title', dims.join('x') === '1080x1440' && qrSame && /小丽（朋友圈） 的海报/.test(await page.locator('#ptitle').innerText()) && (await page.locator('#plink').innerText()) === madeLink, dims.join('x'));
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#pdl').click()]);
    const [dq] = await Promise.all([page.waitForEvent('download'), page.locator('#qdl').click()]);
    check('poster: poster and QR code download as pictures named after the referrer', /^kaocivique-[a-z2-9]{5}-poster\.png$/.test(dl.suggestedFilename()) && /^kaocivique-[a-z2-9]{5}-qr\.png$/.test(dq.suggestedFilename()), dl.suggestedFilename() + ' ' + dq.suggestedFilename());
    await page.locator('#phome').click();
    await page.waitForFunction(() => /官网的海报/.test(document.getElementById('ptitle').textContent));
    check('poster: the plain site has its own poster, with no referrer in the link', /\/$/.test(await page.locator('#plink').innerText()) && !/r=/.test(await page.locator('#plink').innerText()) && await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.locator('#pclose').click();
    await page.fill('#rname', '老王');
    await page.fill('#rcode', 'wang');
    await page.fill('#rpct', '50');
    await page.locator('#rnew').click();
    await page.waitForFunction(() => /老王/.test(document.getElementById('rlist').innerText));
    await page.waitForFunction(() => /€/.test(document.getElementById('rlist').innerText));
    const refsTxt2 = await page.locator('#rlist').innerText();
    check('referrers: a chosen code is kept; the list shows names, orders from the payments and each one\'s commission', /老王[\s\S]*代号 wang/.test(refsTxt2) && /小丽（朋友圈）/.test(refsTxt2) && /（50%）/.test(refsTxt2) && /（25%）/.test(refsTxt2) && /25,98 €/.test(refsTxt2), refsTxt2);
    await page.fill('#rname', '又一个老王');
    await page.fill('#rcode', 'wang');
    await page.locator('#rnew').click();
    await page.waitForFunction(() => /已经给别人用了/.test(document.getElementById('msg').textContent));
    await page.fill('#rcode', '带中文');
    await page.locator('#rnew').click();
    check('referrers: a code already taken, or one that would not survive in a link, is refused', /只能用英文字母/.test(await page.locator('#msg').innerText()) && (await adm('refs')).refs.length === 2);
    const wangRow = page.locator('#rlist tr', { hasText: '代号 wang' });
    await wangRow.locator('button.danger').click();
    await wangRow.locator('button.danger').click();
    await page.waitForFunction(() => /已从名单移除/.test(document.getElementById('msg').textContent));
    check('referrers: one can be taken off the list; the visits stay counted, as an unknown code', (await adm('refs')).refs.length === 1 && /wang/.test(await page.locator('#rlist').innerText()));
    await page.locator('.tabs [data-tab="bank"]').click();
    await page.waitForFunction(() => /题库共 \d+ 题，改过 2 题/.test(document.getElementById('binfo').textContent));
    const second = free.qs[1];
    await page.fill('#bq', second.id);
    await page.locator('#blist .card button').first().click();
    await page.fill('#e-e', '后台改的新讲解');
    await page.locator('#bedit button', { hasText: '保存' }).click();
    await page.waitForFunction(() => /已保存/.test(document.getElementById('msg').textContent));
    const saved = (await adm('patches')).patches.find((x) => x.qid === second.id);
    check('admin page: a question is found by its number, edited, and only what changed is saved', !!saved && saved.free === true && JSON.stringify(saved.data) === JSON.stringify({ e: '后台改的新讲解' }), JSON.stringify(saved));
    await page.locator('#blist .card button').first().click();
    await page.locator('#bedit button', { hasText: '恢复成原来的' }).click();
    await page.waitForFunction(() => /已恢复原样/.test(document.getElementById('msg').textContent));
    check('admin page: a correction can be undone', !(await adm('patches')).patches.some((x) => x.qid === second.id));
    check('admin page: no sideways scroll on a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await adm('patch-del', { qid: freeQ.id }); await adm('patch-del', { qid: 'ZZPAID1' });
    await ctx.close();
  }

  // ---- codes the seller makes by hand: one device each; any code can be cancelled
  console.log('seller-made codes');
  {
    const adm = async (op, more) => (await adminCore.admin(new Request('http://x/api/admin', { method: 'POST', body: JSON.stringify(Object.assign({ key: ENV.ADMIN_KEY, op }, more || {})) }), ENV, CF)).json();
    const unlock = async (body) => core.handle(new Request('http://x/api/unlock', { method: 'POST', body: JSON.stringify(body) }), ENV, stripeStandIn);
    const made = (await adm('code-new', { n: 3, note: '送给老王' })).codes;
    check('codes: the seller gets as many as asked, all different, in the usual shape', made.length === 3 && new Set(made).size === 3 && made.every((c) => /^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(c)), made.join(' '));
    const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb';
    check('codes: without a device number a hand-made code is not given away', (await unlock({ code: made[0] })).status === 409);
    const first = await unlock({ code: made[0], device: A });
    check('codes: the first device to use one is unlocked', first.status === 200 && (await first.json()).k === ENV.CONTENT_KEY);
    check('codes: a second device is refused, the first keeps working', (await unlock({ code: made[0], device: B })).status === 409 && (await unlock({ code: made[0], device: A })).status === 200);
    let listed = (await adm('codes')).codes.find((c) => c.code === made[0]);
    check('codes: the list shows the note, that it was used, and by which device', listed.note === '送给老王' && listed.used_by === A && listed.used_at > 0 && !listed.revoked, JSON.stringify(listed));
    await adm('code-reset', { code: made[0] });
    check('codes: "new phone" lets it be used once more, on the next device', (await unlock({ code: made[0], device: B })).status === 200 && (await unlock({ code: made[0], device: A })).status === 409);
    await adm('code-del', { code: made[0] });
    check('codes: a cancelled code stops working everywhere', (await unlock({ code: made[0], device: B })).status === 403 && (await adm('codes')).codes.find((c) => c.code === made[0]).revoked === true);
    const paidCode = (await (await unlock({ session: 'cs_live_PAID00000001' })).json()).code;
    check('codes: one issued after a payment still works on several devices', (await unlock({ code: paidCode, device: A })).status === 200 && (await unlock({ code: paidCode, device: B })).status === 200);
    check('codes: junk cannot be cancelled', (await adminCore.admin(new Request('http://x/api/admin', { method: 'POST', body: JSON.stringify({ key: ENV.ADMIN_KEY, op: 'code-del', code: 'nope' }) }), ENV, CF)).status === 400);

    // in the app: unlock with a hand-made code, then the seller cancels it
    if (CODE) {
      const realKey = require('child_process').execFileSync('node', [path.resolve(__dirname, 'bank.mjs'), 'key', '--code', CODE]).toString().trim().split('\n').pop();
      const keep = ENV.CONTENT_KEY; ENV.CONTENT_KEY = realKey;
      const mine = (await adm('code-new', { n: 1 })).codes[0];
      ({ ctx, page } = await fresh({ cfg: { payUrl: 'https://pay.example.com/x' } }));
      await page.goto(base);
      await page.locator('[data-a="target"][data-v="csp"]').click();
      await page.waitForSelector('.themes');
      await page.goto(base + '#unlock');
      await page.waitForSelector('.gets');
      await page.locator('#have-code summary').click();
      await page.fill('#code', mine);
      await page.locator('#codeform button').click();
      await page.waitForFunction(() => { try { return !!JSON.parse(localStorage.getItem('civique.v1')).unlock; } catch (e) { return false; } }, null, { timeout: 15000 });
      check('codes: a hand-made code typed in the app opens the whole bank', (await state(page)).unlock.code === mine);
      const other = await fresh({ cfg: { payUrl: 'https://pay.example.com/x' } });
      await other.page.goto(base);
      await other.page.locator('[data-a="target"][data-v="csp"]').click();
      await other.page.goto(base + '#unlock');
      await other.page.waitForSelector('.gets');
      await other.page.locator('#have-code summary').click();
      await other.page.fill('#code', mine);
      await other.page.locator('#codeform button').click();
      await other.page.waitForSelector('#codeform .msg.bad');
      check('codes: on a second phone the app says the code is already in use', /已经在另一台设备上用过/.test(await other.page.locator('#codeform .msg').innerText()) && !(await state(other.page)).unlock);
      await other.ctx.close();
      await adm('code-del', { code: mine });
      await page.reload();
      await page.waitForFunction(() => { try { return !JSON.parse(localStorage.getItem('civique.v1')).unlock; } catch (e) { return false; } }, null, { timeout: 15000 });
      check('codes: once cancelled, the phone that used it is back to the free trial at its next visit', !(await state(page)).unlock);
      await ctx.close();
      ENV.CONTENT_KEY = keep;
    }

    ({ ctx, page } = await fresh());
    await page.goto(base + 'admin.html');
    await page.fill('#k', ENV.ADMIN_KEY);
    await page.locator('#f button').click();
    await page.waitForSelector('#main:not([hidden])');
    await page.locator('.tabs [data-tab="codes"]').click();
    await page.fill('#cn', '2');
    await page.fill('#cnote', '小红书活动');
    await page.locator('#cnew').click();
    await page.waitForSelector('#cmade-text');
    const shownCodes = (await page.inputValue('#cmade-text')).split('\n');
    await page.waitForFunction((c) => document.getElementById('clist').innerText.includes(c), shownCodes[0]);
    check('admin page: codes are made on request and listed with their note and state', shownCodes.length === 2 && /小红书活动/.test(await page.locator('#clist').innerText()) && /未使用/.test(await page.locator('#clist').innerText()) && /已作废/.test(await page.locator('#clist').innerText()));
    const rowOf = page.locator('#clist tr', { hasText: shownCodes[0] });
    await rowOf.locator('button.danger').click();
    await rowOf.locator('button.danger').click();
    await page.waitForFunction(() => /已作废。$/.test(document.getElementById('msg').textContent));
    check('admin page: cancelling a code asks twice, then it is cancelled', (await adm('codes')).codes.find((c) => c.code === shownCodes[0]).revoked === true);
    check('admin page: the codes tab fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await ctx.close();
  }

  // ---- the admin pages behind an authenticator code; a purchase on a few devices only
  console.log('authenticator, device limit');
  {
    const auth = await import(require('url').pathToFileURL(path.resolve(__dirname, '..', 'server', 'auth.mjs')).href);
    check('authenticator: the codes are the standard ones (RFC 6238 test value)', await auth.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000) === '287082');
    const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP', E2 = Object.assign({}, ENV, { ADMIN_TOTP: SECRET });
    const call = async (body, env) => adminCore.admin(new Request('http://x/api/admin', { method: 'POST', body: JSON.stringify(body) }), env, CF);
    const now = await auth.totp(SECRET, Date.now());
    check('authenticator: the password alone is no longer enough', (await (await call({ key: ENV.ADMIN_KEY, op: 'users' }, E2)).json()).error === 'otp_required');
    check('authenticator: a wrong code is refused', (await (await call({ key: ENV.ADMIN_KEY, otp: now === '000000' ? '111111' : '000000', op: 'users' }, E2)).json()).error === 'bad_otp');
    const login = await (await call({ key: ENV.ADMIN_KEY, otp: now, op: 'login' }, E2)).json();
    check('authenticator: password and code give a pass for the session', login.ok && /^\d{13}\.[0-9a-f]{64}$/.test(login.token), JSON.stringify(login).slice(0, 80));
    check('authenticator: the pass works without the password, a forged or foreign one does not', (await (await call({ token: login.token, op: 'users' }, E2)).json()).ok === true
      && (await call({ token: login.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')), op: 'users' }, E2)).status === 403 && (await call({ token: login.token, op: 'users' }, ENV)).status === 403);
    const old = (Date.now() - 1000) + '.' + 'ab'.repeat(32);
    check('authenticator: a pass with a changed date is refused', (await call({ token: old, op: 'users' }, E2)).status === 403);
    const expired = await auth.newToken(E2, Date.now() - 13 * 3600000);
    check('authenticator: a pass ends after twelve hours', (await (await call({ token: expired.token, op: 'users' }, E2)).json()).error === 'expired');
    check('authenticator: the sales report asks for it too', (await (await salesCore.handle(new Request('http://x/api/sales', { method: 'POST', body: JSON.stringify({ key: ENV.ADMIN_KEY }) }), E2, stripeStandIn)).json()).error === 'otp_required'
      && (await (await salesCore.handle(new Request('http://x/api/sales', { method: 'POST', body: JSON.stringify({ token: login.token }) }), E2, stripeStandIn)).json()).ok === true);

    const E3 = Object.assign({}, ENV, { DEVICE_LIMIT: undefined });
    {
      const E4 = Object.assign({}, ENV, { ADMIN_TOTP: SECRET, ADMIN_KEY: 'short-pw-1', DB: d1() });
      check('authenticator: with it, a shorter password is accepted; without it, a short password switches the pages off', (await (await call({ key: 'short-pw-1', otp: now, op: 'login' }, E4)).json()).ok === true
        && (await call({ key: 'short-pw-1', op: 'login' }, Object.assign({}, E4, { ADMIN_TOTP: undefined }))).status === 503);
      let last = '';
      for (let i = 0; i < 9; i++) last = (await (await call({ key: 'guess-' + i, op: 'login' }, E4)).json()).error;
      check('door: after eight wrong passwords it stays shut, even for the right one', last === 'locked' && (await (await call({ key: 'short-pw-1', otp: now, op: 'login' }, E4)).json()).error === 'locked');
      check('door: someone already inside keeps working, and it opens again after a quarter of an hour', (await (await auth.authorize({ token: (await auth.newToken(E4)).token }, E4)).ok) === true
        && (await auth.authorize({ key: 'short-pw-1', otp: await auth.totp(SECRET, Date.now() + 16 * 60000) }, E4, Date.now() + 16 * 60000)).ok === true);
    }
    const unlock = async (body) => core.handle(new Request('http://x/api/unlock', { method: 'POST', body: JSON.stringify(body) }), E3, stripeStandIn);
    const adm = async (op, more) => (await call(Object.assign({ key: ENV.ADMIN_KEY, op }, more || {}), E3)).json();
    await adm('code-reset', { code: await core.codeForSession(ENV, 'cs_live_PAID00000001') });
    const devs = ['1', '2', '3', '4'].map((x) => x.repeat(16));
    const paid = (await (await unlock({ session: 'cs_live_PAID00000001', device: devs[0] })).json()).code;
    await adm('code-reset', { code: paid });
    const got = [];
    for (const dv of devs) got.push((await unlock({ email: 'buyer@example.com', device: dv })).status);
    check('device limit: a purchase unlocks three devices, the fourth is refused', got.join() === '200,200,200,409', got.join());
    check('device limit: the same three keep working, by code as well', (await unlock({ code: paid, device: devs[1] })).status === 200 && (await unlock({ code: paid, device: devs[3] })).status === 409 && (await (await unlock({ code: paid, device: devs[3] })).json()).error === 'limit');
    const who = await adm('user', { id: 'b:' + paid.replace(/-/g, '') });
    check('device limit: the seller sees how many devices a buyer uses', who.devices === 3 && who.limit === 3, JSON.stringify({ d: who.devices, l: who.limit }));
    await adm('code-reset', { code: paid });
    check('device limit: after the seller clears them, a new phone gets in', (await unlock({ code: paid, device: devs[3] })).status === 200);
    await adm('code-reset', { code: paid });

    ({ ctx, page } = await fresh());
    await page.goto(base + 'admin.html');
    await page.fill('#k', ENV.ADMIN_KEY);
    await page.locator('#f button').click();
    await page.waitForSelector('#main:not([hidden])');
    await page.reload();
    await page.waitForSelector('#main:not([hidden])');
    check('admin page: a reload does not ask for the password again, and the password is not what is kept', (await page.evaluate(() => sessionStorage.getItem('civique.admin'))) !== ENV.ADMIN_KEY && /^\d{13}\./.test(await page.evaluate(() => sessionStorage.getItem('civique.admin'))));
    await page.goto(base + 'sales.html');
    await page.waitForSelector('#out:not([hidden])');
    check('sales page: opens with the same pass', true);
    await ctx.close();
  }

  // ---- signing in with a phone number or an email
  console.log('sign-in');
  {
    const adm = async (op, more) => (await adminCore.admin(new Request('http://x/api/admin', { method: 'POST', body: JSON.stringify(Object.assign({ key: ENV.ADMIN_KEY, op }, more || {})) }), ENV, CF)).json();
    const hasUser = async (id) => { for (let i = 0; i < 40; i++) { const u = (await adm('users')).users.find((x) => x.id === id); if (u) return u; await new Promise((r) => setTimeout(r, 100)); } return null; };
    ({ ctx, page } = await fresh({ cfg: { login: true } }));
    await page.goto(base + '?r=wang');
    await page.waitForSelector('#loginform');
    check('sign-in: the first screen asks for a phone number or an email, and nothing else is offered yet', await page.locator('[data-a="target"]').count() === 0 && await page.locator('.tabs').count() === 0 && await noOverflow(page));
    await page.fill('#login', 'not a phone');
    await page.locator('#loginform button').click();
    await page.waitForSelector('#loginform .msg.bad');
    check('sign-in: something that is neither is refused, and what was typed stays', await page.inputValue('#login') === 'not a phone');
    await page.fill('#login', '+33 6 12 34 56 78');
    await page.locator('#loginform button').click();
    await page.waitForSelector('[data-a="target"]');
    const phone = await hasUser('u:+33612345678');
    check('sign-in: a phone number goes straight in, and the seller sees it with who sent this person', !!phone && phone.login === '+33612345678' && phone.ref === 'wang', JSON.stringify(phone));
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    await page.goto(base + '#me');
    await page.waitForSelector('.acct');
    check('sign-in: the account shows on "me", with a way out', (await page.locator('.acct').innerText()).includes('+33612345678'));
    await page.locator('[data-a="logout"]').click();
    await page.waitForSelector('#loginform');
    await page.locator('[data-a="guest"]').click();
    await page.waitForSelector('.acct');
    check('sign-in: it can be skipped, and offered again later from "me"', /还没登录/.test(await page.locator('.acct').innerText()) && (await state(page)).guest === 1);
    await page.locator('[data-a="login-open"]').click();
    await page.waitForSelector('#loginform');
    await page.fill('#login', 'Buyer@Example.com');
    await page.locator('#loginform button').click();
    await page.waitForFunction(() => { try { return !!JSON.parse(localStorage.getItem('civique.v1')).unlock; } catch (e) { return false; } }, null, { timeout: 8000 }).catch(() => {});
    const st = await state(page);
    check('sign-in: the email of an earlier payment unlocks on the spot', !!st.unlock && st.user.id === 'buyer@example.com', JSON.stringify({ unlock: !!st.unlock, user: st.user }));
    await ctx.close();
    ({ ctx, page } = await fresh({ cfg: { login: true, api: '' } }));
    await page.goto(base);
    await page.waitForSelector('[data-a="target"]');
    check('sign-in: not asked on hosting without the site\'s own service', await page.locator('#loginform').count() === 0);
    await ctx.close();
    await adm('user-del', { id: 'u:+33612345678' });
  }

  // ---- the word note must never stop someone finishing a set (found on a real phone)
  console.log('word note never blocks');
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 568 }, hasTouch: true }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem .tw');
  {
    const overDock = () => page.evaluate(() => { const n = document.querySelector('.tw-pop'), d = document.querySelector('.dock'); if (!n || !d) return false; return n.getBoundingClientRect().bottom > d.getBoundingClientRect().top + 1; });
    await page.locator('.opts button.opt').first().click();
    await page.waitForSelector('.copy');
    let worst = false, n = await page.locator('.tw').count();
    for (let i = 0; i < n; i++) {                       // open the note on every word of the page, wherever it sits
      const w = page.locator('.tw').nth(i);
      await w.scrollIntoViewIfNeeded();
      const b = await w.boundingBox();
      const dockTop = await page.evaluate(() => document.querySelector('.dock').getBoundingClientRect().top);
      if (!b || b.y + b.height > dockTop || b.y < 60) continue;       // hidden behind a bar: cannot be tapped anyway
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      if (!(await page.locator('.tw-pop').count())) continue;
      if (await overDock()) { worst = true; break; }
    }
    check('the word note never lies on the bottom bar, whichever word is tapped', !worst);
    const nb = await page.locator('.dock [data-a="next"]').boundingBox();
    await page.touchscreen.tap(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.waitForFunction(() => /^2 \//.test((document.querySelector('.qbar .pos') || {}).textContent || ''));
    check('"next" works with a word note open', true);
    // a note lying on an option: one tap on the note closes it and still answers
    const stemWords = page.locator('.stem .tw');
    const last = stemWords.nth(await stemWords.count() - 1);
    await last.scrollIntoViewIfNeeded();
    const lb = await last.boundingBox();
    await page.touchscreen.tap(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await page.waitForSelector('.tw-pop');
    const hit = await page.evaluate(() => { const n = document.querySelector('.tw-pop').getBoundingClientRect(); for (const el of document.querySelectorAll('.tools [data-a], .opts button.opt')) { const r = el.getBoundingClientRect(); const x = Math.max(r.left, n.left) + 4, y = Math.max(r.top, n.top) + 4; if (x < Math.min(r.right, n.right) && y < Math.min(r.bottom, n.bottom)) return { x, y, a: el.getAttribute('data-a'), zh: el.getAttribute('aria-pressed') }; } return null; });
    if (hit) {
      await page.touchscreen.tap(hit.x, hit.y);
      await page.waitForTimeout(250);
      const acted = hit.a === 'pick' ? !(await page.locator('.dock [data-a="next"]').isDisabled()) : hit.a === 'zh' ? (await page.locator('[data-a="zh"]').getAttribute('aria-pressed')) !== hit.zh : true;
      check('a tap on the note closes it and reaches the button underneath', await page.locator('.tw-pop').count() === 0 && acted, JSON.stringify(hit));
    } else {
      await page.locator('.tw-pop').click();
      check('a tap on the note closes it', await page.locator('.tw-pop').count() === 0);
    }
  }
  await ctx.close();

  // ---- a failure on the device is said on the screen, with its cause
  ({ ctx, page } = await fresh());
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  {
    const before = errors.length;
    await page.goto(base + '#me');
    await page.waitForSelector('[data-a="target"]');
    await page.evaluate(() => { JSON.stringify = function () { throw new Error('boom-for-test'); }; });   // the next saved action fails
    await page.locator('[data-a="target"][data-v="cr"]').click();
    await page.waitForSelector('#oops');
    const said = await page.locator('#oops').innerText();
    check('a failing tap shows a notice with the cause', /出错了/.test(said) && /boom-for-test/.test(said) && /tap target/.test(said), said.replace(/\n/g, ' '));
    await page.locator('#oops-x').click();
    check('the notice can be closed', await page.locator('#oops').count() === 0);
    errors.length = before;
  }
  await ctx.close();

  // ---- the 闯关 system: five tabs, the two hubs, sub-pages under their tab, the feedback panel, 小玛, contrast
  console.log('navigation and design system');
  ({ ctx, page } = await fresh({ viewport: { width: 390, height: 800 } }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  check('five tabs: 首页 练习 模考 速记 我的', (await page.locator('.tabs li').allInnerTexts()).map((t) => t.trim()).join(' ') === '首页 练习 模考 速记 我的' && (await page.locator('.tabs a').evaluateAll((els) => els.map((a) => a.getAttribute('href')))).join() === '#home,#practice,#exam,#cards,#me');
  {
    const parent = { home: 'home', practice: 'practice', mistakes: 'practice', recall: 'practice', exam: 'exam', cards: 'cards', words: 'cards', sheet: 'cards', me: 'me', register: 'me', check: 'me', about: 'me', unlock: 'me' };
    const wrong = [], noBack = [];
    for (const r of Object.keys(parent)) {
      await page.goto(base + '#' + r);
      await page.waitForFunction((h) => location.hash === '#' + h && document.querySelector('.tabs'), r);
      const cur = await page.locator('.tabs a[aria-current="page"]').evaluateAll((els) => els.map((a) => a.getAttribute('href')).join());
      if (cur !== '#' + parent[r]) wrong.push(r + ' -> ' + cur);
      if (['mistakes', 'recall', 'register', 'check', 'about'].includes(r) && await page.locator('.topbar a.back[href="#' + parent[r] + '"]').count() !== 1) noBack.push(r);
      if (!(await noOverflow(page))) wrong.push(r + ' overflows');
    }
    check('every page highlights the tab it belongs to, old routes still open', wrong.length === 0, wrong.join(' | '));
    check('sub-pages have a back button to their hub', noBack.length === 0 && await (async () => { await page.goto(base + '#home'); await page.goto(base + '#unlock'); await page.locator('[data-a="back"]').click(); await page.waitForSelector('.themes'); return true; })(), noBack.join());
  }
  await page.goto(base + '#practice');
  await page.waitForSelector('.hub-grid');
  check('practice hub: five themes with a start button each, scenario-only, mistakes, recollections, the sheet',
    await page.locator('.th-row').count() === 5 && await page.locator('.th-row [data-a="start"]').count() === 5 && await page.locator('.th-row [data-a="theme"]').count() === 5 &&
    await page.locator('.hub-grid [data-a="start"][data-v="all|situ"]').count() === 1 && await page.locator('.hub-grid a[href="#sheet"]').count() === 1 &&
    await page.locator('.hub-grid a[href="#mistakes"]').count() === 1 && await page.locator('.hub-grid a[href="#recall"]').count() === 1 && /非官方/.test(await page.locator('.hub-grid a[href="#recall"]').innerText()));
  await page.locator('.hub-grid [data-a="start"][data-v="all|situ"]').click();
  await page.waitForSelector('.stem');
  st = await state(page);
  check('"scenario questions only" from the hub mixes the themes and gives only scenario questions', st.sess.ids.length > 0 && st.sess.ids.every((id) => id[0] === 'S') && await page.locator('.qbar a.back[href="#practice"]').count() === 1, st.sess.ids.join());
  await page.locator('.qbar a.back').click();
  await page.waitForSelector('.hub-grid');
  check('practice hub offers to continue the set in progress', await page.locator('main [data-a="continue"]').count() === 1);
  await page.goto(base + '#me');
  await page.waitForSelector('.seg');
  check('我的: offer, exam type switch, exam date, self-check, registration, about, reset, bank date, disclaimer',
    await page.locator('.pay a[href="#unlock"]').count() === 1 && await page.locator('.seg [data-a="target"]').count() === Object.keys(free.meta.counts).length && await page.locator('.seg [data-a="target"][data-v="csp"][aria-pressed="true"]').count() === 1 &&
    await page.locator('main [data-a="plan-edit"]').count() === 1 && await page.locator('main a[href="#check"]').count() === 1 && await page.locator('main a[href="#register"]').count() === 1 && await page.locator('main a[href="#about"]').count() === 1 &&
    await page.locator('main [data-a="reset"]').count() === 1 && (await page.locator('.bank-asof').innerText()).includes(free.built) && /不是法国政府网站/.test(await page.locator('.foot').innerText()) && /Licence Ouverte 2\.0/.test(await page.locator('.foot').innerText()) && /官方备考资料免费/.test(await page.locator('.foot').innerText()));
  await page.locator('.seg [data-a="target"][data-v="cr"]').click();
  await page.goto(base + '#home');
  await page.waitForSelector('.themes');
  check('the exam type is switched in 我的 and shown as a chip on home', (await state(page)).target === 'cr' && (await page.locator('.pagehead a.lv').innerText()).trim() === '十年卡');
  // 小玛 in each mood
  {
    const moods = await page.evaluate(() => [...document.querySelectorAll('.six')].map((s) => s.dataset.mood + ':' + s.querySelectorAll('path, ellipse, circle').length + ':' + Math.round(s.getBoundingClientRect().width)));
    await page.goto(base + '#mistakes');
    await page.waitForSelector('.empty .six');
    const sleep = await page.locator('.empty .six').getAttribute('data-mood');
    check('小玛 is drawn on home (cheering, at a visible size) and sleeps on an empty page', moods.some((m) => /^cheer:\d\d:\d\d+$/.test(m) && Number(m.split(':')[2]) >= 60) && sleep === 'sleep', moods.join(' '));
    // the drawing itself, taken from the source: six moods, the head-only rendering when small, and the old name gone
    const appSrc = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
    const six = new Function(appSrc.slice(appSrc.indexOf('  // 小玛, the mascot'), appSrc.indexOf('  function heroDeco')) + '; return six;')();
    const MOODS = ['cheer', 'console', 'celebrate', 'neutral', 'think', 'sleep'];
    const drawn = await page.evaluate((svgs) => svgs.map((h) => { const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d); const el = d.firstChild, r = el.getBoundingClientRect(), g = el.querySelector('g').getBBox(); d.remove(); return [Math.round(r.width), Math.round(r.height), Math.round(g.width), Math.round(g.height), el.querySelectorAll('text').length]; }), MOODS.map((m) => six(m, 96)));
    check('小玛: each of the six moods renders an svg with a non-zero box, its own drawing, under 1.6 KB and without text; an unknown mood falls back to neutral',
      drawn.every((d) => d[0] === 96 && d[1] === 96 && d[2] > 60 && d[3] > 90 && d[4] === 0) && new Set(MOODS.map((m) => six(m))).size === 6 && MOODS.every((m) => six(m).length <= 1640 && six(m).includes('data-mood="' + m + '"')) && six('nope') === six('neutral'),
      JSON.stringify(drawn) + ' ' + MOODS.map((m) => six(m).length).join(','));
    await page.goto(base + '#me');
    await page.waitForSelector('.pay-head .six, .me-card .six');
    const small = await page.evaluate(() => { const el = document.querySelector('.pay-head .six, .me-card .six'); return [el.classList.contains('mini'), el.getAttribute('viewBox'), Math.round(el.getBoundingClientRect().width)]; });
    check('小玛: below 36px (and in the small status card) only her head is drawn, with the hat and the face; larger sizes get the whole figure',
      /class="six mini"/.test(six('cheer', 28)) && six('cheer', 28).length < six('cheer', 36).length && !/class="six mini/.test(six('cheer', 36)) && !/mini/.test(six('cheer')) && six('cheer', 28).includes('viewBox="9 0 98 98"') && six('cheer', 0, 'bob', { mini: true }).includes('class="six mini bob"') &&
      six('celebrate', 0, '', { cap: 'phrygian' }) !== six('celebrate') && small[0] && small[1] === '9 0 98 98' && small[2] >= 40 && small[2] <= 56, JSON.stringify(small));
    const old = [];
    for (const r of ['home', 'practice', 'exam', 'cards', 'me', 'about', 'check', 'register', 'unlock', 'mistakes', 'sheet', 'recall', 'words']) {
      await page.goto(base + '#' + r);
      await page.waitForSelector('main');
      if (/小六/.test(await page.evaluate(() => document.body.textContent))) old.push(r);
    }
    for (const f of ['app.js', 'index.html', 'app.css', 'icon.svg', 'manifest.webmanifest']) if (/小六/.test(fs.readFileSync(path.join(SITE, f), 'utf8'))) old.push(f);
    check('the mascot is 小玛 everywhere: no page and no shipped file still says “小六”, and the welcome screen introduces her by name', old.length === 0 && /我是小玛/.test(appSrc) && /class="six"[^>]*data-mood="cheer"/.test(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')), old.join(' '));
  }
  await ctx.close();
  // the feedback panel on the smallest phone, with the longest explanation of the free questions
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 568 }, hasTouch: true }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  {
    const long = free.qs.filter((q) => q.l.includes('csp') && q.v && q.v.length).sort((a, b) => (b.e.length + b.o[0].length) - (a.e.length + a.o[0].length))[0];
    await page.evaluate((ids) => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.sess = { theme: 'principes', mode: 'todo', ids: ids, i: 0, perm: {}, ans: {} }; s.zhOn = true; localStorage.setItem('civique.v1', JSON.stringify(s)); }, [long.id, free.qs.find((q) => q.l.includes('csp') && q.id !== long.id).id]);
    await page.reload();
    await page.goto(base + '#quiz');
    await page.waitForSelector('.stem');
    await answer(page, false);
    await page.waitForSelector('.dock.fb.miss .copy');
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => {
      const vh = window.innerHeight, dock = document.querySelector('.dock .in').getBoundingClientRect(), next = document.querySelector('.dock [data-a="next"]'), nr = next.getBoundingClientRect();
      const at = document.elementFromPoint(nr.left + nr.width / 2, nr.top + nr.height / 2), why = document.querySelector('.dock .why');
      window.scrollTo(0, 0);
      const stemTop = document.querySelector('.stem').getBoundingClientRect();
      window.scrollTo(0, document.documentElement.scrollHeight);
      const lastOpt = [...document.querySelectorAll('.opts .opt')].pop().getBoundingClientRect(), dock2 = document.querySelector('.dock .in').getBoundingClientRect();
      return { share: dock.height / vh, nextIn: nr.top >= dock.top && nr.bottom <= vh, nextFree: !!at && (at === next || next.contains(at)), scrolls: why.scrollHeight >= why.clientHeight, whyShown: why.clientHeight > 40,
        stemReach: stemTop.bottom > 0 && stemTop.top < dock.top, optReach: lastOpt.bottom <= dock2.top + 1, explained: why.textContent.length };
    });
    check('feedback panel at 320x568 with a long explanation: at most ~60% of the screen, next button visible and uncovered, question and options reachable',
      m.share <= 0.63 && m.nextIn && m.nextFree && m.whyShown && m.stemReach && m.optReach && m.explained >= long.e.length && await noOverflow(page), JSON.stringify(m));
    await page.locator('.dock .why').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    check('the end of a long explanation is reached by scrolling inside the panel: source link and "report" stay usable', await page.locator('.dock .copy .report').isVisible() && await page.evaluate(() => { const r = document.querySelector('.dock .copy .report').getBoundingClientRect(), n = document.querySelector('.dock [data-a="next"]').getBoundingClientRect(); return r.bottom <= n.top + 1; }));
    const nb = await page.locator('.dock [data-a="next"]').boundingBox();
    await page.touchscreen.tap(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.waitForFunction(() => /^2 /.test((document.querySelector('.qbar .pos') || {}).textContent || ''));
    check('next works from the panel by touch', await page.locator('.dock.fb').count() === 0 && await page.locator('.dock [data-a="next"]').isDisabled());
  }
  await ctx.close();
  // contrast of white text on the solid tiles and panels, light and dark (WCAG: 3 for large bold text, 4.5 for body text)
  for (const scheme of ['light', 'dark']) {
    ({ ctx, page } = await fresh({ colorScheme: scheme }));
    await page.goto(base);
    await page.waitForSelector('[data-a="target"]');
    const ratios = await page.evaluate(() => {
      const names = ['--t-principes', '--t-institutions', '--t-droits', '--t-histoire', '--t-societe', '--g', '--red', '--ok-panel', '--bad-panel'];
      const probe = document.createElement('i'); document.body.appendChild(probe);
      const lum = (c) => { const m = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
      const out = {};
      names.forEach((n) => { probe.style.background = 'var(' + n + ')'; out[n] = Math.round(1.05 / (lum(getComputedStyle(probe).backgroundColor) + 0.05) * 100) / 100; });
      probe.style.background = 'var(--bg)'; const bg = lum(getComputedStyle(probe).backgroundColor);
      ['--ink', '--ink2', '--g-t', '--red-t'].forEach((n) => { probe.style.background = 'var(' + n + ')'; const l = lum(getComputedStyle(probe).backgroundColor); out[n] = Math.round((Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05) * 100) / 100; });
      probe.remove();
      return out;
    });
    const weak = Object.keys(ratios).filter((n) => ratios[n] < (/panel|ink|-t$/.test(n) ? 4.5 : 3));
    check('contrast in ' + scheme + ' mode: white on every theme tile, on the brand green and on the feedback panels; text colours on the ground', weak.length === 0, JSON.stringify(ratios));
    await ctx.close();
  }

  // ==== checks for: welcome, mock exam, result, mistakes (add directly under this line) ====
  console.log('welcome, mock exam, result, mistakes');
  {
    // welcome on the smallest phone: the example answers in place, 小玛 reacts, the three picks can be tapped
    ({ ctx, page } = await fresh({ viewport: { width: 320, height: 568 } }));
    await page.goto(base);
    await page.waitForSelector('.wl-try .opt');
    const fold = await page.evaluate(() => { const top = document.querySelector('.tabs').getBoundingClientRect().top; return document.querySelector('.wl-hero h1').getBoundingClientRect().top >= 0 && document.querySelector('.wl-proof').getBoundingClientRect().bottom < top && document.querySelector('.wl-try .opt').getBoundingClientRect().bottom <= top && /非官方/.test(document.querySelector('.wl-hero').innerText); });
    check('welcome at 320x568: headline with "非官方", the numbers and the first option of the example are above the fold', fold);
    const stem = (await page.locator('.wl-try .stem').innerText()).trim(), dq = free.qs.find((x) => x.q === stem);
    await page.locator('.wl-try .opt', { hasText: dq.o[0] }).click();
    await page.waitForSelector('.wl-try .copy');
    check('welcome: a right answer shows the explanation and 小玛 cheering', (await page.locator('.wl-try .copy.good').innerText()).includes(dq.e) && await page.locator('.wl-react.good .six[data-mood="cheer"]').count() === 1 && await page.locator('[data-a="demo-next"]').count() === 1);
    const picks = page.locator('.wl-next [data-a="target"]');
    const reach = [];
    for (let i = 0; i < await picks.count(); i++) {
      reach.push(await picks.nth(i).evaluate((el) => { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.left >= 0 && r.right <= innerWidth && r.height >= 56 && !!hit && el.contains(hit) && /\d+/.test(el.querySelector('.cnt b').textContent); }));
    }
    check('welcome at 320px: three pick cards, each with its number of official questions, nothing on top of them, no sideways scroll', reach.length === Object.keys(free.meta.counts).length && reach.every(Boolean) && await noOverflow(page), reach.join());
    await picks.first().click();
    await page.waitForSelector('.themes');

    // mistakes: the empty state
    await page.goto(base + '#mistakes');
    await page.waitForSelector('.empty');
    check('mistakes, empty: 小玛 sleeps, a kind line, the way back to practice and no "redo" button', await page.locator('.empty .six[data-mood="sleep"]').count() === 1 && /还没有错题/.test(await page.locator('.empty').innerText()) && await page.locator('main a.btn[href="#practice"]').count() === 1 && await page.locator('[data-a="start"]').count() === 0);

    // exam intro: the split of the real exam in the five theme colours
    await page.goto(base + '#exam');
    await page.waitForSelector('[data-a="exam-start"]');
    const mix = await page.evaluate(() => [...document.querySelectorAll('.ex-mix .mix > span')].map((s) => [Number(s.querySelector('b').textContent), getComputedStyle(s).backgroundColor, Math.round(s.getBoundingClientRect().width)]));
    const tiles = (await page.locator('.ex-hero .nums b').allInnerTexts()).map(Number);
    check('exam intro: 40 / 45 / 32 as tiles, and the five themes share the 40 questions 11 / 6 / 11 / 8 / 4, each in its own colour, wider when it has more',
      tiles.join() === '40,45,32' && mix.map((m) => m[0]).join() === '11,6,11,8,4' && mix.reduce((a, m) => a + m[0], 0) === tiles[0] && new Set(mix.map((m) => m[1])).size === 5 && mix[0][2] > mix[1][2] && mix[3][2] > mix[4][2] && mix[4][2] >= 24 && await noOverflow(page), JSON.stringify(mix));
    check('exam intro, locked: the free trial says how many questions it has and that the full exam needs unlocking', /10 题/.test(await page.locator('[data-a="exam-start"][data-v="mini"]').innerText()) && /解锁后开放/.test(await page.locator('.ex-note').innerText()) && await page.locator('.pay').count() === 1);
    await page.locator('[data-a="exam-start"]').click();
    await page.waitForSelector('#timer');
    const calm = await page.locator('main .six').count() === 0 && await page.locator('#timer.low').count() === 0 && await page.locator('[data-a="exam-flag"][aria-pressed="false"]').count() === 1 && await page.locator('.qbar [data-a="exam-quit"]').count() === 1;
    await page.locator('[data-a="exam-flag"]').click();
    await page.locator('[data-a="exam-grid"]').click();
    const cells = await page.evaluate(() => [...document.querySelectorAll('.grid40 button')].map((b) => b.className.trim()));
    await page.locator('.sheet [data-a="close"]').click();
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.exam.start = Date.now() - (s.exam.dur - 240) * 1000; localStorage.setItem('civique.v1', JSON.stringify(s)); });
    await page.reload();
    await page.waitForSelector('#timer.low');
    await page.waitForTimeout(1300);
    check('running exam: a timer, no mascot, a flag that shows in the number grid, and the timer turns warm (not red) under five minutes',
      calm && cells.length === 10 && cells[0] === 'cur flag' && /^0[34]:\d\d$/.test(await page.locator('#timer.low').innerText()) && await page.evaluate(() => { const c = getComputedStyle(document.getElementById('timer')), w = getComputedStyle(document.documentElement).getPropertyValue('--warm-t').trim(); const p = document.createElement('i'); p.style.color = w; document.body.appendChild(p); const want = getComputedStyle(p).color; p.remove(); return c.color === want; }) && await noOverflow(page), cells.join('|'));
    await page.locator('[data-a="exam-quit"]').click();
    await page.locator('[data-a="exam-quit-yes"]').click();

    // result: the same page celebrates a pass and consoles a fail
    const ids = free.qs.filter((x) => x.l.includes('csp')).slice(0, 10).map((x) => x.id);
    const seed = (score) => page.evaluate(([ids, score]) => {
      const s = JSON.parse(localStorage.getItem('civique.v1'));
      s.exams = [{ ts: Date.now(), target: 'csp', mini: true, score, n: 10, passAt: 8, secs: 125, th: { principes: [Math.min(3, score), 3], institutions: [score > 3 ? 2 : 0, 2], droits: [1, 2], histoire: [score > 5 ? 2 : 0, 2], societe: [0, 1] }, items: ids.map((id, i) => [id, i < score ? 0 : 2, '0123']) }];
      localStorage.setItem('civique.v1', JSON.stringify(s));
    }, [ids, score]);
    await seed(9);
    await page.goto(base + '#result');
    await page.reload();
    await page.waitForSelector('.res-hero');
    const passOk = await page.locator('.res-hero.pass .six[data-mood="celebrate"]').count() === 1 && await page.locator('.res-hero .confetti').count() === 1 && /通过/.test(await page.locator('.verdict-line.pass').innerText()) && await page.locator('.res-th li').count() === 5;
    await page.locator('[data-a="res-filter"][data-v="wrong"]').click();
    const onlyWrong = await page.locator('.res-list .qrow').count() === 1 && await page.locator('.res-list .m.badm').count() === 1;
    await page.locator('.res-list .qrow').first().click();
    const opened = await page.locator('.res-list .detail .copy.miss').count() === 1;
    await page.locator('[data-a="res-filter"][data-v="all"]').click();
    check('result, passed: 小玛 celebrates with confetti, five theme rows, and "只看错题" narrows the review to the wrong answers, which still open', passOk && onlyWrong && opened && await page.locator('.res-list .qrow').count() === 10 && await noOverflow(page));
    await seed(5);
    await page.reload();
    await page.waitForSelector('.res-hero');
    check('result, not passed: 小玛 consoles, no confetti, the score and how many short, in the "not yet" colour rather than red',
      await page.locator('.res-hero.fail .six[data-mood="console"]').count() === 1 && await page.locator('.res-hero .confetti').count() === 0 && (await page.locator('.big').innerText()).replace(/\s+/g, '') === '5/10' && /差\s*3\s*题/.test(await page.locator('.verdict-line.fail').innerText()) &&
      await page.evaluate(() => { const fill = getComputedStyle(document.querySelector('.res-hero .scale .track i')).backgroundColor; const p = document.createElement('i'); p.style.background = 'var(--warm)'; document.body.appendChild(p); const want = getComputedStyle(p).backgroundColor; p.remove(); return fill === want; }) && await noOverflow(page));
    await ctx.close();
  }

  // (end of: welcome, mock exam, result, mistakes)

  // --------------------------------------------------------------------------------------------------

  // ==== checks for: study cards, words, cram sheet, recollections (add directly under this line) ====
  console.log('study screens');
  if (free.cards && free.cards.length) {
    ({ ctx, page } = await fresh());
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.goto(base + '#cards');
    await page.waitForSelector('.kc');
    const tid = 'histoire', inTheme = free.cards.filter((c) => c.t === tid);
    await page.locator('.kf [data-a="cth"][data-v="' + tid + '"]').click();
    const deck = await page.evaluate(() => ({ minis: document.querySelectorAll('.kmini').length, shelves: [...document.querySelectorAll('.ks')].map((s) => s.className), pos: document.querySelector('.kc-pos').textContent.replace(/\s+/g, ''), card: document.querySelector('.kc').className, pressed: [...document.querySelectorAll('.kf [aria-pressed="true"]')].map((b) => b.dataset.v).join() }));
    check('study cards: a theme chip shows only the cards of that theme, with the position in the deck',
      inTheme.length > 0 && deck.minis === inTheme.length && deck.shelves.length === 1 && deck.shelves[0].includes('t-' + tid) && deck.pos === '第1/' + inTheme.length + '张' && deck.card.includes('t-' + tid) && deck.pressed === tid, JSON.stringify(deck));
    const lockedIn = inTheme.findIndex((c) => c.x);
    if (lockedIn >= 0) {
      await page.locator('.kmini').nth(lockedIn).click();
      const lk = await page.evaluate(() => ({ title: document.querySelector('.kc.lk h2').textContent, points: document.querySelectorAll('.kc .facts li').length, lead: document.querySelector('.kc .kc-lead').textContent.length }));
      await page.locator('.kc.lk [data-a="locked"]').click();
      check('study cards: a locked card shows its title and lead, no points, and one tap leads to the offer',
        inTheme[lockedIn].title.startsWith(lk.title) && lk.points === 0 && lk.lead > 5 && await page.locator('.sheet [data-a="goto"][data-v="unlock"]').count() === 1, JSON.stringify(lk));
      await page.locator('.sheet [data-a="close"]').click();
    }
    await page.locator('.kf [data-a="cth"][data-v=""]').click();
    await page.locator('.kc-nav .btn').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const second = (await page.locator('.kc-pos').innerText()).replace(/\s+/g, '');
    await page.locator('.kc-nav .sq').click();
    await page.locator('.kc-nav .sq').click();
    check('study cards: next and previous walk the deck, by keyboard too; no sideways scroll with the shelves',
      second === '第3/' + free.cards.length + '张' && (await page.locator('.kc-pos').innerText()).replace(/\s+/g, '') === '第1/' + free.cards.length + '张' && await page.locator('.kc-nav .sq').isDisabled() && await page.locator('.kmini[aria-current="true"]').count() === 1 && await noOverflow(page), second);
    // words: everything the open questions teach is on the list, and the Chinese can be hidden to test oneself
    await page.goto(base + '#words');
    await page.waitForSelector('.words');
    const want = [...new Set(free.qs.filter((q) => q.l.includes('csp')).flatMap((q) => (q.v || []).map((v) => v[0].toLowerCase())))].sort();
    const got = (await page.locator('.words .w').allTextContents()).map((w) => w.trim().toLowerCase()).sort();
    await page.locator('[data-a="wmask"]').click();
    const hidden = await page.locator('.words .peek').count(), zhLeft = await page.locator('.words span.z').count();
    await page.locator('.words .peek').first().click();
    check('words: every word of the open questions is listed once, with a count; the Chinese can be hidden and shown word by word',
      want.length > 10 && JSON.stringify(got) === JSON.stringify(want) && (await page.locator('.w-n b').innerText()).trim() === String(want.length) && hidden === want.length && zhLeft === 0 &&
      await page.locator('.words span.z').count() === 1 && await page.locator('.words .peek').count() === want.length - 1, got.length + ' / ' + want.length + ' / ' + hidden);
    await ctx.close();
  }
  for (const scheme of ['light', 'dark']) {
    ({ ctx, page } = await fresh({ colorScheme: scheme }));
    await page.goto(base + '#sheet');
    await page.waitForSelector('#fig-map .sh-svg');
    const figs = await page.evaluate(() => [...document.querySelectorAll('.sh-fig')].map((f) => {
      const s = f.querySelector('.sh-svg').getBoundingClientRect(), z = f.querySelector('.sh-zoom'), zr = z.getBoundingClientRect(), bar = getComputedStyle(f.querySelector('figcaption')).backgroundColor;
      return { id: f.id, w: Math.round(s.width), h: Math.round(s.height), zoom: z.textContent.trim(), zw: Math.round(zr.width), zh: Math.round(zr.height), bar, shapes: f.querySelectorAll('.sh-svg rect, .sh-svg path').length };
    }));
    let opened = 0;
    for (const f of figs) {
      await page.locator('#' + f.id + ' .sh-zoom').click();
      if (await page.locator('.veil .sh-zoomed .sh-svg').count() === 1) opened++;
      await page.locator('.sheet [data-a="close"]').click();
    }
    check('the sheet in ' + scheme + ' mode: three drawings with a real size, a coloured title bar and a 放大 button that opens each one larger',
      figs.length === 3 && figs.every((f) => f.w > 300 && f.h > 200 && f.shapes > 10 && f.zoom === '放大' && f.zw >= 44 && f.zh >= 38 && !/rgba\(0, 0, 0, 0\)|255, 255, 255/.test(f.bar)) && opened === 3, JSON.stringify(figs));
    if (scheme === 'light') {
      await page.emulateMedia({ media: 'print' });
      const paper = await page.evaluate(() => {
        const dark = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.length > 3 && m[3] === 0 ? null : (m[0] + m[1] + m[2]) / 3; };
        const bad = [];
        document.querySelectorAll('.sheetpage *').forEach((e) => {
          if (!e.getClientRects().length || e.closest('.sh-pic')) return;
          const cs = getComputedStyle(e), bg = dark(cs.backgroundColor);
          if (bg !== null && bg < 235) bad.push(e.className + ' bg ' + cs.backgroundColor);
          if (e instanceof SVGElement && cs.fill !== 'none' && /^(rect|path)$/.test(e.tagName) && !/v-(city|top|peak)/.test(e.getAttribute('class') || '') && !e.closest('.hexic') && dark(cs.fill) !== null && dark(cs.fill) > 20 && dark(cs.fill) < 235) bad.push((e.getAttribute('class') || e.tagName) + ' fill ' + cs.fill);
        });
        return { bad: [...new Set(bad)].slice(0, 6), hidden: ['.tabs', '.seg', '.sh-zoom', '.sh-top .chip'].every((s) => [...document.querySelectorAll(s)].every((e) => !e.getClientRects().length)) };
      });
      const pdf = (await page.pdf({ format: 'A4', preferCSSPageSize: true })).toString('latin1');
      const pages = (pdf.match(/\/Type\s*\/Page\b/g) || []).length;
      check('the sheet prints black on white, without the app chrome, on 2 to 4 pages', paper.bad.length === 0 && paper.hidden && pages >= 2 && pages <= 4, pages + ' pages ' + JSON.stringify(paper));
      await page.emulateMedia({ media: 'screen' });
    }
    await ctx.close();
  }
  if ((free.recall || []).length) {
    ({ ctx, page } = await fresh());
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.goto(base + '#recall');
    await page.waitForSelector('.rc-feed');
    const rc = await page.evaluate(() => {
      const n = document.querySelector('.rc-note'), r = n.getBoundingClientRect(), b = document.querySelector('[data-a="start"][data-v="all|recall"]').getBoundingClientRect();
      return { text: n.innerText, top: r.top, bottom: r.bottom, btn: b.bottom, vh: window.innerHeight, nums: [...document.querySelectorAll('.rc-nums b')].map((x) => Number(x.textContent)), months: document.querySelectorAll('.rc-m').length, sess: document.querySelectorAll('.rc-s').length, dots: document.querySelectorAll('.rq[class*="t-"] .i').length, rows: document.querySelectorAll('.rc-s .qlist.inner > li').length };
    });
    const ids = new Set(), seen = {};
    free.recall.forEach((r) => r.i.forEach((x) => { if (x.r) { ids.add(x.r); seen[x.r] = (seen[x.r] || 0) + 1; } }));
    check('recollections: "not official, from the web, may be inaccurate" and the practise button are on the first screen without opening anything',
      /非官方/.test(rc.text) && /来源于网络/.test(rc.text) && /不是官方/.test(rc.text) && /可能有出入/.test(rc.text) && rc.top >= 0 && rc.bottom < rc.vh / 2 && rc.btn < rc.vh, JSON.stringify(rc));
    check('recollections: the three big numbers come from the data; sessions are grouped under month pills and each question carries its theme colour',
      rc.nums[0] === free.recall.length && rc.nums[1] === ids.size && rc.nums[2] === Object.keys(seen).filter((k) => seen[k] >= 2).length && rc.sess === free.recall.length &&
      rc.months === new Set(free.recall.map((r) => r.w)).size && rc.rows > 0 && rc.dots === rc.rows && await noOverflow(page), JSON.stringify(rc));
    await ctx.close();
  }

  // (end of: study cards, words, cram sheet, recollections)

  // --------------------------------------------------------------------------------------------------

  // ==== checks for: registration, self-check, about, payment states (add directly under this line) ====

  console.log('registration, self-check, about, payment states');
  ({ ctx, page } = await fresh());
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  await page.goto(base + '#register');
  await page.waitForSelector('.chips .chip');
  {
    const first = await page.evaluate(() => [...document.querySelectorAll('.steps > li')].map((li) => li.classList.contains('on')));
    const seen = [];
    for (let i = 0; i < 7; i++) {
      await page.locator('.step-h').nth(i).click();
      seen.push(await page.evaluate((i) => { const lis = [...document.querySelectorAll('.steps > li')], on = lis.filter((li) => li.classList.contains('on'));
        return on.length === 1 && lis.indexOf(on[0]) === i && document.querySelectorAll('.step-b').length === 1 && on[0].querySelector('.step-h').getAttribute('aria-expanded') === 'true' &&
          document.querySelectorAll('.step-h[aria-expanded="true"]').length === 1 && on[0].querySelectorAll('.step-b > p').length >= 1 && on[0].querySelectorAll('.step-b > p').length <= 2 && on[0].querySelector('.step-h b').textContent.length <= 5; }, i));
    }
    check('registration: the first step is open at the start, exactly one step is open at a time and all seven open in turn, each with at most two lines',
      first.length === 7 && first[0] && first.filter(Boolean).length === 1 && seen.length === 7 && seen.every(Boolean), JSON.stringify([first, seen]));
    await page.locator('.step-h').nth(0).click();
    await page.locator('.step-n').click();
    const second = await page.evaluate(() => document.querySelectorAll('.steps > li.on').length === 1 && document.querySelectorAll('.steps > li')[1].classList.contains('on'));
    await page.locator('.step-h').nth(5).click();
    const toExam = await page.locator('.step-b a[href="#exam"]').count();
    await page.locator('.step-h').nth(0).click();
    check('registration: "next step" opens the following step; step 6 leads to the mock exam and step 1 to the self-check', second && toExam === 1 && await page.locator('.step-b a[href="#check"]').count() === 1);
    const centres = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'centres.json'), 'utf8'));
    const regText = await page.locator('main').evaluate((m) => m.textContent);
    const notes = [/France Éducation International/, /考场会增减/, /官方地图/, /巴黎工商会的考场不在这份名单里/, /位置只在你的手机上用来计算距离，不会上传/, /直线距离/, /费用由各考场自己定/, /报名和交费都在官方机构的网站上完成/, /本站不代办、不收报名费/];
    const missing = notes.filter((re) => !re.test(regText)).map(String);
    check('registration: every honesty note of the centre finder is on the page (source and its date, the other organiser, position stays on the device, straight-line distance, fees, no booking through this site)',
      missing.length === 0 && regText.includes(centres.asof) && await page.locator('.fd-notes a[href*="france-education-international.fr"]').count() === 1 && await page.locator('.fd-notes a[href*="cci-paris-idf.fr/candidat?produit=21"]').count() === 1 &&
      /不代办、不收报名费/.test(await page.locator('.reg-own').innerText()), missing.join(' '));
    await page.locator('.topbar [data-a="cfind"]').click();
    await page.locator('[data-a="cq"]').first().click();
    await page.waitForSelector('.centre .c-acts');
    const acts = await page.evaluate(() => [...document.querySelectorAll('.centre')].map((c) => ({ map: c.querySelectorAll('.c-acts a[href^="https://www.google.com/maps/"]').length, n: c.querySelectorAll('.c-acts a').length, h: Math.min(...[...c.querySelectorAll('.c-acts a')].map((a) => a.getBoundingClientRect().height)), cp: /\d{5}/.test(c.querySelector('.ca').textContent), name: c.querySelector('.cn').textContent.length > 1 })));
    check('registration: a centre card shows the name, the postcode and city, and up to three actions (phone, site, map) of a tappable size',
      acts.length > 0 && acts.every((a) => a.map === 1 && a.n >= 1 && a.n <= 3 && a.h >= 40 && a.cp && a.name), JSON.stringify(acts.slice(0, 3)));
  }
  {
    const walk = async (picks) => { await page.goto(base + '#about'); await page.goto(base + '#check'); if (await page.locator('.chk-said li').count()) await page.locator('[data-a="chk-back"][data-v="0"]').first().click(); for (const l of picks) await page.locator('.chk-opt', { hasText: l }).first().click(); await page.waitForSelector('.chk-res'); };
    const got = {};
    for (const [v, picks, mood] of [['yes', ['多年居留卡', '未满 65', '工薪', '没有'], 'cheer'], ['no', ['续签'], 'celebrate'], ['maybe', ['申请入籍', '不清楚'], 'neutral']]) {
      await walk(picks);
      got[v] = await page.evaluate(([v, n, mood]) => { const r = document.querySelector('.chk-res'); return r.classList.contains(v) && r.querySelector('.six').dataset.mood === mood && r.querySelectorAll('.facts li').length >= 1 &&
        document.querySelectorAll('.chk-src a[href^="https://"]').length >= 1 && [...document.querySelectorAll('.chk-src a')].every((a) => /service-public\.gouv\.fr|interieur\.gouv\.fr/.test(a.href)) &&
        document.querySelectorAll('.chk-said li [data-a="chk-back"]').length === n && document.querySelectorAll('.chk-prog i.done').length === n && !document.querySelector('.chk-prog i:not(.done)') &&
        /不是法律意见/.test(document.querySelector('.chk-legal').innerText) && /欧盟/.test(document.querySelector('.chk-legal').innerText) && /查阅于 \d{4}-\d\d-\d\d/.test(document.querySelector('.chk-legal').textContent); }, [v, picks.length, mood]);
    }
    await page.goto(base + '#about'); await page.goto(base + '#check');
    await page.locator('[data-a="chk-back"][data-v="0"]').first().click();
    const start = await page.evaluate(() => ({ dots: document.querySelectorAll('.chk-prog i').length, now: document.querySelectorAll('.chk-prog i.now').length, done: document.querySelectorAll('.chk-prog i.done').length }));
    await page.locator('.chk-opt', { hasText: '多年居留卡' }).first().click();
    const second = await page.evaluate(() => ({ dots: document.querySelectorAll('.chk-prog i').length, done: document.querySelectorAll('.chk-prog i.done').length, chips: document.querySelectorAll('.chk-said li').length }));
    check('self-check: the three verdicts (must, need not, to confirm) are all reachable, each with its 小玛, reasons, at least one official link and the legal note; progress dots follow the answers',
      got.yes && got.no && got.maybe && start.dots === 4 && start.now === 1 && start.done === 0 && second.dots === 4 && second.done === 1 && second.chips === 1, JSON.stringify([got, start, second]));
  }
  {
    await page.goto(base + '#about');
    await page.waitForSelector('.faq');
    const t = await page.locator('main').evaluate((m) => m.textContent);
    const need = [/知识题的题干是内政部公布的官方题目/, /官方没有公布选项，本站的选项、中文翻译和讲解是自己编写的/, /情景题官方没有公布，本站的情景题是按官方讲义编写的练习题/, /正式考试的选项措辞会和这里不同/, /练习记录只保存在你这台设备上/, /不要求注册/];
    const lost = need.filter((re) => !re.test(t)).map(String);
    const tiles = (await page.locator('.faq .nums b').allInnerTexts()).join(',');
    check('about: what is official and what this site wrote (four statements), privacy, the exam in three numbers, a way to the self-check',
      lost.length === 0 && tiles === '40,45,32' && await page.locator('.faq a[href="#check"]').count() === 1 && await page.locator('.faq details[open]').count() === 1, lost.join(' ') + ' ' + tiles);
  }
  await ctx.close();
  {
    ({ ctx, page } = await fresh());
    let reply = { error: 'pending' }, wait = 0;
    await page.route('**/api/unlock', async (route) => { if (wait) await new Promise((r) => setTimeout(r, wait)); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) }); });
    await page.goto(base + '?paid=cs_live_STATE0000001');
    await page.waitForSelector('.pay-state.wait');
    const waiting = await page.evaluate(() => ({ retry: document.querySelectorAll('.pay-state [data-a="pay-retry"]:not([disabled])').length, msg: document.querySelector('.pay-state .msg.bad').textContent, six: !!document.querySelector('.pay-state .six') }));
    wait = 1500;
    await page.locator('[data-a="pay-retry"]').click();
    await page.waitForSelector('.pay-state.busy');
    const busy = await page.evaluate(() => ({ bar: document.querySelectorAll('.pay-state .ps-bar').length, off: document.querySelector('.pay-state [data-a="pay-retry"]').disabled, h: document.querySelector('.pay-state h2').textContent, again: /不用再付一次/.test(document.querySelector('.pay-state').textContent) }));
    await page.waitForSelector('.pay-state.wait');
    wait = 0; reply = { error: 'not_paid' };
    await page.locator('[data-a="pay-retry"]').click();
    await page.waitForSelector('.pay-state.fail');
    const failed = await page.evaluate(() => ({ h: document.querySelector('.pay-state h2').textContent, msg: document.querySelector('.pay-state .msg.bad').textContent, retry: document.querySelectorAll('[data-a="pay-retry"]').length, find: document.querySelectorAll('.pay-state [data-a="pay-find"]').length, gets: document.querySelectorAll('.gets .tile').length }));
    await page.locator('[data-a="pay-find"]').click();
    check('payment states on the unlock page: waiting (with a way to confirm again), confirming (progress cue, button off, "no need to pay twice"), not confirmed (what to do next, the rest of the offer still there)',
      waiting.retry === 1 && /处理中/.test(waiting.msg) && waiting.six && busy.bar === 1 && busy.off && /正在确认/.test(busy.h) && busy.again &&
      /没有确认/.test(failed.h) && /没有完成/.test(failed.msg) && failed.retry === 0 && failed.find === 1 && failed.gets >= 3 && (await state(page)).pending === null &&
      await page.locator('#find-code[open] #mail').count() === 1 && await noOverflow(page), JSON.stringify([waiting, busy, failed]));
    await ctx.close();
  }

  // (end of: registration, self-check, about, payment states)

  // ---- reading French aloud: a French voice is chosen, never the phone's default one
  console.log('speech');
  {
    // these three checks are about the phone's own voice, the fallback: recordings are switched off for them
    const fakeSpeech = (voices) => `(() => { const said = []; window.__said = said; try { Object.defineProperty(window, 'Audio', { value: undefined, configurable: true }); } catch (e) {}
      class U { constructor(t) { this.text = t; this.lang = ''; this.voice = null; this.rate = 1; } }
      window.SpeechSynthesisUtterance = U;
      const synth = { getVoices: () => ${JSON.stringify(voices)}, cancel() {}, speak(u) { said.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name }); }, addEventListener() {} };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true }); })();`;
    ({ ctx, page } = await fresh());
    await ctx.addInitScript(fakeSpeech([{ name: '婷婷', lang: 'zh-CN', localService: true }, { name: 'Samantha', lang: 'en-US', localService: true }, { name: 'Amélie', lang: 'fr-CA', localService: true }, { name: 'Thomas', lang: 'fr-FR', localService: true }]));
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    await page.locator('[data-a="continue"]').click();
    await page.waitForSelector('[data-a="say"]');
    await page.locator('[data-a="say"]').first().click();
    let said = await page.evaluate(() => window.__said);
    check('listening uses a French voice from France, not the phone\'s default voice', said.length === 1 && said[0].voice === 'Thomas' && said[0].lang === 'fr-FR', JSON.stringify(said));
    const spoken = await page.evaluate(() => { const out = []; const synth = window.speechSynthesis; const keep = synth.speak; synth.speak = (u) => out.push(u.text);
      for (const t of ['La Ve République', 'au XIXe siècle', 'Louis XVI', 'Napoléon Ier', 'François Ier', 'le 1er janvier', 'madame X', 'C\'est Victor Hugo']) { const b = document.createElement('button'); b.setAttribute('data-a', 'word'); b.setAttribute('data-v', t); document.body.appendChild(b); b.click(); b.remove(); }
      synth.speak = keep; return out; });
    check('roman numerals are read as numbers, ordinary capitals are left alone', spoken.join(' | ') === 'La 5e République | au 19e siècle | Louis 16 | Napoléon 1er | François 1er | le 1er janvier | madame X | C\'est Victor Hugo', spoken.join(' | '));
    await ctx.close();
    ({ ctx, page } = await fresh());
    await ctx.addInitScript(fakeSpeech([{ name: '婷婷', lang: 'zh-CN', localService: true }, { name: 'Samantha', lang: 'en-US', localService: true }]));
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    await page.locator('[data-a="continue"]').click();
    await page.waitForSelector('[data-a="say"]');
    await page.locator('[data-a="say"]').first().click();
    await page.waitForSelector('#saynote');
    said = await page.evaluate(() => window.__said);
    check('a phone that lists no French voice still gets the French request, with a warning that it may be poor', said.length === 1 && said[0].lang === 'fr-FR' && !said[0].voice && /没有找到法语语音/.test(await page.locator('#saynote').innerText()), JSON.stringify(said));
    await ctx.close();
  }

  // ---- recordings: what is read aloud comes from site/audio, the same on every phone
  console.log('recordings');
  {
    const tool = await import(require('url').pathToFileURL(path.resolve(__dirname, 'audio_names.mjs')).href);
    const fileOf = (text) => { const n = tool.clipName(text); return path.join(SITE, 'audio', n.slice(0, 2), n + '.mp3'); };
    const need = new Set();
    for (const q of free.qs) { need.add(q.q); for (const o of q.o) need.add(o); for (const v of q.v || []) need.add(v[0]); }
    for (const c of free.cards || []) for (const v of c.v || []) need.add(v[0]);
    const lost = [...need].filter((x) => !fs.existsSync(fileOf(x)));
    check('every stem, option and vocabulary entry of the free questions has a recording', need.size > 300 && lost.length === 0, lost.length + ' missing of ' + need.size + ': ' + lost.slice(0, 3).join(' | '));
    ({ ctx, page } = await fresh());
    const asked = [];
    page.on('request', (r) => { if (/\/audio\//.test(r.url())) asked.push(r.url()); });
    await ctx.addInitScript(() => { const said = []; window.__said = said; class U { constructor(t) { this.text = t; } }
      window.SpeechSynthesisUtterance = U; Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], cancel() {}, speak(u) { said.push(u.text); }, addEventListener() {} }, configurable: true });
      const play = HTMLMediaElement.prototype.play; window.__played = []; HTMLMediaElement.prototype.play = function () { window.__played.push(this.src); return play.call(this); }; });
    await page.goto(base);
    await page.locator('[data-a="target"][data-v="csp"]').click();
    await page.waitForSelector('.themes');
    await page.locator('[data-a="continue"]').click();
    await page.waitForSelector('[data-a="say"]');
    const stemText = (await page.locator('.stem').first().innerText()).trim();
    await page.locator('[data-a="say"]').first().click();
    await page.waitForFunction(() => window.__played.length > 0);
    const want = tool.clipName(stemText);
    const first = await page.evaluate(() => window.__played[0]);
    check('"listen" plays the recording of the question, not the phone\'s voice', first.endsWith('/audio/' + want.slice(0, 2) + '/' + want + '.mp3') && (await page.evaluate(() => window.__said.length)) === 0, first);
    const names = await page.evaluate((list) => { /* same key in the page and in the tool */ const out = []; for (const t of list) { const b = document.createElement('button'); b.setAttribute('data-a', 'word'); b.setAttribute('data-v', t); document.body.appendChild(b); window.__played.length = 0; b.click(); out.push(window.__played[0] || ''); b.remove(); } return out; }, ['l’infraction', 'Liberté, Égalité, Fraternité', 'LA  LAÏCITÉ']);
    check('the page and the recording tool agree on file names', names.every((u, i) => u.endsWith(tool.clipName(['l’infraction', 'Liberté, Égalité, Fraternité', 'LA  LAÏCITÉ'][i]) + '.mp3')), names.join(' '));
    await page.evaluate(() => { window.__played.length = 0; const b = document.createElement('button'); b.setAttribute('data-a', 'word'); b.setAttribute('data-v', 'un mot qui n’a pas de fichier zzz'); document.body.appendChild(b); b.click(); b.remove(); });
    await page.waitForFunction(() => window.__said.length > 0, null, { timeout: 8000 });
    check('a text with no recording falls back to the phone\'s voice', (await page.evaluate(() => window.__said[0])) === 'un mot qui n’a pas de fichier zzz');
    await ctx.close();
  }

  console.log('layouts');
  ({ ctx, page } = await fresh({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  check('no sideways scroll on desktop', await noOverflow(page));
  await shot(page, '17-home-desktop-dark');
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  await answer(page, false);
  await shot(page, '18-wrong-desktop-dark');
  await ctx.close();
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="cr"]').click();
  await page.waitForSelector('.themes');
  check('no sideways scroll at 320px', await noOverflow(page));
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  await answer(page, true);
  check('no sideways scroll at 320px in a question', await noOverflow(page));
  await shot(page, '19-question-320');
  await ctx.close();

  check('no script errors in the browser', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  srv.close();
  console.log(`\n${passed} passed, ${failed} failed` + (fullCount ? ` (bank: ${fullCount} questions)` : ''));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
