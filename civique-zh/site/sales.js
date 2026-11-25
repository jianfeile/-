// The seller's sales page: asks /api/sales with the admin password, shows sales by referrer and by month.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var sales = [], more = false;
  var NONE = '（没有推荐人）';
  function paris(t, opt) { return new Intl.DateTimeFormat('sv-SE', Object.assign({ timeZone: 'Europe/Paris' }, opt)).format(new Date(t * 1000)); }
  function month(s) { return paris(s.t, { year: 'numeric', month: '2-digit' }); }
  function money(c) { return (c / 100).toFixed(2).replace('.', ',') + ' €'; }
  function cell(tr, text, cls) { var td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr.appendChild(td); }
  function picked() { var m = $('m').value; return sales.filter(function (s) { return m === 'all' || month(s) === m; }); }
  function rate() { var p = parseFloat($('pc').value); return isFinite(p) && p >= 0 && p <= 100 ? p / 100 : 0; }
  function groups(list) {
    var by = {};
    list.forEach(function (s) { var g = by[s.ref] || (by[s.ref] = { ref: s.ref, n: 0, amount: 0 }); g.n++; g.amount += s.amount; });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return (a.ref === '') - (b.ref === '') || b.n - a.n || (a.ref < b.ref ? -1 : 1); });
  }
  function draw() {
    var list = picked(), g = groups(list), r = rate();
    var total = list.reduce(function (a, s) { return a + s.amount; }, 0);
    var referred = list.filter(function (s) { return s.ref; });
    var due = referred.reduce(function (a, s) { return a + s.amount; }, 0) * r;
    $('sum').innerHTML = '';
    [[list.length, '笔订单'], [money(total), '收款'], [referred.length, '笔有推荐人'], [money(Math.round(due)), '应付佣金']].forEach(function (x) {
      var d = document.createElement('div'), b = document.createElement('b'); b.textContent = x[0]; d.appendChild(b); d.appendChild(document.createTextNode(x[1])); $('sum').appendChild(d);
    });
    $('by').innerHTML = ''; $('rows').innerHTML = '';
    g.forEach(function (x) {
      var tr = document.createElement('tr');
      cell(tr, x.ref || NONE); cell(tr, x.n, 'n'); cell(tr, money(x.amount), 'n'); cell(tr, x.ref ? money(Math.round(x.amount * r)) : '—', 'n');
      $('by').appendChild(tr);
    });
    list.forEach(function (s) {
      var tr = document.createElement('tr');
      cell(tr, paris(s.t, { dateStyle: 'short', timeStyle: 'short' })); cell(tr, s.ref || NONE); cell(tr, money(s.amount), 'n');
      $('rows').appendChild(tr);
    });
    if (!list.length) { var tr = document.createElement('tr'); cell(tr, '这个月还没有订单'); $('rows').appendChild(tr); }
  }
  function show() {
    var months = [];
    sales.forEach(function (s) { var m = month(s); if (months.indexOf(m) < 0) months.push(m); });
    var now = paris(Date.now() / 1000, { year: 'numeric', month: '2-digit' });
    if (months.indexOf(now) < 0) months.unshift(now);
    $('m').innerHTML = '';
    months.concat(['all']).forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = m === 'all' ? '全部' : m; $('m').appendChild(o); });
    $('m').value = now;
    $('out').hidden = false;
    $('msg').textContent = more ? '订单很多，只显示了最近的 3000 笔。' : '';
    draw();
  }
  $('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('msg').textContent = '读取中…';
    fetch('/api/sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: $('k').value }) })
      .then(function (r) { return r.json().catch(function () { return { error: 'server' }; }); })
      .then(function (d) {
        if (!d.ok) {
          $('out').hidden = true;
          $('msg').textContent = d.error === 'forbidden' ? '密码不对。' : d.error === 'not_configured' ? '还没设置好：Cloudflare 里缺少密钥。' : d.error === 'payment_service' ? 'Stripe 没有回应，稍后再试。' : '出错了，稍后再试。';
          return;
        }
        sales = d.sales || []; more = !!d.more; show();
      }, function () { $('msg').textContent = '网络不通，稍后再试。'; });
  });
  $('m').addEventListener('change', draw);
  $('pc').addEventListener('input', draw);
  $('csv').addEventListener('click', function () {
    var r = rate(), lines = ['时间（巴黎）,推荐人,金额（欧元）,佣金（欧元）'];
    picked().forEach(function (s) { lines.push([paris(s.t, { dateStyle: 'short', timeStyle: 'short' }), s.ref, (s.amount / 100).toFixed(2), s.ref ? (s.amount * r / 100).toFixed(2) : '0.00'].join(',')); });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    a.download = 'sales-' + $('m').value + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  });
})();
