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
  function payHref() { var u = String(CFG.payUrl || ''); return u + (u.indexOf('?') < 0 ? '?' : '&') + 'locale=zh'; }
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
  }

  // ---------------------------------------------------------------- speech
  var canSpeak = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
  function speak(text) {
    if (!canSpeak) return;
    try {
      window.speechSynthesis.cancel();
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR'; u.rate = 0.88;
      window.speechSynthesis.speak(u);
    } catch (e) { /* no voice on this device */ }
  }
  function hush() { if (canSpeak) { try { window.speechSynthesis.cancel(); } catch (e) { /* nothing playing */ } } }

  // ---------------------------------------------------------------- practice sessions
  function startPractice(tid, mode) {
    var qs;
    if (mode === 'wrong') qs = shuffle(mistakes());
    else if (mode === 'recall') qs = recallTodo();
    else {
      qs = pool().filter(function (q) { return q.t === tid && !mastered(q.id); });
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
    S.exam = null; ui.resultIdx = 0; ui.open = {};
    save();
    ping(x.mini ? 'mini_done' : 'exam_done');
  }

  // ---------------------------------------------------------------- pieces of markup
  var ICON = {
    home: '<path d="M4 11.5 12 4l8 7.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
    principes: '<path d="M5.5 20.5v-16"/><path d="M5.5 5.5H19v9H5.5"/><path d="M10 5.5v9M14.5 5.5v9"/>',
    institutions: '<path d="M3.5 9.5 12 4l8.5 5.5z"/><path d="M6.5 12.5V17M10.2 12.5V17M13.8 12.5V17M17.5 12.5V17M4 20h16"/>',
    droits: '<path d="M12 4.5V20M8 20h8M5.5 7.5h13"/><path d="m5.5 7.5-2.5 6a2.6 2.6 0 0 0 5 0zM18.5 7.5l-2.5 6a2.6 2.6 0 0 0 5 0z"/>',
    histoire: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.2 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.2-3.8-8.5s1.3-6.1 3.8-8.5z"/>',
    societe: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19.5c0-3.2 2.3-5.5 5.5-5.5s5.5 2.3 5.5 5.5M15.5 5.7a3 3 0 0 1 0 5.6M17.3 14.4c2 .7 3.2 2.5 3.2 5.1"/>',
    exam: '<circle cx="12" cy="13.5" r="7"/><path d="M12 9.5v4l2.6 1.8M9.5 3.5h5"/>',
    mistakes: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="m9.5 9.5 5 5m0-5-5 5"/>',
    words: '<path d="M4 6.5h9M8.5 4v2.5M11 6.5c-.6 3.2-2.8 5.8-6.5 7.3M6.5 9.5c1 2 2.800 3.500 5 4.300"/><path d="m13 20 3.500-9 3.500 9M14.200 17h4.600"/>',
    about: '<circle cx="12" cy="12" r="8.500"/><path d="M12 11v5.500M12 7.600v.3"/>',
    cards: '<path d="M4 5.500c2.700-1 5.300-.8 8 .7 2.700-1.500 5.300-1.700 8-.7v12.300c-2.700-1-5.300-.8-8 .7-2.700-1.500-5.300-1.700-8-.7z"/><path d="M12 6.200v12.300"/>',
    recall: '<path d="M4.500 5.500h15v10.500h-7.800L7 19.600V16H4.500z"/><path d="M8 9.300h8M8 12.300h5"/>',
    register: '<path d="M12 20.500s6.500-5.600 6.500-10.500a6.500 6.500 0 0 0-13 0c0 4.900 6.500 10.500 6.500 10.500z"/><circle cx="12" cy="10" r="2.300"/>',
    sheet: '<path d="M6.500 3.500h8l3 3v14h-11z"/><path d="M14.500 3.500v3h3M9 10.500h6M9 14h6M9 17.500h3.500"/>',
    say: '<path d="M4 10v4h3l4.500 3.500v-11L7 10z"/><path d="M15.500 9a4.200 4.200 0 0 1 0 6M18 6.500a7.600 7.600 0 0 1 0 11"/>'
  };
  function icon(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>'; }
  function tabs(active) {
    var items = [['home', '首页'], ['cards', '速记'], ['exam', '模考'], ['recall', '机经'], ['register', '报名'], ['about', '说明']];
    return '<nav class="tabs" aria-label="主导航"><ul>' + items.map(function (it) {
      return '<li><a href="#' + it[0] + '"' + (active === it[0] ? ' aria-current="page"' : '') + '>' + icon(it[0]) + '<span>' + it[1] + '</span></a></li>';
    }).join('') + '</ul></nav>';
  }
  function levelIds() { return ['csp', 'cr', 'nat'].filter(function (lv) { return !!DB.free.meta.counts[lv]; }); }
  function brand() {
    return '<header class="brand"><h1>公民考试中文题库</h1><span class="mark" title="40 题答对 32 题通过"><b>32</b>/40</span></header>';
  }
  function bar(done, total, cls) {
    var w = total ? Math.round(done / total * 1000) / 10 : 0;
    return '<div class="bar ' + (cls || '') + '" role="img" aria-label="' + done + ' / ' + total + '"><i style="width:' + w + '%"></i></div>';
  }
  function payBlock(lead) {
    var d = offerData();
    return '<section class="pay"><h2>' + esc(lead || '解锁全部题目') + '</h2>' +
      '<ul class="pay-facts">' +
      '<li><b>' + d.total + '</b><span>' + (d.lv ? LEVELS[d.lv].short + '题目' : '全部题目') + '</span></li>' +
      (d.cards ? '<li><b>' + d.cards + '</b><span>张考点速记</span></li>' : '') +
      '<li><b>' + EXAM.n + '</b><span>题完整模考</span></li></ul>' +
      '<p class="pay-line">每题都有中文翻译和讲解。' + levelIds().map(function (lv) { return LEVELS[lv].short; }).join('、') + '的题库都包含，现在免费开放 ' + d.free + ' 题。</p>' +
      (CFG.price ? buyButton('#unlock', '解锁全部')
        : '<div class="pay-foot"><span class="price"><small>一次性付款，不是订阅</small></span><a class="btn" href="#unlock">去解锁</a></div>') + '</section>';
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
    return '<a class="src" href="' + esc(s[1]) + '" target="_blank" rel="noopener">对照官方讲义：<span lang="fr">' + esc(s[0]) + '</span> ↗</a>';
  }
  // one question. o: { perm, chosen, zh, mode: 'practice' | 'exam' | 'review' | 'show' | 'demo' }  (demo: the question of the welcome screen, answered in place and never recorded)
  function question(q, o) {
    var answered = o.chosen !== undefined && o.chosen !== -1;
    var show = o.mode === 'show';
    var demo = o.mode === 'demo';
    var reveal = show || o.mode === 'review' || ((o.mode === 'practice' || demo) && answered);
    var showZh = o.zh || reveal;
    var kind = q.k === 's' ? '<span class="tag blue">情景题</span><span class="tag">本站练习题，非官方原题</span>' : '<span class="tag blue">知识题</span><span class="tag">官方题目</span>';
    var seen = recallIds().n[q.id];
    if (seen) kind += '<span class="tag hot">机经提到 ' + seen + ' 次</span>';
    var tap = o.mode !== 'exam';
    if (tap) loadDict();
    var out = '<div class="kind">' + kind + '</div><p class="stem" lang="fr">' + (tap ? tapWords(q.q) : esc(q.q)) + '</p>';
    if (o.mode !== 'exam' && !demo) {
      out += '<div class="tools">' +
        (canSpeak ? '<button class="chip" data-a="say"' + (o.mode === 'practice' ? '' : ' data-v="' + esc(q.id) + '"') + '>' + icon('say') + '朗读</button>' : '') +
        (o.mode === 'practice' ? '<button class="chip" data-a="zh" aria-pressed="' + (o.zh ? 'true' : 'false') + '">' + (o.zh ? '中文：开' : '中文：关') + '</button>' : '') + '</div>' + wordHint(o.mode, q);
    }
    if (showZh) out += '<p class="stemz">' + esc(q.qz) + '</p>';
    out += '<div class="opts">' + o.perm.map(function (orig, pos) {
      var cls = 'opt', dis = '';
      if (reveal) {
        dis = ' disabled';
        if (orig === 0) cls += ' right'; else if (orig === o.chosen && !show) cls += ' wrong'; else cls += ' dim';
      } else if (o.mode === 'exam' && o.chosen === orig) cls += ' sel';
      // once the answer is out an option is no longer a button: its words can be tapped instead
      var el = reveal && tap ? 'div' : 'button';
      return '<' + el + ' class="' + cls + '"' + (el === 'div' ? '' : ' data-a="' + (o.mode === 'exam' ? 'exam-pick' : (demo ? 'demo-pick' : 'pick')) + '" data-v="' + orig + '"' + dis) + '>' +
        '<span class="let">' + LETTERS[pos] + '</span><span class="txt"><span class="fr" lang="fr">' + (el === 'div' ? tapWords(q.o[orig]) : esc(q.o[orig])) + '</span>' +
        (showZh ? '<span class="zh">' + esc(q.oz[orig]) + '</span>' : '') + '</span></' + el + '>';
    }).join('') + '</div>';
    if (reveal) {
      var ok = o.chosen === 0, letter = LETTERS[o.perm.indexOf(0)];
      var head = show ? '正确答案是 ' + letter : (ok ? '答对了' : (answered ? '答错了，正确答案是 ' + letter : '没有作答，正确答案是 ' + letter));
      out += '<section class="copy ' + (show ? 'plain' : (ok ? 'good' : 'miss')) + '"><span class="verdict" aria-hidden="true">' + (show ? '→' : (ok ? '✓' : '✗')) + '</span>' +
        '<h3>' + head + '</h3><p>' + esc(q.e) + '</p>' +
        (q.v && q.v.length ? '<ul class="voc">' + q.v.map(function (v) { var tip = vocTip(v[0]); return '<li><span class="w" lang="fr">' + esc(v[0]) + '</span><span>' + esc(v[1]) + '</span>' + (tip ? '<span class="tip">' + esc(tip) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
        srcLink(q) + (demo ? '' : reportLink(q)) + '</section>';
    }
    return out;
  }
  function disclaimer() {
    return '<footer class="foot"><p>本站不是法国政府网站，与法国内政部和考试机构没有任何关系。官方备考资料是免费的，见 <a href="https://formation-civique.interieur.gouv.fr/examen-civique/" target="_blank" rel="noopener">formation-civique.interieur.gouv.fr</a>。本站收费的是中文翻译、讲解和练习工具。</p>' +
      '<p>知识题题干来自内政部公布的官方清单（Ministère de l’Intérieur – DIAN，Licence Ouverte 2.0，查阅于 ' + esc(DB.free.consulted || DB.free.built) + '）。官方没有公布选项：选项、翻译和讲解由本站编写，正式考试的选项措辞会不同，请理解知识点，不要死记选项。</p></footer>';
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
    var mid = r.left + r.width / 2;
    var left = Math.max(edge, Math.min(mid - bw / 2, vw - edge - bw));
    var below = r.top - gap - bh < roof + 4 && r.bottom + gap + bh <= vh - 4;
    if (below) wordBox.className = 'tw-pop below';
    wordBox.style.left = Math.round(left) + 'px';
    wordBox.style.top = Math.round(below ? r.bottom + gap : Math.max(4, r.top - gap - bh)) + 'px';
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
    if (wordAt && !(ev.target.closest && ev.target.closest('.tw-pop, .tw'))) closeWord();
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeWord(); });
  // the note is pinned to the screen, so it goes when the page really moves (not for the tail end of a scroll that brought the word into view)
  window.addEventListener('scroll', function () { if (wordAt && Math.abs((window.pageYOffset || 0) - wordY) > 6) closeWord(); }, { passive: true });
  window.addEventListener('resize', function () { if (wordAt) closeWord(); });

  // ---------------------------------------------------------------- first question, price buttons, report
  // a button that leads to paying: the price is written on it and the terms right under it
  function buyButton(href, label) {
    return '<div class="buy"><a class="btn wide" href="' + esc(href) + '"><span>' + esc(label) + '</span>' +
      (CFG.price ? '<span class="buy-dot" aria-hidden="true"> · </span><b class="buy-p">' + esc(CFG.price) + '</b>' : '') + '</a>' +
      '<p class="buy-terms">' + (CFG.price ? '一次付款，不是订阅，长期使用' : '一次性付款，不是订阅') + '</p></div>';
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
    var done = ui.demo !== undefined;
    return '<section class="offer-sample wl-try"><span class="offer-stamp">先做一题</span>' +
      question(q, { perm: DEMO_PERM, chosen: ui.demo, mode: 'demo' }) +
      (done ? '<button class="wl-on" data-a="demo-next"><span>每道题都是这样讲的。<b>选你要考的类型，接着练</b></span><i aria-hidden="true">↓</i></button>'
        : '<p class="tw-hint">点一个选项就能看到答案和中文讲解。法语词也可以点。</p>') + '</section>';
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
  function vChoose() {
    var meta = DB.free.meta, m = meta.counts;
    function n(lv) { var c = 0; THEMES.forEach(function (t) { c += m[lv][t.id].c; }); return c; }
    var proof = [[meta.total, '道练习题'], [meta.cards, '张考点速记'], [DB.recall.length, '场考生回忆'], [meta.free, '道免费试做', 'free']]
      .filter(function (p) { return p[0] > 0; });
    return '<main class="wrap wl">' +
      '<header class="wl-hero"><p class="wl-kicker"><span lang="fr">examen civique</span> · 中文题库</p>' +
      '<h1>法国公民考试，<br>用中文<em>看懂每一题</em></h1>' +
      '<p class="wl-lead">法语原题，每题都有中文翻译和讲解。</p>' +
      '<span class="wl-stamp" role="img" aria-label="40 题答对 32 题通过"><b>32</b><i>/40</i><small>及格线</small></span></header>' +
      '<section class="wl-proof-wrap"><ul class="wl-proof" style="grid-template-columns:repeat(' + proof.length + ',1fr)">' + proof.map(function (p) {
        return '<li' + (p[2] ? ' class="' + p[2] + '"' : '') + '><b>' + p[0] + '</b><span>' + p[1] + '</span></li>';
      }).join('') + '</ul>' +
      '<p class="small">' + (DB.recall.length ? '考生回忆（机经）来自网上的分享，不是官方公布的题目。' : '') + '另有<a href="#register">官方考点查询和报名步骤</a>。</p></section>' +
      demoBlock() +
      '<section class="stack wl-next" id="pickexam"><div><p class="wl-step">免费开始，不用注册</p><h2>你准备申请哪一种？</h2></div>' +
      levelIds().map(function (lv) {
        return '<button class="pick" data-a="target" data-v="' + lv + '"><span class="grow"><span class="t1">' + LEVELS[lv].zh + '</span><br><span class="t2" lang="fr">' + LEVELS[lv].fr + '</span></span><span class="cnt"><b>' + n(lv) + '</b> 道官方题<span class="go" aria-hidden="true">›</span></span></button>';
      }).join('') +
      '<p class="small">每种申请的考题不一样。选错了没关系，之后可以在首页随时切换。</p></section>' +
      disclaimer() + '</main>' + tabs('home');
  }
  function vHome() {
    if (!S.target) return vChoose();
    var t = totals(), sess = S.sess && S.sess.i < S.sess.ids.length ? S.sess : null;
    var out = '<main class="wrap">' + brand() +
      '<div class="seg n' + levelIds().length + '" role="group" aria-label="准备申请的类型">' + levelIds().map(function (lv) {
        return '<button data-a="target" data-v="' + lv + '" aria-pressed="' + (S.target === lv) + '"><b>' + LEVELS[lv].short + '</b><span lang="fr">' + LEVELS[lv].frs + '</span></button>';
      }).join('') + '</div>';
    if (ui.netFail) out += '<p class="note warn">已购买的题库这次没有加载出来，目前只显示免费题。请检查网络后刷新页面。</p>';
    if (ui.revoked) out += '<p class="note warn">这台设备保存的解锁码已失效，请重新输入解锁码或联系卖家。</p>';
    var pct = t.total ? Math.round(t.done / t.total * 1000) / 10 : 0, nm = mistakes().length;
    // best result so far for this exam type: full mock exams first, the short trial exam otherwise
    var mine = S.exams.filter(function (e) { return e.target === S.target && e.n > 0; });
    var run = mine.filter(function (e) { return !e.mini; });
    if (!run.length) run = mine;
    var best = run.reduce(function (a, e) { return !a || e.score > a.score ? e : a; }, null);
    out += '<section class="hero home"><div class="row between"><span class="sub">已掌握</span>' + (unlocked() ? '<span class="tag blue">已解锁全部题目</span>' : '<span class="tag">免费试用：开放 ' + t.have + ' 题</span>') + '</div>' +
      '<div class="hero-main"><div class="ring" role="img" aria-label="已掌握 ' + t.done + ' / ' + t.total + ' 题">' +
      '<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="trk" cx="60" cy="60" r="54"/>' +
      (pct > 0 ? '<circle class="arc" cx="60" cy="60" r="54" pathLength="100" stroke-dasharray="' + pct + ' 100"/>' : '') + '</svg>' +
      '<div class="in" aria-hidden="true"><span class="n">' + t.done + '</span><span class="of">/ ' + t.total + ' 题</span></div></div>' +
      '<div class="hero-acts"><button class="btn" data-a="continue">' + (sess ? '继续练习' : (answeredCount() ? '接着练' : '开始练习')) + '</button><a class="btn ghost" href="#exam">模拟考试</a></div></div>' +
      (best ? '<p class="hero-fact">' + (best.mini ? '试考' : '模拟考试') + '最好成绩 <b' + (best.score >= best.passAt ? ' class="pass"' : '') + '>' + best.score + '/' + best.n + '</b>' +
        (best.score >= best.passAt ? '，已过及格线（' + best.passAt + ' 题）' : '，离及格还差 ' + (best.passAt - best.score) + ' 题') + '</p>' : '') +
      '<div class="quick n3"><a href="#mistakes">' + icon('mistakes') + '错题本' + (nm ? '<b>' + nm + '</b>' : '') + '</a><a href="#words">' + icon('words') + '生词表</a><a href="#sheet">' + icon('sheet') + '考前一页</a></div></section>';
    out += '<section class="stack"><h2>五个主题</h2><div class="themes">' + THEMES.map(function (th) {
      var c = counts(th.id);
      return '<button class="theme' + (c.total && c.done >= c.total ? ' full' : '') + '" data-a="theme" data-v="' + th.id + '"><span class="ti">' + icon(th.id) + '</span>' +
        '<span class="tx"><span class="t1">' + th.zh + '</span><span class="t2" lang="fr">' + th.fr + '</span>' + bar(c.done, c.total) + '</span>' +
        '<span class="cnt"><b>' + c.done + '</b>/' + c.total + '<span class="go" aria-hidden="true">›</span></span></button>';
    }).join('') + '</div></section>';
    if (!unlocked()) out += payBlock('免费题做完了？解锁全部内容');
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
    var body = '<p class="sub" lang="fr">' + th.fr + '</p><ul class="rules">' +
      '<li><span class="k">官方知识题</span><span class="v"><b>' + c.know + '</b> 题</span></li>' +
      (c.situ ? '<li><span class="k">情景练习题</span><span class="v"><b>' + c.situ + '</b> 题</span></li>' : '') +
      '<li><span class="k">正式考试</span><span class="v">这个主题出 <b>' + (th.k + th.s) + '</b> 题' + (th.s ? '（其中 ' + th.s + ' 题情景题）' : '') + '</span></li>' +
      '<li><span class="k">你的进度</span><span class="v">已掌握 <b>' + c.done + '</b> / ' + c.total + (unlocked() ? '' : '，免费开放 ' + c.have + ' 题') + '</span></li></ul>' +
      (c.situ ? '<p class="small">情景题怎么判断：见<button class="link" data-a="goto" data-v="sheet">考前一页</button></p>' : '') +
      (!unlocked() && !c.todo ? '<p class="note blue">这个主题的免费题已经全部掌握，其余 ' + (c.total - c.have) + ' 题解锁后可以练。</p>' : '');
    ui.modal = { title: th.zh, body: body, actions: acts };
  }
  function vQuiz() {
    var s = S.sess;
    if (!s) return vHome();
    var special = s.mode === 'wrong' || s.mode === 'recall';
    var th = s.mode === 'wrong' ? { zh: '错题重做' } : (s.mode === 'recall' ? { zh: '机经题' } : theme(s.theme));
    if (s.i >= s.ids.length) {            // set finished
      var right = s.ids.filter(function (id) { return s.ans[id] === 0; }).length;
      var more = s.mode === 'wrong' ? mistakes().length : (s.mode === 'recall' ? recallTodo().length : pool().filter(function (q) { return q.t === s.theme && !mastered(q.id) && (s.mode !== 'situ' || q.k === 's'); }).length);
      var c = special ? null : counts(s.theme);
      var out = '<main class="wrap">' + brand() + '<section class="hero"><span class="sub">' + th.zh + ' · 这一组做完了</span>' +
        '<div class="big">' + right + '<small> / ' + s.ids.length + ' 题答对</small></div>' + bar(right, s.ids.length, 'ok') + '</section>';
      out += '<div class="stack">';
      if (more) out += '<button class="btn wide" data-a="start" data-v="' + s.theme + '|' + s.mode + '">' + (s.mode === 'wrong' ? '继续重做错题（还有 ' + more + ' 题）' : '下一组（还有 ' + more + ' 题没掌握）') + '</button>';
      else if (s.mode === 'wrong') out += '<p class="note blue">错题本清空了。</p>';
      else if (s.mode === 'recall') out += '<p class="note blue">机经里能练的题都已经掌握。</p>';
      else if (!unlocked() && c && c.have < c.total) out += '<p class="note blue">这个主题的免费题已经全部掌握，其余 ' + (c.total - c.have) + ' 题解锁后可以练。</p>';
      else out += '<p class="note blue">这个主题的题目已经全部掌握。</p>';
      var nt = nextTheme();
      if (!more && nt && !special) out += '<button class="btn wide" data-a="start" data-v="' + nt + '|todo">去练「' + theme(nt).zh + '」</button>';
      out += '<a class="btn wide ghost" href="#home">回首页</a></div>';
      if (!unlocked() && !more) out += payBlock();
      return out + '</main>' + tabs('home');
    }
    var id = s.ids[s.i], q = DB.byId[id], chosen = s.ans[id];
    var last = s.i === s.ids.length - 1;
    return '<main class="wrap bare"><div class="qbar"><a class="back" href="' + (s.mode === 'recall' ? '#recall' : '#home') + '" aria-label="返回">‹ 返回</a><span class="ttl">' + th.zh + '</span><span class="pos">' + (s.i + 1) + ' / ' + s.ids.length + '</span></div>' +
      question(q, { perm: permFor(s, id), chosen: chosen, zh: !!S.zhOn, mode: 'practice' }) + '</main>' +
      '<div class="dock"><div class="in"><button class="btn quiet fix" data-a="prev"' + (s.i === 0 ? ' disabled' : '') + '>上一题</button>' +
      '<button class="btn" data-a="next"' + (chosen === undefined ? ' disabled' : '') + '>' + (last ? '完成这一组' : '下一题') + '</button></div></div>';
  }
  function vExam() {
    if (!S.target) return vChoose();
    var x = S.exam;
    if (!x) {
      var un = unlocked(), hist = S.exams.filter(function (e) { return e.target === S.target; }).slice(0, 5);
      var out = '<main class="wrap">' + brand() + '<section class="stack"><h2>模拟考试 · ' + LEVELS[S.target].zh + '</h2>' +
        '<p class="sub">和正式考试一样的题量、时间和及格线。考试过程中只有法语，没有中文和讲解，交卷后可以逐题看讲解。</p>' +
        '<ul class="rules"><li><span class="k">题量</span><span class="v"><b>40</b> 题单选：28 题知识题 + 12 题情景题</span></li>' +
        '<li><span class="k">时间</span><span class="v">最长 <b>45</b> 分钟</span></li>' +
        '<li><span class="k">及格</span><span class="v">答对 <b>32</b> 题（80%）</span></li>' +
        '<li><span class="k">各主题</span><span class="v">' + THEMES.map(function (t) { return t.zh + ' <b>' + (t.k + t.s) + '</b>'; }).join('、') + '</span></li></ul>';
      out += un ? '<button class="btn wide" data-a="exam-start" data-v="full">开始考试</button>'
        : '<button class="btn wide" data-a="exam-start" data-v="mini">免费试考：' + MINI.n + ' 题 · ' + MINI.min + ' 分钟</button><p class="small">试考从免费题里抽题，答对 ' + MINI.pass + ' 题算通过。完整的 40 题模拟考试在解锁后开放。</p>';
      out += '</section>';
      if (hist.length) out += '<section class="stack"><h2>最近的成绩</h2><ul class="split">' + hist.map(function (e) {
        var idx = S.exams.indexOf(e);
        return '<li><button class="link" data-a="result-show" data-v="' + idx + '">' + dateZh(e.ts) + (e.mini ? ' · 试考' : '') + '</button><span class="n' + (e.score >= e.passAt ? '' : ' lowv') + '">' + e.score + ' / ' + e.n + '</span></li>';
      }).join('') + '</ul></section>';
      if (!un) out += payBlock('解锁完整模拟考试');
      return out + '</main>' + tabs('exam');
    }
    var id = x.ids[x.i], q = DB.byId[id], left = examLeft(), last = x.i === x.ids.length - 1;
    var answered = x.ids.filter(function (k) { return x.ans[k] !== undefined; }).length;
    return '<main class="wrap bare"><div class="qbar"><span class="timer' + (left < 300 ? ' low' : '') + '" id="timer" aria-label="剩余时间">' + mmss(left) + '</span>' +
      '<span class="ttl">已答 ' + answered + ' / ' + x.ids.length + '</span><button class="chip" data-a="exam-grid">第 ' + (x.i + 1) + ' 题 ▾</button></div>' +
      question(q, { perm: permFor(x, id), chosen: x.ans[id], zh: false, mode: 'exam' }) +
      '<div class="row between"><button class="chip" data-a="exam-flag" aria-pressed="' + (x.flags[id] ? 'true' : 'false') + '">' + (x.flags[id] ? '已标记，稍后再看' : '标记这题') + '</button><button class="link" data-a="exam-quit">放弃本次考试</button></div></main>' +
      '<div class="dock"><div class="in"><button class="btn quiet fix" data-a="exam-prev"' + (x.i === 0 ? ' disabled' : '') + '>上一题</button>' +
      (last ? '<button class="btn" data-a="exam-submit">交卷</button>' : '<button class="btn" data-a="exam-next">下一题</button>') + '</div></div>';
  }
  function examGrid() {
    var x = S.exam;
    var body = '<div class="grid40">' + x.ids.map(function (id, i) {
      var cls = (x.ans[id] !== undefined ? 'done ' : '') + (i === x.i ? 'cur ' : '') + (x.flags[id] ? 'flag' : '');
      return '<button class="' + cls + '" data-a="exam-go" data-v="' + i + '" aria-label="第 ' + (i + 1) + ' 题">' + (i + 1) + '</button>';
    }).join('') + '</div><p class="small">蓝色是已作答，黄点是标记过的题。</p>';
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
    var pass = e.score >= e.passAt, wrong = e.items.filter(function (it) { return it[1] !== 0; }).length;
    var out = '<main class="wrap">' + brand() + '<section class="hero"><span class="sub">' + (e.mini ? '试考' : '模拟考试') + ' · ' + LEVELS[e.target].zh + ' · ' + dateZh(e.ts) + '</span>' +
      '<div class="big">' + e.score + '<small> / ' + e.n + '</small></div>' +
      '<p class="verdict-line ' + (pass ? 'pass' : 'fail') + '">' + (pass ? '通过' : '未通过，还差 ' + (e.passAt - e.score) + ' 题') + '</p>' +
      '<div class="scale' + (pass ? ' pass' : '') + '"><div class="track"><i style="width:' + (e.score / e.n * 100) + '%"></i></div>' +
      '<div class="passmark" style="left:' + (e.passAt / e.n * 100) + '%"><span>及格线 ' + e.passAt + '</span></div><div class="ends"><span>0</span><span>' + e.n + '</span></div></div>' +
      '<p class="sub">用时 ' + Math.floor(e.secs / 60) + ' 分 ' + (e.secs % 60) + ' 秒</p></section>';
    out += '<section class="stack"><h2>各主题得分</h2><ul class="split">' + THEMES.filter(function (t) { return e.th[t.id]; }).map(function (t) {
      var r = e.th[t.id];
      return '<li><span>' + t.zh + '</span><span class="n' + (r[0] / r[1] < 0.8 ? ' lowv' : '') + '">' + r[0] + ' / ' + r[1] + '</span></li>';
    }).join('') + '</ul></section>';
    out += '<section class="stack"><h2>逐题讲解' + (wrong ? '（错 ' + wrong + ' 题）' : '') + '</h2><p class="small">点开任意一题看中文翻译和讲解。答错的题已自动加入错题本。</p><ul class="qlist">' + e.items.map(function (it, i) {
      var q = DB.byId[it[0]];
      if (!q) return '';
      return reviewRow(q, i + 1, it[1], it[2].split('').map(Number), 'r' + i);
    }).join('') + '</ul></section>';
    out += '<div class="stack"><a class="btn wide" href="#exam">再考一次</a>' + (wrong ? '<a class="btn wide ghost" href="#mistakes">去错题本</a>' : '') + '</div>';
    if (!unlocked()) out += payBlock('解锁完整模拟考试');
    return out + '</main>' + tabs('exam');
  }
  function vMistakes() {
    if (!S.target) return vChoose();
    var ms = mistakes();
    var out = '<main class="wrap">' + brand() + '<section class="stack"><h2>错题本 · ' + LEVELS[S.target].zh + '</h2>';
    if (!ms.length) return out + '<p class="note">还没有错题。练习和模拟考试里答错的题会自动收进这里，连续答对两次后移出。</p><a class="btn wide" href="#home">去练习</a></section></main>' + tabs('home');
    out += '<p class="sub">共 <span class="num">' + ms.length + '</span> 题。每题连续答对两次后自动移出。</p>' +
      '<button class="btn wide" data-a="start" data-v="all|wrong">重做错题（每组最多 ' + SET + ' 题）</button></section>';
    THEMES.forEach(function (t) {
      var list = ms.filter(function (q) { return q.t === t.id; });
      if (!list.length) return;
      out += '<section class="stack"><h2>' + t.zh + '（' + list.length + '）</h2><ul class="qlist">' + list.map(function (q, i) {
        return reviewRow(q, i + 1, null, [0, 1, 2, 3], 'm' + q.id);
      }).join('') + '</ul></section>';
    });
    return out + '</main>' + tabs('home');
  }
  function vWords() {
    if (!S.target) return vChoose();
    var out = '<main class="wrap">' + brand() + studyNav('words') + '<section class="stack"><h2>生词表 · ' + LEVELS[S.target].zh + '</h2><p class="sub">考题里反复出现、值得先认熟的法语词。' + (canSpeak ? '点一下可以听发音。' : '') + '</p></section>';
    var n = 0, seen = {};
    THEMES.forEach(function (t) {
      var list = [];
      pool().forEach(function (q) {
        if (q.t !== t.id) return;
        (q.v || []).forEach(function (v) { var k = v[0].toLowerCase(); if (!seen[k]) { seen[k] = 1; list.push(v); } });
      });
      if (!list.length) return;
      list.sort(function (a, b) { return a[0].replace(/^(l'|le |la |les |un |une |des )/i, '').localeCompare(b[0].replace(/^(l'|le |la |les |un |une |des )/i, ''), 'fr'); });
      n += list.length;
      out += '<section class="stack"><h2>' + t.zh + '（' + list.length + '）</h2><ul class="words">' + list.map(function (v) {
        return '<li><button class="w" lang="fr" data-a="word" data-v="' + esc(v[0]) + '">' + esc(v[0]) + '</button><span>' + esc(v[1]) + '</span></li>';
      }).join('') + '</ul></section>';
    });
    if (!unlocked()) out += '<p class="note blue">现在显示的是免费题里的 ' + n + ' 个生词，解锁后显示全部题目的生词。</p>' + payBlock();
    return out + '</main>' + tabs('cards');
  }
  function studyNav(active) {
    return '<div class="seg n3 study" role="group" aria-label="速记、生词和考前一页"><a href="#cards"' + (active === 'cards' ? ' aria-current="page"' : '') + '><b>考点速记</b></a><a href="#words"' + (active === 'words' ? ' aria-current="page"' : '') + '><b>生词表</b></a><a href="#sheet"' + (active === 'sheet' ? ' aria-current="page"' : '') + '><b>考前一页</b></a></div>';
  }
  // 考点速记: the official sheets (French only) condensed into Chinese cards
  function vCards() {
    var out = '<main class="wrap">' + brand() + studyNav('cards') + '<section class="stack"><h2>考点速记</h2><p class="sub">官方讲义只有法语。这里按主题整理成中文要点，每张卡片都附官方讲义的链接，可以对照。</p></section>';
    if (!DB.cards.length) return out + '<p class="note">考点速记正在整理中。</p></main>' + tabs('cards');
    THEMES.forEach(function (t) {
      var list = DB.cards.filter(function (c) { return c.t === t.id; });
      if (!list.length) return;
      out += '<section class="stack"><h2>' + t.zh + '（' + list.length + '）</h2><ul class="qlist">' + list.map(function (c) {
        var open = !c.x && !!ui.open['k' + c.id];
        var row = '<li><button class="crow" data-a="' + (c.x ? 'locked' : 'open') + '" data-v="k' + esc(c.id) + '" aria-expanded="' + open + '"><span class="grow"><span class="ct">' + esc(c.title) + '</span><span class="cl">' + esc(c.lead) + '</span></span>' +
          '<span class="m more" aria-hidden="true">' + (c.x ? lockMark() : (open ? '−' : '+')) + '</span></button>';
        if (open) {
          row += '<div class="detail"><ul class="facts">' + c.p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
            (c.v && c.v.length ? '<ul class="words mini">' + c.v.map(function (v) { return '<li><button class="w" lang="fr" data-a="word" data-v="' + esc(v[0]) + '">' + esc(v[0]) + '</button><span>' + esc(v[1]) + '</span></li>'; }).join('') + '</ul>' : '') +
            (c.s || []).filter(function (i) { return DB.src[i]; }).map(function (i) { return '<a class="small" href="' + esc(DB.src[i][1]) + '" target="_blank" rel="noopener">官方讲义：<span lang="fr">' + esc(DB.src[i][0]) + '</span> ↗</a>'; }).join('') + '</div>';
        }
        return row + '</li>';
      }).join('') + '</ul></section>';
    });
    if (!unlocked()) out += payBlock('解锁全部 ' + DB.cards.length + ' 张考点速记');
    return out + '</main>' + tabs('cards');
  }
  // 考前一页: the numbers, years and names worth a last look the night before (data/sheet.json). Free for everyone.
  var sheetWait = null, canPrint = typeof window.print === 'function' && !/MicroMessenger/i.test(navigator.userAgent);
  function loadSheet() {
    if (DB.sheet || sheetWait || ui.sheetFail) return;
    sheetWait = (window.CIVIQUE_SHEET ? Promise.resolve(window.CIVIQUE_SHEET) : getJson('data/sheet.json')).then(function (d) { DB.sheet = d; })
      .catch(function () { ui.sheetFail = true; }).then(function () { sheetWait = null; if (route() === 'sheet') render(); });
  }
  function vSheet() {
    loadSheet();
    var know = 0, situ = 0;
    THEMES.forEach(function (t) { know += t.k; situ += t.s; });
    var out = '<main class="wrap sheetpage">' + brand() + studyNav('sheet') +
      '<section class="stack sh-top"><h2>考前一页</h2><p class="sub">考前最后看一眼的数字、年份和人名，按官方题目清单和讲义整理。它只帮你记，不能代替做题。<a class="link" href="#home">去练题</a></p></section>' +
      '<ul class="sh-exam" aria-label="考试本身"><li><b>' + EXAM.n + '</b><span>题单选</span></li><li><b>' + EXAM.min + '</b><span>分钟</span></li>' +
      '<li class="pass"><b>' + EXAM.pass + '</b><span>题及格</span></li><li><b>' + know + '<i>+</i>' + situ + '</b><span>知识 + 情景</span></li></ul>';
    var d = DB.sheet;
    if (!d) return out + (ui.sheetFail ? '<p class="note warn">这一页没有加载出来，请检查网络后刷新页面。</p>' : '<p class="sub center">正在加载…</p>') + disclaimer() + '</main>' + tabs('cards');
    out += '<div class="sh-grid">' + d.groups.map(function (g) {
      return '<section class="sh-card' + (g.wide ? ' wide' : '') + '"><h3>' + esc(g.title) + '</h3><ul>' + g.items.map(function (it) {
        return '<li><b class="k' + (/^[\d约]/.test(it.k) ? ' n' : '') + (it.hl ? ' hl' : '') + '">' + esc(it.k) + '</b><span class="v">' + esc(it.v) + (it.fr ? ' <i lang="fr">' + esc(it.fr) + '</i>' : '') + '</span></li>';
      }).join('') + '</ul></section>';
    }).join('') + '</div>';
    if (d.rule) {
      out += '<section class="sh-rule" id="sh-rule"><h3>' + esc(d.rule.title) + '</h3><p>' + esc(d.rule.lead) + '</p><ol>' +
        d.rule.points.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol></section>';
    }
    out += '<p class="small sh-asof">整理于 ' + esc(d.asof) + '。' + (canPrint ? '<button class="link" data-a="print">打印或存成 PDF</button>' : '') + '</p>';
    return out + disclaimer() + '</main>' + tabs('cards');
  }
  function lockMark() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5.500" y="10.500" width="13" height="9" rx="2"/><path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500"/></svg>'; }
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
  function vRecall() {
    var out = '<main class="wrap">' + brand() + '<section class="stack"><h2>机经 · 考生回忆</h2>' +
      '<p class="sub">考过的人在网上分享的回忆，按考试时间整理。来源于网络，不是官方公布的题目，回忆可能有出入，仅供参考。</p></section>';
    if (!DB.recall.length) return out + '<p class="note">还没有收录。收集到考生的回忆后会更新在这里。</p></main>' + tabs('recall');
    var rc = recallIds(), hot = rc.ids.filter(function (id) { return rc.n[id] >= 2; });
    var can = rc.ids.filter(function (id) { return DB.byId[id]; });
    out += '<section class="hero"><div class="row between"><span class="sub">已收录</span><span class="tag">' + DB.recall.length + ' 场考试的回忆</span></div>' +
      '<div class="big">' + rc.ids.length + '<small> 道被回忆到的题</small></div>' +
      (hot.length ? '<p class="sub">其中 <span class="num">' + hot.length + '</span> 道被不同的人提到两次以上。</p>' : '') +
      (can.length ? '<button class="btn wide" data-a="start" data-v="all|recall">练这些题（每组最多 ' + SET + ' 题）</button>' : '') + '</section>';
    out += '<section class="stack"><h2>按考试时间</h2><ul class="qlist">';
    DB.recall.forEach(function (r, ri) {
      var ym = r.w.split('-'), key = 's' + ri, isOpen = sessOpen(ri);
      out += '<li><button class="crow" data-a="sess" data-v="' + ri + '" aria-expanded="' + isOpen + '"><span class="grow"><span class="ct">' + ym[0] + ' 年 ' + Number(ym[1]) + ' 月' + (LEVELS[r.l] ? ' · ' + LEVELS[r.l].zh : '') + '</span><span class="cl">回忆到 ' + r.i.length + ' 题' + (r.n ? ' · ' + esc(r.n) : '') + '</span></span><span class="m more" aria-hidden="true">' + (isOpen ? '−' : '+') + '</span></button>';
      if (!isOpen) { out += '</li>'; return; }
      out += '<ul class="qlist inner">' +
        r.i.map(function (x, i) {
          var tag = '<span class="tag' + (x.k === 's' ? ' blue' : '') + '">' + (x.k === 's' ? '情景题' : '知识题') + '</span>';
          if (x.r && DB.byId[x.r]) return reviewRow(DB.byId[x.r], i + 1, null, [0, 1, 2, 3], 'r' + ri + '-' + i);
          if (x.r) return '<li><button class="qrow" data-a="locked"><span class="i">' + (i + 1) + '</span><span class="s" lang="fr">' + esc(x.q) + '</span><span class="m more" aria-hidden="true">' + lockMark() + '</span></button></li>';
          return '<li><div class="qrow"><span class="i">' + (i + 1) + '</span><span class="s zhs">' + esc(x.x) + ' ' + tag + '</span><span class="m"></span></div></li>';
        }).join('') + '</ul></li>';
    });
    out += '</ul></section>';
    if (!unlocked()) out += payBlock('解锁后可以看每道题的讲解');
    return out + '</main>' + tabs('recall');
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
  function centreList() {
    if (ui.centresFail) return '<p class="note warn">考场名单没有加载出来。请检查网络后刷新，或直接到官方地图上查。</p>';
    if (!DB.centres) return '<p class="note">正在加载考场名单</p>';
    var f = findCentres();
    if (!f.q && !ui.geo) {
      return '<div class="chips">' + ['巴黎', '里昂', '马赛', '图卢兹', '尼斯', '斯特拉斯堡', '波尔多', '里尔', '南特', '蒙彼利埃'].map(function (c) {
        return '<button class="chip" data-a="cq" data-v="' + c + '">' + c + '</button>';
      }).join('') + '</div>';
    }
    if (!f.list.length) {
      return '<p class="note">' + (f.dep ? esc(f.dep + (DEPTS[f.dep] ? ' ' + DEPTS[f.dep] : '')) + ' 省' : '“' + esc(ui.cq) + '”') + '在这份名单里没有考场。可以试试邻近的省号，或者点“用我的位置”找最近的；另一家机构的考场见下面。</p>';
    }
    var max = ui.cmore ? f.list.length : 8, shown = f.list.slice(0, max);
    var head = (f.q ? '找到 ' + f.list.length + ' 个考场' : '离你最近的考场') + (ui.geo && f.q ? '，按距离排列' : '');
    return '<p class="sub" id="ccount">' + head + '</p><ul class="centres">' + shown.map(function (x) {
      var c = x.c, addr = (c.street ? c.street + ', ' : '') + c.cp + ' ' + c.city;
      return '<li class="centre"><div class="row between"><b class="cn" lang="fr">' + esc(c.name) + '</b>' + (x.km != null ? '<span class="tag blue">约 ' + (x.km < 10 ? Math.round(x.km * 10) / 10 : Math.round(x.km)) + ' 公里</span>' : '') + '</div>' +
        '<p class="ca" lang="fr">' + esc(addr) + '</p><p class="cd">' + esc(c.dep) + (DEPTS[c.dep] ? ' <span lang="fr">' + esc(DEPTS[c.dep]) + '</span>' : '') + '</p><div class="clinks">' +
        (c.tel ? '<a href="tel:' + esc(c.tel.split('/')[0].replace(/[^\d+]/g, '')) + '">' + esc(c.tel) + '</a>' : '') +
        (c.web ? '<a href="' + esc(c.web) + '" target="_blank" rel="noopener">考场网站 ↗</a>' : '') +
        '<a href="https://www.google.com/maps/search/?api=1&amp;query=' + encodeURIComponent(c.name + ', ' + addr) + '" target="_blank" rel="noopener">地图 ↗</a></div></li>';
    }).join('') + '</ul>' + (f.list.length > max ? '<button class="btn quiet wide" data-a="cmore">显示其余 ' + (f.list.length - max) + ' 个</button>' : '');
  }
  function vRegister() {
    loadCentres();
    var lv = LEVELS[S.target] ? S.target : '', cci = 'https://francais.cci-paris-idf.fr/candidat?produit=' + (CCI_PRODUCT[lv] || 21);
    var out = '<main class="wrap">' + brand() + '<section class="stack"><h2>报名考试 · 全流程</h2>' +
      '<p class="sub">从报名到拿到通过证明的每一步。本站只帮你找到入口：报名和交费都在官方机构的网站上完成，本站不代办、不收报名费。</p>' +
      '<ol class="steps">' +
      '<li><b>确认考哪一种</b><p>考试分三种：多年居留卡、十年居留卡、入籍。报名时要选对' + (lv ? '，你在首页选的是「' + LEVELS[lv].zh + '」' : '') + '。选错了，证明可能不能用于你的申请。</p></li>' +
      '<li><b>准备好这几样</b><p>有效的居留证；居留证上的外国人号码（<span lang="fr">numéro étranger / AGDREF</span>）；一个常用邮箱（账号、通知和成绩都发到这里，记得看垃圾邮件箱）。</p></li>' +
      '<li><b>选考场，在官网报名</b><p>全法有两家官方指定的考试机构，任选一家，考试内容相同。费用由各考场自己定，每个考场不一样，报名前先问清楚。</p>' +
      '<ul class="facts"><li><span lang="fr">France Éducation International</span>：官方建议先联系想去的考场，确认场次和费用，再填预报名表；提交后会收到一封邮件，用来创建考生账号。<br><a class="link" href="https://test-civique.fr/inscription" target="_blank" rel="noopener">去填官方预报名表 ↗</a></li>' +
      '<li>巴黎工商会（<span lang="fr">CCI Paris Île-de-France</span>）：在它的网站上按城市查场次，直接在线报名。<br><a class="link" href="' + cci + '" target="_blank" rel="noopener">去查场次并报名 ↗</a></li></ul></li>' +
      '<li><b>考试当天</b><p>按准考通知（<span lang="fr">convocation</span>）上的时间到场，带上居留证和准考通知。迟到不能进考场。现场会核对身份、拍照、签名，请当场确认姓名和出生日期没有写错，这些会印在证明上。手机要关机，不能带资料和草稿纸，中途不能离场。</p></li>' +
      '<li><b>查成绩，下载证明</b><p>成绩在考后一到两天内出来（一家是 12 小时内在考生账号里查看，另一家是 24 到 48 个工作小时内发邮件）。证明是电子版，没有纸质的，长期有效，下载后自己保存好。</p></li>' +
      '<li><b>没通过怎么办</b><p>可以再报名，次数不限。答对 32 题才算通过，建议模拟考试稳定在 35 题以上再去。</p><a class="link" href="#exam">去做一次模拟考试</a></li>' +
      '<li><b>提交证明</b><p>办理居留卡或入籍时，把这份通过证明和其他材料一起提交。</p></li></ol></section>';
    out += '<section class="stack"><h2>找考场</h2>' +
      '<p class="sub"><span lang="fr">France Éducation International</span> 认可的考场' + (DB.centres ? '，法国境内共 <span class="num">' + DB.centres.length + '</span> 个' : '') + '。</p>' +
      '<form id="cform" class="field"><input id="cq" class="plain" name="cq" type="search" autocomplete="off" spellcheck="false" placeholder="城市、省号或邮编，如 里昂 / 69" aria-label="城市、省号或邮编" maxlength="40" value="' + esc(ui.cq || '') + '"></form>' +
      '<button class="btn ghost wide" data-a="geo"' + (ui.geoBusy ? ' disabled' : '') + '>' + (ui.geoBusy ? '正在定位' : ui.geo ? '已按你的位置排序 · 重新定位' : '用我的位置找最近的') + '</button>' +
      (ui.geoMsg ? '<p class="msg bad" role="status">' + esc(ui.geoMsg) + '</p>' : '') +
      '<div id="clist" class="stack">' + centreList() + '</div>' +
      '<p class="small">位置只在你的手机上用来计算距离，不会上传。距离是直线距离。名单取自 France Éducation International 官网' + (DB.centresAsOf ? '（' + DB.centresAsOf + '）' : '') + '，考场会增减，以<a href="https://www.france-education-international.fr/centres-d-examen/carte?type-centre=examen_civique" target="_blank" rel="noopener">官方地图 ↗</a>为准。巴黎工商会的考场不在这份名单里，请在<a href="' + cci + '" target="_blank" rel="noopener">它的网站 ↗</a>上按城市查。</p></section>';
    return out + disclaimer() + '</main>' + tabs('register');
  }
  function vAbout() {
    var out = '<main class="wrap">' + brand() + '<section class="stack"><h2>关于公民考试</h2><ul class="facts">' +
      '<li>从 2026 年 1 月 1 日起，第一次申请多年居留卡（<span lang="fr">carte de séjour pluriannuelle</span>）或十年居留卡（<span lang="fr">carte de résident</span>）要提交公民考试（<span lang="fr">examen civique</span>）的通过证明。续签不需要。</li>' +
      '<li>考试是 40 道法语单选题，每题 4 个选项，只有 1 个正确。其中 28 题是知识题，12 题是情景题。</li>' +
      '<li>在平板或电脑上作答，最长 45 分钟。答对 32 题（80%）通过。</li>' +
      '<li>可以随时报名，没通过可以再考，次数不限。通过证明长期有效。</li>' +
      '<li>十年居留卡的通过证明，申请多年居留卡时同样有效。</li>' +
      '<li>申请入籍（<span lang="fr">naturalisation par décret</span>）也要通过公民考试，形式相同（40 题、45 分钟、32 题及格），题目清单另有一套。通过结婚等方式以声明取得国籍的不用考。</li>' +
      '<li>65 岁以上的人不用考。因残疾或健康原因确实无法参加的，可以凭医生证明申请调整考试方式或免考。</li>' +
      '<li>不是所有类别的居留卡都要求考试，例如不需要签署融入合同（<span lang="fr">CIR</span>）的类别就不用。自己属于哪种情况，请看下面 service-public 的页面。</li>' +
      '<li>考试中作弊会被禁考两年。</li></ul>' +
      '<p class="small">以上内容整理自法国内政部和 service-public.gouv.fr 的官方页面，规定可能调整，办理前请以官方页面为准。</p></section>';
    out += '<section class="stack"><h2>官方入口</h2><ul class="facts">' +
      '<li><a href="https://formation-civique.interieur.gouv.fr/examen-civique/" target="_blank" rel="noopener">内政部：考试说明、官方题目清单和讲义（免费）↗</a></li>' +
      '<li><a href="https://www.service-public.gouv.fr/particuliers/vosdroits/F39530" target="_blank" rel="noopener">service-public：居留卡谁需要考、怎么报名 ↗</a></li>' +
      '<li><a href="https://www.service-public.gouv.fr/particuliers/vosdroits/F39426" target="_blank" rel="noopener">service-public：入籍的公民考试 ↗</a></li>' +
      '<li><a href="#register">报名流程和考场查询（本站整理）</a></li>' +
      '<li><a href="https://francais.cci-paris-idf.fr/candidat?produit=21" target="_blank" rel="noopener">考试机构一：巴黎工商会（CCI Paris Île-de-France）↗</a></li>' +
      '<li><a href="https://test-civique.fr/inscription" target="_blank" rel="noopener">考试机构二：France Éducation International 报名 ↗</a></li></ul>' +
      '<p class="small">报名、考点和费用以两家考试机构的网站为准。</p></section>';
    out += '<section class="stack"><h2>这个题库是什么</h2><ul class="facts">' +
      '<li>知识题的题干是内政部公布的官方题目。官方没有公布选项，本站的选项、中文翻译和讲解是自己编写的，并对照官方讲义核对。</li>' +
      '<li>情景题官方没有公布，本站的情景题是按官方讲义编写的练习题，用来熟悉题型。</li>' +
      '<li>正式考试的选项措辞会和这里不同。把知识点弄懂，比背选项有用。</li>' +
      '<li>发现错误请告诉我们' + (CFG.contact ? '：' + esc(CFG.contact) : '') + '，核实后会更正。</li>' +
      '<li>练习记录只保存在你这台设备上，本站不要求注册，不收集个人信息。</li></ul>' +
      bankLine() + (CFG.seller ? '<p class="small">经营者：' + esc(CFG.seller) + '</p>' : '') + '</section>';
    out += '<section class="stack"><h2>设置</h2>' +
      '<div class="row between"><span>题库</span><span class="row">' + (unlocked() ? '<span class="tag blue">已解锁</span>' : '<a class="link" href="#unlock">输入解锁码</a>') + '</span></div>' +
      '<div class="row between"><span>练习记录</span><button class="link" data-a="reset">清空全部记录</button></div></section>';
    return out + (DB.free ? disclaimer() : '') + '</main>' + tabs('about');
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
  function vUnlock() {
    ping('paywall');
    var out = '<main class="wrap">' + brand();
    if (unlocked()) {
      return out + '<section class="stack"><h2 class="offer-h">已解锁全部题目</h2>' + (ui.msg ? '<p class="msg ok">' + esc(ui.msg.text) + '</p>' : '') +
        '<div class="offer-code"><span class="sub">你的解锁码</span><b class="code">' + esc(S.unlock ? S.unlock.code : '') + '</b><span class="small">建议现在截图保存。</span></div>' +
        '<p class="small">这台设备已经解锁。换手机或换浏览器时，输入同一个解锁码即可' + (CFG.api ? '，也可以用付款时的邮箱找回' : '') + '。</p>' +
        '<a class="btn wide" href="#home">回首页</a></section>' + bankLine() + '</main>' + tabs('home');
    }
    var d = offerData(), at = ui.msg ? (ui.msg.at || 'code') : '';
    var names = levelIds().map(function (lv) { return LEVELS[lv].zh; }).join('、');
    var others = levelIds().filter(function (lv) { return lv !== d.lv; }).map(function (lv) { return LEVELS[lv].short; }).join('、');
    function msg(where) { return '<p class="msg ' + (at === where ? (ui.msg.ok ? 'ok' : 'bad') : '') + '" role="status">' + (at === where ? esc(ui.msg.text) : '') + '</p>'; }
    function cell(n, unit, more) { return (n === '' ? '' : '<b>' + n + '</b>') + '<span>' + unit + '</span>' + (more ? '<small>' + more + '</small>' : ''); }
    function row(name, free, paid) { return '<tr><th scope="row">' + name + '</th><td>' + free + '</td><td class="on">' + paid + '</td></tr>'; }
    if (S.pending || at === 'pay') out += '<section class="stack"><h2>' + (S.pending ? '正在确认你的付款' : '付款没有确认') + '</h2>' + msg('pay') +
      (S.pending ? '<button class="btn wide" data-a="pay-retry"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? '确认中' : '重新确认') + '</button>' : '') + '</section>';

    // 1. the offer and its price
    out += '<section class="offer"><p class="offer-eye">解锁全部内容</p>' +
      '<h2 class="offer-h"><span>全部 <span class="num">' + DB.free.meta.total + '</span> 题，</span><span>每题都有中文翻译和讲解</span></h2>' +
      '<p class="sub">' + names + '的题库都包含。</p>' +
      '<div class="offer-price"><span class="price"><b>' + esc(CFG.price || '') + '</b></span>' +
      '<p class="offer-terms"><b>一次性付款</b>不是订阅，不会自动续费。想用多久用多久，题目更正和补充不再收费。</p></div>' +
      (CFG.payUrl ? buyButton(payHref(), '去付款') +
        '<div class="offer-after"><h3>付款之后</h3><ol>' +
        '<li>自动回到本站，全部题目马上解锁。</li>' +
        '<li>同时给你一个解锁码，换手机或换浏览器时输入。</li>' +
        (CFG.api ? '<li>解锁码找不到了，可以用付款时的邮箱找回。</li>' : '') + '</ol></div>' +
        '<p class="small">支持银行卡等方式，付款页面由 Stripe 提供，本站不接触你的卡号。</p>'
        : '<p class="small">' + (CFG.contact ? '购买请联系：' + esc(CFG.contact) + '。付款后会收到一个解锁码。' : '付款后会收到一个解锁码，填在下面即可。') + '</p>') +
      '</section>';

    // 2. free trial next to the unlocked bank
    out += '<section class="stack"><h2>免费试用和解锁后的区别</h2><table class="cmp"><thead><tr><td></td><th scope="col">免费试用</th><th scope="col" class="on">解锁后</th></tr></thead><tbody>' +
      row('题目' + (d.lv ? '<small>' + LEVELS[d.lv].short + '</small>' : ''), cell(d.free, '题', '翻译和讲解都有'),
        '<b class="key">' + d.total + '</b><span>题</span><small>' + (d.lv ? '知识题 ' + d.know + '，情景题 ' + d.situ : '三种考试合计，逐题翻译和讲解') + '</small>') +
      (d.lv && others ? row('其他类型', cell('', '同样可以试用'), cell('', others + '的题库也包含')) : '') +
      (d.cards ? row('考点速记', cell(d.cardsFree, '张'), cell(d.cards, '张', '中文要点，对照官方讲义')) : '') +
      row('模拟考试', cell(MINI.n, '题', '试考，' + MINI.min + ' 分钟'), cell(EXAM.n, '题', '完整模考，' + EXAM.min + ' 分钟，' + EXAM.pass + ' 题及格，可以反复考')) +
      (d.recall ? row('机经讲解', cell(d.recallFree, '道'), cell(d.recall, '道', '考生回忆到的题，逐题讲解')) : '') +
      row('错题本', cell('', '只收免费题的错题'), cell('', '收全部题目的错题')) +
      row('生词表', cell(d.words, '个词'), cell('', '全部题目的生词')) +
      '</tbody></table></section>';

    // 3. what one question looks like
    var sq = offerSample(d.lv);
    if (sq) out += '<section class="stack"><h2>每道题都是这样讲的</h2><p class="sub">这是免费题里的一道知识题：法语原题、中文翻译、讲解和生词。解锁后的每道题都是同样的格式。</p>' +
      '<div class="offer-sample"><span class="offer-stamp">示例</span>' + question(sq, { perm: [2, 0, 3, 1], mode: 'show' }) + '</div>' +
      (CFG.payUrl ? buyButton(payHref(), '解锁全部') : '') +
      '</section>';

    // 4. for people who already paid
    out += '<hr class="hr"><section class="stack offer-have"><h2>已经有解锁码</h2><form id="codeform" class="stack"><div class="field"><input id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="例如 ABCD-2345-EFGH" aria-label="解锁码" maxlength="20"><button class="btn" type="submit"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? '解锁中' : '解锁') + '</button></div>' +
      msg('code') + '</form></section>';
    if (CFG.api) out += '<section class="stack offer-have"><h2>找回解锁码</h2><p class="small">付过款，但换了手机或找不到解锁码：填付款时用的邮箱。</p><form id="mailform" class="stack"><div class="field"><input id="mail" class="plain" name="mail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="付款时填写的邮箱" aria-label="付款邮箱" maxlength="120"><button class="btn" type="submit"' + (ui.busy ? ' disabled' : '') + '>找回</button></div>' + msg('mail') + '</form></section>';
    out += '<section class="offer-honest"><h2>不付款也可以备考</h2><p>官方的备考资料是免费的，不付款也可以在内政部网站上看到全部法语题目和讲义。这里收费的是中文翻译、讲解和练习工具。免费试用部分开放 ' + d.free + ' 题，可以先试再决定。</p></section>' + bankLine();
    return out + '</main>' + tabs('home');
  }

  // ---------------------------------------------------------------- routing + render
  var VIEWS = { home: vHome, quiz: vQuiz, exam: vExam, result: vResult, mistakes: vMistakes, words: vWords, cards: vCards, sheet: vSheet, recall: vRecall, register: vRegister, about: vAbout, unlock: vUnlock };
  function route() { var h = (location.hash || '').replace(/^#/, ''); return VIEWS[h] ? h : 'home'; }
  function go(name) { if (route() === name) render(true); else location.hash = name; }
  function render(top) {
    if (!DB.free) return;               // still loading: the first render comes when the questions are in
    var r = route();
    if (S.exam && r !== 'exam') { location.hash = 'exam'; return; }
    if (r === 'quiz' && !S.sess) { location.hash = 'home'; return; }
    closeWord();
    app.innerHTML = VIEWS[r]() + modal();
    if (top) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () { hush(); ui.modal = null; if (route() !== 'unlock') ui.msg = null; render(true); });

  setInterval(function () {
    if (!S.exam) return;
    var left = examLeft();
    if (left <= 0) { finishExam(); ui.modal = null; go('result'); return; }
    var el = document.getElementById('timer');
    if (el) { el.textContent = mmss(left); el.className = 'timer' + (left < 300 ? ' low' : ''); }
  }, 1000);

  // ---------------------------------------------------------------- actions
  var ACT = {
    target: function (v) { if (!LEVELS[v]) return; if (S.target !== v) { S.target = v; S.sess = null; } save(); render(); },
    goto: function (v) { ui.modal = null; go(v); },
    close: function () { ui.modal = null; render(); },
    print: function () { window.print(); },
    locked: function () {
      ui.modal = { title: '这部分需要解锁', body: '<p>解锁后可以看全部题目的讲解、全部考点速记和完整模拟考试。</p>', actions: [{ label: '去解锁', a: 'goto', v: 'unlock' }, { label: '关闭', a: 'close', cls: 'quiet' }] };
      render();
    },
    veil: function (v, el, ev) { if (ev.target === el) { ui.modal = null; render(); } },
    theme: function (v) { themeSheet(v); render(); },
    'continue': function () {
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
      ui.modal = null;
      if (startPractice(p[0], p[1])) go('quiz'); else render();
    },
    restart: function (v) {
      ui.modal = { title: '清空「' + theme(v).zh + '」的记录？', body: '<p>这个主题的练习记录和错题会被清空，其他主题不受影响。</p>', actions: [{ label: '清空并从头练', a: 'restart-yes', v: v }, { label: '取消', a: 'close', cls: 'quiet' }] };
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
      s.ans[id] = Number(v); record(id, Number(v) === 0); save();
      if (before < 10 && answeredCount() >= 10) ping('ten_answers');
      hush(); render();
      var card = document.querySelector('.copy');
      if (card && card.scrollIntoView) { try { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { card.scrollIntoView(false); } }
    },
    zh: function () { S.zhOn = !S.zhOn; save(); render(); },
    say: function (v) {
      if (v && DB.byId[v]) return speak(DB.byId[v].q);      // in lists: the question only
      var q = null, perm = null;
      if (route() === 'quiz' && S.sess) { var id = S.sess.ids[S.sess.i]; q = DB.byId[id]; perm = permFor(S.sess, id); }
      if (!q) return;
      speak(q.q + ' ... ' + perm.map(function (orig, pos) { return LETTERS[pos] + '. ' + q.o[orig]; }).join(' ... '));
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
      ui.modal = { title: '确定交卷？', body: '<p>' + (miss ? '还有 <b class="num">' + miss + '</b> 题没有作答，没答的题按答错计算。' : '全部题目都已作答。') + '剩余时间 <span class="num">' + mmss(examLeft()) + '</span>。</p>', actions: [{ label: '交卷', a: 'exam-submit-yes' }, { label: '继续答题', a: 'close', cls: 'quiet' }] };
      render();
    },
    'exam-submit-yes': function () { finishExam(); ui.modal = null; go('result'); },
    'exam-quit': function () {
      ui.modal = { title: '放弃这次考试？', body: '<p>这次的作答不会保存，也不计入成绩。</p>', actions: [{ label: '放弃考试', a: 'exam-quit-yes', cls: 'ghost' }, { label: '继续答题', a: 'close' }] };
      render();
    },
    'exam-quit-yes': function () { S.exam = null; ui.modal = null; save(); render(true); },
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
    'result-show': function (v) { ui.resultIdx = Number(v); ui.open = {}; go('result'); },
    open: function (v) { ui.open[v] = !ui.open[v]; render(); },
    sess: function (v) { ui.open['s' + v] = !sessOpen(Number(v)); render(); },
    reset: function () {
      ui.modal = { title: '清空全部练习记录？', body: '<p>练习进度、错题本和模拟考试成绩都会被清空。解锁状态不受影响。</p>', actions: [{ label: '清空', a: 'reset-yes', cls: 'ghost' }, { label: '取消', a: 'close' }] };
      render();
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
    'reset-yes': function () { S.stats = {}; S.exams = []; S.sess = null; S.exam = null; ui.modal = null; save(); render(true); }
  };
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-a]') : null;
    if (!el || el.disabled) return;
    var a = el.getAttribute('data-a');
    if (!ACT[a]) return;
    ev.preventDefault();
    ACT[a](el.getAttribute('data-v'), el, ev);
  });
  document.addEventListener('input', function (ev) {
    if (ev.target.id !== 'cq') return;
    ui.cq = ev.target.value; ui.cmore = false;
    var box = document.getElementById('clist'); if (box) box.innerHTML = centreList();
  });
  document.addEventListener('submit', function (ev) {
    if (ev.target.id === 'cform') { ev.preventDefault(); var cq = document.getElementById('cq'); if (cq) cq.blur(); return; }
    if (ev.target.id === 'mailform') {
      ev.preventDefault();
      if (ui.busy) return;
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
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ui.modal) { ui.modal = null; render(); } });

  // ---------------------------------------------------------------- start
  function fonts() {
    ['Atkinson+Hyperlegible+Next:wght@400;600;700', 'Atkinson+Hyperlegible+Mono:wght@500;700'].forEach(function (f) {
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
  loadFree().then(function () {
    if (S.target && !DB.free.meta.counts[S.target]) { S.target = ''; S.sess = null; S.exam = null; }
  }).then(restoreUnlock).then(codeFromUrl).then(paidFromUrl).then(function () {
    sanitize(); save(); render(true);
  }).catch(function () {
    app.innerHTML = '<main class="wrap"><h1>公民考试中文题库</h1><p class="note warn">题目没有加载出来。请检查网络后刷新页面。</p></main>';
  });
})();
