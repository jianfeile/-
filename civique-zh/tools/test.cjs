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

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
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
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const errors = [];
  async function fresh(opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1, locale: 'zh-CN' }, opts || {}));
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
  check('asks which card on first visit', await page.locator('text=你要申请哪一种居留卡').count() === 1);
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
  await page.waitForSelector('.stem');
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
      by('P') === 5 && by('SP') === 6 && by('I') === 6 && by('D') === 5 && by('SD') === 6 && by('H') === 8 && by('V') === 4,
      [by('P'), by('SP'), by('I'), by('D'), by('SD'), by('H'), by('V')].join(','));
    check('timer starts at 45 minutes', /^4[45]:/.test(await page.locator('#timer').innerText()));
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

    ({ ctx, page } = await fresh());
    await page.goto(base + '?code=' + CODE);
    await page.waitForSelector('text=已解锁全部题目', { timeout: 20000 });
    check('payment redirect with ?code= unlocks', true);
    check('the code is removed from the address bar', !/code=/.test(page.url()), page.url());
    await ctx.close();
  } else console.log('unlock checks skipped (no CIVIQUE_CODE)');

  // ---- 8. wide screen and dark theme
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
