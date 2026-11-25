// The seller's admin page: who uses the site and how far they are, who sent whom, and corrections to the bank.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var TOKEN = '', USERS = [], QS = [], BY = {}, FREE = {}, PATCHES = {}, ORIG = {};
  var THEMES = [['principes', '共和国的原则与价值'], ['institutions', '制度与政治体系'], ['droits', '权利与义务'], ['histoire', '历史、地理与文化'], ['societe', '在法国社会生活']];
  var LEVELS = { csp: '多年卡', cr: '十年卡', nat: '入籍' };
  var LETTERS = ['A（正确答案）', 'B', 'C', 'D'];

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'cls') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function td(text, cls) { return el('td', { text: text === null || text === undefined ? '' : String(text), cls: cls || '' }); }
  function say(text, ok) { $('msg').textContent = text || ''; $('msg').className = ok ? 'ok' : ''; }
  function api(op, more) {
    return fetch('/api/admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ token: TOKEN, op: op }, more || {})) })
      .then(function (r) { return r.json().catch(function () { return { error: 'server' }; }); }, function () { return { error: 'network' }; })
      .then(function (d) { if (d.error === 'expired' || (d.error === 'forbidden' && TOKEN)) signOut('登录已过期，请重新输入密码。'); return d; });
  }
  function why(e) {
    return e === 'forbidden' ? '密码不对。' : e === 'otp_required' ? '请输入谷歌验证器里的 6 位数字。' : e === 'bad_otp' ? '验证器的数字不对或已过期，等它换下一组再试。' : e === 'expired' ? '登录已过期，请重新输入密码。' : e === 'locked' ? '输错次数太多，后台已暂时锁住，15 分钟后再试。' : e === 'not_configured' ? '还没设置管理密码。' : e === 'no_database' ? '数据库还没接上。' : e === 'network' ? '网络不通，稍后再试。' : '出错了，稍后再试。';
  }
  function when(ms) {
    if (!ms) return '';
    var d = Date.now() - ms, m = Math.round(d / 60000);
    if (m < 2) return '刚刚'; if (m < 60) return m + ' 分钟前'; if (m < 60 * 24) return Math.round(m / 60) + ' 小时前'; if (m < 60 * 24 * 30) return Math.round(m / 1440) + ' 天前';
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date(ms));
  }
  function full(ms) { return ms ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms)) : ''; }
  function isPaid(u) { return u.id.slice(0, 2) === 'b:' || !!u.unlocked; }
  function who(u) {
    var kind = u.id.slice(0, 2);
    if (kind === 'b:') return (u.email || u.login || '付费用户 ' + u.id.slice(2, 6)) + (u.login && u.email && u.login !== u.email ? '（登录：' + u.login + '）' : '');
    return kind === 'u:' ? (u.login || u.id.slice(2)) : '访客 ' + u.id.slice(2, 8);
  }
  function kindOf(u) { return isPaid(u) ? '付费' : (u.id.slice(0, 2) === 'u:' ? '已登录' : '访客'); }
  function place(u) { return [u.city, u.country].filter(Boolean).join(', '); }

  // ---------------------------------------------------------------- users
  function drawUsers() {
    var q = $('uq').value.trim().toLowerCase(), f = $('uf').value, week = Date.now() - 7 * 864e5, day = Date.now() - 864e5;
    var list = USERS.filter(function (u) {
      if (f === 'paid' && !isPaid(u)) return false;
      if (f === 'free' && isPaid(u)) return false;
      if (f === 'anon' && u.id.slice(0, 2) !== 'v:') return false;
      return !q || [who(u), u.id, u.login, u.email, u.city, u.country, u.ref].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    $('usum').innerHTML = '';
    [[USERS.length, '人用过'], [USERS.filter(function (u) { return u.id.slice(0, 2) !== 'v:'; }).length, '已登录或付费'], [USERS.filter(isPaid).length, '已付费'], [USERS.filter(function (u) { return u.last_seen > day; }).length, '24 小时内在用'], [USERS.filter(function (u) { return u.last_seen > week; }).length, '7 天内在用']]
      .forEach(function (x) { $('usum').appendChild(el('div', {}, [el('b', { text: x[0] }), x[1]])); });
    $('ulist').innerHTML = '';
    list.slice(0, 500).forEach(function (u) {
      var s = u.sum || {}, tr = el('tr', { cls: 'pick' });
      var name = td(''); name.appendChild(el('span', { cls: 'tag' + (isPaid(u) ? ' paid' : ''), text: kindOf(u) })); name.appendChild(document.createTextNode(' ' + who(u)));
      tr.appendChild(name); tr.appendChild(td(u.ref || '—')); tr.appendChild(td(place(u))); tr.appendChild(td(when(u.last_seen))); tr.appendChild(td(u.days || 0, 'n'));
      tr.appendChild(td((LEVELS[u.level] || '') + (u.exam_date ? ' · ' + u.exam_date : '')));
      tr.appendChild(td(s.seen ? s.seen + ' / ' + (s.pool || '?') : '0', 'n')); tr.appendChild(td(s.ok || 0, 'n')); tr.appendChild(td(s.miss || 0, 'n'));
      tr.appendChild(td(s.best ? s.best + ' / ' + s.bestN : '—', 'n'));
      tr.addEventListener('click', function () { openUser(u.id); });
      $('ulist').appendChild(tr);
    });
    if (!list.length) { var tr = el('tr'); var c = td(USERS.length ? '没有符合的用户' : '还没有人用过'); c.colSpan = 10; tr.appendChild(c); $('ulist').appendChild(tr); }
    drawRefs();
  }
  var REFS = [], SALES = null;
  function money(c) { return (c / 100).toFixed(2).replace('.', ',') + ' €'; }
  function linkOf(code) { return location.origin + '/?r=' + code; }
  function copy(text, btn) {
    try { navigator.clipboard.writeText(text).then(function () { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1500); }, function () { say('复制不了，请手动选中链接。'); }); }
    catch (e) { say('复制不了，请手动选中链接。'); }
  }
  function drawRefs() {
    var by = {}, week = Date.now() - 7 * 864e5;
    function g(k) { return by[k] || (by[k] = { ref: k, n: 0, paid: 0, live: 0, orders: 0, amount: 0 }); }
    REFS.forEach(function (r) { var x = g(r.code); x.name = r.name; x.pct = r.pct; x.known = true; x.created = r.created; });
    USERS.forEach(function (u) { var x = g(u.ref || ''); x.n++; if (isPaid(u)) x.paid++; if (u.last_seen > week) x.live++; });
    (SALES || []).forEach(function (s) { var x = g(s.ref || ''); x.orders++; x.amount += s.amount; });
    var list = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return (a.ref === '') - (b.ref === '') || (!!b.known - !!a.known) || (b.created || 0) - (a.created || 0) || b.n - a.n; });
    $('rlist').innerHTML = '';
    list.forEach(function (x) {
      var tr = el('tr'), name = td('');
      if (x.ref === '') name.textContent = '官网直接来的（没有推荐人）';
      else { name.appendChild(el('b', { text: x.name || x.ref })); if (!x.known) name.appendChild(el('span', { cls: 'tag', text: '未登记' })); name.appendChild(el('div', { cls: 'small', text: '代号 ' + x.ref })); }
      tr.appendChild(name);
      var link = td('');
      if (x.ref) { var b = el('button', { type: 'button', cls: 'plain', text: '复制' }); b.style.padding = '3px 9px'; b.addEventListener('click', function () { copy(linkOf(x.ref), b); }); link.appendChild(b); }
      tr.appendChild(link);
      tr.appendChild(td(x.n, 'n')); tr.appendChild(td(x.paid, 'n')); tr.appendChild(td(x.live, 'n'));
      tr.appendChild(td(SALES ? x.orders : '—', 'n')); tr.appendChild(td(SALES ? money(x.amount) : '—', 'n'));
      tr.appendChild(td(SALES && x.known ? money(Math.round(x.amount * (x.pct || 0) / 100)) + '（' + (x.pct || 0) + '%）' : '—', 'n'));
      var ops = td('');
      if (x.known) {
        var del = el('button', { type: 'button', cls: 'danger', text: '移除' }); del.style.padding = '3px 9px';
        del.addEventListener('click', function () {
          if (del.getAttribute('data-sure') !== '1') { del.setAttribute('data-sure', '1'); del.textContent = '确认移除'; return; }
          api('ref-del', { code: x.ref }).then(function (r) { if (!r.ok) return say(why(r.error)); say('已从名单移除。这条链接带来的人和订单仍然记着。', true); loadRefs(); });
        });
        ops.appendChild(del);
      }
      tr.appendChild(ops); $('rlist').appendChild(tr);
    });
  }
  function loadRefs() {
    return api('refs').then(function (d) { if (d.ok) REFS = d.refs || []; drawRefs(); });
  }
  function loadSales() {
    return fetch('/api/sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) })
      .then(function (r) { return r.json(); }).then(function (d) { if (d && d.ok) { SALES = d.sales || []; drawRefs(); } }, function () { /* the list still shows visitors */ });
  }
  function openUser(id) {
    var box = $('udetail');
    box.innerHTML = ''; box.appendChild(el('p', { cls: 'small', text: '读取中…' }));
    api('user', { id: id }).then(function (d) {
      box.innerHTML = '';
      if (!d.ok) { box.appendChild(el('p', { text: why(d.error) })); return; }
      var u = d.user, st = u.state || { stats: {}, exams: [], days: {} }, s = u.sum || {};
      var card = el('div', { cls: 'card' });
      card.appendChild(el('h2', { text: who(u) }));
      card.appendChild(el('p', { cls: 'small', text: [isPaid(u) ? '已付费' + (u.paid_at ? '（' + full(u.paid_at) + '）' : '') : '未付费', '推荐人：' + (u.ref || '无'), '地点：' + (place(u) || '未知'),
        '第一次来：' + full(u.created), '最近使用：' + full(u.last_seen), '用了 ' + (d.days.length) + ' 天', '考试类型：' + (LEVELS[u.level] || '未选') + (u.exam_date ? '，考试日期 ' + u.exam_date : '')].join(' · ') }));
      card.appendChild(el('p', { cls: 'small', text: '设备：' + (u.ua || '') }));

      card.appendChild(el('h3', { text: '各主题掌握情况' }));
      var tb = el('tbody');
      THEMES.forEach(function (t) {
        var pool = QS.filter(function (q) { return q.t === t[0] && (!u.level || (q.l || []).indexOf(u.level) >= 0); });
        var seen = 0, ok = 0, miss = 0;
        pool.forEach(function (q) { var r = st.stats[q.id]; if (!r) return; seen++; if (r[2] === 1) ok++; if (r[3] > 0) miss++; });
        var tr = el('tr'); tr.appendChild(td(t[1]));
        var b = td(''); var bar = el('div', { cls: 'bar' }); var i = el('i'); i.style.width = (pool.length ? Math.round(100 * ok / pool.length) : 0) + '%'; bar.appendChild(i); b.appendChild(bar); tr.appendChild(b);
        tr.appendChild(td(ok + ' / ' + pool.length, 'n')); tr.appendChild(td(seen, 'n')); tr.appendChild(td(miss, 'n'));
        tb.appendChild(tr);
      });
      card.appendChild(el('div', { cls: 'scroll' }, [el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: '主题' }), el('th', { text: '掌握' }), el('th', { text: '掌握 / 总数', cls: 'n' }), el('th', { text: '做过', cls: 'n' }), el('th', { text: '还在错题本', cls: 'n' })])]), tb])]));

      card.appendChild(el('h3', { text: '没学明白的题（错得最多的排前面）' }));
      var weak = Object.keys(st.stats).map(function (qid) { var r = st.stats[qid]; return { id: qid, seen: r[0] || 0, wrong: (r[0] || 0) - (r[1] || 0), open: r[3] > 0, last: r[2] === 1 }; })
        .filter(function (x) { return x.wrong > 0; }).sort(function (a, b) { return (b.open - a.open) || (b.wrong - a.wrong); }).slice(0, 40);
      if (!weak.length) card.appendChild(el('p', { cls: 'small', text: '还没有做错过的题。' }));
      else {
        var wb = el('tbody');
        weak.forEach(function (x) {
          var q = BY[x.id], tr = el('tr');
          tr.appendChild(td(x.id));
          var c = td('', 'wrap'); c.appendChild(el('div', { cls: 'fr', text: q ? q.q : '（题库里没有这道题）' })); if (q) c.appendChild(el('div', { cls: 'small', text: q.qz })); tr.appendChild(c);
          tr.appendChild(td(x.wrong + ' / ' + x.seen, 'n')); tr.appendChild(td(x.open ? '还没过' : (x.last ? '后来做对了' : '')));
          wb.appendChild(tr);
        });
        card.appendChild(el('div', { cls: 'scroll' }, [el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: '题号' }), el('th', { text: '题目' }), el('th', { text: '错 / 做', cls: 'n' }), el('th', { text: '现在' })])]), wb])]));
      }

      card.appendChild(el('h3', { text: '模拟考试' }));
      if (!st.exams.length) card.appendChild(el('p', { cls: 'small', text: '还没考过。' }));
      else {
        var eb = el('tbody');
        st.exams.forEach(function (e) { var tr = el('tr'); tr.appendChild(td(full(e.ts))); tr.appendChild(td(e.mini ? '试考' : '完整模考')); tr.appendChild(td(e.score + ' / ' + e.n, 'n')); tr.appendChild(td(e.score >= e.passAt ? '通过' : '没过')); tr.appendChild(td(Math.round(e.secs / 60) + ' 分钟', 'n')); eb.appendChild(tr); });
        card.appendChild(el('div', { cls: 'scroll' }, [el('table', {}, [el('thead', {}, [el('tr', {}, [el('th', { text: '时间' }), el('th', { text: '类型' }), el('th', { text: '成绩', cls: 'n' }), el('th', { text: '结果' }), el('th', { text: '用时', cls: 'n' })])]), eb])]));
      }

      card.appendChild(el('h3', { text: '哪几天用了' }));
      card.appendChild(el('p', { cls: 'small', text: d.days.length ? d.days.map(function (x) { var p = st.days[x.day]; return x.day + (p ? '（' + p[0] + ' 题）' : ''); }).join('　') : '没有记录。' }));
      if (u.id.slice(0, 2) === 'b:') {
        card.appendChild(el('h3', { text: '解锁的设备' }));
        var dv = el('div', { cls: 'row' }, [el('span', { text: '已在 ' + d.devices + ' 台设备上解锁，上限 ' + d.limit + ' 台。' })]);
        var rs = el('button', { type: 'button', cls: 'plain', text: '清空设备（客人换手机时用）' });
        rs.addEventListener('click', function () { api('code-reset', { code: u.id.slice(2) }).then(function (r) { if (!r.ok) return say(why(r.error)); say('已清空，客人可以重新在 ' + d.limit + ' 台设备上解锁。', true); openUser(u.id); }); });
        dv.appendChild(rs); card.appendChild(dv);
      }
      var del = el('button', { type: 'button', cls: 'danger', text: '删除这个人的记录' });
      del.style.marginTop = '14px';
      del.addEventListener('click', function () {
        if (del.getAttribute('data-sure') !== '1') { del.setAttribute('data-sure', '1'); del.textContent = '再点一次确认删除（删了不能恢复）'; return; }
        api('user-del', { id: u.id }).then(function (r) { if (!r.ok) return say(why(r.error)); box.innerHTML = ''; say('已删除。如果这个人继续使用，会重新出现。', true); loadUsers(); });
      });
      card.appendChild(del);
      box.appendChild(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  function loadUsers() {
    return api('users').then(function (d) { if (d.ok) { USERS = d.users || []; drawUsers(); } return d; });
  }

  // ---------------------------------------------------------------- bank
  function unb64(s) { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function loadBank() {
    return fetch('data/free.json').then(function (r) { return r.json(); }).then(function (free) {
      free.qs.forEach(function (q) { FREE[q.id] = 1; });
      QS = free.qs;
      return api('key').then(function (d) {
        if (!d.ok || !d.k || !window.crypto || !crypto.subtle) return;
        return fetch('data/bank.json').then(function (r) { return r.json(); }).then(function (bank) {
          return crypto.subtle.importKey('raw', unb64(d.k), { name: 'AES-GCM' }, false, ['decrypt']).then(function (key) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(bank.iv) }, key, unb64(bank.ct));
          }).then(function (buf) { QS = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf))).qs; });
        });
      });
    }).catch(function () { /* the free questions are enough to start */ }).then(function () {
      BY = {}; QS.forEach(function (q) { BY[q.id] = q; ORIG[q.id] = { q: q.q, qz: q.qz, e: q.e, o: q.o.slice(), oz: q.oz.slice() }; });
      return api('patches');
    }).then(function (d) {
      PATCHES = {};
      if (d && d.ok) d.patches.forEach(function (p) { PATCHES[p.qid] = p; });
      drawBank();
    });
  }
  function current(id) { var o = ORIG[id], p = (PATCHES[id] || {}).data || {}; return { q: p.q || o.q, qz: p.qz || o.qz, e: p.e || o.e, o: p.o || o.o, oz: p.oz || o.oz }; }
  function drawBank() {
    var q = $('bq').value.trim().toLowerCase(), only = $('bonly').checked;
    var list = QS.filter(function (x) {
      if (only && !PATCHES[x.id]) return false;
      if (!q) return only;
      var c = current(x.id);
      return x.id.toLowerCase() === q || [x.id, c.q, c.qz].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    $('binfo').textContent = '题库共 ' + QS.length + ' 题，改过 ' + Object.keys(PATCHES).length + ' 题。' + (q || only ? '找到 ' + list.length + ' 题' + (list.length > 30 ? '，只显示前 30 题。' : '。') : '输入题号或关键词开始找。');
    $('blist').innerHTML = '';
    list.slice(0, 30).forEach(function (x) {
      var c = current(x.id), card = el('div', { cls: 'card' });
      var head = el('div', { cls: 'row' }, [el('b', { text: x.id }), el('span', { cls: 'tag', text: FREE[x.id] ? '免费题' : '付费题' })]);
      if (PATCHES[x.id]) head.appendChild(el('span', { cls: 'tag edit', text: '改过' }));
      var btn = el('button', { cls: 'plain', type: 'button', text: '修改' }); btn.style.marginLeft = 'auto'; btn.addEventListener('click', function () { editQ(x.id); });
      head.appendChild(btn); card.appendChild(head);
      card.appendChild(el('div', { cls: 'fr', text: c.q })); card.appendChild(el('div', { cls: 'small', text: c.qz }));
      $('blist').appendChild(card);
    });
  }
  function editQ(id) {
    var c = current(id), box = $('bedit');
    box.innerHTML = '';
    var card = el('div', { cls: 'card' });
    card.appendChild(el('h2', { text: '修改 ' + id }));
    card.appendChild(el('p', { cls: 'small', text: '保存后，所有用户下次打开网站时看到的就是新内容（最多晚一分钟）。选项 A 永远是正确答案，做题时顺序会自动打乱。改了法语题干或选项，这道题的录音会对不上，改用手机自带的朗读。' }));
    function area(label, key, val, rows) { card.appendChild(el('label', { text: label, for: 'e-' + key })); var t = el('textarea', { id: 'e-' + key, rows: String(rows || 2) }); t.value = val; card.appendChild(t); }
    area('法语题干', 'q', c.q, 2); area('中文题干', 'qz', c.qz, 2);
    c.o.forEach(function (v, i) {
      var two = el('div', { cls: 'two' });
      var a = el('div'); a.appendChild(el('label', { text: '选项 ' + LETTERS[i] + ' 法语', for: 'e-o' + i })); var ta = el('textarea', { id: 'e-o' + i, rows: '2' }); ta.value = v; a.appendChild(ta);
      var b = el('div'); b.appendChild(el('label', { text: '选项 ' + LETTERS[i] + ' 中文', for: 'e-oz' + i })); var tb = el('textarea', { id: 'e-oz' + i, rows: '2' }); tb.value = c.oz[i]; b.appendChild(tb);
      two.appendChild(a); two.appendChild(b); card.appendChild(two);
    });
    area('中文讲解', 'e', c.e, 5);
    var save = el('button', { type: 'button', text: '保存' }), cancel = el('button', { type: 'button', cls: 'plain', text: '取消' }), row = el('div', { cls: 'row' }, [save, cancel]);
    row.style.marginTop = '12px';
    if (PATCHES[id]) {
      var undo = el('button', { type: 'button', cls: 'danger', text: '恢复成原来的' });
      undo.addEventListener('click', function () { api('patch-del', { qid: id }).then(function (d) { if (!d.ok) return say(why(d.error)); delete PATCHES[id]; box.innerHTML = ''; say(id + ' 已恢复原样。', true); drawBank(); }); });
      row.appendChild(undo);
    }
    cancel.addEventListener('click', function () { box.innerHTML = ''; });
    save.addEventListener('click', function () {
      var v = function (k) { return $('e-' + k).value.trim(); };
      var data = { q: v('q'), qz: v('qz'), e: v('e'), o: [0, 1, 2, 3].map(function (i) { return v('o' + i); }), oz: [0, 1, 2, 3].map(function (i) { return v('oz' + i); }) };
      if (!data.q || !data.qz || !data.e || data.o.concat(data.oz).some(function (x) { return !x; })) return say('每一格都要填，不能留空。');
      var o = ORIG[id], changed = {};
      ['q', 'qz', 'e'].forEach(function (k) { if (data[k] !== o[k]) changed[k] = data[k]; });
      ['o', 'oz'].forEach(function (k) { if (data[k].join('\u0001') !== o[k].join('\u0001')) changed[k] = data[k]; });
      if (!Object.keys(changed).length) return say('和原来一样，没有要保存的。');
      save.disabled = true;
      api('patch-set', { qid: id, free: !!FREE[id], data: changed }).then(function (d) {
        save.disabled = false;
        if (!d.ok) return say(why(d.error));
        PATCHES[id] = { qid: id, free: !!FREE[id], data: changed, t: Date.now() };
        box.innerHTML = ''; say(id + ' 已保存。', true); drawBank();
      });
    });
    card.appendChild(row); box.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('rhome').textContent = location.origin;
  $('rnew').addEventListener('click', function () {
    var name = $('rname').value.trim(), code = $('rcode').value.trim();
    if (!name) return say('先填名字或备注，方便你以后认出是谁。');
    if (code && !/^[A-Za-z0-9_-]{1,40}$/.test(code)) return say('代号只能用英文字母、数字、短横线，不能有空格和中文。');
    $('rnew').disabled = true;
    api('ref-set', { name: name, code: code, pct: Number($('rpct').value), fresh: true }).then(function (d) {
      $('rnew').disabled = false;
      if (!d.ok) return say(d.error === 'taken' ? '这个代号已经给别人用了，换一个。' : why(d.error));
      $('rlink').value = linkOf(d.code); $('rmade').hidden = false;
      say('链接生成好了。', true); $('rname').value = ''; $('rcode').value = '';
      loadRefs();
    });
  });
  $('rcopy').addEventListener('click', function () { copy($('rlink').value, $('rcopy')); });

  // ---------------------------------------------------------------- unlock codes
  function loadCodes() {
    return api('codes').then(function (d) {
      $('clist').innerHTML = '';
      if (!d.ok) return;
      d.codes.forEach(function (c) {
        var tr = el('tr'), state = c.revoked ? '已作废' : (c.used_by ? '已使用 ' + full(c.used_at) : '未使用');
        var code = td(''); code.appendChild(el('b', { text: c.code })); tr.appendChild(code);
        tr.appendChild(td(c.note || '')); tr.appendChild(td(full(c.created))); tr.appendChild(td(state));
        var ops = td('');
        function btn(text, cls, fn) { var b = el('button', { type: 'button', cls: cls, text: text }); b.style.padding = '3px 9px'; b.style.marginRight = '6px'; b.addEventListener('click', function () { fn(b); }); ops.appendChild(b); }
        if (!c.revoked) {
          btn('复制', 'plain', function (b) { try { navigator.clipboard.writeText(c.code).then(function () { b.textContent = '已复制'; }); } catch (e) { say('复制不了，请手动选中解锁码。'); } });
          if (c.used_by) btn('换设备', 'plain', function () { api('code-reset', { code: c.code }).then(function (r) { if (!r.ok) return say(why(r.error)); say(c.code + ' 可以在新设备上重新用一次。', true); loadCodes(); }); });
          btn('作废', 'danger', function (b) {
            if (b.getAttribute('data-sure') !== '1') { b.setAttribute('data-sure', '1'); b.textContent = '确认作废'; return; }
            api('code-del', { code: c.code }).then(function (r) { if (!r.ok) return say(why(r.error)); say(c.code + ' 已作废。', true); loadCodes(); });
          });
        }
        tr.appendChild(ops); $('clist').appendChild(tr);
      });
      if (!d.codes.length) { var tr = el('tr'); var x = td('还没有生成过解锁码'); x.colSpan = 5; tr.appendChild(x); $('clist').appendChild(tr); }
    });
  }
  $('cnew').addEventListener('click', function () {
    $('cnew').disabled = true;
    api('code-new', { n: Number($('cn').value) || 1, note: $('cnote').value }).then(function (d) {
      $('cnew').disabled = false;
      if (!d.ok) return say(why(d.error));
      var box = $('cmade'); box.innerHTML = ''; box.hidden = false;
      box.appendChild(el('p', { cls: 'small', text: '新生成的解锁码（每个只能用在一台设备上）：' }));
      var pre = el('textarea', { rows: String(Math.min(10, d.codes.length)), readonly: 'readonly', id: 'cmade-text' }); pre.value = d.codes.join('\n'); box.appendChild(pre);
      say('生成了 ' + d.codes.length + ' 个解锁码。', true); $('cnote').value = '';
      loadCodes();
    });
  });
  $('cdelgo').addEventListener('click', function () {
    var v = $('cdel').value.trim();
    if (!v) return;
    api('code-del', { code: v }).then(function (r) { if (!r.ok) return say(r.error === 'bad_request' ? '这不是一个解锁码（12 位字母和数字）。' : why(r.error)); say(v + ' 已作废。', true); $('cdel').value = ''; loadCodes(); });
  });

  // ---------------------------------------------------------------- start
  var STORE = 'civique.admin';
  function signOut(text) {
    TOKEN = ''; try { sessionStorage.removeItem(STORE); } catch (e) { /* nothing kept */ }
    $('main').hidden = true; $('f').hidden = false; say(text || '');
  }
  function enter() {
    return loadUsers().then(function (d) {
      if (!d.ok) { if (!$('main').hidden || TOKEN) signOut(why(d.error)); else say(why(d.error)); return; }
      say(''); $('main').hidden = false; $('f').hidden = true;
      loadCodes(); loadRefs(); loadSales();
      return loadBank();
    });
  }
  $('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    say('读取中…', true);
    fetch('/api/admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: $('k').value, otp: $('otp').value, op: 'login' }) })
      .then(function (r) { return r.json().catch(function () { return { error: 'server' }; }); }, function () { return { error: 'network' }; })
      .then(function (d) {
        if (!d.ok) { $('main').hidden = true; if (d.error === 'otp_required') $('otp').focus(); return say(why(d.error)); }
        TOKEN = d.token; try { sessionStorage.setItem(STORE, TOKEN); } catch (e) { /* asked again after a reload */ }
        $('k').value = ''; $('otp').value = '';
        return enter();
      });
  });
  try { TOKEN = sessionStorage.getItem(STORE) || ''; } catch (e) { TOKEN = ''; }
  if (TOKEN) enter();
  $('uq').addEventListener('input', drawUsers); $('uf').addEventListener('change', drawUsers);
  $('reload').addEventListener('click', function () { loadUsers(); });
  $('bq').addEventListener('input', drawBank); $('bonly').addEventListener('change', drawBank);
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      ['users', 'refs', 'bank', 'codes'].forEach(function (t) { $('t-' + t).hidden = t !== b.getAttribute('data-tab'); });
    });
  });
})();
