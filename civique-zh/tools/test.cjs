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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// ---- a stand-in for Stripe: the unlock function is the real one, only its calls to Stripe are answered here
const SESSIONS = {
  cs_live_PAID00000001: { livemode: true, status: 'complete', payment_status: 'paid', payment_link: 'plink_ours', customer_details: { email: 'buyer@example.com' } },
  cs_live_PROC00000001: { livemode: true, status: 'complete', payment_status: 'unpaid', payment_link: 'plink_ours', customer_details: { email: 'slow@example.com' } },
  cs_live_OTHER0000001: { livemode: true, status: 'complete', payment_status: 'paid', payment_link: 'plink_other', customer_details: { email: 'other@example.com' } },
  cs_test_PAID00000001: { livemode: false, status: 'complete', payment_status: 'paid', payment_link: 'plink_ours', customer_details: { email: 'tester@example.com' } },
};
for (const id of Object.keys(SESSIONS)) Object.assign(SESSIONS[id], { id, object: 'checkout.session' });
const ENV = { STRIPE_KEY: 'rk_live_standin', PAYMENT_LINK: 'plink_ours', CONTENT_KEY: Buffer.alloc(32, 7).toString('base64') };
async function stripeStandIn(url, opts) {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if ((opts.headers.authorization || '') !== 'Bearer ' + ENV.STRIPE_KEY) return reply(401, { error: { message: 'bad key' } });
  const u = new URL(url);
  const one = /^\/v1\/checkout\/sessions\/([A-Za-z0-9_]+)$/.exec(u.pathname);
  if (one) return SESSIONS[one[1]] ? reply(200, SESSIONS[one[1]]) : reply(404, { error: { message: 'no such session' } });
  if (u.pathname === '/v1/checkout/sessions') {
    const email = u.searchParams.get('customer_details[email]'), link = u.searchParams.get('payment_link'), status = u.searchParams.get('status');
    const data = Object.values(SESSIONS).filter((x) => x.customer_details.email === email && (!link || x.payment_link === link) && (!status || x.status === status));
    return reply(200, { object: 'list', data });
  }
  return reply(404, {});
}
let core = null;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
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
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const errors = [];
  async function fresh(opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, locale: 'zh-CN', serviceWorkers: 'block' }, opts || {}));
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
  check('explanation names the right letter', /正确答案是 [ABCD]/.test(await page.locator('.copy.miss h3').innerText()));
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
  await page.waitForSelector('.facts');
  check('about page renders', await page.locator('text=关于公民考试').count() === 1);
  await shot(page, '13-about');
  // study cards (locked)
  await page.goto(base + '#cards');
  await page.waitForSelector('main');
  if (free.cards && free.cards.length) {
    const openable = free.cards.filter((c) => !c.x).length, lockedCards = free.cards.length - openable;
    check('study cards: every card is listed', await page.locator('.crow').count() === free.cards.length);
    await page.locator('.crow[data-a="open"]').first().click();
    check('a free study card opens with its points and the official sheet link', await page.locator('.detail .facts li').count() >= 3 && await page.locator('.detail a[href^="https://formation-civique"]').count() >= 1);
    check('no sideways scroll on an open study card', await noOverflow(page));
    await shot(page, '22-cards');
    if (lockedCards) {
      await page.locator('.crow[data-a="locked"]').first().click();
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
    check('home says unlocked and hides the offer', await page.locator('.pay').count() === 0 && await page.locator('text=已解锁全部题目').count() === 1);
    if (free.cards && free.cards.length) {
      await page.goto(base + '#cards');
      await page.waitForSelector('.crow');
      check('unlocked: every study card can be opened', await page.locator('.crow[data-a="locked"]').count() === 0 && await page.locator('.crow[data-a="open"]').count() === free.cards.length);
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
      await page.goto(base + '#home');
      await page.locator('[data-a="target"][data-v="nat"]').click();
      await page.goto(base + '#exam');
      await page.locator('[data-a="exam-start"][data-v="full"]').click();
      await page.waitForSelector('#timer');
      st = await state(page);
      check('the naturalisation exam also has 40 different questions', st.exam.ids.length === 40 && new Set(st.exam.ids).size === 40, String(st.exam.ids.length));
      await page.locator('[data-a="exam-quit"]').click();
      await page.locator('[data-a="exam-quit-yes"]').click();
      await page.goto(base + '#home');
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
    await page.goto(base + '#about');
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
    check('questions reported twice are counted', /1<\/span> 道被不同的人提到两次以上/.test(await page.locator('main').innerHTML()));
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
  check('sheet.json: 50 to 75 items, each with a key and a meaning, no addresses or links',
    sheetItems.length >= 50 && sheetItems.length <= 75 && sheetItems.every((it) => it.k && it.k.trim() && it.v && it.v.trim()) &&
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
  const shown = await page.evaluate(() => [...document.querySelectorAll('.sh-card')].map((c) => ({ t: c.querySelector('h3').textContent, items: [...c.querySelectorAll('li')].map((li) => [li.querySelector('.k').textContent, li.querySelector('.v').firstChild.textContent.trim(), (li.querySelector('.v [lang="fr"]') || {}).textContent || '']) })));
  check('every group and item of sheet.json is on the page, and the scenario rule too',
    JSON.stringify(shown) === JSON.stringify(sheet.groups.map((g) => ({ t: g.title, items: g.items.map((it) => [it.k, it.v, it.fr || '']) }))) &&
    await page.locator('.sh-rule ol li').count() === sheet.rule.points.length && (await page.locator('.sh-rule p').innerText()) === sheet.rule.lead &&
    (await page.locator('.sh-exam').innerText()).replace(/\s+/g, ' ').includes('40') && await page.locator('.sh-card .k.hl').count() === sheetItems.filter((it) => it.hl).length);
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
  check('the sheet opens directly before any exam type is chosen, no sideways scroll at 320px', await noOverflow(page) && await page.locator('.sh-card').count() === sheet.groups.length);
  await page.goto(base + '#home');
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.quick a[href="#sheet"]');
  check('home links to the sheet and still fits at 320px', await noOverflow(page) && await page.evaluate(() => [...document.querySelectorAll('.quick a')].every((a) => a.scrollWidth <= a.clientWidth + 1)));
  await shot(page, '28-sheet-320');
  await ctx.close();

  // ---- registering for the real exam: steps and the centre finder
  console.log('registration page');
  ({ ctx, page } = await fresh({ geolocation: { latitude: 45.764, longitude: 4.8357 }, permissions: ['geolocation'] }));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="cr"]').click();
  await page.waitForSelector('.themes');
  await page.locator('.tabs a[href="#register"]').click();
  await page.waitForSelector('.chips .chip');
  check('registration page lists the steps and names the chosen exam', await page.locator('.steps > li').count() === 7 && await page.locator('.steps >> text=十年居留卡').count() >= 1);
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
  check('no sideways scroll at 320px with centres and six tabs', await noOverflow(page) && await page.locator('.tabs li').count() === 6);
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
  check('home ring starts empty and shows the total from the data', await page.locator('.ring .arc').count() === 0 && (await page.locator('.ring').getAttribute('aria-label')).replace(/\s+/g, '') === '已掌握0/' + csp + '题' && await page.locator('.hero-fact').count() === 0, await page.locator('.ring').getAttribute('aria-label'));
  check('each theme has an icon and the home actions fit at 320px', await page.locator('.theme .ti svg').count() === 5 && await page.locator('.hero [data-a="continue"]').count() === 1 && await page.locator('.hero a[href="#exam"]').count() === 1 && await page.locator('.quick a').count() === 3 && await noOverflow(page));
  await page.locator('[data-a="continue"]').click();
  await page.waitForSelector('.stem');
  await answer(page, true);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('civique.v1')); s.exams = [{ ts: 1, target: 'csp', mini: true, score: 9, n: 10, passAt: 8, th: {}, items: [] }, { ts: 2, target: 'csp', mini: false, score: 30, n: 40, passAt: 32, th: {}, items: [] }, { ts: 3, target: 'cr', mini: false, score: 39, n: 40, passAt: 32, th: {}, items: [] }]; localStorage.setItem('civique.v1', JSON.stringify(s)); });
  await page.goto(base + '#home');
  await page.reload();
  await page.waitForSelector('.themes');
  check('home ring counts a mastered question and the best full exam of this type is shown', await page.locator('.ring .arc').count() === 1 && (await page.locator('.ring .n').innerText()).trim() === '1' && (await page.locator('.hero-fact b').innerText()).trim() === '30/40' && await page.locator('.hero-fact b.pass').count() === 0, await page.locator('.hero-fact').innerText());
  console.log('offer');
  ({ ctx, page } = await fresh({ viewport: { width: 320, height: 640 } }));
  await page.goto(base + '#cards');
  await page.waitForSelector('.crow');
  check('the compact offer also shows before an exam is chosen', await page.locator('.pay').count() === 1 && await page.locator('.pay a[href="#unlock"]').count() === 1 && (await page.locator('.pay-facts b').first().innerText()).trim() === String(free.meta.total));
  await page.goto(base);
  await page.locator('[data-a="target"][data-v="csp"]').click();
  await page.waitForSelector('.themes');
  await page.goto(base + '#unlock');
  await page.waitForSelector('.cmp');
  {
    const csp = free.meta.counts.csp, all = Object.values(csp).reduce((n, c) => n + c.c + c.s, 0), open = free.qs.filter((q) => q.l.includes('csp')).length;
    const cells = await page.locator('.cmp tbody tr').first().locator('td b').allInnerTexts();
    check('the offer compares the free trial with the full bank, counted from the data', cells.join('|') === open + '|' + all && (await page.locator('.offer-h').innerText()).includes(String(free.meta.total)), cells.join('|'));
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
    await page.waitForSelector('.cmp');
    check('the price of config.js is written on the button of the offer, with the terms under it, and on the unlock page', price !== '' && payBtn.includes('解锁全部') && payBtn.includes(price) && /一次付款，不是订阅，长期使用/.test(payTerms) && (await page.locator('.offer-price').innerText()).includes(price), payBtn + ' / ' + payTerms);
    check('the unlock page still says the official material is free, and when the bank was built', /官方的备考资料是免费的/.test(await page.locator('.offer-honest').innerText()) && (await page.locator('.bank-asof').innerText()).includes(free.built));
    await page.goto(base + '#about');
    await page.waitForSelector('.bank-asof');
    const asof = await page.locator('.bank-asof').innerText();
    check('about: date of the bank, date the official list was read, number of questions', asof.includes('题库更新于 ' + free.built) && asof.includes('官方题目清单查阅于 ' + free.consulted) && asof.includes(String(free.meta.total)), asof);
    // no contact in the settings: the question number in a sheet, with a copy button
    await page.goto(base + '#home');
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
      Object.defineProperty(window, 'CIVIQUE_CONFIG', { configurable: true, get: () => cfg, set: (v) => { cfg = Object.assign(v, { contact: 'aide@example.com', payUrl: 'https://pay.example.com/x' }); } });
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
    await page.waitForSelector('.cmp');
    const payBtns = await page.locator('.buy a.btn').allInnerTexts();
    check('unlock page: every pay button carries the price and the terms sit under it', payBtns.length === 2 && payBtns.every((t) => t.includes(price)) && (await page.locator('.buy-terms').allInnerTexts()).every((t) => /一次付款，不是订阅，长期使用/.test(t)) && (await page.locator('.buy a.btn').first().getAttribute('href')).startsWith('https://pay.example.com/x'), payBtns.join(' | '));
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
