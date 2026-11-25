/* 公民考试中文题库 — single-page app, no dependencies.
   Data: data/free.json (free sample, plain) and data/bank.json (full bank, AES-GCM, opened with an unlock code).
   In every stored question the correct option is index 0; options are shuffled when shown. */
(function () {
  'use strict';

  var CFG = window.CIVIQUE_CONFIG || {};
  var LS = 'civique.v1';
  var ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  var SET = 10;                       // questions per practice set
  var EXAM = { n: 40, min: 45, pass: 32 };
  var MINI = { n: 10, min: 12, pass: 8 };
  // k / s: knowledge and situational questions per theme in the real exam; mk / ms: in the short trial exam
  var THEMES = [
    { id: 'principes', zh: '共和国的原则与价值', fr: 'Principes et valeurs de la République', k: 5, s: 6, mk: 2, ms: 1 },
    { id: 'institutions', zh: '制度与政治体系', fr: 'Système institutionnel et politique', k: 6, s: 0, mk: 2, ms: 0 },
    { id: 'droits', zh: '权利与义务', fr: 'Droits et devoirs', k: 5, s: 6, mk: 1, ms: 1 },
    { id: 'histoire', zh: '历史、地理与文化', fr: 'Histoire, géographie et culture', k: 8, s: 0, mk: 2, ms: 0 },
    { id: 'societe', zh: '在法国社会生活', fr: 'Vivre dans la société française', k: 4, s: 0, mk: 1, ms: 0 }
  ];
  var LEVELS = {
    csp: { zh: '多年居留卡', fr: 'carte de séjour pluriannuelle', short: '多年卡', frs: 'pluriannuelle' },
    cr: { zh: '十年居留卡', fr: 'carte de résident', short: '十年卡', frs: 'résident' },
    nat: { zh: '入籍', fr: 'naturalisation', short: '入籍', frs: 'naturalisation' }
  };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var app = document.getElementById('app');

  // ---------------------------------------------------------------- storage
  var mem = {};
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function fresh() { return { target: '', zhOn: false, stats: {}, exams: [], sess: null, exam: null, unlock: null, pending: null, marks: {} }; }
  var S = fresh();
  (function () {
    try { var o = JSON.parse(lsGet(LS) || 'null'); if (o && typeof o === 'object') for (var k in o) S[k] = o[k]; } catch (e) { /* start clean */ }
    if (!LEVELS[S.target]) S.target = '';
    if (!S.stats || typeof S.stats !== 'object') S.stats = {};
    if (!Array.isArray(S.exams)) S.exams = [];
    if (!S.marks) S.marks = {};
  })();
  function save() { lsSet(LS, JSON.stringify(S)); }

  var ui = { modal: null, open: {}, msg: null, busy: false, resultIdx: 0, netFail: false, revoked: false };
  var DB = { free: null, bank: null, qs: [], src: [], byId: {}, cards: [], recall: [] };

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function theme(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }
  function unlocked() { return !!DB.bank; }
  function pool() { return DB.qs.filter(function (q) { return q.l.indexOf(S.target) >= 0; }); }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function ping(name) {
    if (!CFG.beacon || S.marks[name]) return;
    S.marks[name] = 1; save();
    try { new Image().src = CFG.beacon + encodeURIComponent(name); } catch (e) { /* counting is optional */ }
  }
  function dateZh(ts) { var d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }

  // per-question record: [times seen, times right, last answer right (1/0), right answers still needed to leave the mistakes list, time]
  function record(id, ok) {
    var s = S.stats[id] || [0, 0, 0, 0, 0];
    s[0]++;
    if (ok) { s[1]++; s[2] = 1; if (s[3] > 0) s[3]--; } else { s[2] = 0; s[3] = 2; }
    s[4] = Date.now();
    S.stats[id] = s;
  }
  function mastered(id) { var s = S.stats[id]; return !!(s && s[2] === 1); }
  function inMistakes(id) { var s = S.stats[id]; return !!(s && s[3] > 0); }
  function answeredCount() { var n = 0; for (var k in S.stats) n++; return n; }

  function counts(tid) {
    var m = DB.free.meta.counts[S.target][tid];
    var mine = pool().filter(function (q) { return q.t === tid; });
    return {
      total: m.c + m.s, know: m.c, situ: m.s,
      have: mine.length,
      done: mine.filter(function (q) { return mastered(q.id); }).length,
      todo: mine.filter(function (q) { return !mastered(q.id); }).length
    };
  }
  function totals() {
    var t = { total: 0, have: 0, done: 0, know: 0, situ: 0 };
    THEMES.forEach(function (th) { var c = counts(th.id); t.total += c.total; t.have += c.have; t.done += c.done; t.know += c.know; t.situ += c.situ; });
    return t;
  }
  function mistakes() { return pool().filter(function (q) { return inMistakes(q.id); }); }

  // ---------------------------------------------------------------- exam date, daily goal, readiness
  // S.examDate: 'YYYY-MM-DD' or ''. S.days: { 'YYYY-MM-DD': [answers given in practice that day, questions newly mastered that day] }.
  var GOAL = { def: 20, min: 10, max: 60, keep: 30 };
  var GUESS = 0.25;                   // four options: a question not yet mastered is still right one time in four
  var READY = { near: 28, from: SET }; // "close" from 28; no estimate before one set's worth of answers
  function isoDay(d) { return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }
  function dayAt(iso) { var p = String(iso).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  function today() { return isoDay(new Date()); }
  function planTidy() {
    if (typeof S.examDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(S.examDate) || isoDay(dayAt(S.examDate)) !== S.examDate) S.examDate = '';
    var old = S.days && typeof S.days === 'object' ? S.days : {}, limit = new Date(), days = {};
    limit.setDate(limit.getDate() - GOAL.keep);
    limit = isoDay(limit);
    Object.keys(old).forEach(function (k) {
      if (/^\d{4}-\d\d-\d\d$/.test(k) && k > limit && Array.isArray(old[k])) days[k] = [Number(old[k][0]) || 0, Number(old[k][1]) || 0];
    });
    S.days = days;
  }
  // an answer given in practice: the question's record, and today's count
  function practised(id, ok) {
    var was = mastered(id);
    record(id, ok);
    planTidy();
    var d = S.days[today()] || [0, 0];
    d[0]++;
    if (ok && !was) d[1]++;
    if (!ok && was && d[1] > 0) d[1]--;
    S.days[today()] = d;
  }
  function daysLeft() {
    if (!S.examDate) return null;
    return Math.round((dayAt(S.examDate) - dayAt(today())) / 864e5);
  }
  function weekDays() {
    var d = new Date(), n = 0, back = (d.getDay() + 6) % 7;       // Monday starts the week
    for (var i = 0; i <= back; i++) { var day = (S.days || {})[isoDay(d)]; if (day && day[0] > 0) n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  // today's target: what is still to master in the questions this device can practise, spread over the days left
  function plan() {
    var t = totals(), day = (S.days || {})[today()] || [0, 0], left = daysLeft();
    var todo = t.have - t.done, base = todo + day[1];              // what was still to master this morning
    var live = left !== null && left >= 0, per = live ? Math.ceil(base / Math.max(1, left)) : GOAL.def;
    var goal = Math.min(base, Math.max(GOAL.min, Math.min(GOAL.max, per)));
    return { left: left, live: live, done: day[0], goal: goal, todo: todo, have: t.have, locked: t.total - t.have, over: live && per > GOAL.max, week: weekDays() };
  }
  // expected right answers out of 40 if the exam were today: per theme and per kind of question,
  // quota x (share mastered + share not mastered x guess rate). The share is taken on the full bank.
  function readiness() {
    var m = DB.free.meta.counts[S.target], p = pool(), r = { est: 0, cap: 0, seen: 0, rows: [], weak: null, total: 0, have: p.length };
    p.forEach(function (q) { if (S.stats[q.id]) r.seen++; });
    THEMES.forEach(function (th) {
      var row = { id: th.id, zh: th.zh, n: th.k + th.s, est: 0, todo: 0 };
      [['c', th.k, m[th.id].c], ['s', th.s, m[th.id].s]].forEach(function (x) {
        r.total += x[2];
        if (!x[1]) return;
        var mine = p.filter(function (q) { return q.t === th.id && q.k === x[0]; });
        var done = mine.filter(function (q) { return mastered(q.id); }).length;
        var share = x[2] ? Math.min(1, done / x[2]) : 0, open = x[2] ? Math.min(1, mine.length / x[2]) : 0;
        row.est += x[1] * (share + (1 - share) * GUESS);
        r.cap += x[1] * (open + (1 - open) * GUESS);
        row.todo += mine.length - done;
      });
      r.est += row.est;
      r.rows.push(row);
    });
    // the weakest theme, among those that still have something to practise when there is one
    r.rows.forEach(function (row) {
      var w = r.weak;
      if (!w || (row.todo > 0 && !w.todo) || ((row.todo > 0) === (w.todo > 0) && row.est / row.n < w.est / w.n)) r.weak = row;
    });
    r.n = Math.round(r.est);
    r.capN = Math.floor(r.cap);
    r.ready = r.seen >= READY.from;
    r.state = r.n >= EXAM.pass ? 'go' : (r.n >= READY.near ? 'near' : 'low');
    return r;
  }
  function one(x) { return String(Math.round(x * 10) / 10); }
  function lastExam() {
    var mine = S.exams.filter(function (e) { return e.target === S.target && e.n > 0; });
    var run = mine.filter(function (e) { return !e.mini; });
    if (!run.length) run = mine;
    if (!run.length) return null;
    return {
      last: run.reduce(function (a, e) { return e.ts > a.ts ? e : a; }),
      best: run.reduce(function (a, e) { return e.score > a.score ? e : a; })
    };
  }
  // the exam date: a chip on the home screen, a row in 我的, edited in a bottom sheet
  function planSheet() {
    var p = plan(), d = S.examDate ? dayAt(S.examDate) : null, note;
    if (p.left !== null && p.left < 0) note = '你设的考试日期（' + (d.getMonth() + 1) + '月' + d.getDate() + '日）已经过了。';
    else if (!p.todo) note = unlocked() ? '全部题目都已掌握，用模拟考试保持手感。' : '已开放的 ' + p.have + ' 题都已掌握。';
    else if (p.over) note = '还有 ' + p.todo + ' 题没掌握，每天 ' + GOAL.max + ' 题也练不完，先练最弱的主题。';
    else note = '还有 ' + p.todo + ' 题没掌握' + (p.live ? '，今天的目标是 ' + p.goal + ' 题。' : '。');
    if (!unlocked()) note += '另有 ' + p.locked + ' 题解锁后才能练。';
    var acts = [];
    if (S.examDate) acts.push({ label: '清除日期', a: 'plan-clear', cls: 'quiet' });
    acts.push({ label: '关闭', a: 'close', cls: 'quiet' });
    ui.modal = {
      title: '考试日期',
      body: '<p class="small">设一个日期，按剩下的天数排每天做多少题。</p>' +
        '<form id="planform" class="stack"><div class="field"><input type="date" id="examdate" name="examdate" aria-label="正式考试的日期" min="' + today() + '" value="' + esc(S.examDate || '') + '">' +
        '<button class="btn" type="submit">保存</button></div>' +
        '<p class="msg bad plan-msg" role="alert">' + esc(ui.planMsg || '') + '</p></form>' +
        '<p class="small plan-note">' + note + '</p>',
      actions: acts
    };
  }
  function countChip() {
    var left = daysLeft(), txt;
    if (left === null) txt = icon('date') + '设日期';
    else if (left > 0) txt = '还有 <b>' + left + '</b> 天';
    else txt = left === 0 ? '就是今天' : '日期已过';
    return '<button class="chip count' + (left !== null && left < 0 ? ' late' : '') + '" data-a="plan-edit" aria-label="' + (left === null ? '设考试日期' : '修改考试日期') + '">' + txt + '</button>';
  }
  // the exam being prepared, as a chip that leads to the switch in 我的
  function levelChip() {
    if (!LEVELS[S.target]) return '';
    return '<a class="chip lv" href="#me" aria-label="考试类型：' + LEVELS[S.target].zh + '，去“我的”切换">' + LEVELS[S.target].short + '</a>';
  }
  // readiness as a stat tile; how it is computed opens in a sheet
  function readyTile(r) {
    var lab = '<div class="lab">把握度<span class="tag warm">估算，不是保证</span></div>';
    if (!r.ready) {
      return '<div class="stat rd rd-empty">' + lab + '<p class="rd-invite">做几组题之后，这里估算你现在去考能对几题。' +
        (r.seen ? '<span class="small">再答 ' + (READY.from - r.seen) + ' 题就有估算。</span>' : '') + '</p></div>';
    }
    var label = { low: '还不够', near: '接近', go: '可以去考' }[r.state];
    return '<button class="stat rd ' + r.state + '" data-a="rd-how" aria-label="把握度估算 ' + r.n + ' / ' + EXAM.n + ' 题，及格线 ' + EXAM.pass + '。点开看怎么算的">' + lab +
      '<div class="num rd-num"><b>' + r.n + '</b><span>/ ' + EXAM.n + '<em>题</em></span></div>' +
      '<div class="bar ' + (r.state === 'go' ? 'ok' : 'warm') + '"><i style="width:' + (r.est / EXAM.n * 100).toFixed(1) + '%"></i><span class="pass" style="left:' + (EXAM.pass / EXAM.n * 100) + '%"></span></div>' +
      '<div class="cap"><span class="rd-state">' + label + '</span><span>及格线 <b>' + EXAM.pass + '</b></span></div></button>';
  }
  function readyHow() {
    var r = readiness(), x = lastExam();
    ui.modal = {
      title: '把握度怎么算',
      body: '<div class="rd-how"><p>这是估算，不是保证：现在去考，' + EXAM.n + ' 题里大概能对 <b class="num">' + r.n + '</b> 题，及格线 ' + EXAM.pass + ' 题。</p>' +
        '<p>每个主题：你已掌握的比例 × 正式考试这个主题出的题数；没掌握的题按四选一、猜对 ' + Math.round(GUESS * 100) + '% 算。知识题和情景题分开算，加起来是 ' + one(r.est) + ' 题。' +
        (x ? '模拟考试成绩不算进这个数。' : '') + '</p>' +
        '<ul class="split">' + r.rows.map(function (row) { return '<li><span>' + row.zh + '</span><span class="n">' + one(row.est) + ' / ' + row.n + '</span></li>'; }).join('') + '</ul>' +
        (unlocked() ? '' : '<p>按全部 ' + r.total + ' 题算；解锁前只能练其中 ' + r.have + ' 题，把它们全部掌握，估算最多到 ' + r.capN + ' 题。</p>') +
        '<p>正式考试的选项和情景题跟题库不完全一样，所以只是估算。</p></div>',
      actions: [{ label: '知道了', a: 'close', cls: 'quiet' }]
    };
  }
  // under the tiles: the weakest theme with its button, or the way to the mock exam once the estimate is over the line
  function weakRow(r) {
    var w = r.weak, out = '';
    if (!r.ready) return '';
    if (r.state === 'go') out += '<a class="card hero-fact rd-go" href="#exam"><span>估算过线了，用一次完整模考确认</span><span class="go">' + icon('go') + '</span></a>';
    if (w && w.todo) {
      out += '<div class="card rd-weak t-' + w.id + '">' + hexBadge(icon(w.id), 'solid') + '<p><span class="small">最弱的主题 · 估 ' + one(w.est) + ' / ' + w.n + ' 题</span><b>' + w.zh + '</b></p>' +
        '<button class="btn sm" data-a="start" data-v="' + w.id + '|todo">去练</button></div>';
    } else if (w && !unlocked()) {
      out += '<div class="card rd-weak t-' + w.id + '">' + hexBadge(icon(w.id), 'solid') + '<p><span class="small">已开放的题都已掌握 · 最弱的主题</span><b>' + w.zh + '</b></p><a class="btn sm ghost" href="#unlock">去解锁</a></div>';
    }
    return out;
  }
  function examFact(x) {
    var e = x.last;
    return '<a class="card hero-fact" href="#exam"><span>最近' + (e.mini ? '试考' : '模考') + ' <b' + (e.score >= e.passAt ? ' class="pass"' : '') + '>' + e.score + '/' + e.n + '</b>' +
      (x.best.score > e.score ? '，最好 ' + x.best.score + '/' + x.best.n : (e.score >= e.passAt ? '，已过及格线' : '，离及格差 ' + (e.passAt - e.score) + ' 题')) + '</span><span class="go">' + icon('go') + '</span></a>';
  }
  // on the result page: from this score to what to practise next
  function resultNext(e) {
    if (e.target !== S.target) return '';
    var worst = null;
    THEMES.forEach(function (t) {
      var x = e.th && e.th[t.id];
      if (x && x[1] && x[0] < x[1] && (!worst || x[0] / x[1] < worst.r)) worst = { id: t.id, zh: t.zh, r: x[0] / x[1], got: x[0], n: x[1] };
    });
    var r = readiness(), go = worst && counts(worst.id).todo ? worst : (r.weak && r.weak.todo ? r.weak : null);
    var lost = worst ? '这次丢分最多 · ' + worst.got + ' / ' + worst.n : '';
    var row = go ? '<div class="rd-th t-' + go.id + '">' + hexBadge(icon(go.id), 'solid') + '<p><span class="small">' + (worst && go.id === worst.id ? lost : '练习里最弱的主题') + '</span><b>' + go.zh + '</b></p></div>'
      : '<p class="rd-none">' + (worst ? '「' + worst.zh + '」' + lost : '各主题都没丢分') + '</p>';
    return '<section class="card rd-next"><h2>下一步</h2>' + row +
      (r.ready ? '<p class="rd-est"><span>把握度 <b>' + r.n + '</b> / ' + EXAM.n + ' · 及格线 ' + EXAM.pass + '</span><span class="tag warm">估算，不是保证</span></p>' : '') +
      (go ? '<button class="btn wide" data-a="start" data-v="' + go.id + '|todo">去练最弱的主题</button>' : '') + '</section>';
  }

  // ---------------------------------------------------------------- data + unlock
  function getJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function useQuestions() {
    var d = DB.bank || DB.free;
    DB.qs = d.qs; DB.src = d.src || []; DB.byId = {};
    DB.cards = (DB.bank && DB.bank.cards) || DB.free.cards || [];
    DB.recall = DB.free.recall || [];
    DB.rc = null;
    DB.qs.forEach(function (q) { DB.byId[q.id] = q; });
    applyPatches();
  }
  // Corrections made in the admin page since the bank file was built: question id -> the fields that changed.
  // Those of paid questions come encrypted with the bank key, so only an unlocked device can read them.
  var PATCH = { free: {}, paid: {}, sealed: null };
  function apiUrl(name) { return CFG.api ? String(CFG.api).replace(/unlock$/, name) : ''; }
  function applyPatches() {
    [PATCH.free, DB.bank ? PATCH.paid : {}].forEach(function (set) {
      Object.keys(set).forEach(function (id) {
        var q = DB.byId[id], p = set[id];
        if (!q || !p) return;
        ['q', 'qz', 'e'].forEach(function (k) { if (typeof p[k] === 'string') q[k] = p[k]; });
        ['o', 'oz'].forEach(function (k) { if (Array.isArray(p[k]) && p[k].length === 4) q[k] = p[k].slice(); });
      });
    });
  }
  function openPatches() {
    if (!PATCH.sealed || !S.unlock || !S.unlock.k || !subtle) return Promise.resolve();
    return aesOpen(b64d(S.unlock.k), b64d(PATCH.sealed.iv), b64d(PATCH.sealed.ct)).then(function (plain) {
      PATCH.paid = JSON.parse(new TextDecoder('utf-8').decode(plain)) || {};
      applyPatches();
    }, function () { /* an older key: the bank file is still right */ });
  }
  function loadPatches() {
    if (!apiUrl('patches')) return Promise.resolve();
    return getJson(apiUrl('patches')).then(function (d) {
      if (!d || !d.ok) return;
      PATCH.free = d.free && typeof d.free === 'object' ? d.free : {};
      PATCH.sealed = d.paid && d.paid.iv && d.paid.ct ? d.paid : null;
      applyPatches();
      return openPatches();
    }).catch(function () { /* corrections are optional */ });
  }
  // Now and then the app tells the site how far this device's owner is, so the seller can see who is stuck where
  // (see the terms page). No name is asked: a buyer is known by the unlock code, anyone else by a random device number.
  var DEV_KEY = 'civique.dev', syncAt = 0, syncSent = '';
  function deviceId() {
    var id = lsGet(DEV_KEY);
    if (!/^[a-f0-9]{16}$/.test(id || '')) {
      var u = new Uint8Array(8);
      try { window.crypto.getRandomValues(u); } catch (e) { for (var i = 0; i < 8; i++) u[i] = Math.floor(Math.random() * 256); }
      id = toHex(u); lsSet(DEV_KEY, id);
    }
    return id;
  }
  function syncNow(force) {
    var url = apiUrl('sync');
    if (!url || !DB.free || !S.target) return;
    var now = Date.now();
    if (!force && now - syncAt < 60000) return;
    var ok = 0, miss = 0, ans = 0, seen = 0, best = 0, bestN = 0;
    Object.keys(S.stats).forEach(function (id) { var r = S.stats[id]; seen++; ans += r[0] || 0; if (r[2] === 1) ok++; if (r[3] > 0) miss++; });
    S.exams.forEach(function (e) { if (!e.mini && e.score >= best) { best = e.score; bestN = e.n; } });
    var body = JSON.stringify({
      device: deviceId(), code: (S.unlock && S.unlock.code) || '', unlocked: unlocked(), ref: lsGet(REF_KEY) || '', level: S.target, examDate: S.examDate || '',
      sum: { seen: seen, ok: ok, miss: miss, ans: ans, pool: pool().length, exams: S.exams.length, best: best, bestN: bestN },
      state: { stats: S.stats, days: S.days || {}, exams: S.exams.map(function (e) { return { ts: e.ts, target: e.target, mini: e.mini, score: e.score, n: e.n, passAt: e.passAt, secs: e.secs }; }) }
    });
    if (body === syncSent) return;
    syncAt = now; syncSent = body;
    try { fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: body.length < 60000 }).catch(function () { syncSent = ''; }); } catch (e) { /* optional */ }
  }
  function loadFree() {
    var p = window.CIVIQUE_FREE ? Promise.resolve(window.CIVIQUE_FREE) : getJson('data/free.json');
    return p.then(function (d) { DB.free = d; useQuestions(); });
  }
  var bankFile = null;
  function loadBankFile() {
    if (bankFile) return Promise.resolve(bankFile);
    var p = window.CIVIQUE_BANK ? Promise.resolve(window.CIVIQUE_BANK) : getJson('data/bank.json');
    return p.then(function (d) { bankFile = d; return d; });
  }
  function b64d(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function b64e(u) { var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function toHex(u) { var s = ''; for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
  function normCode(raw) {
    var c = String(raw || '').toUpperCase().split('').filter(function (ch) { return ALPHA.indexOf(ch) >= 0; }).join('');
    return c.length === 12 ? c : null;
  }
  function fmtCode(c) { return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12); }
  var subtle = window.crypto && window.crypto.subtle;

  function aesOpen(keyBytes, iv, data) {
    return subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    }).then(function (buf) { return new Uint8Array(buf); });
  }
  function openBank(bank, K) {
    return aesOpen(K, b64d(bank.iv), b64d(bank.ct)).then(function (plain) {
      var data = JSON.parse(new TextDecoder('utf-8').decode(plain));
      DB.bank = data; useQuestions();
      setTimeout(openPatches, 0);          // S.unlock is set by the caller right after
    });
  }
  function keyFromCode(bank, code) {
    return subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']).then(function (km) {
      return subtle.deriveBits({ name: 'PBKDF2', salt: b64d(bank.kdf.salt), iterations: bank.kdf.iter, hash: 'SHA-256' }, km, 512);
    }).then(function (bits) {
      var u = new Uint8Array(bits), entry = bank.keys[toHex(u.subarray(32, 40))];
      if (!entry) return null;
      return aesOpen(u.subarray(0, 32), b64d(entry.iv), b64d(entry.wk));
    });
  }
  // The site's own /api/unlock (only on deployments that have it) checks online payments and the codes it issued.
  function ask(payload) {
    if (!CFG.api) return Promise.resolve({ error: 'no_api' });
    return fetch(CFG.api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      return r.json().catch(function () { return { error: 'server' }; });
    }, function () { return { error: 'network' }; });
  }
  // resolves to 'ok' or the name of what went wrong
  function unlockViaServer(payload) {
    if (!subtle || !window.TextDecoder) return Promise.resolve('nocrypto');
    return ask(payload).then(function (res) {
      if (!res || !res.ok || !res.k) return (res && res.error) || 'server';
      return loadBankFile().then(function (bank) {
        return openBank(bank, b64d(res.k)).then(function () {
          S.unlock = { code: res.code || '', k: res.k, built: bank.built || '' };
          S.sess = null; S.pending = null; save(); ping('unlocked');
          return 'ok';
        }, function () { return 'server'; });
      }, function () { return 'network'; });
    });
  }
  // resolves to 'ok' | 'format' | 'nocrypto' | 'network' | 'unknown' | 'server'
  function unlockWithCode(raw) {
    var code = normCode(raw);
    if (!code) return Promise.resolve('format');
    if (!subtle || !window.TextDecoder) return Promise.resolve('nocrypto');
    function online() {
      if (!CFG.api) return 'unknown';
      return unlockViaServer({ code: fmtCode(code) }).then(function (r) {
        return r === 'ok' || r === 'network' ? r : (r === 'bad_code' || r === 'revoked' ? 'unknown' : 'server');
      });
    }
    return loadBankFile().then(function (bank) {
      return keyFromCode(bank, code).then(function (K) {
        if (!K) return online();
        return openBank(bank, K).then(function () {
          S.unlock = { code: fmtCode(code), k: b64e(K), built: bank.built || '' };
          S.sess = null; S.pending = null; save(); ping('unlocked');
          return 'ok';
        });
      }, function () { return online(); });
    }, function () { return 'network'; });
  }
  function restoreUnlock() {
    if (!S.unlock || !S.unlock.k) return Promise.resolve();
    if (!subtle || !window.TextDecoder) return Promise.resolve();
    return loadBankFile().then(function (bank) {
      return openBank(bank, b64d(S.unlock.k)).catch(function () {
        // the bank key changed since this device unlocked: try the stored code again
        return unlockWithCode(S.unlock.code).then(function (r) {
          if (r === 'unknown') { S.unlock = null; save(); ui.revoked = true; }
          else if (r !== 'ok') ui.netFail = true;
        });
      });
    }, function () { ui.netFail = true; });
  }
  function codeFromUrl() {
    var m = /[?&]code=([^&#]+)/.exec(location.search || '');
    if (!m) return Promise.resolve();
    var raw = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + (location.hash || '')); } catch (e) { /* keep the url */ }
    if (unlocked()) return Promise.resolve();
    return unlockWithCode(raw).then(function (r) {
      ui.msg = r === 'ok' ? { ok: true, text: '解锁成功，全部题目已开放。' } : { ok: false, text: codeError(r) };
      location.hash = 'unlock';
    });
  }
  // back from the payment page: Stripe adds the id of the payment to the address
  function paidFromUrl() {
    var m = /[?&](?:paid|session_id)=(cs_[A-Za-z0-9_]{8,220})/.exec(location.search || '');
    if (m) {
      S.pending = m[1]; save();
      try { history.replaceState(null, '', location.pathname + (location.hash || '')); } catch (e) { /* keep the url */ }
    }
    if (!S.pending) return Promise.resolve();
    if (unlocked()) { S.pending = null; save(); return Promise.resolve(); }
    return confirmPayment();
  }
  function confirmPayment() {
    return unlockViaServer({ session: S.pending }).then(function (r) {
      if (r === 'not_paid' || r === 'not_found') { S.pending = null; save(); }
      ui.msg = r === 'ok' ? { ok: true, text: '付款成功，全部题目已开放。' } : { ok: false, text: payError(r), at: 'pay' };
      if (route() === 'unlock') render(true); else location.hash = 'unlock';
    });
  }
  function payError(r) {
    if (r === 'pending') return '付款还在处理中。请等一两分钟，再点“重新确认”。';
    if (r === 'not_paid') return '这笔付款没有完成，不会扣款。需要的话可以重新付款。';
    if (r === 'not_found') return '没有找到这笔付款记录。如果你已经付款，请用下面的“找回解锁码”。';
    if (r === 'network') return '网络不通，暂时无法确认付款。请检查网络后点“重新确认”，不用再付一次。';
    if (r === 'nocrypto') return '当前浏览器不支持解锁，请点右上角用 Safari 或 Chrome 打开本页面。';
    return '暂时无法确认付款。请稍后点“重新确认”，不用再付一次。';
  }
  function mailError(r) {
    if (r === 'bad_email') return '邮箱格式不对，请检查后再试。';
    if (r === 'not_found' || r === 'not_paid') return '没有找到这个邮箱的付款记录。请填付款时用的那个邮箱。';
    if (r === 'network') return '网络不通，请检查网络后重试。';
    if (r === 'nocrypto') return '当前浏览器不支持解锁，请点右上角用 Safari 或 Chrome 打开本页面。';
    return '找回服务暂时不可用，请稍后再试。';
  }
  // who sent this visitor: a link shared as ?r=name. The name is kept on this device and handed to the payment page,
  // where it is saved with the payment (Stripe: client_reference_id). The newest link wins.
  var REF_KEY = 'civique.ref';
  function refOk(r) { return /^[A-Za-z0-9_-]{1,40}$/.test(r || ''); }
  (function () {
    var m = /[?&]r(?:ef)?=([A-Za-z0-9_-]{1,40})(?=[&#]|$)/.exec(location.search || '');
    if (m) lsSet(REF_KEY, m[1]);
  })();
  // the name stays in the address, so that "open in the browser" from WeChat, a copied link or a forwarded page still carry it
  function keepRef() {
    var ref = lsGet(REF_KEY), q = location.search || '';
    if (!refOk(ref) || /^(about|blob|data):/.test(location.href) || /[?&](paid|session_id|code)=/.test(q)) return;
    if (new RegExp('[?&]r=' + ref + '(&|$)').test(q)) return;
    try { history.replaceState(history.state, '', location.pathname + '?r=' + ref + (location.hash || '')); } catch (e) { /* keep the url */ }
  }
  function payHref() {
    var u = String(CFG.payUrl || ''), ref = lsGet(REF_KEY);
    u += (u.indexOf('?') < 0 ? '?' : '&') + 'locale=zh';
    return refOk(ref) ? u + '&client_reference_id=' + ref : u;
  }
  function codeError(r) {
    if (r === 'format') return '解锁码是 12 位字母和数字，例如 ABCD-2345-EFGH，请检查后再试。';
    if (r === 'unknown') return '这个解锁码不对或已失效，请核对后再试' + (CFG.contact ? '，或联系 ' + CFG.contact : '') + '。';
    if (r === 'nocrypto') return '当前浏览器不支持解锁，请点右上角用 Safari 或 Chrome 打开本页面。';
    if (r === 'server') return '解锁服务暂时不可用，请稍后再试。';
    return '题库没有加载出来，请检查网络后重试。';
  }
  function sanitize() {
    var has = function (id) { return !!DB.byId[id]; };
    if (S.sess) { if (!S.sess.ids || !S.sess.ids.every(has)) S.sess = null; }
    if (S.exam) { if (!S.exam.ids || !S.exam.ids.every(has)) S.exam = null; }
    planTidy();
  }

  // ---------------------------------------------------------------- speech
  // Reading aloud. First choice: a recording made in advance (site/audio, one small mp3 per question, option, word),
  // the same on every phone. Second choice, when a recording is missing or cannot be played: the phone's own voice.
  var canTTS = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
  var canClips = CFG.audio !== false && typeof window.Audio !== 'undefined';
  var canSpeak = canTTS || canClips;
  function akey(t) { return String(t).normalize('NFC').replace(/[’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase(); }
  function clipName(t) {
    var s = akey(t), a = 0x811c9dc5, b = 0x01000193;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = (Math.imul(b + c, 0x9e3779b1) ^ (b >>> 15)) >>> 0; }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }
  var player = null, queue = [], playing = 0;
  // texts: what to read, in order. Each is played from its recording; from the first one that has none, the rest
  // is handed to the phone's voice.
  function playClips(texts) {
    stopClips();
    if (!canClips) return tts(texts.join(' ... '));
    queue = texts.slice(); var run = ++playing;
    if (!player) { try { player = new window.Audio(); player.preload = 'auto'; } catch (e) { canClips = false; return tts(texts.join(' ... ')); } }
    function fallback() { if (run !== playing) return; var rest = queue.slice(); queue = []; tts(rest.join(' ... ')); }
    function next() {
      if (run !== playing) return;
      if (!queue.length) return;
      var name = clipName(queue[0]);
      player.onended = function () { if (run !== playing) return; queue.shift(); next(); };
      player.onerror = fallback;
      try {
        player.src = 'audio/' + name.slice(0, 2) + '/' + name + '.mp3';
        var p = player.play();
        if (p && p.catch) p.catch(function (e) { if (e && e.name === 'AbortError') return; fallback(); });
      } catch (e) { fallback(); }
    }
    next();
  }
  function stopClips() { playing++; queue = []; if (player) { try { player.onended = null; player.onerror = null; player.pause(); } catch (e) { /* nothing playing */ } } }
  // The phone's own voices do the reading. Saying "this is French" is not enough: many phones (and WeChat's browser)
  // then read French with the default Chinese or English voice. So a French voice is chosen by name, and when the
  // phone has none, the user is told instead of hearing nonsense.
  var frVoice = null, voicesSeen = false;
  function pickVoice() {
    if (!canTTS) return;
    var list = [];
    try { list = window.speechSynthesis.getVoices() || []; } catch (e) { list = []; }
    if (!list.length) return;
    voicesSeen = true;
    var best = null, top = -1;
    for (var i = 0; i < list.length; i++) {
      var v = list[i], lang = String(v.lang || '').replace('_', '-').toLowerCase();
      if (lang.indexOf('fr') !== 0) continue;
      var score = lang === 'fr-fr' ? 30 : lang === 'fr' ? 20 : 10;                      // France first, then other French
      if (/enhanced|premium|natural|neural|compact/i.test(v.name) && !/compact/i.test(v.name)) score += 6;
      if (/google|microsoft|amélie|amelie|thomas|audrey|denise|henri|marie/i.test(v.name)) score += 3;
      if (v.localService) score += 1;                                                    // works without a connection
      if (score > top) { top = score; best = v; }
    }
    frVoice = best;
  }
  if (canTTS) {
    pickVoice();
    try { window.speechSynthesis.addEventListener('voiceschanged', pickVoice); } catch (e) { try { window.speechSynthesis.onvoiceschanged = pickVoice; } catch (x) { /* older engines */ } }
  }
  var ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  function fromRoman(r) { var n = 0; for (var i = 0; i < r.length; i++) { var a = ROMAN[r[i]], b = ROMAN[r[i + 1]] || 0; n += a < b ? -a : a; } return n; }
  // what is written for the eye is not always what a voice can read: "Ve République", "XIXe siècle", "Louis XVI"
  function forVoice(text) {
    return String(text)
      .replace(/\b([IVXLC]+)(er|re|e|ème|eme)\b/g, function (m, r, suf) { var n = fromRoman(r); return n > 0 && n < 400 ? n + (suf === 'ème' || suf === 'eme' ? 'e' : suf) : m; })
      .replace(/\b(Louis|Napoléon|Charles|François|Henri|Philippe|Clovis|Jean|Léon|Pie|Benoît)(-[A-Z][a-zé]+)?\s+([IVXLC]{1,6})\b/g, function (m, name, extra, r) { var n = fromRoman(r); return n > 0 && n < 100 ? name + (extra || '') + ' ' + n : m; })
      .replace(/[«»]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function speak(text) { playClips(Array.isArray(text) ? text : [text]); }
  function tts(text) {
    if (!canTTS || !text) return;
    try {
      if (!frVoice) pickVoice();
      // No French voice in the phone's list: still ask for French (some phones speak it without listing it), and say
      // once that the result may be poor, rather than staying silent.
      if (voicesSeen && !frVoice && !speak.warned) { speak.warned = true; sayNote('这台手机的法语朗读可能不准：系统里没有找到法语语音。可以在手机设置里添加“法语”朗读语音。'); }
      window.speechSynthesis.cancel();
      var u = new window.SpeechSynthesisUtterance(forVoice(text));
      u.lang = frVoice ? frVoice.lang : 'fr-FR';
      if (frVoice) u.voice = frVoice;
      u.rate = 0.88;
      window.speechSynthesis.speak(u);
    } catch (e) { /* no voice on this device */ }
  }
  function sayNote(msg) {
    try {
      var box = document.getElementById('saynote');
      if (!box) { box = document.createElement('div'); box.id = 'saynote'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
      box.textContent = msg;
      clearTimeout(sayNote.t);
      sayNote.t = setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 6000);
    } catch (e) { /* a note only */ }
  }
  function hush() { stopClips(); if (canTTS) { try { window.speechSynthesis.cancel(); } catch (e) { /* nothing playing */ } } }

  // ---------------------------------------------------------------- practice sessions
  function startPractice(tid, mode) {
    var qs;
    if (mode === 'wrong') qs = shuffle(mistakes());
    else if (mode === 'recall') qs = recallTodo();
    else {
      qs = pool().filter(function (q) { return (tid === 'all' || q.t === tid) && !mastered(q.id); });      // 'all' with mode 'situ': scenario questions of every theme
      if (mode === 'situ') qs = qs.filter(function (q) { return q.k === 's'; });
      else qs = mixKinds(qs);
    }
    qs = qs.slice(0, SET);
    if (!qs.length) return false;
    S.sess = { theme: tid, mode: mode, ids: qs.map(function (q) { return q.id; }), i: 0, perm: {}, ans: {} };
    save();
    return true;
  }
  // up to 4 situational questions per set, spread between the knowledge questions
  function mixKinds(qs) {
    var k = qs.filter(function (q) { return q.k === 'c'; }), s = qs.filter(function (q) { return q.k === 's'; });
    var ns = Math.min(s.length, Math.max(4, SET - k.length)), nk = Math.min(k.length, SET - ns);
    var out = k.slice(0, nk), step = (nk + 1) / (ns + 1);
    for (var i = 0; i < ns; i++) out.splice(Math.min(out.length, Math.round(step * (i + 1)) + i), 0, s[i]);
    return out.concat(k.slice(nk), s.slice(ns));
  }
  function recallTodo() {
    return recallIds().ids.map(function (id) { return DB.byId[id]; }).filter(function (q) { return q && !mastered(q.id); });
  }
  function permFor(holder, id) {
    if (!holder.perm[id]) holder.perm[id] = shuffle([0, 1, 2, 3]).join('');
    return holder.perm[id].split('').map(Number);
  }
  function nextTheme() {
    for (var i = 0; i < THEMES.length; i++) if (counts(THEMES[i].id).todo > 0) return THEMES[i].id;
    return null;
  }

  // ---------------------------------------------------------------- exam
  function startExam(mini) {
    var p = pool(), ids = [];
    THEMES.forEach(function (t) {
      var nk = mini ? t.mk : t.k, ns = mini ? t.ms : t.s;
      var k = shuffle(p.filter(function (q) { return q.t === t.id && q.k === 'c'; })).slice(0, nk);
      var s = shuffle(p.filter(function (q) { return q.t === t.id && q.k === 's'; })).slice(0, ns);
      ids = ids.concat(k.concat(s).map(function (q) { return q.id; }));
    });
    S.exam = { ids: ids, perm: {}, ans: {}, flags: {}, i: 0, start: Date.now(), dur: (mini ? MINI.min : EXAM.min) * 60, mini: !!mini };
    save();
  }
  function examLeft() { return S.exam ? S.exam.dur - (Date.now() - S.exam.start) / 1000 : 0; }
  function finishExam() {
    var x = S.exam; if (!x) return;
    var th = {}, score = 0, items = [];
    x.ids.forEach(function (id) {
      var q = DB.byId[id], a = x.ans[id], ok = a === 0;
      th[q.t] = th[q.t] || [0, 0]; th[q.t][1]++;
      if (ok) { th[q.t][0]++; score++; }
      if (a !== undefined) record(id, ok);
      items.push([id, a === undefined ? -1 : a, permFor(x, id).join('')]);
    });
    var passAt = x.mini ? MINI.pass : EXAM.pass;
    S.exams.unshift({ ts: Date.now(), target: S.target, mini: x.mini, score: score, n: x.ids.length, passAt: passAt, secs: Math.min(x.dur, Math.round((Date.now() - x.start) / 1000)), th: th, items: items });
    S.exams = S.exams.slice(0, 10);
    S.exam = null; ui.resultIdx = 0; ui.open = {}; ui.resOnly = false;
    save();
    ping(x.mini ? 'mini_done' : 'exam_done');
  }

  // ---------------------------------------------------------------- pieces of markup
  // ---- brand pieces: icons, the hexagon, 小玛
  // icons: 24 x 24, round 2.4 stroke in currentColor; the few solid ones carry their own fill
  var ICON = {
    home: '<path d="M3.5 11 12 3.5 20.5 11v8.500a1.500 1.500 0 0 1-1.500 1.500h-4.500v-6h-5v6H5a1.500 1.500 0 0 1-1.500-1.500z" fill="currentColor" stroke-width="1.5"/>',
    practice: '<path d="m4 20 1.200-5L16 4.200a1.700 1.700 0 0 1 2.400 0l1.400 1.400a1.700 1.700 0 0 1 0 2.400L9 18.800zM13.500 6.700l3.800 3.800"/>',
    exam: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.500V9.500M9.500 3h5M18.500 6l1.500 1.500"/>',
    cards: '<path d="M13.5 2.500 5 13.500h6L10 21.500l9-11.500h-6z"/>',
    me: '<circle cx="12" cy="8" r="4"/><path d="M4 20.500c.8-4.300 4-6.300 8-6.300s7.200 2 8 6.300"/>',
    principes: '<path d="m12 2.800 2.800 5.800 6.300.9-4.600 4.400 1.100 6.300L12 17.200l-5.600 3 1.100-6.300L2.900 9.500l6.300-.9z" fill="currentColor" stroke="none"/>',
    institutions: '<path d="M3.5 9 12 3.500 20.500 9M6 11v6.500M10 11v6.500M14 11v6.500M18 11v6.500M3.500 20.500h17"/>',
    droits: '<path d="M12 3.500v17M7.500 20.500h9M4.500 7h15M5 7.500l-2.500 6a2.900 2.900 0 0 0 5 0zM19 7.500l-2.500 6a2.900 2.900 0 0 0 5 0z"/>',
    histoire: '<circle cx="12" cy="12" r="8.700"/><path d="M3.500 12h17M12 3.300c-4.500 4.800-4.500 12.600 0 17.400M12 3.300c4.500 4.800 4.500 12.600 0 17.400"/>',
    societe: '<path d="M3.500 11.500 12 4l8.500 7.500M6 10v9.500h12V10M10 19.500v-5h4v5"/>',
    situ: '<circle cx="9" cy="8.500" r="3"/><path d="M3.500 19.500c0-3.200 2.300-5.500 5.500-5.500s5.500 2.300 5.500 5.500M15.500 5.700a3 3 0 0 1 0 5.600M17.300 14.400c2 .7 3.200 2.500 3.200 5.100"/>',
    mistakes: '<rect x="4.500" y="3.500" width="15" height="17" rx="3"/><path d="m9.500 9.500 5 5m0-5-5 5"/>',
    words: '<path d="M4 6h9M8.500 3.500V6M11.500 6c-.7 3.300-3 6-6.500 7.500M6.500 9.500c1 2 2.800 3.500 5 4.300"/><path d="m13 20.500 3.500-9 3.500 9M14.200 17.500h4.600"/>',
    about: '<circle cx="12" cy="12" r="8.700"/><path d="M12 11v5.500M12 7.500v.2"/>',
    check: '<circle cx="12" cy="12" r="8.700"/><path d="M9.600 9.700a2.500 2.500 0 1 1 3.700 2.200c-.9.500-1.300 1-1.300 1.900M12 16.800v.2"/>',
    recall: '<path d="M4.500 5h15v11h-7.500L7.500 20v-4h-3z"/><path d="M8.500 9h7M8.500 12.200h4.500"/>',
    register: '<path d="M12 21s6.500-5.800 6.500-11a6.500 6.500 0 0 0-13 0c0 5.200 6.500 11 6.500 11z"/><circle cx="12" cy="10" r="2.300"/>',
    sheet: '<path d="M6.500 3.500h8l3 3v14h-11z"/><path d="M14.500 3.500v3h3M9.500 11h5M9.500 14.500h5"/>',
    say: '<path d="M4 10v4h3l4.500 3.500v-11L7 10z"/><path d="M15.500 9a4.200 4.200 0 0 1 0 6M18 6.500a7.600 7.600 0 0 1 0 11"/>',
    date: '<rect x="4" y="5.500" width="16" height="14.500" rx="3"/><path d="M4 10h16M8.500 3.500v4M15.500 3.500v4"/>',
    reset: '<path d="M5 7.500h14M10 7.500V4.500h4v3M7 7.500l.8 12.500h8.400L17 7.500"/>',
    lock: '<rect x="5.500" y="10.500" width="13" height="9.500" rx="2.500"/><path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500"/>',
    back: '<path d="M15 4.500 7.500 12l7.500 7.500" stroke-width="3.2"/>',
    close: '<path d="m6 6 12 12m0-12L6 18" stroke-width="3.2"/>',
    next: '<path d="M5 12h13m-5.500-6 6 6-6 6" stroke-width="3.2"/>',
    go: '<path d="m9 5 7 7-7 7" stroke-width="3"/>',
    play: '<path d="M7 4.500v15a1 1 0 0 0 1.500.9l12-7.500a1 1 0 0 0 0-1.700l-12-7.500A1 1 0 0 0 7 4.500z" fill="currentColor" stroke="none"/>',
    ok: '<path d="m5 12.500 4.700 4.700L19 7.500" stroke-width="3.6"/>',
    no: '<path d="m6.500 6.500 11 11m0-11-11 11" stroke-width="3.6"/>',
    tick: '<circle cx="12" cy="12" r="11" fill="currentColor" stroke="none"/><path d="m7 12.500 3.400 3.400L17 9" stroke="var(--card)" stroke-width="3"/>'
  };
  function icon(n, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>'; }
  // the hexagon: brand shape behind option letters, theme icons and the active tab
  function hex(cls) { return '<svg class="' + (cls || 'hx') + '" viewBox="0 0 40 40" aria-hidden="true"><path d="M35 20 27.5 33h-15L5 20l7.5-13h15z" fill="currentColor" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/></svg>'; }
  function hexBadge(inner, cls) { return '<span class="hexic' + (cls ? ' ' + cls : '') + '">' + hex() + inner + '</span>'; }
  // a hexagon progress ring with something in the middle (小玛 on the home screen). pct: 0 to 100
  function hexRing(pct, inner, label) {
    var d = 'M70 15.5H98.5L130 70 98.5 124.5H41.5L10 70 41.5 15.500z';
    pct = Math.max(0, Math.min(100, pct));
    return '<div class="hexring ring" role="img" aria-label="' + esc(label) + '"><svg class="r" viewBox="0 0 140 140" aria-hidden="true"><path class="trk" d="' + d + '"/>' +
      (pct > 0 ? '<path class="arc" d="' + d + '" pathLength="100" stroke-dasharray="' + (Math.round(pct * 10) / 10) + ' 100"/>' : '') + '</svg>' + (inner || '') + '</div>';
  }
  // 小玛, the mascot: a chibi study buddy with a red beret, a chestnut bob, a yellow dress and a pale scarf.
  // The same head and body in every mood; only the arms, the face and a prop or two change.
  var MA_INK = '#5A2F1C', MA_SKIN = '#FFDFC4', MA_RED = '#E8362D', MA_SUN = '#FFC933';
  // every shape lives in one group that defaults to a thin chestnut outline; maP is a stroke with its own width / colour
  function maP(d, w, stroke, more) { return '<path d="' + d + '" stroke-width="' + w + '"' + (stroke ? ' stroke="' + stroke + '"' : '') + (more || '') + '/>'; }
  // an arm is a fat outlined stroke with a rounder hand at its end. d: the arm, h: the hand as "Mx yh.01"
  function maArm(d, h) { return maP(d, 13) + maP(h, 17) + maP(d, 8, MA_SKIN) + maP(h, 12, MA_SKIN); }
  // the face is drawn inside one dark stroke group: eyes are short fat strokes with a white glint
  function maEyes(y, dx) { return maP('M45 ' + y + 'v2M75 ' + y + 'v2', 10) + maP('M' + (46.6 + (dx || 0)) + ' ' + (y - 1.5) + 'h.01m30 0h.01', 3.8, '#fff'); }
  function maMouth(d) { return '<path d="' + d + '" fill="#C8302A"/>'; }
  function maSun(d, w, fill) { return maP(d, w, MA_SUN, fill ? ' fill="' + MA_SUN + '"' : ''); }
  var MA = {   // [arms behind the body, face, arms and props in front]
    cheer: [maArm('M48 97 19 76M72 97l29-21', 'M16 73h.01M104 73h.01'), maEyes(67) + maMouth('M51 76h18q-1 10-9 10t-9-10z'), ''],
    console: [maArm('M48 97 33 108M72 97l28-9', 'M31 110h.01M104 86h.01'), '<path d="M37 58l11-3M83 58l-11-3"/>' + maEyes(69) + '<path d="M54 80q6 4 12 0"/>', maSun('M109 67q-5-7 0-7 3 0 3 3 0-3 3-3 5 0 0 7l-3 3z', 2, 1)],
    celebrate: [maArm('M48 97 20 64M72 97l28-33', 'M17 60h.01M103 60h.01'), maP('M38 70q7-10 14 0M68 70q7-10 14 0', 3.8) + maMouth('M49 75h22q-1 13-11 13T49 75z'), maSun('M9 34l3 6 6 1-5 4 2 6-6-4-5 4 2-6-5-4 6-1zM112 32v10M107 37h10', 3, 1)],
    neutral: [maArm('M48 97 34 108M72 97l14 11', 'M32 110h.01M88 110h.01'), maEyes(67) + '<path d="M53 78q7 6 14 0"/>', ''],
    think: ['', '<path d="M67 56q7-5 14-1M55 80h8"/>' + maEyes(65, 1.6), maArm('M48 97 34 108M76 101q13 1 7-9', 'M32 110h.01M81 88h.01') + maSun('M101 52h.01M108 41h.01', 6) + maSun('M112 24h.01', 12)],
    sleep: [maArm('M48 97 35 108M72 97l13 11', 'M33 110h.01M87 110h.01'), '<path d="M38 68q7 6 14 0M68 68q7 6 14 0"/>' + maP('M60 79v1', 6), maSun('M96 36h10l-10 11h10M109 20h6l-6 7h6', 3.4)]
  };
  var MA_HAIR = '<path d="M25 62C25 28 95 28 95 62c0 12 3 21-5 26H30c-8-5-5-14-5-26z" fill="' + MA_INK + '"/>',
    MA_BODY = maP('M53 113v4M67 113v4', 7) + '<path d="M49 90l-11 22q22 6 44 0L71 90z" fill="' + MA_SUN + '"/>',
    MA_HEAD = '<ellipse cx="60" cy="64" rx="32" ry="27" fill="' + MA_SKIN + '"/><path d="M29 59q4-19 31-19t31 19q-16 0-25-12-11 13-37 12z" fill="' + MA_INK + '"/>' + maP('M34 77h4M82 77h4', 6.5, '#FF9E9E'),
    MA_SCARF = '<path d="M42 89q18 9 36 0l1 7q-19 10-38 0zM64 99l9 9-12 1z" fill="#FFF4DC" stroke="#0B7A52"/>';
  // the hat sits on a thin pale rim so that red still separates from a red panel
  function maHat(d, more) { return maP(d, 6.4, '#FFEFE2') + '<g stroke="#A81F1A">' + more + '<path d="' + d + '" fill="' + MA_RED + '"/></g>'; }
  var MA_HAT = {
    beret: maHat('M23 48Q10 25 48 16q42-9 50 16 3 15-10 14-33-8-65 2z', maP('M62 15l3-8', 4)) + maP('M33 30q9-7 21-8', 4, '#FF8E7E'),
    phrygian: maHat('M25 51Q21 22 52 16q12-9 26-6 12 4 8 14-4 6-10 2 12 9 14 25Q58 39 25 51z', '') + maP('M52 16q13 2 24 10', 2.6, '#A81F1A')
  };
  // six(mood, size, cls, opt): the full figure, or just her head (bigger eyes and mouth) below 36px or with opt.mini.
  // opt.cap = 'phrygian' swaps the beret for a red cap, a one-off costume for a passed mock exam.
  function six(mood, size, cls, opt) {
    var m = MA[mood] ? mood : 'neutral', mini = opt && opt.mini || size > 0 && size < 36, hat = MA_HAT[opt && opt.cap] || MA_HAT.beret;
    return '<svg class="six' + (mini ? ' mini' : '') + (cls ? ' ' + cls : '') + '" viewBox="' + (mini ? '9 0 98 98' : '0 0 120 120') + '"' + (size ? ' width="' + size + '" height="' + size + '"' : '') + ' aria-hidden="true" data-mood="' + m + '">' +
      '<g fill="none" stroke="' + MA_INK + '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' + (mini ? MA_HAIR + MA_HEAD + hat : MA[m][0] + MA_HAIR + MA_BODY + MA_HEAD + MA_SCARF + hat) +
      '<g stroke="#3B1D10" stroke-width="3"' + (mini ? ' transform="matrix(1.12 0 0 1.12 -7.2 -8.6)"' : '') + '>' + MA[m][1] + '</g>' + (mini ? '' : MA[m][2]) + '</g></svg>';
  }
  function heroDeco() { return hex('deco d1') + hex('deco d2'); }
  var CONFETTI = [['12%', '14%', 18, '#FFC933'], ['24%', '60%', 12, '#fff'], ['8%', '70%', 14, '#FF9FC8'], ['80%', '10%', 14, '#fff'], ['72%', '58%', 18, '#9FD2FF'], ['88%', '72%', 13, '#FFC933']];
  function confetti() {
    return '<div class="confetti" aria-hidden="true">' + CONFETTI.map(function (c) {
      return '<svg class="cf" style="left:' + c[0] + ';top:' + c[1] + ';width:' + c[2] + 'px;height:' + c[2] + 'px;color:' + c[3] + '" viewBox="0 0 40 40"><path d="M35 20 27.5 33h-15L5 20l7.5-13h15z" fill="currentColor" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/></svg>';
    }).join('') + '</div>';
  }
  // ---- navigation: five tabs; every sub-page names the tab it belongs to
  function tabs(active) {
    var items = [['home', '首页'], ['practice', '练习'], ['exam', '模考'], ['cards', '速记'], ['me', '我的']];
    return '<nav class="tabs" aria-label="主导航"><ul>' + items.map(function (it) {
      return '<li><a href="#' + it[0] + '"' + (active === it[0] ? ' aria-current="page"' : '') + '><span class="ic">' + hex() + icon(it[0]) + '</span><span>' + it[1] + '</span></a></li>';
    }).join('') + '</ul></nav>';
  }
  // the title of a tab's own page, with room for chips on the right
  function pagehead(title, slot, cls) {
    return '<header class="pagehead' + (cls ? ' ' + cls : '') + '"><h1>' + title + '</h1>' + (slot ? '<div class="slot">' + slot + '</div>' : '') + '</header>';
  }
  // the bar of a sub-page: back to its hub, title
  function topbar(title, back, slot) {
    return '<header class="topbar"><a class="sq back" href="#' + back + '" aria-label="返回">' + icon('back') + '</a><h1>' + title + '</h1>' + (slot || '') + '</header>';
  }
  function levelIds() { return ['csp', 'cr', 'nat'].filter(function (lv) { return !!DB.free.meta.counts[lv]; }); }
  function bar(done, total, cls) {
    var w = total ? Math.round(done / total * 1000) / 10 : 0;
    return '<div class="bar ' + (cls || '') + '" role="img" aria-label="' + done + ' / ' + total + '"><i style="width:' + w + '%"></i></div>';
  }
  function payBlock(lead) {
    var d = offerData();
    return '<section class="card pay"><div class="pay-head">' + six('cheer', 0, '', { mini: true }) + '<h2>' + esc(lead || '解锁全部题目') + '</h2></div>' +
      '<ul class="pay-facts">' +
      '<li><b>' + d.total + '</b><span>' + '道题带讲解' + '</span></li>' +
      (d.cards ? '<li><b>' + d.cards + '</b><span>张考点速记</span></li>' : '') +
      '<li><b>' + EXAM.n + '</b><span>题完整模考</span></li></ul>' +
      (CFG.price ? buyButton('#unlock', '解锁全部')
        : '<div class="buy"><a class="btn wide" href="#unlock">去解锁</a><p class="buy-terms">一次性付款，不是订阅</p></div>') + '</section>';
  }
  function modal() {
    var m = ui.modal; if (!m) return '';
    return '<div class="veil" data-a="veil"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(m.title) + '">' +
      '<h2>' + esc(m.title) + '</h2>' + (m.body || '') +
      '<div class="stack">' + m.actions.map(function (a) {
        return '<button class="btn wide ' + (a.cls || '') + '" data-a="' + a.a + '"' + (a.v !== undefined ? ' data-v="' + esc(a.v) + '"' : '') + '>' + esc(a.label) + '</button>';
      }).join('') + '</div></div></div>';
  }
  function srcLink(q) {
    if (q.s === undefined || !DB.src[q.s]) return '';
    var s = DB.src[q.s];
    return '<a class="src" href="' + esc(s[1]) + '" target="_blank" rel="noopener">官方讲义：<span lang="fr">' + esc(s[0]) + '</span> ↗</a>';
  }
  // one question. o: { perm, chosen, zh, mode: 'practice' | 'exam' | 'review' | 'show' | 'demo' }  (demo: the question of the welcome screen, answered in place and never recorded)
  function question(q, o) {
    var answered = o.chosen !== undefined && o.chosen !== -1;
    var show = o.mode === 'show';
    var demo = o.mode === 'demo';
    var reveal = show || o.mode === 'review' || ((o.mode === 'practice' || demo) && answered);
    var showZh = o.zh || reveal;
    var kind = o.mode === 'practice' ? '<span class="tag th t-' + q.t + '"><i></i>' + theme(q.t).zh + '</span>' : '';
    kind += q.k === 's' ? '<span class="tag">情景题 · 本站编写，非官方原题</span>' : '<span class="tag g">知识题 · 官方题目</span>';
    var seen = recallIds().n[q.id];
    if (seen) kind += '<span class="tag hot">机经提到 ' + seen + ' 次</span>';
    var tap = o.mode !== 'exam';
    if (tap) loadDict();
    var out = '<div class="kind">' + kind + '</div><p class="stem" lang="fr">' + (tap ? tapWords(q.q) : esc(q.q)) + '</p>';
    if (o.mode !== 'exam' && !demo) {
      var tools = (o.mode === 'practice' ? '<button class="chip" data-a="zh" aria-pressed="' + (o.zh ? 'true' : 'false') + '" aria-label="显示中文翻译">中文</button>' : '') +
        (canSpeak ? '<button class="chip" data-a="say"' + (o.mode === 'practice' ? '' : ' data-v="' + esc(q.id) + '"') + ' aria-label="朗读">' + icon('say') + '听</button>' : '');
      out += (tools ? '<div class="tools">' + tools + '</div>' : '') + wordHint(o.mode, q);
    }
    if (showZh) out += '<p class="stemz">' + esc(q.qz) + '</p>';
    out += '<div class="opts">' + o.perm.map(function (orig, pos) {
      var cls = 'opt', dis = '', st = '';
      if (reveal) {
        dis = ' disabled';
        if (orig === 0) { cls += ' right'; st = icon('ok', 'st'); } else if (orig === o.chosen && !show) { cls += ' wrong'; st = icon('no', 'st'); } else cls += ' dim';
      } else if (o.mode === 'exam' && o.chosen === orig) cls += ' sel';
      // once the answer is out an option is no longer a button: its words can be tapped instead
      var el = reveal && tap ? 'div' : 'button';
      return '<' + el + ' class="' + cls + '"' + (el === 'div' ? '' : ' data-a="' + (o.mode === 'exam' ? 'exam-pick' : (demo ? 'demo-pick' : 'pick')) + '" data-v="' + orig + '"' + dis) + '>' +
        '<span class="let hexic">' + hex() + '<b>' + LETTERS[pos] + '</b></span><span class="txt"><span class="fr" lang="fr">' + (el === 'div' ? tapWords(q.o[orig]) : esc(q.o[orig])) + '</span>' +
        (showZh ? '<span class="zh">' + esc(q.oz[orig]) + '</span>' : '') + '</span>' + st + '</' + el + '>';
    }).join('') + '</div>';
    if (reveal && o.mode !== 'practice') out += explain(q, o);      // in practice the explanation is the panel at the bottom (vQuiz)
    return out;
  }
  // right or wrong, the right answer, why, the words, the official sheet, "something is wrong with this question"
  function explain(q, o) {
    var answered = o.chosen !== undefined && o.chosen !== -1, show = o.mode === 'show', ok = o.chosen === 0;
    var mark = '<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="14" fill="currentColor"/><path d="' + (ok ? 'm8 14.500 4.200 4.200L20 10' : 'm9 9 10 10m0-10L9 19') + '" fill="none" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<section class="copy ' + (show ? 'plain' : (ok ? 'good' : 'miss')) + '"' + (o.mode === 'practice' ? ' role="status"' : '') + '>' +
      (show ? '' : '<h3>' + mark + (ok ? '答对了' : (answered ? '答错了' : '没有作答')) + '</h3>') +
      (ok && !show ? '' : '<p class="ans"><span>正确答案是</span><span class="pill"><b>' + LETTERS[o.perm.indexOf(0)] + '</b><i lang="fr">' + esc(q.o[0]) + '</i></span></p>') +
      '<div class="why"><p>' + esc(q.e) + '</p>' +
      (q.v && q.v.length ? '<ul class="voc">' + q.v.map(function (v) { var tip = vocTip(v[0]); return '<li><span class="w" lang="fr">' + esc(v[0]) + '</span><span>' + esc(v[1]) + '</span>' + (tip ? '<span class="tip">' + esc(tip) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="more">' + srcLink(q) + (o.mode === 'demo' ? '' : reportLink(q)) + '</div></div></section>';
  }
  function disclaimer() {
    return '<footer class="foot"><p><b class="hex-b">非官方</b>本站不是法国政府网站，与内政部和考试机构无关。官方备考资料免费：<a href="https://formation-civique.interieur.gouv.fr/examen-civique/" target="_blank" rel="noopener">formation-civique.interieur.gouv.fr</a>。本站收费的是中文翻译、讲解和工具。</p>' +
      '<p>知识题题干来自内政部官方清单（Ministère de l’Intérieur – DIAN，Licence Ouverte 2.0，查阅于 ' + esc(DB.free.consulted || DB.free.built) + '）；选项、翻译和讲解由本站编写，正式考试的选项措辞会不同。</p></footer>';
  }

  // ---------------------------------------------------------------- tap a French word, see what it means
  // data/dict.json has one entry per word form found in the questions: word -> [meaning] or [meaning, tip].
  // Never in the mock exam: the real exam has no dictionary.
  var WORD_RE = /([A-Za-zÀ-ÿœæŒÆ]+['’])|([A-Za-zÀ-ÿœæŒÆ]+(?:-[A-Za-zÀ-ÿœæŒÆ]+)*)/g;
  var HINT_TIMES = 6;
  var dictWait = null, dictFail = false, wordAt = null, wordBox = null, wordY = 0;
  function loadDict() {
    if (DB.dict || dictWait) return;
    dictFail = false;
    dictWait = (window.CIVIQUE_DICT ? Promise.resolve(window.CIVIQUE_DICT) : getJson('data/dict.json')).then(function (d) {
      if (!d || !d.w || typeof d.w !== 'object') throw new Error('dict');
      DB.dict = d.w;
    }).catch(function () { dictFail = true; }).then(function () { dictWait = null; if (wordAt) fillWord(); });
  }
  function wordKey(w) { return String(w).toLowerCase().replace(/’/g, '\''); }
  function dictEntry(w) {
    var k = wordKey(w);
    var e = DB.dict && Object.prototype.hasOwnProperty.call(DB.dict, k) ? DB.dict[k] : null;
    return Array.isArray(e) && e[0] ? e : null;
  }
  function tapWords(text) {
    var out = '', last = 0;
    text = String(text);
    text.replace(WORD_RE, function (m) {
      var at = arguments[arguments.length - 2];
      out += esc(text.slice(last, at)) + '<span class="tw" data-a="tw">' + esc(m) + '</span>';
      last = at + m.length;
      return m;
    });
    return out + esc(text.slice(last));
  }
  // the tip for a word of the vocabulary list: the word itself, or the word without its article
  function vocTip(w) {
    var e = dictEntry(w) || dictEntry(String(w).replace(/^(?:l['’]|(?:le|la|les|un|une|des)\s+)/i, ''));
    return e && e[1] ? e[1] : '';
  }
  function wordHint(mode, q) {
    if (mode !== 'practice' || S.tapped) return '';
    if (ui.hintFor !== q.id) { ui.hintFor = q.id; S.hinted = (S.hinted || 0) + 1; }     // saved with the next answer
    return S.hinted > HINT_TIMES ? '' : '<p class="tw-hint">点任意法语词，看中文意思</p>';
  }
  function closeWord() {
    if (wordAt) wordAt.classList.remove('on');
    if (wordBox && wordBox.parentNode) wordBox.parentNode.removeChild(wordBox);
    wordAt = null; wordBox = null;
  }
  function fillWord() {
    if (!wordAt || !wordBox) return;
    var w = wordAt.textContent, e = dictEntry(w), said = w, nx = wordAt.nextSibling;
    if (/['’]$/.test(w) && nx && nx.nodeType === 1 && nx.classList.contains('tw')) said = w + nx.textContent;      // "l'" alone cannot be pronounced
    var body;
    if (e) body = '<p class="tw-zh">' + esc(e[0]) + '</p>' + (e[1] ? '<p class="tw-tip"><b>记法</b>' + esc(e[1]) + '</p>' : '');
    else if (DB.dict) body = '<p class="tw-none">词典里没有这个词，多半是人名、地名或数字。</p>';
    else if (dictFail) body = '<p class="tw-none">词典没有加载出来，检查网络后再点一次。</p>';
    else body = '<p class="tw-none">词典正在加载…</p>';
    wordBox.innerHTML = '<div class="tw-top"><span class="tw-w" lang="fr">' + esc(w) + '</span>' +
      (canSpeak ? '<button class="tw-say" data-a="word" data-v="' + esc(said) + '" aria-label="听发音">' + icon('say') + '</button>' : '') + '</div>' + body;
    placeWord();
  }
  function placeWord() {
    var rects = wordAt.getClientRects(), r = rects.length ? rects[0] : wordAt.getBoundingClientRect();
    var vw = document.documentElement.clientWidth, vh = window.innerHeight, edge = 10, gap = 10;
    wordBox.className = 'tw-pop';
    wordBox.style.left = '0px'; wordBox.style.top = '0px';
    var bw = wordBox.offsetWidth, bh = wordBox.offsetHeight;
    var bar = document.querySelector('.qbar'), roof = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    var foot = document.querySelector('.dock, .tabs'), floor = foot ? Math.min(vh, foot.getBoundingClientRect().top) : vh;   // the note never covers the bottom bar
    var mid = r.left + r.width / 2;
    var left = Math.max(edge, Math.min(mid - bw / 2, vw - edge - bw));
    var below = r.top - gap - bh < roof + 4 && r.bottom + gap + bh <= floor - 4;
    if (below) wordBox.className = 'tw-pop below';
    var top = below ? r.bottom + gap : Math.max(roof + 4, r.top - gap - bh);
    wordBox.style.left = Math.round(left) + 'px';
    wordBox.style.top = Math.round(Math.max(4, Math.min(top, floor - 4 - bh))) + 'px';
    wordBox.style.setProperty('--tw-x', Math.round(Math.max(18, Math.min(mid - left, bw - 18))) + 'px');
  }
  function tapWord(el) {
    if (wordAt === el) return closeWord();
    closeWord();
    if (!DB.dict) loadDict();
    if (!S.tapped) {
      S.tapped = 1; save();
      var hint = document.querySelector('.tw-hint'); if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    }
    wordAt = el; wordY = window.pageYOffset || 0; el.classList.add('on');
    wordBox = document.createElement('div');
    wordBox.className = 'tw-pop'; wordBox.setAttribute('role', 'status');
    document.body.appendChild(wordBox);
    fillWord();
  }
  document.addEventListener('click', function (ev) {
    if (!wordAt || !ev.target.closest) return;
    if (ev.target.closest('.tw-say') || ev.target.closest('.tw')) return;      // listening keeps the note open; another word replaces it
    var onNote = ev.target.closest('.tw-pop');
    closeWord();                                                                 // anywhere else, the note itself included
    if (onNote && typeof ev.clientX === 'number' && document.elementFromPoint) {  // the note was lying on something: pass the tap on to it
      var under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (under && under !== ev.target && under.click && !(under.closest && under.closest('.tw'))) under.click();
    }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeWord(); });
  // the note is pinned to the screen, so it goes when the page really moves (not for the tail end of a scroll that brought the word into view)
  window.addEventListener('scroll', function () { if (wordAt && Math.abs((window.pageYOffset || 0) - wordY) > 6) closeWord(); }, { passive: true });
  window.addEventListener('resize', function () { if (wordAt) closeWord(); });

  // ---------------------------------------------------------------- first question, price buttons, report
  // a button that leads to paying: the price is written on it and the terms right under it
  function buyButton(href, label, bare) {
    return '<div class="buy"><a class="btn wide lg" href="' + esc(href) + '"><span>' + esc(label) + '</span>' +
      (CFG.price ? '<span class="buy-dot" aria-hidden="true"> · </span><b class="buy-p">' + esc(CFG.price) + '</b>' : '') + '</a>' +
      (bare ? '' : '<p class="buy-terms">' + (CFG.price ? '一次付款，不是订阅，长期使用' : '一次性付款，不是订阅') + '</p>') + '</div>';
  }
  // the question a visitor can answer on the welcome screen: a free official question every exam has,
  // one that candidates reported if there is one, then the shortest to read
  var DEMO_PERM = [2, 0, 3, 1];
  function demoQuestion() {
    var lv = levelIds(), seen = recallIds().n;
    var list = (DB.free.qs || []).filter(function (q) {
      return q.k === 'c' && q.e && q.qz && q.v && q.v.length && q.o.length === 4 && lv.every(function (l) { return q.l.indexOf(l) >= 0; });
    });
    list.sort(function (a, b) {
      return (seen[b.id] ? 1 : 0) - (seen[a.id] ? 1 : 0) || a.q.length - b.q.length || (a.id < b.id ? -1 : 1);
    });
    return list[0] || null;
  }
  function demoBlock() {
    var q = demoQuestion();
    if (!q) return '';
    var done = ui.demo !== undefined, ok = ui.demo === 0;
    return '<section class="offer-sample wl-try' + (done ? ' done' : '') + '"><div class="wl-try-head"><h2 class="offer-stamp">先试一题</h2>' + (done ? '' : '<span class="tw-hint">点一个答案</span>') + '</div>' +
      question(q, { perm: DEMO_PERM, chosen: ui.demo, mode: 'demo' }) +
      (done ? '<div class="wl-react ' + (ok ? 'good' : 'miss') + '">' + six(ok ? 'cheer' : 'console', 0, 'bob') + '<p class="say"><span>' + (ok ? '答对了！' : '没关系，') + '每题都这样讲</span></p></div>' +
        '<button class="wl-on" data-a="demo-next"><b>选考试类型，接着练</b><i aria-hidden="true">↓</i></button>' : '') + '</section>';
  }
  // when the bank was built and when the official list was last read, with the number of questions
  function bankLine() {
    var f = DB.free, parts = [];
    if (f.built) parts.push('题库更新于 ' + esc(f.built));
    if (f.consulted) parts.push('官方题目清单查阅于 ' + esc(f.consulted));
    if (f.meta && f.meta.total) parts.push('共 ' + f.meta.total + ' 题');
    return parts.length ? '<p class="small bank-asof">' + parts.join(' · ') + '</p>' : '';
  }
  // "something is wrong with this question": there is no server, so it is an email when the seller gave one, else the number to pass on
  function contactMail() { var c = String(CFG.contact || '').trim(); return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(c) ? c : ''; }
  function reportLink(q) {
    var mail = contactMail();
    if (mail) {
      return '<a class="report" href="mailto:' + esc(encodeURIComponent(mail).replace(/%40/g, '@')) + '?subject=' + encodeURIComponent('题目纠错 ' + q.id) +
        '&amp;body=' + encodeURIComponent('题号：' + q.id + '\n哪里有问题：\n') + '">这道题有问题？<span class="rid">题号 ' + esc(q.id) + '</span></a>';
    }
    return '<button class="report" data-a="report" data-v="' + esc(q.id) + '">这道题有问题？</button>';
  }
  function reportSheet(id) {
    var c = String(CFG.contact || '').trim();
    ui.modal = {
      title: '这道题有问题？',
      body: '<p class="rep-id"><span>题号</span><b class="code" id="repid">' + esc(id) + '</b></p>' +
        '<p>' + (c ? '把题号和哪里有问题发给：<b class="rep-to">' + esc(c) + '</b>，核实后会更正。' : '把题号发给卖家，核实后会更正。') + '</p>' +
        '<p class="msg" id="repmsg" role="status"></p>',
      actions: [{ a: 'copy-id', v: id, label: '复制题号' }, { a: 'close', label: '关闭', cls: 'quiet' }]
    };
  }
  function copyId(id) {
    var note = document.getElementById('repmsg');
    function say(t, ok) { if (note) { note.textContent = t; note.className = 'msg' + (ok ? ' ok' : ''); } }
    function byHand() {
      var el = document.getElementById('repid'), done = false;
      try {
        var r = document.createRange(), sel = window.getSelection();
        r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
        done = !!(document.execCommand && document.execCommand('copy'));
      } catch (e) { /* the number stays on screen to copy by hand */ }
      say(done ? '已复制题号 ' + id : '题号已选中，长按可以复制。', done);
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(id).then(function () { say('已复制题号 ' + id, true); }, byHand); return; }
    } catch (e) { /* older browsers: select it instead */ }
    byHand();
  }

  // ---------------------------------------------------------------- views
  // small pictures only the welcome and exam screens use (drawn like icon())
  var PIC = {
    csp: '<rect x="3" y="5.500" width="18" height="13" rx="2.500"/><circle cx="8.500" cy="10.800" r="1.900"/><path d="M13.500 10h4M13.500 13.500h4M6 15.500h5"/>',
    cr: '<rect x="3" y="5.500" width="18" height="13" rx="2.500"/><path d="m9 8.400 1.100 2.300 2.500.3-1.900 1.700.5 2.500L9 14l-2.200 1.200.5-2.500-1.900-1.700 2.500-.3z" fill="currentColor" stroke="none"/><path d="M15 10h3M15 13.500h3"/>',
    nat: '<rect x="5.500" y="3" width="13" height="18" rx="2.500"/><circle cx="12" cy="10" r="3"/><path d="M9.500 16.500h5"/>',
    flag: '<path d="M6.500 21V4M6.500 4.500H18l-2.800 4 2.800 4H6.500"/>',
    flagOn: '<path d="M6.500 21V4"/><path d="M6.500 4.500H18l-2.800 4 2.800 4H6.500z" fill="currentColor"/>',
    grid: '<rect x="4" y="4" width="6.500" height="6.500" rx="1.800"/><rect x="13.500" y="4" width="6.500" height="6.500" rx="1.800"/><rect x="4" y="13.500" width="6.500" height="6.500" rx="1.800"/><rect x="13.500" y="13.500" width="6.500" height="6.500" rx="1.800"/>'
  };
  function pic(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PIC[n] + '</svg>'; }
  function vChoose() {
    var meta = DB.free.meta, m = meta.counts;
    function n(lv) { var c = 0; THEMES.forEach(function (t) { c += m[lv][t.id].c; }); return c; }
    var proof = [[meta.total, '道题'], [meta.cards, '张速记卡'], [DB.recall.length, '场机经'], [meta.free, '题免费', 'free']]
      .filter(function (p) { return p[0] > 0; });
    return '<main class="wrap wl">' +
      '<header class="hero wl-hero">' + heroDeco() + six('cheer', 0, 'bob') + '<div class="txt"><p class="say wl-hi"><span>你好，我是小玛</span></p>' +
      '<h1>法国公民考试，<br>用中文<em>看懂每一题</em></h1>' +
      '<p class="wl-lead"><b class="wl-un">非官方</b>法语原题 + 中文讲解</p></div></header>' +
      '<section class="wl-proof-wrap"><ul class="wl-proof" style="grid-template-columns:repeat(' + proof.length + ',minmax(0,1fr))">' + proof.map(function (p) {
        return '<li' + (p[2] ? ' class="' + p[2] + '"' : '') + '><b>' + p[0] + '</b><span>' + p[1] + '</span></li>';
      }).join('') + '</ul>' +
      (DB.recall.length ? '<p class="small">机经是考生在网上分享的回忆，不是官方题目。</p>' : '') + '</section>' +
      demoBlock() +
      '<section class="stack wl-next" id="pickexam"><div class="wl-next-head"><h2>你准备申请哪一种？</h2><span class="tag g">免费开始，不用注册</span></div>' +
      levelIds().map(function (lv) {
        return '<button class="tile wl-pick lv-' + lv + '" data-a="target" data-v="' + lv + '">' + hex('deco') + '<span class="hexic white">' + hex() + pic(lv) + '</span>' +
          '<span class="t1">' + LEVELS[lv].zh + '</span><span class="cnt"><b>' + n(lv) + '</b></span>' +
          '<span class="t2" lang="fr">' + LEVELS[lv].fr + '</span><span class="u">道官方题</span></button>';
      }).join('') +
      '<a class="wl-check" href="#check"><span>不确定要不要考？</span><b>30 秒自测' + icon('go') + '</b></a>' +
      '<p class="small center">选错了没关系，随时在“我的”里换。</p></section>' +
      disclaimer() + '</main>' + tabs('home');
  }
  function vHome() {
    if (!S.target) return vChoose();
    var t = totals(), p = plan(), r = readiness(), x = lastExam(), sess = S.sess && S.sess.i < S.sess.ids.length ? S.sess : null;
    var began = answeredCount() > 0, hit = p.goal > 0 && p.done >= p.goal;
    var out = '<main class="wrap">' + pagehead('<span class="h-opt">今天</span>' + (began ? '继续闯关' : '开始闯关'), levelChip() + countChip(), 'h-head');
    if (ui.netFail) out += '<p class="note warn">已购买的题库这次没有加载出来，目前只显示免费题。请检查网络后刷新页面。</p>';
    if (ui.revoked) out += '<p class="note warn">这台设备保存的解锁码已失效，请重新输入解锁码或联系卖家。</p>';
    // today's goal, with 小玛 inside the ring
    var say = !p.goal ? (unlocked() ? '全部掌握了，去模考吧' : '免费题都掌握了') : (hit ? '今天达标了！' : (p.done ? '再做 <b>' + (p.goal - p.done) + '</b> 题就达标！' : '今天做 <b>' + p.goal + '</b> 题'));
    out += '<section class="hero home">' + heroDeco() + '<div class="hero-top">' +
      hexRing(p.goal ? p.done / p.goal * 100 : 100, six(hit ? 'celebrate' : 'cheer', 0, 'bob'), '今日目标：已完成 ' + p.done + (p.goal ? ' / ' + p.goal : '') + ' 题') +
      '<div class="goal"><div class="lab">今日目标' + (p.week > 1 ? ' · 本周第 ' + p.week + ' 天' : '') + '</div>' +
      '<div class="num"><b>' + p.done + '</b><span>' + (p.goal ? '/ ' + p.goal : '') + '<em>题</em></span></div>' +
      '<div class="say"><span>' + say + '</span></div></div></div>' +
      '<button class="btn wide lg" data-a="continue">' + icon('play') + (sess ? '继续练习' : (began ? '接着练' : '开始练习')) + '</button></section>';
    // mastered, and the readiness estimate
    out += '<div class="stats"><div class="stat st-done"><div class="lab">已掌握' + (unlocked() ? '<span class="tag g">已解锁</span>' : '') + '</div>' +
      '<div class="num"><b>' + t.done + '</b><span>/ ' + t.total + '<em>题</em></span></div>' + bar(t.done, t.total) +
      '<div class="cap"><b>' + (t.total ? Math.round(t.done / t.total * 100) : 0) + '%</b>' + (unlocked() ? '' : '<span>免费开放 ' + t.have + ' 题</span>') + '</div></div>' +
      readyTile(r) + '</div>' + weakRow(r) + (x ? examFact(x) : '');
    out += '<div class="themes">' + THEMES.map(function (th) {
      var c = counts(th.id);
      return '<button class="theme tile t-' + th.id + (c.total && c.done >= c.total ? ' full' : '') + '" data-a="theme" data-v="' + th.id + '" aria-label="' + th.zh + '，已掌握 ' + c.done + ' / ' + c.total + '">' +
        '<span class="ti hexic white">' + hex() + icon(th.id) + '</span><span class="cnt">' + c.done + '<small> / ' + c.total + '</small></span>' +
        '<span class="t1">' + th.zh + '</span>' + bar(c.done, c.total, 'on-c') + '</button>';
    }).join('') + '</div>';
    if (!unlocked()) out += payBlock('解锁全部内容');
    return out + disclaimer() + '</main>' + tabs('home');
  }
  function themeSheet(tid) {
    var th = theme(tid), c = counts(tid), acts = [];
    var situTodo = pool().filter(function (q) { return q.t === tid && q.k === 's' && !mastered(q.id); }).length;
    if (c.todo) acts.push({ label: (c.done ? '接着练' : '开始练') + '（每组 ' + Math.min(SET, c.todo) + ' 题）', a: 'start', v: tid + '|todo' });
    if (situTodo) acts.push({ label: '只练情景题', a: 'start', v: tid + '|situ', cls: 'ghost' });
    if (c.done) acts.push({ label: '清空这个主题的记录，从头重练', a: 'restart', v: tid, cls: 'quiet' });
    if (!unlocked() && !c.todo) acts.unshift({ label: '解锁全部题目', a: 'goto', v: 'unlock' });
    acts.push({ label: '关闭', a: 'close', cls: 'quiet' });
    var body = '<p class="sub" lang="fr">' + th.fr + '</p><ul class="rules theme-rules">' +
      '<li><span class="k">你的进度</span><span class="v">已掌握 <b>' + c.done + '</b> / ' + c.total + (unlocked() ? '' : '，免费开放 ' + c.have + ' 题') + '</span></li>' +
      '<li><span class="k">题库</span><span class="v">官方知识题 <b>' + c.know + '</b> 题' + (c.situ ? '，情景练习题 <b>' + c.situ + '</b> 题' : '') + '</span></li>' +
      '<li><span class="k">正式考试</span><span class="v">这个主题出 <b>' + (th.k + th.s) + '</b> 题' + (th.s ? '（其中 ' + th.s + ' 题情景题）' : '') + '</span></li></ul>' +
      (c.situ ? '<p class="small">情景题怎么判断：见<button class="link" data-a="goto" data-v="sheet">考前一页</button></p>' : '') +
      (!unlocked() && !c.todo ? '<p class="note blue">这个主题的免费题已经全部掌握，其余 ' + (c.total - c.have) + ' 题解锁后可以练。</p>' : '');
    ui.modal = { title: th.zh, body: body, actions: acts };
  }
  function vQuiz() {
    var s = S.sess;
    if (!s) return vHome();
    var special = s.mode === 'wrong' || s.mode === 'recall' || s.theme === 'all';
    var th = s.mode === 'wrong' ? { zh: '错题重做' } : (s.mode === 'recall' ? { zh: '机经题' } : (s.theme === 'all' ? { zh: '情景题' } : theme(s.theme)));
    var n = s.ids.length;
    if (s.i >= n) {            // set finished: a celebration in proportion to the score
      var right = s.ids.filter(function (id) { return s.ans[id] === 0; }).length, ratio = n ? right / n : 0;
      var more = s.mode === 'wrong' ? mistakes().length : (s.mode === 'recall' ? recallTodo().length : pool().filter(function (q) { return (s.theme === 'all' || q.t === s.theme) && !mastered(q.id) && (s.mode !== 'situ' || q.k === 's'); }).length);
      var c = special ? null : counts(s.theme);
      var mood = ratio >= 0.8 ? 'celebrate' : (ratio >= 0.5 ? 'cheer' : 'console');
      var cheer = right === n ? '全对！' : (ratio >= 0.8 ? '太棒了！' : (ratio >= 0.5 ? '不错，继续' : '别灰心，再来'));
      var out = '<main class="wrap"><section class="hero done-hero">' + heroDeco() + (ratio >= 0.8 ? confetti() : '') + six(mood, 0, 'bob') +
        '<h2>' + cheer + '</h2><div class="big" aria-label="答对 ' + right + ' / ' + n + ' 题">' + right + '<small> / ' + n + '</small></div>' +
        '<span class="sub">' + th.zh + ' · 这一组做完了</span>' + bar(right, n, 'on-c') + '</section>';
      out += '<div class="stack">';
      if (more) out += '<button class="btn wide lg" data-a="start" data-v="' + s.theme + '|' + s.mode + '">' + (s.mode === 'wrong' ? '继续重做错题 · 还有 ' + more + ' 题' : '下一组 · 还有 ' + more + ' 题没掌握') + '</button>';
      else if (s.mode === 'wrong') out += '<p class="note blue">错题本清空了。</p>';
      else if (s.mode === 'recall') out += '<p class="note blue">机经里能练的题都已经掌握。</p>';
      else if (s.theme === 'all') out += '<p class="note blue">' + (unlocked() ? '情景题已经全部掌握。' : '免费开放的情景题已经全部掌握，其余的解锁后可以练。') + '</p>';
      else if (!unlocked() && c && c.have < c.total) out += '<p class="note blue">这个主题的免费题已经全部掌握，其余 ' + (c.total - c.have) + ' 题解锁后可以练。</p>';
      else out += '<p class="note blue">这个主题的题目已经全部掌握。</p>';
      var nt = nextTheme();
      if (!more && nt && !special) out += '<button class="btn wide lg" data-a="start" data-v="' + nt + '|todo">去练「' + theme(nt).zh + '」</button>';
      out += '<a class="btn wide ghost" href="#home">回首页</a></div>';
      if (!unlocked() && !more) out += payBlock();
      return out + '</main>' + tabs('practice');
    }
    var id = s.ids[s.i], q = DB.byId[id], chosen = s.ans[id], done = chosen !== undefined;
    var last = s.i === n - 1, o = { perm: permFor(s, id), chosen: chosen, zh: !!S.zhOn, mode: 'practice' };
    var back = s.mode === 'recall' ? 'recall' : (s.mode === 'wrong' ? 'mistakes' : (ui.from && VIEWS[ui.from] && ui.from !== 'quiz' ? ui.from : 'home'));
    var prev = '<button class="sq" data-a="prev" aria-label="上一题"' + (s.i === 0 ? ' disabled' : '') + '>' + icon('back') + '</button>';
    return '<main class="wrap bare"><div class="qbar"><a class="sq back" href="#' + back + '" aria-label="返回">' + icon('back') + '</a>' +
      '<div class="bar" role="img" aria-label="' + th.zh + '：第 ' + (s.i + 1) + ' 题，共 ' + n + ' 题"><i style="width:' + Math.round((s.i + (done ? 1 : 0)) / n * 100) + '%"></i></div>' +
      '<span class="pos"><b>' + (s.i + 1) + '</b> <small>/ ' + n + '</small></span></div>' +
      question(q, o) + '</main>' +
      (done ? '<div class="dock fb ' + (chosen === 0 ? 'good' : 'miss') + '">' + six(chosen === 0 ? 'cheer' : 'console') + '<div class="in">' + explain(q, o) +
        '<div class="fb-go">' + prev + '<button class="btn white" data-a="next">' + (last ? '完成这一组' : '下一题') + icon('next') + '</button></div></div></div>'
        : '<div class="dock"><div class="in">' + prev + '<button class="btn" data-a="next" disabled>' + (last ? '完成这一组' : '下一题') + '</button></div></div>');
  }
  // 练习: the hub of everything that is practice
  function vPractice() {
    if (!S.target) return vChoose();
    var sess = S.sess && S.sess.i < S.sess.ids.length ? S.sess : null, nm = mistakes().length;
    var situ = pool().filter(function (q) { return q.k === 's' && !mastered(q.id); }).length, rc = recallIds();
    var out = '<main class="wrap">' + pagehead('练习', levelChip());
    if (sess) out += '<button class="btn wide" data-a="continue">' + icon('play') + '继续上次的练习 · 第 ' + (sess.i + 1) + ' / ' + sess.ids.length + ' 题</button>';
    out += '<section class="stack"><h2>按主题练</h2><div class="list">' + THEMES.map(function (th) {
      var c = counts(th.id);
      return '<div class="lrow th-row t-' + th.id + '"><button class="th-open" data-a="theme" data-v="' + th.id + '" aria-label="' + th.zh + '：详情和更多练法">' + hexBadge(icon(th.id), 'solid') +
        '<span class="grow"><span class="t1">' + th.zh + '</span><span class="t2"><b class="num">' + c.done + '</b> / ' + c.total + ' 题</span>' + bar(c.done, c.total) + '</span></button>' +
        (c.todo ? '<button class="btn sm" data-a="start" data-v="' + th.id + '|todo" aria-label="练' + th.zh + '">练</button>'
          : (unlocked() ? '<span class="tag g">已掌握</span>' : '<a class="btn sm ghost" href="#unlock">解锁</a>')) + '</div>';
    }).join('') + '</div></section>';
    function tile(attrs, ic, t1, t2, dot) {
      var el = attrs.indexOf('href=') === 0 ? 'a' : 'button';
      return '<' + el + ' class="hub-tile" ' + attrs + '><span class="top">' + hexBadge(icon(ic), 'solid') + (dot || '') + '</span><span class="t1">' + t1 + '</span><span class="t2">' + t2 + '</span></' + el + '>';
    }
    out += '<section class="stack"><h2>专项</h2><div class="hub-grid">' +
      (situ ? tile('data-a="start" data-v="all|situ"', 'situ', '只练情景题', '还有 ' + situ + ' 题没掌握') : '') +
      tile('href="#mistakes"', 'mistakes', '错题本', nm ? '答对两次才移出' : '还没有错题', nm ? '<b class="dot">' + nm + '</b>' : '') +
      tile('href="#recall"', 'recall', '机经', DB.recall.length ? DB.recall.length + ' 场考生回忆，非官方' : '考生回忆，非官方', rc.ids.length ? '<b class="dot calm">' + rc.ids.length + '</b>' : '') +
      tile('href="#sheet"', 'sheet', '考前一页', '免费 · 数字、年份、人名') + '</div></section>';
    return out + '</main>' + tabs('practice');
  }
  // 我的: unlock, exam type, exam date, the pages about the real exam, settings
  function vMe() {
    var out = '<main class="wrap">' + pagehead('我的'), t = S.target ? totals() : null, left = S.target ? daysLeft() : null, d = S.examDate ? dayAt(S.examDate) : null;
    if (unlocked()) {
      out += '<a class="card me-card done lrow" href="#unlock">' + six('celebrate', 0, '', { mini: true }) + '<span class="grow"><span class="t1">已解锁全部题目</span><span class="t2">查看解锁码</span></span><span class="go">' + icon('go') + '</span></a>';
    } else out += payBlock(t ? '免费试用中 · 开放 ' + t.have + ' / ' + t.total + ' 题' : '免费试用中');
    out += '<section class="stack"><h2>考试类型</h2><div class="seg n' + levelIds().length + '" role="group" aria-label="准备申请的类型">' + levelIds().map(function (lv) {
      return '<button data-a="target" data-v="' + lv + '" aria-pressed="' + (S.target === lv) + '"><b>' + LEVELS[lv].short + '</b><span lang="fr">' + LEVELS[lv].frs + '</span></button>';
    }).join('') + '</div></section>';
    function row(attrs, ic, t1, t2) {
      var el = attrs.indexOf('href=') === 0 ? 'a' : 'button';
      return '<' + el + ' class="lrow" ' + attrs + '>' + hexBadge(icon(ic)) + '<span class="grow"><span class="t1">' + t1 + '</span>' + (t2 ? '<span class="t2">' + t2 + '</span>' : '') + '</span><span class="go">' + icon('go') + '</span></' + el + '>';
    }
    out += '<div class="list">' +
      (S.target ? row('data-a="plan-edit"', 'date', '考试日期', d ? (d.getMonth() + 1) + '月' + d.getDate() + '日' + (left > 0 ? ' · 还有 ' + left + ' 天' : (left === 0 ? ' · 就是今天' : ' · 已经过了')) : '还没设') : '') +
      row('href="#check"', 'check', '我要不要考？', '30 秒自测') +
      row('href="#register"', 'register', '报名考试', '步骤和考场查询') +
      row('href="#about"', 'about', '说明', '关于考试和这个题库') +
      row('data-a="reset"', 'reset', '清空练习记录', '') + '</div>';
    return out + bankLine() + disclaimer() + '</main>' + tabs('me');
  }
  function vExam() {
    if (!S.target) return vChoose();
    var x = S.exam;
    if (!x) {
      var un = unlocked(), hist = S.exams.filter(function (e) { return e.target === S.target; }).slice(0, 5), know = 0, situ = 0;
      THEMES.forEach(function (t) { know += t.k; situ += t.s; });
      // the challenge card: the exam in three numbers and the one button
      var out = '<main class="wrap">' + pagehead('模考', levelChip()) + '<section class="hero ex-hero">' + heroDeco() +
        '<div class="ex-top">' + six('cheer', 0, 'bob') + '<p class="say"><span>和正式考试一样</span></p></div>' +
        '<ul class="nums n3"><li><b>' + EXAM.n + '</b><span>题单选</span></li><li><b>' + EXAM.min + '</b><span>分钟</span></li><li class="pass"><b>' + EXAM.pass + '</b><span>题及格</span></li></ul>' +
        '<p class="sub">考试中只有法语，交卷后看中文讲解</p>' +
        (un ? '<button class="btn wide lg" data-a="exam-start" data-v="full">' + icon('play') + '开始考试</button>'
          : '<button class="btn wide lg" data-a="exam-start" data-v="mini">' + icon('play') + '免费试考 · ' + MINI.n + ' 题 ' + MINI.min + ' 分钟</button>') + '</section>';
      if (!un) out += '<p class="small center ex-note">试考从免费题里抽 ' + MINI.n + ' 题，对 ' + MINI.pass + ' 题通过。完整 ' + EXAM.n + ' 题模考解锁后开放。</p>';
      // how the 40 questions are shared between the five themes
      out += '<section class="card ex-mix"><div class="row between"><h2>' + EXAM.n + ' 题怎么分</h2><span class="tag"><b>' + know + '</b> 知识题 + <b>' + situ + '</b> 情景题</span></div>' +
        themeMix(THEMES.map(function (t) { return [t, t.k + t.s]; }), '正式考试各主题的题数') +
        '<details class="disc flat"><summary>五个主题</summary><ul class="in mix-key">' + THEMES.map(function (t) {
          return '<li class="t-' + t.id + '"><i></i><span>' + t.zh + '</span><b>' + (t.k + t.s) + '</b></li>';
        }).join('') + '</ul></details></section>';
      if (hist.length) out += '<section class="stack"><h2>最近成绩</h2><div class="list">' + hist.map(function (e) {
        var idx = S.exams.indexOf(e), ok = e.score >= e.passAt;
        return '<button class="lrow ex-past ' + (ok ? 'pass' : 'fail') + '" data-a="result-show" data-v="' + idx + '"><span class="sc"><b>' + e.score + '</b> / ' + e.n + '</span>' +
          '<span class="grow t2">' + dateZh(e.ts) + (e.mini ? ' · 试考' : '') + '</span><span class="tag ' + (ok ? 'g' : 'warm') + '">' + (ok ? '通过' : '差 ' + (e.passAt - e.score) + ' 题') + '</span><span class="go">' + icon('go') + '</span></button>';
      }).join('') + '</div></section>';
      if (!un) out += payBlock('解锁完整模拟考试');
      return out + '</main>' + tabs('exam');
    }
    // the running exam: calm, French only, no mascot
    var id = x.ids[x.i], q = DB.byId[id], left = examLeft(), n = x.ids.length, last = x.i === n - 1, flagged = !!x.flags[id];
    var answered = x.ids.filter(function (k) { return x.ans[k] !== undefined; }).length;
    return '<main class="wrap bare ex-run"><div class="qbar"><button class="sq" data-a="exam-quit" aria-label="放弃本次考试">' + icon('close') + '</button>' +
      '<div class="bar" role="img" aria-label="已答 ' + answered + ' / ' + n + '"><i style="width:' + Math.round(answered / n * 100) + '%"></i></div>' +
      '<span class="timer' + (left < 300 ? ' low' : '') + '" id="timer" aria-label="剩余时间">' + mmss(left) + '</span></div>' +
      '<div class="ex-bar"><span class="pos">第 <b>' + (x.i + 1) + '</b> <small>/ ' + n + ' 题</small></span>' +
      '<button class="chip ex-flag" data-a="exam-flag" aria-pressed="' + flagged + '" aria-label="' + (flagged ? '取消标记' : '标记这题，稍后再看') + '">' + pic(flagged ? 'flagOn' : 'flag') + (flagged ? '已标记' : '标记') + '</button>' +
      '<button class="chip ex-nums" data-a="exam-grid" aria-label="题号：已答 ' + answered + ' / ' + n + '">' + pic('grid') + '已答 <b>' + answered + '</b></button></div>' +
      question(q, { perm: permFor(x, id), chosen: x.ans[id], zh: false, mode: 'exam' }) + '</main>' +
      '<div class="dock"><div class="in"><button class="sq" data-a="exam-prev" aria-label="上一题"' + (x.i === 0 ? ' disabled' : '') + '>' + icon('back') + '</button>' +
      (last ? '<button class="btn" data-a="exam-submit">交卷</button>' : '<button class="btn" data-a="exam-next">下一题' + icon('next') + '</button>') + '</div></div>';
  }
  // a stacked bar of theme-coloured blocks, each as wide as its share. parts: [[theme, n], …]
  function themeMix(parts, label) {
    return '<div class="mix" role="img" aria-label="' + esc(label) + '：' + parts.map(function (p) { return p[0].zh + ' ' + p[1] + ' 题'; }).join('、') + '">' + parts.map(function (p) {
      return '<span class="t-' + p[0].id + '" style="flex-grow:' + p[1] + '">' + icon(p[0].id) + '<b>' + p[1] + '</b></span>';
    }).join('') + '</div>';
  }
  function examGrid() {
    var x = S.exam, done = 0, flags = 0;
    var cells = x.ids.map(function (id, i) {
      var a = x.ans[id] !== undefined, f = !!x.flags[id];
      if (a) done++;
      if (f) flags++;
      return '<button class="' + (a ? 'done ' : '') + (i === x.i ? 'cur ' : '') + (f ? 'flag' : '') + '" data-a="exam-go" data-v="' + i + '" aria-label="第 ' + (i + 1) + ' 题' + (a ? '，已答' : '，未答') + (f ? '，已标记' : '') + '">' + hex() + '<b>' + (i + 1) + '</b></button>';
    }).join('');
    var body = '<div class="grid40' + (x.ids.length <= 10 ? ' few' : '') + '">' + cells + '</div>' +
      '<ul class="grid-key"><li class="done"><i></i>已答 <b>' + done + '</b></li><li><i></i>未答 <b>' + (x.ids.length - done) + '</b></li><li class="flag"><i></i>标记 <b>' + flags + '</b></li></ul>';
    ui.modal = { title: '题号', body: body, actions: [{ label: '交卷', a: 'exam-submit' }, { label: '继续答题', a: 'close', cls: 'quiet' }] };
  }
  // a row that opens to the question with its explanation. chosen === null: plain list (no right / wrong mark)
  function reviewRow(q, n, chosen, perm, key) {
    var plain = chosen === null, ok = chosen === 0, open = !!ui.open[key];
    return '<li><button class="qrow" data-a="open" data-v="' + esc(key) + '" aria-expanded="' + open + '"><span class="i">' + n + '</span><span class="s" lang="fr">' + esc(q.q) + '</span>' +
      (plain ? '<span class="m more" aria-hidden="true">' + (open ? '−' : '+') + '</span>' : '<span class="m ' + (ok ? 'okm' : 'badm') + '">' + (ok ? '✓' : '✗') + '</span>') + '</button>' +
      (open ? '<div class="detail">' + question(q, { perm: perm, chosen: plain ? -1 : chosen, zh: true, mode: plain ? 'show' : 'review' }) + '</div>' : '') + '</li>';
  }
  function vResult() {
    var e = S.exams[ui.resultIdx] || S.exams[0];
    if (!e) return vExam();
    var pass = e.score >= e.passAt, wrong = e.items.filter(function (it) { return it[1] !== 0; }).length, secs = e.secs || 0;
    var only = !!ui.resOnly && wrong > 0 && wrong < e.items.length;
    // the moment: 小玛 celebrates (in a red cap, just this once) or consoles, the score, the pass mark
    var out = '<main class="wrap">' + topbar('成绩', 'exam') + '<section class="hero res-hero ' + (pass ? 'pass' : 'plain fail') + '">' + (pass ? heroDeco() + confetti() : '') + six(pass ? 'celebrate' : 'console', 0, 'bob', pass ? { cap: 'phrygian' } : null) +
      '<p class="verdict-line ' + (pass ? 'pass' : 'fail') + '">' + (pass ? '通过！' : '还没过，差 <b>' + (e.passAt - e.score) + '</b> 题') + '</p>' +
      '<div class="big" aria-label="答对 ' + e.score + ' / ' + e.n + ' 题">' + e.score + '<small> / ' + e.n + '</small></div>' +
      '<div class="scale' + (pass ? ' pass' : '') + '"><div class="track"><i style="width:' + (e.score / e.n * 100) + '%"></i></div>' +
      '<div class="passmark" style="left:' + (e.passAt / e.n * 100) + '%"><span>及格线 ' + e.passAt + '</span></div><div class="ends"><span>0</span><span>' + e.n + '</span></div></div>' +
      '<span class="sub">' + (e.mini ? '试考' : '模考') + ' · ' + LEVELS[e.target].short + ' · ' + dateZh(e.ts) + ' · 用时 ' + mmss(secs) + '</span></section>';
    out += '<section class="stack"><h2>各主题得分</h2><ul class="card res-th">' + THEMES.filter(function (t) { return e.th[t.id]; }).map(function (t) {
      var r = e.th[t.id];
      return '<li class="t-' + t.id + '">' + hexBadge(icon(t.id), 'solid') + '<span class="grow"><span class="t1">' + t.zh + '</span>' + bar(r[0], r[1]) + '</span>' +
        '<span class="n' + (r[0] === r[1] ? ' full' : '') + '"><b>' + r[0] + '</b> / ' + r[1] + '</span></li>';
    }).join('') + '</ul></section>';
    var next = resultNext(e), canGo = next.indexOf('data-a="start"') >= 0;
    out += next;
    out += '<section class="stack res-rev"><div class="row between"><h2>逐题讲解</h2>' +
      (wrong > 0 && wrong < e.items.length ? '<div class="chips" role="group" aria-label="显示哪些题"><button class="chip" data-a="res-filter" data-v="wrong" aria-pressed="' + only + '">只看错题 <b>' + wrong + '</b></button>' +
        '<button class="chip" data-a="res-filter" data-v="all" aria-pressed="' + !only + '">全部</button></div>' : '') + '</div>' +
      '<ul class="qlist res-list">' + e.items.map(function (it, i) {
        var q = DB.byId[it[0]];
        if (!q || (only && it[1] === 0)) return '';
        return reviewRow(q, i + 1, it[1], it[2].split('').map(Number), 'r' + i);
      }).join('') + '</ul>' + (wrong ? '<p class="small">错题已收进错题本。</p>' : '') + '</section>';
    out += '<div class="stack"><a class="btn wide' + (canGo ? ' ghost' : '') + '" href="#exam">再考一次</a>' + (wrong ? '<a class="btn wide ghost" href="#mistakes">去错题本</a>' : '') + '</div>';
    if (!unlocked()) out += payBlock('解锁完整模拟考试');
    return out + '</main>' + tabs('exam');
  }
  function vMistakes() {
    if (!S.target) return vChoose();
    var ms = mistakes();
    var out = '<main class="wrap">' + topbar('错题本', 'practice', levelChip());
    if (!ms.length) return out + '<section class="card empty mis-empty">' + six('sleep', 104) + '<h2>还没有错题</h2><p>答错的题会自动收进来。</p></section><a class="btn wide" href="#practice">去练习</a></main>' + tabs('practice');
    var groups = THEMES.map(function (t) { return [t, ms.filter(function (q) { return q.t === t.id; })]; }).filter(function (g) { return g[1].length; });
    out += '<section class="hero plain mis-hero"><div class="mis-top">' + six('cheer', 0, 'bob') + '<div class="grow"><div class="big" aria-label="' + ms.length + ' 道错题">' + ms.length + '<small> 道错题</small></div>' +
      '<p class="sub">连续答对两次，自动移出</p></div></div>' +
      themeMix(groups.map(function (g) { return [g[0], g[1].length]; }), '各主题的错题数') +
      '<button class="btn wide lg" data-a="start" data-v="all|wrong">' + icon('play') + '重做错题' + (ms.length > SET ? ' · 先做 ' + SET + ' 题' : '') + '</button></section>';
    groups.forEach(function (g) {
      out += '<section class="stack t-' + g[0].id + '"><h2 class="mis-h">' + hexBadge(icon(g[0].id), 'solid') + '<span class="grow">' + g[0].zh + '</span><b class="cnt">' + g[1].length + '</b></h2><ul class="qlist">' + g[1].map(function (q, i) {
        return reviewRow(q, i + 1, null, [0, 1, 2, 3], 'm' + q.id);
      }).join('') + '</ul></section>';
    });
    return out + '</main>' + tabs('practice');
  }
  // short theme names for chips and legends (the full name stays in the label read aloud)
  var TH_SHORT = { principes: '原则', institutions: '制度', droits: '权利', histoire: '历史', societe: '社会' };
  // 生词表: the words of the questions by theme; the French word can be heard, the Chinese can be hidden to test oneself
  function vWords() {
    if (!S.target) return vChoose();
    var out = '<main class="wrap">' + pagehead('速记', levelChip()) + studyNav('words');
    var n = 0, seen = {}, secs = '', mask = !!ui.wmask, shown = ui.wrev || {};
    THEMES.forEach(function (t) {
      var list = [];
      pool().forEach(function (q) {
        if (q.t !== t.id) return;
        (q.v || []).forEach(function (v) { var k = v[0].toLowerCase(); if (!seen[k]) { seen[k] = 1; list.push(v); } });
      });
      if (!list.length) return;
      list.sort(function (a, b) { return a[0].replace(/^(l'|le |la |les |un |une |des )/i, '').localeCompare(b[0].replace(/^(l'|le |la |les |un |une |des )/i, ''), 'fr'); });
      n += list.length;
      secs += '<section class="wl t-' + t.id + '"><h2 class="sec-h">' + hexBadge(icon(t.id), 'solid') + '<span class="grow">' + t.zh + '</span><b class="num">' + list.length + '</b></h2><ul class="words">' + list.map(function (v) {
        var key = v[0].toLowerCase(), hide = mask && !shown[key];
        return '<li>' + (canSpeak ? '<button class="w" lang="fr" data-a="word" data-v="' + esc(v[0]) + '" aria-label="听 ' + esc(v[0]) + '">' + icon('say') + '<span>' + esc(v[0]) + '</span></button>' : '<span class="w" lang="fr"><span>' + esc(v[0]) + '</span></span>') +
          (hide ? '<button class="z peek" data-a="wrev" data-v="' + esc(key) + '" aria-label="看中文">？</button>' : '<span class="z">' + esc(v[1]) + '</span>') + '</li>';
      }).join('') + '</ul></section>';
    });
    out += '<div class="w-bar"><p class="w-n"><b class="num">' + n + '</b> 个词' + (unlocked() ? '' : '<span class="tag">免费题里的</span>') + '</p>' +
      '<button class="chip" data-a="wmask" aria-pressed="' + mask + '">遮住中文</button></div>' + secs;
    if (!unlocked()) out += payBlock('解锁全部题目的生词');
    return out + '</main>' + tabs('cards');
  }
  function studyNav(active) {
    return '<div class="seg n3 study" role="group" aria-label="速记、生词和考前一页"><a href="#cards"' + (active === 'cards' ? ' aria-current="page"' : '') + '><b>考点速记</b></a><a href="#words"' + (active === 'words' ? ' aria-current="page"' : '') + '><b>生词表</b></a><a href="#sheet"' + (active === 'sheet' ? ' aria-current="page"' : '') + '><b>考前一页</b></a></div>';
  }
  // 考点速记: the official sheets (French only) condensed into Chinese cards. A deck: one card open at a time,
  // previous / next, a theme filter, and under it every card of the deck as a small tile to jump to.
  function cardTitle(c) {
    var m = /^(.*?)（([^（）]*[A-Za-zÀ-ÿ][^（）]*)）$/.exec(c.title);
    return m ? [m[1], m[2]] : [c.title, ''];
  }
  function cardDeck() { return DB.cards.filter(function (c) { return !ui.cth || c.t === ui.cth; }); }
  function vCards() {
    var out = '<main class="wrap">' + pagehead('速记', levelChip()) + studyNav('cards');
    if (!DB.cards.length) return out + '<p class="note">考点速记正在整理中。</p></main>' + tabs('cards');
    if (ui.cth && theme(ui.cth).id !== ui.cth) ui.cth = '';
    var deck = cardDeck(), at = -1;
    deck.forEach(function (c, i) { if (c.id === ui.card) at = i; });
    if (at < 0) { deck.forEach(function (c, i) { if (at < 0 && !c.x) at = i; }); if (at < 0) at = 0; }
    var cur = deck[at], t = theme(cur.t), ti = cardTitle(cur), prev = deck[at - 1], next = deck[at + 1] || (deck.length > 1 ? deck[0] : null);
    out += '<div class="kf" role="group" aria-label="按主题看"><button class="chip" data-a="cth" data-v="" aria-pressed="' + !ui.cth + '">全部<b>' + DB.cards.length + '</b></button>' + THEMES.map(function (th) {
      var k = DB.cards.filter(function (c) { return c.t === th.id; }).length;
      return k ? '<button class="chip t-' + th.id + '" data-a="cth" data-v="' + th.id + '" aria-pressed="' + (ui.cth === th.id) + '" aria-label="' + th.zh + '，' + k + ' 张">' + icon(th.id) + TH_SHORT[th.id] + '<b>' + k + '</b></button>' : '';
    }).join('') + '</div>';
    out += '<article class="kc t-' + t.id + (cur.x ? ' lk' : '') + '" id="kc" aria-label="' + esc(cur.title) + '"><header class="kc-head">' + hex('deco') +
      '<p class="kc-top"><span class="kc-th">' + icon(t.id) + t.zh + '</span><span class="kc-pos">第 <b>' + (at + 1) + '</b> / ' + deck.length + ' 张</span></p>' +
      '<h2>' + esc(ti[0]) + '</h2>' + (ti[1] ? '<p class="kc-fr" lang="fr">' + esc(ti[1]) + '</p>' : '') + '</header><div class="kc-body"><p class="kc-lead">' + esc(cur.lead) + '</p>';
    if (cur.x) {
      out += '<div class="kc-lock">' + hexBadge(icon('lock')) + '<p>' + (cur.n ? '还有 <b class="num">' + cur.n + '</b> 条要点' : '要点还没开放') + '</p><button class="btn" data-a="locked">解锁</button></div>';
    } else {
      out += '<ul class="facts">' + cur.p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        (cur.v && cur.v.length ? '<ul class="kc-voc">' + cur.v.map(function (v) {
          var inner = '<b lang="fr">' + esc(v[0]) + '</b><span>' + esc(v[1]) + '</span>';
          return '<li>' + (canSpeak ? '<button class="voc" data-a="word" data-v="' + esc(v[0]) + '" aria-label="听 ' + esc(v[0]) + '：' + esc(v[1]) + '">' + inner + '</button>' : '<span class="voc">' + inner + '</span>') + '</li>';
        }).join('') + '</ul>' : '') +
        (cur.s || []).filter(function (i) { return DB.src[i]; }).map(function (i) { return '<a class="kc-src" href="' + esc(DB.src[i][1]) + '" target="_blank" rel="noopener">官方讲义：<span lang="fr">' + esc(DB.src[i][0]) + '</span> ↗</a>'; }).join('');
    }
    out += '</div><footer class="kc-nav"><button class="sq" data-a="card" data-v="' + (prev ? esc(prev.id) : '') + '" aria-label="上一张"' + (prev ? '' : ' disabled') + '>' + icon('back') + '</button>' +
      '<button class="btn ghost grow" data-a="card" data-v="' + (next ? esc(next.id) : '') + '"' + (next ? '' : ' disabled') + '>' + (deck[at + 1] || !next ? '下一张' : '回到第 1 张') + icon('next') + '</button></footer></article>';
    // every card of the deck, by theme: a shelf that scrolls sideways (all themes) or a grid (one theme)
    THEMES.forEach(function (th) {
      var list = deck.filter(function (c) { return c.t === th.id; });
      if (!list.length) return;
      out += '<section class="ks t-' + th.id + (ui.cth ? ' grid' : '') + '"><h2 class="sec-h">' + hexBadge(icon(th.id), 'solid') + '<span class="grow">' + th.zh + '</span><b class="num">' + list.length + '</b></h2><ul>' + list.map(function (c) {
        return '<li><button class="kmini' + (c.x ? ' lk' : '') + '" data-a="card" data-v="' + esc(c.id) + '"' + (c.id === cur.id ? ' aria-current="true"' : '') + '><span class="kn">' + (deck.indexOf(c) + 1) + (c.x ? lockMark() : '') + '</span><span class="ct">' + esc(cardTitle(c)[0]) + '</span></button></li>';
      }).join('') + '</ul></section>';
    });
    if (!unlocked()) out += payBlock('解锁全部 ' + DB.cards.length + ' 张考点速记');
    return out + '</main>' + tabs('cards');
  }
  // the page is drawn again after every tap: give the keyboard its place back
  function refocus(sel) {
    var el = document.querySelector(sel);
    if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) { /* not essential */ } }
  }
  // after a tap on previous / next / a tile: the new card starts at the top of the screen
  function showCard() {
    var el = document.getElementById('kc');
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight * 0.45) { try { el.scrollIntoView({ block: 'start' }); } catch (e) { el.scrollIntoView(true); } }
  }
  // 考前一页: the numbers, years and names worth a last look the night before (data/sheet.json). Free for everyone.
  var sheetWait = null, canPrint = typeof window.print === 'function' && !/MicroMessenger/i.test(navigator.userAgent);
  function loadSheet() {
    if (DB.sheet || sheetWait || ui.sheetFail) return;
    sheetWait = (window.CIVIQUE_SHEET ? Promise.resolve(window.CIVIQUE_SHEET) : getJson('data/sheet.json')).then(function (d) { DB.sheet = d; })
      .catch(function () { ui.sheetFail = true; }).then(function () { sheetWait = null; if (route() === 'sheet') render(); });
  }
  // ---- the drawings of 考前一页. Each one is an inline SVG built from sheet.json, 340 units wide (about one CSS pixel
  // per unit on a phone), coloured through the classes of the "cram sheet" block in app.css so that it follows
  // the theme and prints in black.
  function sTx(x, y, s, cls, size, anchor) {
    return '<text x="' + x + '" y="' + y + '" font-size="' + size + '"' + (cls ? ' class="' + cls + '"' : '') + (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + s + '</text>';
  }
  function sSvg(w, h, cls, label, desc, body) {
    return '<svg class="sh-svg ' + cls + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' + (desc ? '<desc>' + esc(desc) + '</desc>' : '') + body + '</svg>';
  }
  // breaks a Chinese line after `max` character widths (a Latin letter counts for about half), never before a closing mark
  function sWrap(s, max) {
    var lines = [], cur = '', w = 0;
    String(s).split('').forEach(function (ch) {
      var cw = /[⺀-￿]/.test(ch) ? 1 : 0.56;
      if (w + cw > max && cur && !/[，。；：、）》”！？]/.test(ch)) { lines.push(cur); cur = ''; w = 0; }
      cur += ch; w += cw;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function sWords(s, max) {   // the same for French: breaks between words
    var lines = [], cur = '';
    String(s).split(' ').forEach(function (wd) {
      if (cur && (cur + ' ' + wd).length > max) { lines.push(cur); cur = wd; } else cur = cur ? cur + ' ' + wd : wd;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function sheetItem(d, gid, test) {
    var g = d.groups.filter(function (x) { return x.id === gid; })[0], hit = null;
    if (g) g.items.forEach(function (it) { if (!hit && test(it)) hit = it; });
    return hit;
  }
  function isYearKey(k) { var m = /^(\d{4})(?:–(\d{4}))?$/.exec(k); return m && m[1] >= 1000 && m[1] <= 2100 ? m : null; }   // 3919 is a phone number
  // every dated item of the sheet in order: the ones whose key is a year, and the people who carry a year (t, tl)
  function sheetDated(d) {
    var ev = [];
    d.groups.forEach(function (g) {
      g.items.forEach(function (it) {
        var m = isYearKey(it.k);
        if (m) ev.push({ t: Number(m[1]), t2: m[2] ? Number(m[2]) : 0, label: it.v, fr: it.fr, hl: it.hl, eu: g.id === 'ue' });
        else if (it.t) ev.push({ t: it.t, t2: 0, label: it.tl || it.k });
      });
    });
    return ev.sort(function (a, b) { return a.t - b.t || b.t2 - a.t2; });
  }
  // the timeline: a chunky pill per year on a rail, one colour per century (the five theme colours in turn);
  // yellow = the years the sheet marks as the ones to know, outlined = the building of Europe
  function figTimeline(d) {
    var ev = sheetDated(d), W = 340, PX = 4, PW = 72, RX = PX + PW / 2, LX = PX + PW + 12, y = 2, cent = 0, era = -1, heads = '', rows = '', spans = '', hasEu = false;
    ev.forEach(function (e, i) {
      var c = Math.floor(e.t / 100) + 1;
      if (c !== cent) {
        cent = c; era++; y += i ? 12 : 0;
        heads += '<g class="v-e' + (era % 5) + '"><rect class="v-era" x="' + PX + '" y="' + y + '" width="' + PW + '" height="22" rx="11"/>' + sTx(RX, y + 15.5, c + ' 世纪', 'v-t', 12, 'middle') + '</g>';
        y += 32;
      }
      var lines = sWrap(e.label, 17.4), ph = e.t2 ? 48 : 28, row, h = lines.length * 19;
      e.y = y; e.era = era % 5;
      row = '<rect class="' + (e.hl ? 'v-hl' : 'v-pill') + (e.eu ? ' v-eu' : '') + '" x="' + PX + '" y="' + y + '" width="' + PW + '" height="' + ph + '" rx="14"/>' +
        '<text class="v-num ' + (e.hl ? 'v-on' : (e.eu ? 'v-k' : 'v-w')) + '" x="' + RX + '" y="' + (y + 20) + '" font-size="17" text-anchor="middle">' + e.t +
        (e.t2 ? '<tspan x="' + RX + '" dy="19" font-size="16">–' + e.t2 + '</tspan>' : '') + '</text>';
      row += '<text font-size="14" x="' + LX + '" y="' + (y + 19) + '">' + lines.map(function (l, j) { return '<tspan x="' + LX + '"' + (j ? ' dy="19"' : '') + '>' + esc(l) + '</tspan>'; }).join('') + '</text>';
      if (e.fr) { row += sTx(LX, y + 19 + h - 3, esc(e.fr), 'v-fr', 11.5).replace('<text ', '<text lang="fr" '); h += 15; }
      if (e.eu) hasEu = true;
      rows += '<g class="tl-row v-e' + e.era + '" data-t="' + e.t + '">' + row + '</g>';
      e.b = y + ph;
      y += Math.max(h + 4, ph) + 10;
    });
    ev.forEach(function (e, i) {
      if (!e.t2) return;   // a war: a coloured stretch of the rail down to the last year inside it
      var last = e;
      ev.forEach(function (o, j) { if (j > i && o.t <= e.t2) last = o; });
      if (last !== e) spans += '<path class="v-span v-e' + e.era + '" d="M' + RX + ' ' + (e.y + 10) + 'V' + (last.b - 6) + '"/>';
    });
    var foot = '<g class="v-e2"><rect class="v-pill" x="' + (PX + 18) + '" y="' + (y + 4) + '" width="36" height="14" rx="7"/></g>' + sTx(LX, y + 15.5, '法国', 'v-2', 12) +
      (hasEu ? '<rect class="v-pill v-eu" x="' + (LX + 40) + '" y="' + (y + 4) + '" width="36" height="14" rx="7"/>' + sTx(LX + 84, y + 15.5, '欧洲建设', 'v-2', 12) : '') +
      '<rect class="v-hl" data-legend="1" x="' + (LX + 148) + '" y="' + (y + 4) + '" width="36" height="14" rx="7"/>' + sTx(LX + 192, y + 15.5, '必记', 'v-2', 12);
    return sSvg(W, y + 24, 'v-tl', '时间线', '', '<path class="v-rail" d="M' + RX + ' 12V' + (y - 14) + '"/>' + spans + heads + rows + foot);
  }
  // 三权分立: three solid blocks, who sits in each, and the arrows the sheet supports (who elects, who appoints)
  function figInst(d) {
    var pw = (d.groups.filter(function (g) { return g.id === 'pouvoirs'; })[0] || { items: [] }).items;
    if (pw.length < 5) return '';
    var byFr = function (gid, re) { return sheetItem(d, gid, function (it) { return re.test(it.fr || ''); }); };
    var dep = byFr('chiffres', /députés/), sen = byFr('chiffres', /sénateurs/), t5 = byFr('vote', /députés/), t6 = byFr('vote', /sénateurs/);
    var adult = byFr('vote', /majorité/), nat = sheetItem(d, 'vote', function (it) { return /国籍/.test(it.k); });
    var pres = byFr('pouvoirs', /président/), pm = byFr('pouvoirs', /ministre/);
    var W = 340, TOP = 58, B = TOP + 30, BOT = 288, o = '';
    var part = function (it) { var a = it.v.split('：'); return a.length > 1 ? [a[0].replace(/（.*）/, ''), a.slice(1).join('：')] : ['', it.v]; };
    var frLines = function (x, y, s, max, anchor) { return sWords(s, max).map(function (l, i) { return sTx(x, y + i * 12.5, esc(l), 'v-fr', 10.8, anchor).replace('<text ', '<text lang="fr" '); }).join(''); };
    var box = function (x, y, w, h) { return '<rect class="v-box" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="9"/>'; };
    var arrow = function (x, y1, y2, word) {
      var dd = 'M' + x + ' ' + y1 + 'V' + (y2 - 3) + 'M' + (x - 5) + ' ' + (y2 - 9) + 'l5 6 5-6';
      return '<path class="v-arrow-b" d="' + dd + '"/><path class="v-arrow" d="' + dd + '"/>' +
        '<rect class="v-lab" x="' + (x + 8) + '" y="' + ((y1 + y2) / 2 - 12) + '" width="34" height="19" rx="9.5"/>' + sTx(x + 25, (y1 + y2) / 2 + 2, word, 'v-t', 11.5, 'middle');
    };
    var block = function (x, w, it, n, right) {
      var p = part(it), cx = x + w / 2;
      return '<g class="v-e' + n + '"><rect class="v-blk" x="' + x + '" y="' + TOP + '" width="' + w + '" height="' + (BOT - TOP) + '" rx="13"/>' +
        sTx(right ? x + w - 10 : x + 10, TOP + 20, esc(it.k), 'v-w v-t', 15, right ? 'end' : '') + '</g>' +
        box(x + 6, 210, w - 12, 72) + sTx(cx, 226, esc(p[0]), 'v-2', 11.5, 'middle') + sTx(cx, 245, esc(p[1]), 'v-t', 15, 'middle') +
        (it.fr ? frLines(cx, 260, it.fr, w > 80 ? 22 : 10, 'middle') : '');
    };
    var chamber = function (x, zh, fr, n, term) {
      var cx = x + 33, s = box(x, B, 66, 116) + sTx(cx, B + 18, zh, 'v-t', 13, 'middle') + frLines(cx, B + 31, fr, 10, 'middle');
      if (n) {
        s += (n.hl ? '<rect class="v-hl" x="' + (cx - 27) + '" y="' + (B + 55) + '" width="54" height="26" rx="8"/>' : '') +
          sTx(cx, B + 76, esc(n.k), 'v-num' + (n.hl ? ' v-on' : ''), 25, 'middle') + (n.fr ? frLines(cx, B + 93, n.fr, 12, 'middle') : '');
      }
      if (term) s += sTx(cx, B + 109, '任期 ' + esc(term.k), 'v-2', 11.5, 'middle');
      return s;
    };
    // citizens, and what they elect directly
    var who = [adult && adult.k, nat && nat.k].filter(Boolean).join(' · ');
    o += '<rect class="v-cit" x="46" y="4" width="228" height="30" rx="15"/>' + sTx(who ? 62 : 160, 24, '公民', 'v-w v-t', 15, who ? '' : 'middle') + (who ? sTx(260, 23.5, esc(who), 'v-w', 12, 'end') : '');
    o += block(6, 146, pw[0], 1, true) + block(160, 104, pw[1], 2, false) + block(272, 62, pw[2], 0, false);
    o += chamber(12, '国民议会', 'Assemblée nationale', dep, t5) + chamber(80, '参议院', 'Sénat', sen, t6);
    if (pres) o += box(166, B, 92, 50) + sTx(212, B + 17, esc(pres.k) + (t5 ? ' · ' + esc(t5.k) : ''), 'v-t', 13, 'middle') + frLines(212, B + 29.5, pres.fr || '', 16, 'middle');
    if (pm) o += box(166, B + 78, 92, 38) + sTx(212, B + 94, esc(pm.k) + '和政府', 'v-t', 13, 'middle') + frLines(212, B + 107, pm.fr || '', 18, 'middle');
    o += arrow(45, 34, B, '选举') + arrow(236, 34, B, '选举') + (pm ? arrow(196, B + 50, B + 78, '任命') : '');
    o += '<svg class="v-pic v-pic-w" x="281" y="' + (B + 36) + '" width="44" height="44" viewBox="0 0 24 24">' + ICON.droits + '</svg>';
    return sSvg(W, BOT + 4, 'v-inst', '三权分立示意图', pw.map(function (it) { return it.k + '：' + it.v + (it.fr ? '（' + it.fr + '）' : ''); }).join('；'), o);
  }
  // the points of one open line of a path written by tools/map.mjs ("M x y l dx dy l dx dy …")
  function pathPts(d) {
    var n = (d.match(/-?\d*\.?\d+/g) || []).map(Number), pts = [], x = 0, y = 0;
    for (var i = 0; i + 1 < n.length; i += 2) { if (i) { x += n[i]; y += n[i + 1]; } else { x = n[0]; y = n[1]; } pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]); }
    return pts;
  }
  // the sea: each long open coast line, closed along the edges of the drawing (west and north for the Atlantic
  // and the Channel, south and east for the Mediterranean). A sketch, like the rest of the map.
  function mapSeas(m) {
    var out = '';
    m.coast.split(/(?=M)/).forEach(function (sub) {
      var p = pathPts(sub), a = p[0], b = p[p.length - 1];
      if (p.length < 12 || Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 12) return;   // islands close on themselves
      var west = Math.min(a[0], b[0]) < m.w * 0.3, ends;
      if (west) { if (a[1] < b[1]) p.reverse(); ends = [[p[p.length - 1][0] + 24, 0], [0, 0], [0, p[0][1] + 5]]; }
      else { if (a[0] < b[0]) p.reverse(); ends = [[p[p.length - 1][0] - 12, m.h], [m.w, m.h], [m.w, p[0][1] + 5]]; }
      out += '<path class="v-seabg" d="M' + p.concat(ends).map(function (q) { return q[0] + ' ' + q[1]; }).join('L') + 'z"/>';
    });
    return out;
  }
  function hexAt(x, y, r, cls) {
    var h = Math.round(r * 86.6) / 100, r2 = r / 2;
    return '<path class="' + cls + '" d="M' + (x + r) + ' ' + y + 'l' + (-r2) + ' ' + h + 'h' + (-r) + 'l' + (-r2) + ' ' + (-h) + 'l' + r2 + ' ' + (-h) + 'h' + r + 'z"/>';
  }
  // the map: outline, borders and labels come projected from tools/map.mjs (sheet.json, key "map")
  function figMap(m, big) {
    var clip = 'mapclip' + (big ? 'b' : 's');
    var o = '<clipPath id="' + clip + '"><rect width="' + m.w + '" height="' + m.h + '" rx="14"/></clipPath><g clip-path="url(#' + clip + ')"><rect class="v-ground" width="' + m.w + '" height="' + m.h + '"/>' + mapSeas(m) +
      '<path class="v-land0" d="' + m.land + '"/><path class="v-land" d="' + m.land + '"/></g><path class="v-border" d="' + m.border + '"/><path class="v-coast" d="' + m.coast + '"/>';
    var lab = function (it, cls, size, extra) {
      if (big && !(cls.indexOf('v-t v-halo') === 0 && it.a === 'middle' && it.y < it.p[1])) extra = true;   // the French name goes under the Chinese one unless a dot is there
      return '<text class="' + cls + '" x="' + it.x + '" y="' + it.y + '" font-size="' + size + '" text-anchor="' + (it.a || 'middle') + '" data-k="' + esc(it.k) + '">' + esc(it.k) +
        ((big || extra) && it.fr ? '<tspan class="v-fr" lang="fr" font-size="' + (big ? 7.6 : 10.5) + '"' + (extra ? ' x="' + it.x + '" dy="' + (big ? 9 : 12.5) + '"' : ' dx="2.5"') + '>' + esc(it.fr) + '</tspan>' : '') + '</text>';
    };
    m.rivers.forEach(function (r) { o += '<path class="v-river" d="' + r.d + '"/>'; });
    m.mounts.forEach(function (r) { r.pk.forEach(function (p) { o += '<path class="v-peak" d="M' + (p[0] - 5) + ' ' + (p[1] + 3) + 'l5-7 5 7"/>'; }); });
    m.tops.forEach(function (r) { o += '<path class="v-top" d="M' + (r.p[0] - 5) + ' ' + (r.p[1] + 3.5) + 'l5-8 5 8z"/>'; });
    m.seas.forEach(function (r) { o += lab(r, 'v-sea', 13, true); });
    m.lands.forEach(function (r) { if (r.p) o += hexAt(r.p[0], r.p[1], 2.6, 'v-city v-far'); o += lab(r, 'v-2 v-far v-t', 11.5); });
    m.rivers.forEach(function (r) { o += lab(r, 'v-b' + (r.sea ? '' : ' v-halo'), 11.5); });
    m.mounts.concat(m.tops).forEach(function (r) { o += lab(r, 'v-2 v-halo', 11.5); });
    m.isles.forEach(function (r) { o += lab(r, 'v-t', 12); });
    m.cities.forEach(function (r) {
      o += (r.cap ? hexAt(r.p[0], r.p[1], 7.5, 'v-hl v-cap') + hexAt(r.p[0], r.p[1], 3.4, 'v-city v-on') : hexAt(r.p[0], r.p[1], 3.8, 'v-city')) + lab(r, 'v-t v-halo', r.cap ? 13.5 : 12);
    });
    // the overseas departments, by sea, under the map
    var y = m.h + 10, cw = m.w / m.dom.length, rowsMax = Math.max.apply(null, m.dom.map(function (g) { return g.items.length; })), step = big ? 23 : 18;
    m.dom.forEach(function (g, i) {
      var x = Math.round(i * cw) + 2;
      o += '<rect class="v-dom" x="' + x + '" y="' + y + '" width="' + (Math.round(cw) - 6) + '" height="' + (34 + rowsMax * step) + '" rx="10"/>' + sTx(x + 9, y + 18, esc(g.sea), 'v-sea v-domsea', 11.5, '');
      g.items.forEach(function (it, j) {
        var yy = y + 38 + j * step;
        o += hexAt(x + 13, yy - 4.5, 3.6, 'v-city') +
          '<text class="v-t" x="' + (x + 21) + '" y="' + yy + '" font-size="12.5" data-k="' + esc(it.k) + '">' + esc(it.k) + (big ? '<tspan class="v-fr" lang="fr" font-size="7.6" x="' + (x + 21) + '" dy="9">' + esc(it.fr) + '</tspan>' : '') + '</text>';
      });
    });
    return sSvg(m.w, y + 36 + rowsMax * step, 'v-map' + (big ? ' big' : ''), '法国本土地图和海外省', '', o);
  }
  var SHEET_FIG = {
    inst: { t: '三权分立', th: 'institutions', draw: function (d) { return figInst(d); } },
    tl: { t: '时间线', th: 'histoire', draw: function (d) { return figTimeline(d); } },
    map: { t: '法国地图', th: 'brand', ic: 'register', draw: function (d, big) { return d.map ? figMap(d.map, big) : ''; } }
  };
  var ZOOM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.500" cy="10.500" r="6"/><path d="m15 15 5 5M10.500 8v5M8 10.500h5"/></svg>';
  // a drawing as a card: title bar in a theme colour, a 放大 button, the drawing itself (a tap on it enlarges too)
  function sheetFig(d, id, gid, cap) {
    var f = SHEET_FIG[id], svg = f.draw(d), g = gid ? d.groups.filter(function (x) { return x.id === gid; })[0] : null, title = g ? esc(g.title) : f.t;
    if (!svg) return '';
    return '<figure class="sh-fig t-' + f.th + '" id="fig-' + id + '"' + (gid ? ' data-g="' + gid + '"' : '') + '><figcaption>' + icon(f.ic || f.th) + '<h3>' + title + '</h3>' +
      '<button class="sh-zoom" data-a="fig" data-v="' + id + '" aria-label="放大' + f.t + '">' + ZOOM + '放大</button></figcaption>' +
      '<div class="sh-draw" data-a="fig" data-v="' + id + '">' + svg + '</div>' + (cap ? '<p class="sh-cap">' + cap + '</p>' : '') + '</figure>';
  }
  function openFig(id) {
    var f = SHEET_FIG[id], d = DB.sheet;
    if (!f || !d) return;
    ui.modal = { title: f.t, body: '<div class="sh-zoomed' + (id === 'map' ? ' wide' : '') + '">' + f.draw(d, true) + '</div>' + (id === 'map' ? '<p class="small">可以拖动。示意图，不按比例。</p>' : ''), actions: [{ label: '关闭', a: 'close', cls: 'quiet' }] };
    render();
  }
  // small drawings for the tiles and the symbols (24 x 24, same pen as ICON)
  var SHEET_PIC = {
    '15': '<path d="M9.5 4h5v5.500H20v5h-5.500V20h-5v-5.500H4v-5h5.500z"/>',
    '17': '<path d="M12 3.500 5 6v5.500c0 4.300 2.900 7.400 7 9 4.100-1.600 7-4.700 7-9V6z"/><path d="m9 12 2.200 2.200L15.200 10"/>',
    '18': '<path d="M12.500 3.500c.4 3.600 5 5.300 5 10.300a5.500 5.500 0 0 1-11 0c0-2 .9-3.400 2-4.500.2 1.500.8 2.400 1.700 2.800-.3-3.300.7-6.300 2.300-8.600z"/>',
    '112': '<path d="M7 4h2.800l1.400 4-1.900 1.400a10 10 0 0 0 5.300 5.300l1.400-1.900 4 1.400V17a2.500 2.500 0 0 1-2.500 2.500A13 13 0 0 1 4.500 6.500 2.500 2.500 0 0 1 7 4z"/>',
    '119': '<circle cx="12" cy="7.500" r="3"/><path d="M6.500 20v-3a5.500 5.500 0 0 1 11 0v3"/>',
    '3919': '<circle cx="12" cy="9" r="5"/><path d="M12 14v6.500M9 17.500h6"/>',
    drapeau: '<path d="M4.500 3.500v17"/><path class="p-b" d="M4.500 5h5v10h-5z"/><path class="p-w" d="M9.500 5h5v10h-5z"/><path class="p-r" d="M14.500 5h5v10h-5z"/>',
    marseillaise: '<path d="M9 17.500V6.500l9-2v11"/><circle cx="6.800" cy="17.500" r="2.200"/><circle cx="15.800" cy="15.500" r="2.200"/>',
    marianne: '<path d="M4.500 17c.2-6.300 3.300-10.500 8-10.500 3.400 0 5.800 1.700 6 4.300.1 1.700-1.100 2.800-2.500 2.500-1.300-.3-1.800-1.600-1.100-2.700"/><path d="M12.500 6.500c2.300 2.200 3.500 5.500 3.500 10.500"/><path d="M3.500 17h14v3h-14z"/><circle cx="8.300" cy="13.200" r="1.300"/>',
    devise: '<path d="M3.500 9 12 4l8.500 5z"/><path d="M5 9v3h14V9M6.500 12v8M17.500 12v8M4 20h16M9 15h6"/>',
    fete: '<rect x="4" y="5.500" width="16" height="14.500" rx="2"/><path d="M4 9.500h16M8.500 3.500v4M15.500 3.500v4"/>'
  };
  function sheetPic(n, extra) {
    return SHEET_PIC[n] ? '<svg class="sh-pic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SHEET_PIC[n] + (extra || '') + '</svg>' : '';
  }
  // the colour of each group of the sheet: the theme it belongs to
  var SHEET_TH = { urgence: 'societe', symboles: 'principes', chiffres: 'institutions', vote: 'institutions', pouvoirs: 'institutions', dates: 'histoire', geo: 'histoire', outremer: 'histoire', ue: 'droits', personnes: 'histoire', culture: 'histoire', laicite: 'principes', interdits: 'droits', vie: 'societe' };
  var SHEET_NUM = /^(约?)(\d[\d–]*)(\D{0,2})$/;   // a number with at most a short unit: 577, 约35000, 5年, 3–16岁, 35小时
  function sheetFr(it) { return it.fr ? ' <i lang="fr">' + esc(it.fr) + '</i>' : ''; }
  function sheetLi(it, pic) {
    return '<li>' + (pic || '') + '<span class="grow"><b class="k' + (/^[\d约]/.test(it.k) ? ' n' : '') + (it.hl ? ' hl' : '') + '">' + esc(it.k) + '</b><span class="v">' + esc(it.v) + sheetFr(it) + '</span></span></li>';
  }
  // one group of the sheet. how: 'tiles' (the numbers as stat tiles with a big numeral, the rest as rows),
  // 'pics' (a drawing in front of each row), default: rows. skip(it) leaves out the items a drawing already shows in full
  function sheetGroup(g, how, skip) {
    var items = skip ? g.items.filter(function (it) { return !skip(it); }) : g.items, th = SHEET_TH[g.id] || 'brand';
    if (!items.length) return '';
    var head = '<h3 class="sec-h">' + hexBadge(icon(th === 'brand' ? 'sheet' : th), 'solid') + '<span class="grow">' + esc(g.title) + '</span></h3>';
    var nums = how === 'tiles' ? items.filter(function (it) { return SHEET_NUM.test(it.k); }) : [], rest = items.filter(function (it) { return nums.indexOf(it) < 0; });
    var pics = how === 'pics' ? ['drapeau', 'marseillaise', 'marianne', 'devise', 'fete'] : null;
    var rows = rest.length ? '<ul class="sh-rows">' + rest.map(function (it, i) {
      return sheetLi(it, pics ? hexBadge(sheetPic(pics[i], pics[i] === 'fete' ? '<text x="12" y="17.3" text-anchor="middle" font-size="7.500" stroke="none" fill="currentColor" font-weight="700">14</text>' : '')) : '');
    }).join('') + '</ul>' : '';
    if (!nums.length) return '<section class="sh-card t-' + th + (pics ? ' pics' : '') + '" data-g="' + esc(g.id) + '">' + head + rows + '</section>';
    return '<section class="sh-tiles t-' + th + '" data-g="' + esc(g.id) + '">' + head + '<ul class="sh-nums">' + nums.map(function (it) {
      var m = SHEET_NUM.exec(it.k);
      return '<li><b class="k n' + (it.hl ? ' hl' : '') + (m[2].length > 4 ? ' long' : '') + '">' + (g.id === 'urgence' ? sheetPic(it.k) : '') + '<span>' + (m[1] ? '<small>' + m[1] + '</small>' : '') + m[2] + (m[3] ? '<small>' + esc(m[3]) + '</small>' : '') + '</span></b><span class="v">' + esc(it.v) + sheetFr(it) + '</span></li>';
    }).join('') + '</ul>' + rows + '</section>';
  }
  function vSheet() {
    loadSheet();
    var know = 0, situ = 0;
    THEMES.forEach(function (t) { know += t.k; situ += t.s; });
    var out = '<main class="wrap sheetpage">' + pagehead('速记', levelChip()) + studyNav('sheet') +
      '<div class="sh-top"><p class="sub">只帮你记，不能代替做题。<a class="link" href="#home">去练题</a></p>' + (canPrint ? '<button class="chip" data-a="print">' + icon('sheet') + '打印</button>' : '') + '</div>' +
      '<ul class="nums sh-exam" aria-label="考试本身"><li><b>' + EXAM.n + '</b><span>题单选</span></li><li><b>' + EXAM.min + '</b><span>分钟</span></li>' +
      '<li class="pass"><b>' + EXAM.pass + '</b><span>题及格</span></li><li><b>' + know + '<i>+</i>' + situ + '</b><span>知识 + 情景</span></li></ul>';
    var d = DB.sheet;
    if (!d) return out + (ui.sheetFail ? '<p class="note warn">这一页没有加载出来，请检查网络后刷新页面。</p>' : '<p class="sub center">正在加载…</p>') + disclaimer() + '</main>' + tabs('cards');
    var used = {}, grp = function (id, how, skip) {
      var g = d.groups.filter(function (x) { return x.id === id; })[0];
      if (!g || used[id]) return '';
      used[id] = 1;
      return sheetGroup(g, how, skip);
    };
    var drawn = { inst: !!figInst(d), map: !!d.map };
    used.dates = 1;   // the whole group is the timeline
    var near = d.map ? d.map.lands.filter(function (n) { return n.s !== 'H071'; }) : [];
    out += '<div class="sh-grid">' +
      grp('urgence', 'tiles') +
      sheetFig(d, 'inst', '', '') + grp('pouvoirs', '', drawn.inst ? function (it) { return /权$/.test(it.k); } : null) + grp('chiffres', 'tiles') + grp('vote', 'tiles') +
      grp('symboles', 'pics') +
      sheetFig(d, 'tl', 'dates', '') + grp('ue', 'tiles', function (it) { return !!isYearKey(it.k); }) + grp('personnes') + grp('culture') +
      sheetFig(d, 'map', '', drawn.map ? '示意图，不按比例。虚线是陆地边界：本土有 ' + near.length + ' 个邻国。' : '') + grp('geo') + grp('outremer') +
      d.groups.map(function (g) { return grp(g.id, 'tiles'); }).join('') + '</div>';
    if (d.rule) {
      out += '<section class="sh-rule" id="sh-rule"><div class="sh-rule-top">' + six('neutral', 76) + '<h3>' + esc(d.rule.title) + '</h3></div><p class="sh-say">' + esc(d.rule.lead) + '</p><ol>' +
        d.rule.points.map(function (x) { var cut = x.indexOf('。') + 1; return '<li>' + (cut > 0 && cut < x.length ? '<b>' + esc(x.slice(0, cut)) + '</b>' + esc(x.slice(cut)) : esc(x)) + '</li>'; }).join('') + '</ol></section>';
    }
    out += '<p class="small sh-asof">整理于 ' + esc(d.asof) + '</p>';
    return out + disclaimer() + '</main>' + tabs('cards');
  }
  function lockMark() { return icon('lock', 'lockm'); }
  // 机经: what candidates said they were asked, by exam month. Nothing identifies who said it.
  function recallIds() {
    if (DB.rc) return DB.rc;
    var n = {}, order = [];
    DB.recall.forEach(function (r) { r.i.forEach(function (x) { if (x.r) { if (!n[x.r]) order.push(x.r); n[x.r] = (n[x.r] || 0) + 1; } }); });
    order.sort(function (a, b) { return n[b] - n[a]; });
    DB.rc = { n: n, ids: order };
    return DB.rc;
  }
  function sessOpen(ri) { var v = ui.open['s' + ri]; return v === undefined ? ri < 2 : v; }
  // a recalled question in the feed: reviewRow with the theme colour on its number and, from two mentions, the heat
  function recallRow(x, n, key, heat) {
    var hot = heat >= 2 ? '<span class="rq-x"><span class="tag hot">机经提到 ' + heat + ' 次</span></span>' : '';
    if (x.r && DB.byId[x.r]) return reviewRow(DB.byId[x.r], n, null, [0, 1, 2, 3], key).replace('<li>', '<li class="rq t-' + theme(x.t).id + '">').replace('</button>', hot + '</button>');
    if (x.r) return '<li class="rq t-' + esc(x.t) + '"><button class="qrow" data-a="locked" aria-label="' + esc(x.q) + '（讲解未解锁）"><span class="i">' + n + '</span><span class="s" lang="fr">' + esc(x.q) + '</span><span class="m more" aria-hidden="true">' + lockMark() + '</span>' + hot + '</button></li>';
    return '<li class="rq t-' + esc(x.t) + '"><div class="qrow"><span class="i">' + n + '</span><span class="s zhs">' + esc(x.x) + '</span><span class="m"></span><span class="rq-x"><span class="tag' + (x.k === 's' ? '' : ' g') + '">' + (x.k === 's' ? '情景题' : '知识题') + '</span></span></div></li>';
  }
  function vRecall() {
    var out = '<main class="wrap">' + topbar('机经', 'practice') +
      '<p class="rc-note"><b class="hex-b">非官方</b>来源于网络的考生回忆，不是官方题目，可能有出入。</p>';
    if (!DB.recall.length) return out + '<div class="card empty">' + six('sleep', 96) + '<p>还没有收录。收集到考生的回忆后会更新在这里。</p></div></main>' + tabs('practice');
    var rc = recallIds(), hot = rc.ids.filter(function (id) { return rc.n[id] >= 2; });
    var can = rc.ids.filter(function (id) { return DB.byId[id]; });
    out += '<section class="hero rc-hero">' + heroDeco() + '<ul class="rc-nums"><li><b>' + DB.recall.length + '</b><span>场考试</span></li><li><b>' + rc.ids.length + '</b><span>道题</span></li>' +
      (hot.length ? '<li class="rc-hot"><b>' + hot.length + '</b><span>提到 2 次以上</span></li>' : '') + '</ul>' +
      (can.length ? '<button class="btn wide" data-a="start" data-v="all|recall">' + icon('play') + '练这些题</button>' : '') + '</section>';
    out += '<p class="rc-legend" aria-label="题号的颜色是主题">' + THEMES.map(function (t) { return '<span class="tag th t-' + t.id + '"><i></i>' + TH_SHORT[t.id] + '</span>'; }).join('') + '</p><ol class="rc-feed">';
    var month = '';
    DB.recall.forEach(function (r, ri) {
      var ym = r.w.split('-'), isOpen = sessOpen(ri);
      if (r.w !== month) {
        out += (month ? '</ul></li>' : '') + '<li class="rc-month"><h2 class="rc-m">' + ym[0] + ' 年 ' + Number(ym[1]) + ' 月</h2><ul class="rc-list">';
        month = r.w;
      }
      out += '<li class="rc-s' + (isOpen ? ' on' : '') + '"><button class="crow" data-a="sess" data-v="' + ri + '" aria-expanded="' + isOpen + '"><span class="grow"><span class="rc-top">' +
        (LEVELS[r.l] ? '<span class="tag lv-' + r.l + '">' + LEVELS[r.l].zh + '</span>' : '') + '<span class="rc-n"><b>' + r.i.length + '</b> 题</span></span>' +
        (r.n ? '<span class="cl">' + esc(r.n) + '</span>' : '') + '</span><span class="m more" aria-hidden="true">' + (isOpen ? '−' : '+') + '</span></button>';
      if (isOpen) out += '<ul class="qlist inner">' + r.i.map(function (x, i) { return recallRow(x, i + 1, 'r' + ri + '-' + i, x.r ? rc.n[x.r] : 0); }).join('') + '</ul>';
      out += '</li>';
    });
    out += '</ul></li></ol>';
    if (!unlocked()) out += payBlock('解锁后可以看每道题的讲解');
    return out + '</main>' + tabs('practice');
  }
  // ---------------------------------------------------------------- registering for the real exam
  // The centre list is the public list of France Éducation International (data/centres.json). Booking and payment
  // happen on the organisers' own sites; this page only helps to find the way there.
  var DEPTS = {'01':'Ain','02':'Aisne','03':'Allier','04':'Alpes-de-Haute-Provence','05':'Hautes-Alpes','06':'Alpes-Maritimes','07':'Ardèche','08':'Ardennes','09':'Ariège','10':'Aube','11':'Aude','12':'Aveyron','13':'Bouches-du-Rhône','14':'Calvados','15':'Cantal','16':'Charente','17':'Charente-Maritime','18':'Cher','19':'Corrèze','2A':'Corse-du-Sud','2B':'Haute-Corse','21':'Côte-d\'Or','22':'Côtes-d\'Armor','23':'Creuse','24':'Dordogne','25':'Doubs','26':'Drôme','27':'Eure','28':'Eure-et-Loir','29':'Finistère','30':'Gard','31':'Haute-Garonne','32':'Gers','33':'Gironde','34':'Hérault','35':'Ille-et-Vilaine','36':'Indre','37':'Indre-et-Loire','38':'Isère','39':'Jura','40':'Landes','41':'Loir-et-Cher','42':'Loire','43':'Haute-Loire','44':'Loire-Atlantique','45':'Loiret','46':'Lot','47':'Lot-et-Garonne','48':'Lozère','49':'Maine-et-Loire','50':'Manche','51':'Marne','52':'Haute-Marne','53':'Mayenne','54':'Meurthe-et-Moselle','55':'Meuse','56':'Morbihan','57':'Moselle','58':'Nièvre','59':'Nord','60':'Oise','61':'Orne','62':'Pas-de-Calais','63':'Puy-de-Dôme','64':'Pyrénées-Atlantiques','65':'Hautes-Pyrénées','66':'Pyrénées-Orientales','67':'Bas-Rhin','68':'Haut-Rhin','69':'Rhône','70':'Haute-Saône','71':'Saône-et-Loire','72':'Sarthe','73':'Savoie','74':'Haute-Savoie','75':'Paris','76':'Seine-Maritime','77':'Seine-et-Marne','78':'Yvelines','79':'Deux-Sèvres','80':'Somme','81':'Tarn','82':'Tarn-et-Garonne','83':'Var','84':'Vaucluse','85':'Vendée','86':'Vienne','87':'Haute-Vienne','88':'Vosges','89':'Yonne','90':'Territoire de Belfort','91':'Essonne','92':'Hauts-de-Seine','93':'Seine-Saint-Denis','94':'Val-de-Marne','95':'Val-d\'Oise','971':'Guadeloupe','972':'Martinique','973':'Guyane','974':'La Réunion','975':'Saint-Pierre-et-Miquelon','976':'Mayotte','977':'Saint-Barthélemy','978':'Saint-Martin','986':'Wallis et Futuna','987':'Polynésie Française','988':'Nouvelle-Calédonie'};
  var CITY_ZH = { '巴黎': 'paris', '里昂': 'lyon', '马赛': 'marseille', '图卢兹': 'toulouse', '尼斯': 'nice', '南特': 'nantes', '斯特拉斯堡': 'strasbourg', '蒙彼利埃': 'montpellier', '波尔多': 'bordeaux', '里尔': 'lille', '雷恩': 'rennes', '兰斯': 'reims', '格勒诺布尔': 'grenoble', '第戎': 'dijon', '昂热': 'angers', '鲁昂': 'rouen', '奥尔良': 'orleans', '图尔': 'tours', '南锡': 'nancy', '梅斯': 'metz', '克莱蒙费朗': 'clermont ferrand', '亚眠': 'amiens', '贝桑松': 'besancon', '利摩日': 'limoges', '卡昂': 'caen', '凡尔赛': 'versailles', '土伦': 'toulon', '圣艾蒂安': 'saint etienne', '勒阿弗尔': 'le havre', '布雷斯特': 'brest', '勒芒': 'le mans', '普瓦捷': 'poitiers', '佩皮尼昂': 'perpignan', '米卢斯': 'mulhouse', '阿维尼翁': 'avignon', '戛纳': 'cannes', '尼姆': 'nimes', '波城': 'pau', '安纳西': 'annecy', '尚贝里': 'chambery', '特鲁瓦': 'troyes', '拉罗谢尔': 'la rochelle', '艾克斯': 'aix en provence', '留尼汪': '974', '瓜德罗普': '971', '马提尼克': '972', '圭亚那': '973' };
  var CCI_PRODUCT = { csp: 21, cr: 22, nat: 23 };
  var centresWait = null;
  function plain(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/[^a-z0-9一-鿿]+/g, ' ').trim(); }
  function deptOf(cp) { return /^9[78]/.test(cp) ? cp.slice(0, 3) : cp.slice(0, 2) === '20' ? (/^20[01]/.test(cp) ? '2A' : '2B') : cp.slice(0, 2); }
  function loadCentres() {
    if (DB.centres || centresWait) return;
    centresWait = (window.CIVIQUE_CENTRES ? Promise.resolve(window.CIVIQUE_CENTRES) : getJson('data/centres.json')).then(function (d) {
      DB.centres = d.c.map(function (r) {
        var dep = deptOf(r[2]);
        return { name: r[0], street: r[1], cp: r[2], city: r[3], lat: r[4], lon: r[5], tel: r[6], web: r[7], dep: dep, ckey: plain(r[3]), key: plain(r[3] + ' ' + r[0] + ' ' + (DEPTS[dep] || '')) };
      });
      DB.centresAsOf = d.asof;
    }).catch(function () { ui.centresFail = true; }).then(function () { centresWait = null; if (route() === 'register') render(); });
  }
  function kmBetween(a, b, c, d) {
    var p = Math.PI / 180, x = Math.pow(Math.sin((c - a) * p / 2), 2) + Math.cos(a * p) * Math.cos(c * p) * Math.pow(Math.sin((d - b) * p / 2), 2);
    return 12742 * Math.asin(Math.sqrt(x));
  }
  function findCentres() {
    var raw = (ui.cq || '').trim(), q = plain(CITY_ZH[raw] || raw), list = DB.centres, dep = '';
    if (q) {
      var up = q.toUpperCase();
      if (/^\d{5}$/.test(q)) dep = deptOf(q);
      else if (/^(\d{1,3}|2[ab])$/i.test(q)) dep = /^\d$/.test(q) ? '0' + q : up;
      if (dep) {
        var same = list.filter(function (c) { return c.cp === q; });
        list = same.length ? same : list.filter(function (c) { return c.dep === dep; });
      } else {
        var inCity = list.filter(function (c) { return (' ' + c.ckey + ' ').indexOf(' ' + q) >= 0; });   // a city first: "paris" should not bring up a school named after it elsewhere
        list = inCity.length ? inCity : list.filter(function (c) { return (' ' + c.key + ' ').indexOf(' ' + q) >= 0; });
      }
    }
    if (ui.geo) {
      list = list.map(function (c) { return { c: c, km: c.lat == null ? null : kmBetween(ui.geo.lat, ui.geo.lon, c.lat, c.lon) }; });
      list.sort(function (a, b) { return (a.km == null ? 1e9 : a.km) - (b.km == null ? 1e9 : b.km); });
    } else {
      list = list.map(function (c) { return { c: c, km: null }; });
    }
    return { list: list, q: q, dep: dep };
  }
  // a few pictograms only these pages use, drawn like the ICON set
  var RICON = {
    search: '<circle cx="10.500" cy="10.500" r="6.500"/><path d="m15.500 15.500 5 5" stroke-width="3"/>',
    locate: '<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.600" fill="currentColor"/><path d="M12 2.500V6M12 18v3.500M2.500 12H6M18 12h3.500"/>',
    tel: '<path d="M7 3.500h2.800l1.400 4.200-2 1.500a11 11 0 0 0 5.600 5.600l1.500-2 4.200 1.400V17a3 3 0 0 1-3.300 3A16.500 16.500 0 0 1 4 6.800a3 3 0 0 1 3-3.300z"/>',
    web: '<circle cx="12" cy="12" r="8.700"/><path d="M3.500 12h17M12 3.300c2.500 2.400 3.700 5.300 3.700 8.700s-1.200 6.300-3.700 8.700c-2.500-2.400-3.700-5.300-3.700-8.700s1.200-6.300 3.700-8.700z"/>'
  };
  function rIcon(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + RICON[n] + '</svg>'; }
  function centreList() {
    if (ui.centresFail) return '<p class="note warn">考场名单没有加载出来。请检查网络后刷新，或直接到官方地图上查。</p>';
    if (!DB.centres) return '<p class="note">正在加载考场名单</p>';
    var f = findCentres();
    if (!f.q && !ui.geo) {
      return '<p class="sub">热门城市</p><div class="chips">' + ['巴黎', '里昂', '马赛', '图卢兹', '尼斯', '斯特拉斯堡', '波尔多', '里尔', '南特', '蒙彼利埃'].map(function (c) {
        return '<button class="chip" data-a="cq" data-v="' + c + '">' + c + '</button>';
      }).join('') + '</div>';
    }
    if (!f.list.length) {
      return '<div class="note fd-none">' + six('sleep', 0, '', { mini: true }) + '<p>' + (f.dep ? esc(f.dep + (DEPTS[f.dep] ? ' ' + DEPTS[f.dep] : '')) + ' 省' : '“' + esc(ui.cq) + '”') + '在这份名单里没有考场。试试邻近的省号，或点“用我的位置”；另一家机构的考场见下面的说明。</p></div>';
    }
    var max = ui.cmore ? f.list.length : 8, shown = f.list.slice(0, max);
    var head = (f.q ? '找到 <b class="num">' + f.list.length + '</b> 个考场' : '离你最近的考场') + (ui.geo && f.q ? '，按距离排列' : '');
    return '<p class="sub" id="ccount">' + head + '</p><ul class="centres">' + shown.map(function (x) {
      var c = x.c, addr = (c.street ? c.street + ', ' : '') + c.cp + ' ' + c.city;
      return '<li class="centre"><div class="c-top"><p class="ca" lang="fr"><b class="cc"><span class="num">' + esc(c.cp) + '</span> ' + esc(c.city) + '</b></p>' +
        (x.km != null ? '<span class="tag blue">约 ' + (x.km < 10 ? Math.round(x.km * 10) / 10 : Math.round(x.km)) + ' 公里</span>' : '') + '</div>' +
        '<b class="cn" lang="fr">' + esc(c.name) + '</b>' +
        '<p class="cd" lang="fr">' + (c.street ? esc(c.street) + ' · ' : '') + esc(c.dep) + (DEPTS[c.dep] ? ' ' + esc(DEPTS[c.dep]) : '') + '</p><div class="c-acts">' +
        (c.tel ? '<a class="btn sm ghost" href="tel:' + esc(c.tel.split('/')[0].replace(/[^\d+]/g, '')) + '" title="' + esc(c.tel) + '" aria-label="电话 ' + esc(c.tel) + '">' + rIcon('tel') + '电话</a>' : '') +
        (c.web ? '<a class="btn sm ghost" href="' + esc(c.web) + '" target="_blank" rel="noopener">' + rIcon('web') + '网站</a>' : '') +
        '<a class="btn sm ghost" href="https://www.google.com/maps/search/?api=1&amp;query=' + encodeURIComponent(c.name + ', ' + addr) + '" target="_blank" rel="noopener">' + icon('register') + '地图</a></div></li>';
    }).join('') + '</ul>' + (f.list.length > max ? '<button class="btn quiet wide" data-a="cmore">显示其余 ' + (f.list.length - max) + ' 个</button>' : '');
  }
  // the seven steps: a title of a few words, two short lines at most, the action, the rest behind "了解更多"
  function regSteps(lv, cci) {
    function ext(href, t1, t2) { return '<a class="lrow" href="' + href + '" target="_blank" rel="noopener"><span class="grow"><span class="t1" lang="fr">' + t1 + '</span><span class="t2">' + t2 + '</span></span><span class="go out" aria-hidden="true">↗</span></a>'; }
    return [
      { t: '确认考哪种', p: ['分三种：多年卡、十年卡、入籍。' + (lv ? '你选的是「<b>' + LEVELS[lv].zh + '</b>」。' : ''), '选错了，证明可能用不上。'],
        act: '<a class="btn sm ghost" href="#check">不确定？30 秒自测</a>',
        more: '<p>报名时要选对考试类型，选错了，证明可能不能用于你的申请。十年居留卡的通过证明，申请多年居留卡时同样有效。</p>' },
      { t: '备好材料', p: ['有效居留证、外国人号码、一个常用邮箱。'],
        more: '<p>外国人号码（<span lang="fr">numéro étranger / AGDREF</span>）印在居留证上。账号、通知和成绩都发到邮箱，记得看垃圾邮件箱。</p>' },
      { t: '选考场报名', p: ['两家官方机构任选一家，考试内容相同。', '费用由各考场自己定，报名前先问清楚。'],
        act: '<div class="list">' + ext('https://test-civique.fr/inscription', 'France Éducation International', '填官方预报名表') + ext(cci, 'CCI Paris Île-de-France', '巴黎工商会：查场次并报名') + '</div>' +
          '<button class="btn sm ghost" data-a="cfind">' + rIcon('search') + '在下面找考场</button>',
        more: '<p><span lang="fr">France Éducation International</span>：官方建议先联系想去的考场，确认场次和费用，再填预报名表；提交后会收到一封邮件，用来创建考生账号。</p><p>巴黎工商会：在它的网站上按城市查场次，直接在线报名。</p>' },
      { t: '考试当天', p: ['带居留证和准考通知（<span lang="fr">convocation</span>），按通知上的时间到。', '迟到不能进考场。'],
        more: '<p>现场会核对身份、拍照、签名，请当场确认姓名和出生日期没有写错，这些会印在证明上。手机要关机，不能带资料和草稿纸，中途不能离场。</p>' },
      { t: '查成绩', p: ['考后一到两天出成绩。', '证明是电子版，长期有效，下载后保存好。'],
        more: '<p>一家是 12 小时内在考生账号里查看，另一家是 24 到 48 个工作小时内发邮件。没有纸质证明。</p>' },
      { t: '没通过', p: ['可以再报名，次数不限。', '答对 ' + EXAM.pass + ' 题才通过，模考稳定在 35 题以上再去。'],
        act: '<a class="btn sm ghost" href="#exam">去模考一次</a>' },
      { t: '交证明', p: ['办居留卡或入籍时，和其他材料一起交。'] }
    ];
  }
  function vRegister() {
    loadCentres();
    var lv = LEVELS[S.target] ? S.target : '', cci = 'https://francais.cci-paris-idf.fr/candidat?produit=' + (CCI_PRODUCT[lv] || 21);
    var steps = regSteps(lv, cci), open = steps[ui.step] ? ui.step : 0;
    var out = '<main class="wrap reg">' + topbar('报名考试', 'me', '<button class="chip" data-a="cfind">' + rIcon('search') + '找考场</button>') +
      '<p class="reg-own">' + icon('tick') + '<span>报名交费只在官网，本站不代办、不收报名费。</span></p>' +
      '<ol class="steps">' + steps.map(function (s, i) {
        var on = i === open;
        return '<li' + (on ? ' class="on"' : '') + '><button class="step-h" data-a="step" data-v="' + i + '" aria-expanded="' + on + '"><b>' + s.t + '</b>' + icon('go', 'chev') + '</button>' +
          (on ? '<div class="step-b">' + s.p.map(function (p) { return '<p>' + p + '</p>'; }).join('') + (s.act || '') +
            (s.more ? '<details class="disc flat"><summary>了解更多</summary><div class="in">' + s.more + '</div></details>' : '') +
            (steps[i + 1] ? '<button class="link step-n" data-a="step" data-v="' + (i + 1) + '">下一步：' + steps[i + 1].t + ' ›</button>' : '') + '</div>' : '') + '</li>';
      }).join('') + '</ol>';
    out += '<section class="hero finder" id="finder">' + heroDeco() +
      '<div class="fd-head"><div class="grow"><h2>找考场' + (DB.centres ? '<span class="fd-n"><b class="num">' + DB.centres.length + '</b> 个</span>' : '') + '</h2><p class="sub"><span lang="fr">France Éducation International</span> 认可</p></div>' + six('cheer', 0, 'bob') + '</div>' +
      '<form id="cform" class="field fd-q">' + rIcon('search') + '<input id="cq" class="plain" name="cq" type="search" autocomplete="off" spellcheck="false" placeholder="城市、省号或邮编，如 69" aria-label="城市、省号或邮编" maxlength="40" value="' + esc(ui.cq || '') + '"></form>' +
      '<button class="btn white wide" data-a="geo"' + (ui.geoBusy ? ' disabled' : '') + '>' + rIcon('locate') + (ui.geoBusy ? '正在定位' : ui.geo ? '重新定位' : '用我的位置') + '</button></section>' +
      (ui.geoMsg ? '<p class="msg bad" role="status">' + esc(ui.geoMsg) + '</p>' : '') +
      '<div id="clist" class="stack">' + centreList() + '</div>' +
      '<details class="disc fd-notes"><summary>名单来源和注意事项</summary><div class="in"><ul class="facts">' +
      '<li>名单取自 <span lang="fr">France Éducation International</span> 官网' + (DB.centresAsOf ? '（' + esc(DB.centresAsOf) + '）' : '') + '，考场会增减，以<a href="https://www.france-education-international.fr/centres-d-examen/carte?type-centre=examen_civique" target="_blank" rel="noopener">官方地图 ↗</a>为准。</li>' +
      '<li>巴黎工商会的考场不在这份名单里，请在<a href="' + cci + '" target="_blank" rel="noopener">它的网站 ↗</a>上按城市查。</li>' +
      '<li>位置只在你的手机上用来计算距离，不会上传。距离是直线距离。</li>' +
      '<li>费用由各考场自己定，每个考场不一样。</li>' +
      '<li>报名和交费都在官方机构的网站上完成，本站不代办、不收报名费。</li></ul></div></details>';
    return out + disclaimer() + '</main>' + tabs('me');
  }
  // ---------------------------------------------------------------- "do I have to take it?" (free self-check)
  // A small decision tree written from three service-public.gouv.fr pages (F39530 checked 2026-02-10, F39426 checked
  // 2026-07-16, F17048 checked 2026-06-26) and the Ministry's general information page. It gives a first answer and
  // always points to the official page; where the official text does not settle a case, the answer says so.
  var CHK_SRC = {
    sejour: ['service-public：多年居留卡和十年居留卡的公民考试', 'https://www.service-public.gouv.fr/particuliers/vosdroits/F39530'],
    nat: ['service-public：入籍的公民考试', 'https://www.service-public.gouv.fr/particuliers/vosdroits/F39426'],
    cir: ['service-public：融入合同（CIR）谁要签', 'https://www.service-public.gouv.fr/particuliers/vosdroits/F17048'],
    min: ['内政部：公民考试总体说明', 'https://formation-civique.interieur.gouv.fr/examen-civique/']
  };
  var CHK = {
    start: { q: '你现在要办的是哪一件事？', o: [
      { t: '第一次申请多年居留卡', fr: 'carte de séjour pluriannuelle（2 到 4 年）', n: 'cspAge' },
      { t: '第一次申请十年居留卡', fr: 'carte de résident，含长期居民卡和永久居留卡', n: 'crAge' },
      { t: '申请入籍', fr: 'nationalité française', n: 'nat' },
      { t: '续签已经有的多年卡或十年卡', fr: 'renouvellement', r: 'renew' },
      { t: '办一年期的临时居留卡', fr: 'carte de séjour temporaire（1 年）', r: 'cst' }
    ] },
    cspAge: { q: '你满 65 岁了吗？', o: [{ t: '已满 65 岁', r: 'age' }, { t: '未满 65 岁', n: 'cspTitle' }] },
    cspTitle: { q: '你现在拿的是哪一类居留？', sub: '看居留卡或签证上写的类别。', o: [
      { t: '工薪、经商或自由职业', fr: 'salarié · entrepreneur / profession libérale', n: 'cspStudy' },
      { t: '私人和家庭生活', fr: 'vie privée et familiale：法国人配偶、法国孩子的父母、家庭团聚等', n: 'cspStudy' },
      { t: '学生', fr: 'étudiant', r: 'cspNoCir' },
      { t: '人才居留，或人才居留的家属', fr: 'talent · talent (famille)', r: 'cspTalent' },
      { t: '访客、实习、临时工、季节工、互惠生、公司内部外派', fr: 'visiteur · stagiaire · travailleur temporaire · saisonnier · au pair · salarié détaché ICT', r: 'cspNoCir' },
      { t: '因健康原因获得的居留', fr: 'raisons de santé', r: 'cspNoCir' },
      { t: '难民、辅助保护、无国籍，或他们的家属', fr: 'réfugié · protection subsidiaire · apatride', r: 'cspProt' },
      { t: '不清楚，或不在上面', r: 'unsure' }
    ] },
    cspStudy: { q: '你在法国上过学吗？', sub: '指在法国读过至少 1 个学年的高等教育（大学、高商、工程师学校等），或者在法国的中学读过至少 3 个学年。', o: [
      { t: '上过，符合上面任意一条', r: 'cspDispense' }, { t: '没有', r: 'cspYes' }
    ] },
    crAge: { q: '你满 65 岁了吗？', o: [{ t: '已满 65 岁', r: 'age' }, { t: '未满 65 岁', n: 'crWhy' }] },
    crWhy: { q: '你凭什么理由申请十年卡？', o: [
      { t: '在法国合法连续住满 5 年', fr: 'carte de résident de longue durée-UE，包括人才居留、难民、辅助保护满 5 年的', r: 'crYes' },
      { t: '法国人的配偶，或法国孩子的父母', fr: 'époux de Français · parent d’enfant français', r: 'crYes' },
      { t: '家庭团聚，或十年卡持有人的配偶', fr: 'regroupement familial', r: 'crYes' },
      { t: '申请永久居留卡', fr: 'carte de résident permanent', r: 'crYes' },
      { t: '其他理由，或不清楚', r: 'crOther' }
    ] },
    nat: { q: '你通过哪种方式取得法国国籍？', o: [
      { t: '申请入籍，或恢复法国国籍', fr: 'naturalisation · réintégration（par décret）', r: 'natYes' },
      { t: '以声明方式取得', fr: 'par déclaration：和法国人结婚、法国人的直系长辈、法国人的兄弟姐妹', r: 'natNo' },
      { t: '不清楚', r: 'natUnsure' }
    ] }
  };
  var CHK_RES = {
    renew: { v: 'no', h: '不用考', why: ['考试只针对第一次申请多年居留卡或十年居留卡，续签不需要。', '注意一种情况：如果你这次不是续签原来的卡，而是改为申请永久居留卡（carte de résident permanent），那算第一次申请这种卡，要考十年居留卡的考试。'], src: ['sejour', 'min'] },
    cst: { v: 'no', h: '不用考', why: ['一年期的临时居留卡不要求公民考试。考试是在第一次申请多年居留卡或十年居留卡时才需要。', '可以先准备着：等你申请多年卡时就要用到，通过证明长期有效。'], src: ['sejour'] },
    age: { v: 'no', h: '不用考', why: ['官方规定：满 65 岁的人申请多年居留卡或十年居留卡，不需要参加公民考试。'], src: ['sejour'] },
    cspNoCir: { v: 'no', h: '不用考', why: ['官方规定：不需要签融入合同（CIR）的居留类别，申请多年居留卡时不要求公民考试。你这一类居留不用签融入合同。', '以后如果你换成别的居留类别（例如工薪、私人和家庭生活），或者申请十年卡、入籍，情况会不一样，到时再查一次。'], src: ['sejour', 'cir'] },
    cspTalent: { v: 'no', h: '申请多年卡不用考', why: ['人才居留和它的家属卡不用签融入合同（CIR），申请多年居留卡时不要求公民考试。', '但是：人才居留住满 5 年后申请十年卡（长期居民卡），官方明确写了要考十年居留卡的考试。'], src: ['sejour', 'cir'] },
    cspProt: { v: 'no', h: '不用考', why: ['官方页面写明：辅助保护受益人、无国籍人和他们的家属，申请多年居留卡不要求公民考试。内政部的总体说明里，国际保护受益人也不在考试范围内。', '但是：住满 5 年后申请长期居民十年卡时，官方写了要考。'], src: ['sejour', 'min'] },
    cspDispense: { v: 'maybe', h: '很可能不用考，请向省政府确认', why: ['官方规定里，在法国读过至少 1 学年高等教育、或至少 3 学年中学的人，免签融入合同（CIR）。', '而内政部写的是：考试针对的是“签了融入合同”、想申请多年卡或十年卡的人。按这个说法，你很可能不用考。', '但官方页面没有逐字写明“免签融入合同的人免考”，各省政府的要求可能不同。递材料前请向你所在的省政府（préfecture）确认，或者看 ANEF 上给你列出的材料清单里有没有这一项。'], src: ['cir', 'min', 'sejour'] },
    cspYes: { v: 'yes', lv: 'csp', h: '要考：多年居留卡的考试', why: ['你这一类居留要签融入合同（CIR），第一次申请多年居留卡时必须提交公民考试的通过证明。', '报名时选 mention « carte de séjour pluriannuelle »。如果你打算以后办十年卡，也可以直接考十年居留卡的考试：它的通过证明办多年卡同样有效。'], src: ['sejour', 'cir', 'min'] },
    crYes: { v: 'yes', lv: 'cr', h: '要考：十年居留卡的考试', why: ['官方页面把你这种情况列在需要公民考试的十年卡申请里。第一次申请时必须提交通过证明。', '报名时选 mention « carte de résident »。'], src: ['sejour'] },
    crOther: { v: 'maybe', h: '不一定，请对照官方页面', why: ['不是所有十年卡都要求公民考试。官方页面列出要考的有：法国人配偶、法国孩子的父母、家庭团聚或十年卡持有人的配偶、住满 5 年的长期居民卡、永久居留卡。', '不在这个范围里的十年卡（例如依法直接获得的十年卡），官方页面没有列为要考。请对照官方页面，或向省政府确认。'], src: ['sejour'] },
    natYes: { v: 'yes', lv: 'nat', h: '要考：入籍的考试', why: ['通过法令入籍（naturalisation）或恢复国籍（réintégration），必须通过公民考试。', '报名时选 mention « naturalisation »。入籍的官方题目清单和居留卡的不是同一套。', '入籍没有“满 65 岁免考”的规定；只有因残疾或健康原因确实无法考试的，可以凭医生证明申请免除。'], src: ['nat'] },
    natNo: { v: 'no', h: '不用考', why: ['官方规定：公民考试只针对通过法令取得国籍的程序。以声明方式取得国籍（和法国人结婚、法国人的直系长辈、法国人的兄弟姐妹）不需要参加公民考试。'], src: ['nat'] },
    natUnsure: { v: 'maybe', h: '看你走的是哪种程序', why: ['自己申请、由政府审批的入籍（naturalisation par décret）要考。', '因为和法国人结婚等原因、以声明方式（par déclaration）取得国籍的不用考。', '不确定的话，看你准备提交的申请表名称，或对照官方页面。'], src: ['nat'] },
    unsure: { v: 'maybe', h: '请对照官方页面', why: ['是否要考，取决于你的居留类别要不要签融入合同（CIR）。官方有一张表，列出了每一类居留要不要签。', '表里写“要签”的，第一次申请多年卡就要考；写“不用签”的不用考。'], src: ['cir', 'sejour'] }
  };
  function chkWalk() {
    var path = ui.chk || [], node = CHK.start, said = [], res = null;
    for (var i = 0; i < path.length && node; i++) {
      var o = node.o[path[i]]; if (!o) break;
      said.push({ q: node.q, t: o.t, at: i });
      if (o.r) { res = CHK_RES[o.r]; node = null; } else node = CHK[o.n];
    }
    return { said: said, node: node, res: res };
  }
  // the longest way from a question to a verdict, counted in questions: how many progress dots are still to come
  function chkDepth(node) {
    var d = 0;
    node.o.forEach(function (o) { if (o.n && CHK[o.n]) d = Math.max(d, chkDepth(CHK[o.n])); });
    return d + 1;
  }
  var CHK_LEGAL = '<div class="chk-legal"><p class="small">初步判断，不是法律意见，不能代替省政府（<span lang="fr">préfecture</span>）的要求。不适用于欧盟、欧洲经济区和瑞士公民，也不适用于持阿尔及利亚居留证的人。</p>' +
    '<details class="disc flat"><summary>依据和查阅日期</summary><div class="in"><p class="small">根据官方公开页面整理。规定可能调整，办理前请以官方页面和 ANEF 上给你的材料清单为准。欧盟、欧洲经济区和瑞士公民，以及持阿尔及利亚居留证（<span lang="fr">certificat de résidence</span>）的人另有规定。官方页面查阅于 2026-11-23。</p></div></details></div>';
  function vCheck() {
    var w = chkWalk(), done = w.said.length, total = done + (w.node ? chkDepth(w.node) : 0), dots = '';
    for (var i = 0; i < total; i++) dots += '<i' + (i < done ? ' class="done"' : i === done ? ' class="now"' : '') + '></i>';
    var out = '<main class="wrap chk">' + topbar('我要不要考？', 'me');
    if (!done) out += '<div class="chk-hi">' + six('cheer', 0, 'bob') + '<div class="stack tight"><p class="say"><span>答两三题，就知道要不要考、考哪种。</span></p>' +
      '<p class="chk-tags"><span class="tag g">免费</span><span class="tag g">不用注册</span><span class="tag">依据 service-public 官网</span></p></div></div>';
    out += '<div class="chk-prog" role="img" aria-label="' + (w.node ? '第 ' + (done + 1) + ' 题，最多 ' + total + ' 题' : '已答完') + '">' + dots +
      '<span class="lab">' + (w.node ? '第 <b>' + (done + 1) + '</b> 题' : '结果') + '</span></div>';
    if (done) out += '<ol class="chk-said">' + w.said.map(function (s) {
      return '<li><button class="chip" data-a="chk-back" data-v="' + s.at + '" aria-label="修改：' + esc(s.q) + ' ' + esc(s.t) + '"><span class="a">' + esc(s.t) + '</span><span class="ed">改</span></button></li>';
    }).join('') + '</ol>';
    if (w.node) {
      out += '<section class="stack chk-q"><h2>' + esc(w.node.q) + '</h2>' + (w.node.sub ? '<p class="small">' + esc(w.node.sub) + '</p>' : '') +
        w.node.o.map(function (o, i) {
          return '<button class="pick chk-opt" data-a="chk-pick" data-v="' + i + '">' + hexBadge('<b>' + 'ABCDEFGHIJ'.charAt(i) + '</b>') + '<span class="grow"><span class="t1">' + esc(o.t) + '</span>' + (o.fr ? '<span class="t2" lang="fr">' + esc(o.fr) + '</span>' : '') + '</span><span class="go" aria-hidden="true">›</span></button>';
        }).join('') + '</section>';
    } else if (w.res) {
      var r = w.res, lv = r.lv && DB.free.meta.counts[r.lv] ? r.lv : '', h = esc(r.h), stamp = r.v === 'yes' ? '要考' : r.v === 'no' ? '不用考' : '待确认';
      if (r.lv && LEVELS[r.lv]) h = h.replace(esc(LEVELS[r.lv].zh), '<mark>' + esc(LEVELS[r.lv].zh) + '</mark>');
      out += '<section class="chk-res ' + r.v + '" role="status"><div class="chk-v">' + (r.v === 'no' ? confetti() : '') + hex('deco') +
        six(r.v === 'yes' ? 'cheer' : r.v === 'no' ? 'celebrate' : 'neutral', 0, 'bob') +
        '<div class="grow">' + (r.h === stamp ? '' : '<span class="chk-stamp">' + stamp + '</span>') + '<h2' + (r.h === stamp ? ' class="solo"' : '') + '>' + h + '</h2></div></div>' +
        '<ul class="facts">' + r.why.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></section>';
      out += '<div class="stack">' +
        (lv ? '<button class="btn wide" data-a="chk-go" data-v="' + lv + '">开始练「' + LEVELS[lv].zh + '」的题</button><a class="btn ghost wide" href="#register">怎么报名、去哪考</a>'
          : (r.v === 'maybe' ? '<a class="btn ghost wide" href="#home">先练着，不耽误</a>' : '')) +
        '<button class="btn quiet wide" data-a="chk-back" data-v="0">重新回答</button></div>';
      out += '<section class="stack chk-src"><h2>官方出处</h2><div class="list">' + r.src.map(function (k) {
        var s = CHK_SRC[k][0].split('：');
        return '<a class="lrow" href="' + CHK_SRC[k][1] + '" target="_blank" rel="noopener"><span class="grow"><span class="t1">' + esc(s[1] || s[0]) + '</span><span class="t2">' + esc(s[1] ? s[0] : '') + '</span></span><span class="go out" aria-hidden="true">↗</span></a>';
      }).join('') + '</div></section>';
    }
    return out + CHK_LEGAL + disclaimer() + '</main>' + tabs('me');
  }
  // about, as questions people ask: short answers in cards that open, the official links as rows
  function vAbout() {
    var lv = LEVELS[S.target] ? S.target : '', n = 0;
    function faq(ic, q, body, open) {
      return '<details class="disc faq-c" id="faq-' + (++n) + '"' + (open ? ' open' : '') + '><summary>' + hexBadge(icon(ic)) + '<span class="grow">' + q + '</span></summary><div class="in">' + body + '</div></details>';
    }
    function ext(href, t1, t2) { return '<a class="lrow" href="' + href + '" target="_blank" rel="noopener"><span class="grow"><span class="t1">' + t1 + '</span><span class="t2">' + t2 + '</span></span><span class="go out" aria-hidden="true">↗</span></a>'; }
    function own(href, ic, t1, t2) { return '<a class="lrow" href="' + href + '">' + hexBadge(icon(ic)) + '<span class="grow"><span class="t1">' + t1 + '</span><span class="t2">' + t2 + '</span></span><span class="go">' + icon('go') + '</span></a>'; }
    var out = '<main class="wrap about">' + topbar('说明', 'me') + '<section class="stack faq">' +
      faq('exam', '考试是什么？',
        '<ul class="nums n3"><li><b>' + EXAM.n + '</b><span>道单选题</span></li><li><b>' + EXAM.min + '</b><span>分钟</span></li><li class="pass"><b>' + EXAM.pass + '</b><span>题及格</span></li></ul>' +
        '<ul class="facts"><li>法语作答，每题 4 个选项，只有 1 个正确：28 题知识题，12 题情景题。在平板或电脑上考。</li>' +
        '<li>随时可以报名，没通过可以再考，次数不限。通过证明长期有效。</li>' +
        '<li>考试中作弊会被禁考两年。</li></ul>', true) +
      faq('check', '谁要考？',
        '<ul class="facts"><li>从 2026 年 1 月 1 日起，第一次申请多年居留卡（<span lang="fr">carte de séjour pluriannuelle</span>）或十年居留卡（<span lang="fr">carte de résident</span>）要交通过证明。续签不需要。</li>' +
        '<li>申请入籍（<span lang="fr">naturalisation par décret</span>）也要考，形式相同，题目清单另有一套。以声明取得国籍的不用考。</li>' +
        '<li>65 岁以上不用考。因残疾或健康原因确实无法参加的，可以凭医生证明申请调整考试方式或免考。</li>' +
        '<li>不是所有居留类别都要考，例如不用签融入合同（<span lang="fr">CIR</span>）的类别就不用。</li>' +
        '<li>十年居留卡的通过证明，申请多年居留卡时同样有效。</li></ul>' +
        '<a class="btn sm ghost" href="#check">我属于哪种？30 秒自测</a>' +
        '<p class="small">整理自内政部和 service-public.gouv.fr 的官方页面，规定可能调整，办理前请以官方页面为准。</p>') +
      faq('cards', '这个题库是什么？',
        '<ul class="faq-own"><li><span class="tag g">官方</span><p>知识题的题干是内政部公布的官方题目。</p></li>' +
        '<li><span class="tag hot">本站</span><p>官方没有公布选项，本站的选项、中文翻译和讲解是自己编写的，并对照官方讲义核对。</p></li>' +
        '<li><span class="tag hot">本站</span><p>情景题官方没有公布，本站的情景题是按官方讲义编写的练习题，用来熟悉题型。</p></li>' +
        '<li><span class="tag warm">注意</span><p>正式考试的选项措辞会和这里不同。把知识点弄懂，比背选项有用。</p></li></ul>') +
      faq('lock', '我的记录存在哪？', '<p>练习记录只保存在你这台设备上。本站不要求注册，不收集个人信息。</p>') +
      faq('mistakes', '发现题目有错？', '<p>每道题的讲解下面有“这道题有问题？”，点一下就能把题号告诉我们' + (CFG.contact ? '：' + esc(CFG.contact) : '') + '，核实后会更正。</p>') +
      '</section>';
    out += '<section class="stack"><h2>官方入口</h2><div class="list">' +
      ext('https://formation-civique.interieur.gouv.fr/examen-civique/', '考试说明、官方题目清单和讲义', '内政部 · 免费') +
      ext('https://www.service-public.gouv.fr/particuliers/vosdroits/F39530', '居留卡：谁要考、怎么报名', 'service-public') +
      ext('https://www.service-public.gouv.fr/particuliers/vosdroits/F39426', '入籍的公民考试', 'service-public') +
      ext('https://francais.cci-paris-idf.fr/candidat?produit=' + (CCI_PRODUCT[lv] || 21), '报名：巴黎工商会', '考试机构 · CCI Paris Île-de-France') +
      ext('https://test-civique.fr/inscription', '报名：France Éducation International', '考试机构') +
      '</div><p class="small">报名、考点和费用以两家考试机构的网站为准。</p>' +
      '<div class="list">' + own('#check', 'check', '我要不要考？', '30 秒自测 · 本站整理') + own('#register', 'register', '报名步骤和考场查询', '本站整理') + '</div></section>';
    out += bankLine() + (CFG.seller ? '<p class="small center">经营者：' + esc(CFG.seller) + '</p>' : '');
    out += '<p class="small center">朗读录音由开源语音合成 Piper 生成，声音基于 SIWIS 法语语料库（CC BY 4.0）。</p>';
    return out + (DB.free ? disclaimer() : '') + '</main>' + tabs('me');
  }
  // what is open for free and what the unlock adds, counted from the data (for the chosen exam when there is one)
  function offerData() {
    var m = DB.free.meta, lv = LEVELS[S.target] && m.counts[S.target] ? S.target : '';
    var t = lv ? totals() : null, seen = {}, freeIds = {}, words = 0, rc = recallIds();
    (DB.free.qs || []).forEach(function (q) {
      freeIds[q.id] = 1;
      if (lv && q.l.indexOf(lv) < 0) return;
      (q.v || []).forEach(function (v) { var k = v[0].toLowerCase(); if (!seen[k]) { seen[k] = 1; words++; } });
    });
    return {
      lv: lv, free: t ? t.have : m.free, total: t ? t.total : m.total, know: t ? t.know : 0, situ: t ? t.situ : 0,
      cards: m.cards || 0, cardsFree: (DB.free.cards || []).filter(function (c) { return !c.x; }).length,
      words: words, recall: rc.ids.length, recallFree: rc.ids.filter(function (id) { return freeIds[id]; }).length
    };
  }
  // one free knowledge question shown whole, always the same one for a given exam
  function offerSample(lv) {
    var list = (DB.free.qs || []).filter(function (q) { return q.k === 'c' && q.e && q.qz && q.v && q.v.length && (!lv || q.l.indexOf(lv) >= 0); });
    return list[0] || null;
  }
  // back from the payment page and not unlocked yet: being confirmed, waiting to be confirmed again, or not confirmed
  function payState(at, note) {
    var wait = !!S.pending, busy = wait && ui.busy, c = String(CFG.contact || '').trim();
    return '<section class="card pay-state ' + (busy ? 'busy' : wait ? 'wait' : 'fail') + '">' +
      '<div class="ps-head">' + six(busy ? 'cheer' : wait ? 'neutral' : 'console', 0, busy ? 'bob' : '') +
      '<div class="grow"><h2>' + (busy ? '正在确认你的付款' : wait ? '付款还没确认好' : '付款没有确认') + '</h2>' +
      (busy ? '<p class="sub">一般几秒钟，不用再付一次。</p>' : wait && at !== 'pay' ? '<p class="sub">点一下再确认，不用再付一次。</p>' : '') + '</div></div>' +
      (busy ? '<div class="bar ps-bar" role="progressbar" aria-label="正在确认"><i></i></div>' : '') + note +
      (wait ? '<button class="btn wide" data-a="pay-retry"' + (busy ? ' disabled' : '') + '>' + (busy ? '确认中' : '重新确认') + '</button>'
        : (CFG.api ? '<button class="btn ghost wide" data-a="pay-find">已经付过款？找回解锁码</button>' : '') +
          (CFG.payUrl ? '<p class="small">想重新付款，用下面的按钮。</p>' : '')) +
      (c ? '<p class="small ps-help">还是不行？联系 ' + esc(c) + '</p>' : '') + '</section>';
  }
  function vUnlock() {
    ping('paywall');
    var close = '<button class="sq" data-a="back" aria-label="关闭">' + icon('close') + '</button>';
    var stage = '<div class="u-stage">' + confetti() + six('celebrate', 0, 'bob') + '</div>';
    if (unlocked()) {
      return '<main class="wrap"><section class="hero u-hero">' + heroDeco() + close + stage + '<h1 class="offer-h">已解锁全部题目</h1>' +
        (ui.msg ? '<p class="msg ok">' + esc(ui.msg.text) + '</p>' : '') +
        '<div class="offer-code"><span class="sub">你的解锁码</span><br><b class="code">' + esc(S.unlock ? S.unlock.code : '') + '</b></div></section>' +
        '<p class="small center">建议现在截图保存。换手机或换浏览器时，输入同一个解锁码即可' + (CFG.api ? '，也可以用付款时的邮箱找回' : '') + '。</p>' +
        '<a class="btn wide lg" href="#home">回首页</a>' + bankLine() + '</main>' + tabs('me');
    }
    var d = offerData(), at = ui.msg ? (ui.msg.at || 'code') : '';
    var others = levelIds().filter(function (lv) { return lv !== d.lv; }).map(function (lv) { return LEVELS[lv].short; }).join('、');
    function msg(where) { return '<p class="msg ' + (at === where ? (ui.msg.ok ? 'ok' : 'bad') : '') + '" role="status">' + (at === where ? esc(ui.msg.text) : '') + '</p>'; }
    function cell(n, unit, more) { return (n === '' ? '' : '<b>' + n + '</b>') + '<span>' + unit + '</span>' + (more ? '<small>' + more + '</small>' : ''); }
    function row(name, free, paid) { return '<tr><th scope="row">' + name + '</th><td>' + free + '</td><td class="on">' + paid + '</td></tr>'; }
    function get(cls, n, unit, what) { return '<li class="tile ' + cls + '">' + hex('deco') + '<div class="n"><b>' + n + '</b><span>' + unit + '</span></div><p>' + what + '</p></li>'; }
    var out = '<main class="wrap"><section class="hero u-hero">' + heroDeco() + close + stage + '<h1 class="offer-h">解锁全部，一路通关</h1></section>';
    if (S.pending || at === 'pay') out += payState(at, msg('pay'));

    // 1. what you get, the price, one button
    out += '<ul class="gets">' + get('t-institutions', DB.free.meta.total, '题', '全部带中文讲解') +
      (d.cards ? get('t-droits', d.cards, '张', '考点速记') : '') +
      get('t-principes', EXAM.n, '题', '完整模考') +
      (d.recall ? get('t-histoire', d.recall, '道', '机经题逐题讲解') : get('t-histoire', levelIds().length, '种', '考试都包含')) + '</ul>' +
      '<section class="offer stack"><div class="offer-price"><b>' + esc(CFG.price || '') + '</b><span class="offer-terms">' + icon('tick') + '一次付款，不是订阅</span></div>' +
      (CFG.payUrl ? buyButton(payHref(), '解锁全部', true) +
        '<details class="disc flat"><summary>付款之后会怎样？</summary><div class="in offer-after"><ol>' +
        '<li>自动回到本站，全部题目马上解锁。</li>' +
        '<li>同时给你一个解锁码，换手机或换浏览器时输入。</li>' +
        (CFG.api ? '<li>解锁码找不到了，可以用付款时的邮箱找回。</li>' : '') + '</ol>' +
        '<p>不会自动续费，题目更正和补充不再收费。付款页面由 Stripe 提供，本站不接触你的卡号。</p>' +
        '<p>这是付款后立即开通的数字内容，开通后不能无理由退款，所以请先免费试用。详见<a href="conditions.html" target="_blank" rel="noopener">购买条款</a>。</p></div></details>' +
        '<details class="disc flat" id="ref-box"' + (at === 'ref' ? ' open' : '') + '><summary>朋友推荐来的？</summary><div class="in">' +
        (refOk(lsGet(REF_KEY)) ? '<p class="small">推荐码已记下：<b>' + esc(lsGet(REF_KEY)) + '</b>。价格不变，只是让推荐你的朋友得到感谢。要换的话重新填。</p>' : '<p class="small">填朋友给你的推荐码再付款。价格不变，只是让推荐你的朋友得到感谢。没有就不用填。</p>') +
        '<form id="refform" class="stack"><div class="field"><input id="ref" class="plain" name="ref" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="推荐码" aria-label="推荐码" maxlength="40"><button class="btn" type="submit">确定</button></div>' + msg('ref') + '</form></div></details>'
        : '<p class="note">' + (CFG.contact ? '购买请联系：' + esc(CFG.contact) + '。付款后会收到一个解锁码。' : '付款后会收到一个解锁码，填在下面即可。') + '</p>') +
      '<p class="offer-honest">官方备考资料是免费的，这里收费的是中文翻译、讲解和工具。可以先免费试 ' + d.free + ' 题。</p></section>';

    // 2. for people who already paid: the code, or the email of the payment
    out += '<details class="disc" id="have-code"' + (!CFG.payUrl || ui.open.code || at === 'code' ? ' open' : '') + '><summary>已有解锁码？</summary><div class="in">' +
      '<form id="codeform" class="stack"><div class="field"><input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="例如 ABCD-2345-EFGH" aria-label="解锁码" maxlength="20"><button class="btn" type="submit"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? '解锁中' : '解锁') + '</button></div>' +
      msg('code') + '</form></div></details>';
    if (CFG.api) out += '<details class="disc" id="find-code"' + (ui.open.mail || at === 'mail' ? ' open' : '') + '><summary>找回解锁码</summary><div class="in"><p class="small">付过款，但换了手机或找不到解锁码：填付款时用的邮箱。</p>' +
      '<form id="mailform" class="stack"><div class="field"><input id="mail" class="plain" name="mail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="付款时填写的邮箱" aria-label="付款邮箱" maxlength="120"><button class="btn" type="submit"' + (ui.busy ? ' disabled' : '') + '>找回</button></div>' + msg('mail') + '</form></div></details>';

    // 3. free trial next to the unlocked bank
    out += '<details class="disc" id="cmp"' + (ui.open.cmp ? ' open' : '') + '><summary>免费试用和解锁后的区别</summary><div class="in"><table class="cmp"><thead><tr><td></td><th scope="col">免费试用</th><th scope="col" class="on">解锁后</th></tr></thead><tbody>' +
      row('题目' + (d.lv ? '<small>' + LEVELS[d.lv].short + '</small>' : ''), cell(d.free, '题'),
        '<b class="key">' + d.total + '</b><span>题</span><small>' + (d.lv ? '知识题 ' + d.know + '，情景题 ' + d.situ : '三种考试合计') + '</small>') +
      (d.lv && others ? row('其他类型', cell('', '可以试用'), cell('', others + '也包含')) : '') +
      (d.cards ? row('考点速记', cell(d.cardsFree, '张'), cell(d.cards, '张')) : '') +
      row('模拟考试', cell(MINI.n, '题', '试考'), cell(EXAM.n, '题', '可以反复考')) +
      (d.recall ? row('机经讲解', cell(d.recallFree, '道'), cell(d.recall, '道')) : '') +
      row('错题本', cell('', '免费题的错题'), cell('', '全部题的错题')) +
      row('生词表', cell(d.words, '个词'), cell('', '全部生词')) +
      '</tbody></table></div></details>';

    // 4. what one question looks like
    var sq = offerSample(d.lv);
    if (sq) out += '<details class="disc" id="sample"' + (ui.open.sample ? ' open' : '') + '><summary>看一道示例题</summary><div class="in">' +
      '<div class="offer-sample"><span class="offer-stamp">免费题里的一道</span>' + question(sq, { perm: [2, 0, 3, 1], mode: 'show' }) + '</div></div></details>';
    return out + bankLine() + '</main>' + tabs('me');
  }

  // ---------------------------------------------------------------- routing + render
  var VIEWS = { home: vHome, practice: vPractice, me: vMe, quiz: vQuiz, exam: vExam, result: vResult, mistakes: vMistakes, words: vWords, cards: vCards, sheet: vSheet, recall: vRecall, register: vRegister, check: vCheck, about: vAbout, unlock: vUnlock };
  function route() { var h = (location.hash || '').replace(/^#/, ''); return VIEWS[h] ? h : 'home'; }
  function go(name) { if (route() === name) render(true); else location.hash = name; }
  function render(top) {
    if (!DB.free) return;               // still loading: the first render comes when the questions are in
    var r = route();
    if (S.exam && r !== 'exam') { location.hash = 'exam'; return; }
    if (r === 'quiz' && !S.sess) { location.hash = 'home'; return; }
    closeWord();
    keepRef();
    syncNow(false);
    app.innerHTML = VIEWS[r]() + modal();
    syncDock();
    if (top) window.scrollTo(0, 0);
  }
  // the quiz dock (previous / next, or the feedback panel) is fixed: the page keeps that much room under the question
  function syncDock() {
    var d = document.querySelector('.dock');
    try { document.documentElement.style.setProperty('--dock-h', (d ? d.offsetHeight : 0) + 'px'); } catch (e) { /* the default padding applies */ }
  }
  var here = route();
  window.addEventListener('hashchange', function () { try { ui.prev = here; here = route(); hush(); ui.modal = null; if (route() !== 'unlock') ui.msg = null; render(true); } catch (e) { oops(e, 'page ' + route()); } });
  // Something broke on this device: say so on the screen, with enough detail to find it from a screenshot.
  function oops(e, where) {
    try {
      var msg = (e && (e.message || e.reason && (e.reason.message || e.reason))) || String(e), at = '';
      var st = e && e.stack ? String(e.stack).split('\n') : [];
      for (var i = 0; i < st.length && !at; i++) { var m = /(\w[\w.]*)?@?[^\s(]*?:(\d+):(\d+)/.exec(st[i]); if (m && st[i].indexOf(msg) < 0) at = (m[1] || '') + ' ' + m[2] + ':' + m[3]; }
      var box = document.getElementById('oops');
      if (!box) { box = document.createElement('div'); box.id = 'oops'; box.setAttribute('role', 'alert'); document.body.appendChild(box); }
      box.innerHTML = '<b>这一步出错了</b><span>请截图发给卖家，然后刷新页面再试。</span><code>' + esc(where || '') + ' · ' + esc(String(msg).slice(0, 160)) + (at ? ' · ' + esc(at) : '') + ' · ' + esc((DB.free && DB.free.built) || '') + '</code><button type="button" id="oops-x">关闭</button>';
      document.getElementById('oops-x').onclick = function () { if (box.parentNode) box.parentNode.removeChild(box); };
    } catch (x) { /* the notice itself must never throw */ }
  }
  window.addEventListener('error', function (ev) { if (ev && ev.error) oops(ev.error, 'script'); });
  window.addEventListener('unhandledrejection', function (ev) { oops(ev && ev.reason, 'promise'); });

  setInterval(function () {
    if (!S.exam) return;
    var left = examLeft();
    if (left <= 0) { finishExam(); ui.modal = null; go('result'); return; }
    var el = document.getElementById('timer');
    if (el) { el.textContent = mmss(left); el.className = 'timer' + (left < 300 ? ' low' : ''); }
  }, 1000);

  // ---------------------------------------------------------------- actions
  var ACT = {
    target: function (v) { if (!LEVELS[v]) return; var first = !S.target; if (S.target !== v) { S.target = v; S.sess = null; } save(); render(first); },   // first choice: the welcome screen was scrolled, the home screen starts at the top
    goto: function (v) { ui.modal = null; go(v); },
    close: function () { ui.modal = null; render(); },
    print: function () { window.print(); },
    fig: function (v) { openFig(v); },
    locked: function () {
      ui.modal = { title: '这部分需要解锁', body: '<p>解锁后可以看全部题目的讲解、全部考点速记和完整模拟考试。</p>', actions: [{ label: '去解锁', a: 'goto', v: 'unlock' }, { label: '关闭', a: 'close', cls: 'quiet' }] };
      render();
    },
    veil: function (v, el, ev) { if (ev.target === el) { ui.modal = null; render(); } },
    theme: function (v) { themeSheet(v); render(); },
    'continue': function () {
      if (route() !== 'quiz') ui.from = route();
      if (S.sess && S.sess.i < S.sess.ids.length) return go('quiz');
      var nt = nextTheme();
      if (nt && startPractice(nt, 'todo')) return go('quiz');
      ui.modal = unlocked()
        ? { title: '全部题目都已掌握', body: '<p>可以去做模拟考试，或者在主题里选择“从头重练”。</p>', actions: [{ label: '去模拟考试', a: 'goto', v: 'exam' }, { label: '关闭', a: 'close', cls: 'quiet' }] }
        : { title: '免费题都已掌握', body: '<p>其余题目解锁后可以练。</p>', actions: [{ label: '解锁全部题目', a: 'goto', v: 'unlock' }, { label: '关闭', a: 'close', cls: 'quiet' }] };
      render();
    },
    start: function (v) {
      var p = v.split('|');
      if (route() !== 'quiz') ui.from = route();
      ui.modal = null;
      if (startPractice(p[0], p[1])) go('quiz'); else render();
    },
    restart: function (v) {
      ui.modal = { title: '清空「' + theme(v).zh + '」的记录？', body: '<p>这个主题的练习记录和错题会被清空，其他主题不受影响。</p>', actions: [{ label: '清空并从头练', a: 'restart-yes', v: v, cls: 'danger' }, { label: '取消', a: 'close', cls: 'quiet' }] };
      render();
    },
    'restart-yes': function (v) {
      DB.qs.forEach(function (q) { if (q.t === v) delete S.stats[q.id]; });
      S.sess = null; save(); ACT.start(v + '|todo');
    },
    pick: function (v) {
      var s = S.sess; if (!s || s.i >= s.ids.length) return;
      var id = s.ids[s.i]; if (s.ans[id] !== undefined) return;
      var before = answeredCount();
      s.ans[id] = Number(v); practised(id, Number(v) === 0); save();
      if (before < 10 && answeredCount() >= 10) ping('ten_answers');
      hush(); render();
      syncDock();
      var opts = document.querySelector('.opts');      // the options stay in view above the panel that has just come up
      if (opts && opts.scrollIntoView) { try { opts.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { opts.scrollIntoView(false); } }
    },
    zh: function () { S.zhOn = !S.zhOn; save(); render(); },
    say: function (v) {
      if (v && DB.byId[v]) return speak(DB.byId[v].q);      // in lists: the question only
      var q = null, perm = null;
      if (route() === 'quiz' && S.sess) { var id = S.sess.ids[S.sess.i]; q = DB.byId[id]; perm = permFor(S.sess, id); }
      if (!q) return;
      var parts = [q.q]; perm.forEach(function (orig, pos) { parts.push(LETTERS[pos]); parts.push(q.o[orig]); });
      speak(parts);
    },
    word: function (v) { speak(v); },
    tw: function (v, el) { tapWord(el); },
    next: function () { var s = S.sess; if (!s) return; s.i = Math.min(s.ids.length, s.i + 1); save(); hush(); render(true); },
    prev: function () { var s = S.sess; if (!s) return; s.i = Math.max(0, s.i - 1); save(); hush(); render(true); },
    'exam-start': function (v) { startExam(v === 'mini' || !unlocked()); ui.modal = null; render(true); },
    'exam-pick': function (v) { var x = S.exam; if (!x) return; x.ans[x.ids[x.i]] = Number(v); save(); render(); },
    'exam-next': function () { var x = S.exam; if (!x) return; x.i = Math.min(x.ids.length - 1, x.i + 1); save(); render(true); },
    'exam-prev': function () { var x = S.exam; if (!x) return; x.i = Math.max(0, x.i - 1); save(); render(true); },
    'exam-go': function (v) { var x = S.exam; if (!x) return; x.i = Number(v); ui.modal = null; save(); render(true); },
    'exam-flag': function () { var x = S.exam; if (!x) return; var id = x.ids[x.i]; if (x.flags[id]) delete x.flags[id]; else x.flags[id] = 1; save(); render(); },
    'exam-grid': function () { examGrid(); render(); },
    'exam-submit': function () {
      var x = S.exam; if (!x) return;
      var miss = x.ids.filter(function (id) { return x.ans[id] === undefined; }).length;
      ui.modal = {
        title: '确定交卷？',
        body: '<ul class="nums n3 ex-sum"><li><b>' + (x.ids.length - miss) + '</b><span>已答</span></li><li' + (miss ? ' class="miss"' : '') + '><b>' + miss + '</b><span>没答</span></li><li><b>' + mmss(examLeft()) + '</b><span>剩余时间</span></li></ul>' +
          (miss ? '<p class="small center">没答的题按答错算。</p>' : ''),
        actions: [{ label: '交卷', a: 'exam-submit-yes' }, { label: '继续答题', a: 'close', cls: 'quiet' }]
      };
      render();
    },
    'exam-submit-yes': function () { finishExam(); ui.modal = null; go('result'); },
    'exam-quit': function () {
      ui.modal = { title: '放弃这次考试？', body: '<p>这次作答不保存，也不计成绩。</p>', actions: [{ label: '放弃考试', a: 'exam-quit-yes', cls: 'danger' }, { label: '继续答题', a: 'close' }] };
      render();
    },
    'exam-quit-yes': function () { S.exam = null; ui.modal = null; save(); render(true); },
    'pay-find': function () {
      ui.open.mail = true; render();
      var box = document.getElementById('find-code');
      if (box && box.scrollIntoView) { try { box.scrollIntoView({ block: 'center' }); } catch (e) { box.scrollIntoView(false); } }
    },
    'pay-retry': function () {
      if (!S.pending || ui.busy) return;
      ui.busy = true; ui.msg = null; render();
      confirmPayment().then(function () { ui.busy = false; render(); });
    },
    'demo-pick': function (v) {
      if (ui.demo !== undefined) return;
      ui.demo = Number(v); render();                     // nothing is saved: not a practice session, not in the statistics
      var card = document.querySelector('.wl-on');           // bring the way on into view, the explanation sits right above it
      if (card && card.scrollIntoView) { try { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { card.scrollIntoView(false); } }
    },
    'demo-next': function () {
      var el = document.getElementById('pickexam'); if (!el) return;
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      try { el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(true); }
    },
    report: function (v) { reportSheet(v); render(); },
    'copy-id': function (v) { copyId(v); },
    'result-show': function (v) { ui.resultIdx = Number(v); ui.open = {}; ui.resOnly = false; go('result'); },
    'res-filter': function (v) { ui.resOnly = v === 'wrong'; render(); },
    open: function (v) { ui.open[v] = !ui.open[v]; render(); },
    'plan-edit': function () { ui.planMsg = ''; planSheet(); render(); },
    'plan-clear': function () { S.examDate = ''; ui.modal = null; ui.planMsg = ''; save(); render(); },
    'rd-how': function () { readyHow(); render(); },
    back: function () { go(ui.prev && VIEWS[ui.prev] && ui.prev !== 'quiz' && ui.prev !== route() ? ui.prev : 'me'); },
    sess: function (v) { ui.open['s' + v] = !sessOpen(Number(v)); render(); },
    cth: function (v) { ui.cth = v || ''; ui.card = null; render(); refocus('.kf [aria-pressed="true"]'); },
    card: function (v, el) {
      if (!v) return;
      var nav = el && el.parentNode && /kc-nav/.test(el.parentNode.className) ? (/\bsq\b/.test(el.className) ? '.kc-nav .sq' : '.kc-nav .btn') : '';
      ui.card = v; hush(); render(); showCard();
      if (nav) refocus(nav);
    },
    wmask: function () { ui.wmask = !ui.wmask; ui.wrev = {}; render(); refocus('[data-a="wmask"]'); },
    wrev: function (v) { ui.wrev = ui.wrev || {}; ui.wrev[v] = 1; render(); },
    reset: function () {
      ui.modal = { title: '清空全部练习记录？', body: '<p>练习进度、错题本和模拟考试成绩都会被清空。解锁状态不受影响。</p>', actions: [{ label: '清空', a: 'reset-yes', cls: 'danger' }, { label: '取消', a: 'close', cls: 'quiet' }] };
      render();
    },
    step: function (v) { ui.step = Number(v); render(); },
    cfind: function () {
      var el = document.getElementById('finder'); if (!el) return;
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      try { el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(true); }
    },
    cq: function (v) { ui.cq = v; ui.cmore = false; render(); },
    cmore: function () { ui.cmore = true; var box = document.getElementById('clist'); if (box) box.innerHTML = centreList(); },
    geo: function () {
      if (!navigator.geolocation) { ui.geoMsg = '这个浏览器不支持定位。可以直接输入城市、省号或邮编。'; render(); return; }
      ui.geoBusy = true; ui.geoMsg = ''; render();
      navigator.geolocation.getCurrentPosition(function (pos) {
        ui.geoBusy = false; ui.geo = { lat: pos.coords.latitude, lon: pos.coords.longitude }; ui.cmore = false; render();
      }, function () {
        ui.geoBusy = false; ui.geoMsg = '没能取得位置（浏览器没有授权定位，或者这里用不了）。可以直接输入城市、省号或邮编。'; render();
      }, { timeout: 10000, maximumAge: 600000 });
    },
    'chk-pick': function (v) { var w = chkWalk(); if (!w.node || !w.node.o[Number(v)]) return; ui.chk = (ui.chk || []).slice(0, w.said.length).concat(Number(v)); render(true); },
    'chk-back': function (v) { ui.chk = (ui.chk || []).slice(0, Number(v)); render(true); },
    'chk-go': function (v) { if (!LEVELS[v]) return; if (S.target !== v) { S.target = v; S.sess = null; } save(); go('home'); },
    'reset-yes': function () { S.stats = {}; S.exams = []; S.days = {}; S.sess = null; S.exam = null; ui.modal = null; save(); render(true); }
  };
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-a]') : null;
    if (!el || el.disabled) return;
    var a = el.getAttribute('data-a');
    if (!ACT[a] || (a === 'veil' && ev.target !== el)) return;      // a tap inside a sheet is not a tap on the veil: its form must still submit
    ev.preventDefault();
    try { ACT[a](el.getAttribute('data-v'), el, ev); } catch (e) { oops(e, 'tap ' + a); }
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.id !== 'cq') return;
    ui.cq = ev.target.value; ui.cmore = false;
    var box = document.getElementById('clist'); if (box) box.innerHTML = centreList();
  });
  document.addEventListener('submit', function (ev) {
    if (ev.target.id === 'cform') { ev.preventDefault(); var cq = document.getElementById('cq'); if (cq) cq.blur(); return; }
    if (ev.target.id === 'refform') {
      ev.preventDefault();
      var rv = ((document.getElementById('ref') || {}).value || '').trim();
      if (refOk(rv)) { lsSet(REF_KEY, rv); ui.msg = { ok: true, text: '记下了，现在可以付款。', at: 'ref' }; }
      else ui.msg = { ok: false, text: '推荐码只有英文字母、数字和短横线，请照朋友给的原样填。', at: 'ref' };
      render();
      return;
    }
    if (ev.target.id === 'mailform') {
      ev.preventDefault();
      if (ui.busy) return;
      ui.open.mail = true;
      var mail = ((document.getElementById('mail') || {}).value || '').trim();
      ui.busy = true; ui.msg = null; render();
      var box = document.getElementById('mail'); if (box) box.value = mail;
      unlockViaServer({ email: mail }).then(function (r) {
        ui.busy = false;
        ui.msg = r === 'ok' ? { ok: true, text: '已找回，全部题目已开放。' } : { ok: false, text: mailError(r), at: 'mail' };
        render();
        var again = document.getElementById('mail'); if (again && r !== 'ok') again.value = mail;
      });
      return;
    }
    if (ev.target.id !== 'codeform') return;
    ev.preventDefault();
    if (ui.busy) return;
    ui.open.code = true;
    var val = (document.getElementById('code') || {}).value || '';
    ui.busy = true; ui.msg = null; render();
    var input = document.getElementById('code'); if (input) input.value = val;
    unlockWithCode(val).then(function (r) {
      ui.busy = false;
      ui.msg = r === 'ok' ? { ok: true, text: '解锁成功，全部题目已开放。' } : { ok: false, text: codeError(r) };
      ui.revoked = false;
      render();
      var again = document.getElementById('code'); if (again && r !== 'ok') again.value = val;
    });
  });
  document.addEventListener('submit', function (ev) {
    if (ev.target.id !== 'planform') return;
    ev.preventDefault();
    var v = (document.getElementById('examdate') || {}).value || '';
    if (!/^\d{4}-\d\d-\d\d$/.test(v)) ui.planMsg = '请先选一个日期。';
    else if (v < today()) ui.planMsg = '这一天已经过了，请选今天或之后的日期。';
    else { S.examDate = v; ui.modal = null; ui.planMsg = ''; planTidy(); save(); render(); return; }
    planSheet(); render();
    var box = document.getElementById('examdate'); if (box) box.value = v;
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ui.modal) { ui.modal = null; render(); } });
  // a disclosure that was opened stays open when the page is drawn again
  var DISC = { 'have-code': 'code', 'find-code': 'mail', cmp: 'cmp', sample: 'sample' };
  document.addEventListener('toggle', function (ev) { var t = ev.target; if (t && t.id && DISC[t.id]) ui.open[DISC[t.id]] = !!t.open; }, true);
  window.addEventListener('resize', syncDock);

  // ---------------------------------------------------------------- start
  function fonts() {
    ['Fredoka:wght@500;600;700', 'Nunito:wght@600;700;800;900']
.forEach(function (f) {
      try {
        var l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=' + f + '&display=swap';
        document.head.appendChild(l);
      } catch (e) { /* system fonts are fine */ }
    });
  }
  try { document.documentElement.lang = 'zh-CN'; } catch (e) { /* not essential */ }
  fonts();
  if ('serviceWorker' in navigator && CFG.offline !== false && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try { navigator.serviceWorker.register('sw.js').catch(function () { /* the site works without it */ }); } catch (e) { /* same */ }
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') syncNow(true); });
  loadFree().then(function () {
    if (S.target && !DB.free.meta.counts[S.target]) { S.target = ''; S.sess = null; S.exam = null; }
  }).then(restoreUnlock).then(codeFromUrl).then(paidFromUrl).then(function () {
    sanitize(); save(); render(true);
    loadPatches().then(function () { if (PATCH.sealed || Object.keys(PATCH.free).length) render(); });
  }).catch(function () {
    app.innerHTML = '<main class="wrap"><h1>公民考试中文题库</h1><p class="note warn">题目没有加载出来。请检查网络后刷新页面。</p></main>';
  });
})();
