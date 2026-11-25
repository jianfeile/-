// Posters for the seller to send out: a picture with the site's pitch and a QR code that opens the site (with the
// referrer's code when there is one). Drawn in the browser on a canvas; needs vendor/qrcode.js.
(function () {
  'use strict';
  var MASCOT = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 120\" width=\"480\" height=\"480\"><g fill=\"none\" stroke=\"#5A2F1C\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M48 97 19 76M72 97l29-21\" stroke-width=\"13\"/><path d=\"M16 73h.01M104 73h.01\" stroke-width=\"17\"/><path d=\"M48 97 19 76M72 97l29-21\" stroke-width=\"8\" stroke=\"#FFDFC4\"/><path d=\"M16 73h.01M104 73h.01\" stroke-width=\"12\" stroke=\"#FFDFC4\"/><path d=\"M25 62C25 28 95 28 95 62c0 12 3 21-5 26H30c-8-5-5-14-5-26z\" fill=\"#5A2F1C\"/><path d=\"M53 113v4M67 113v4\" stroke-width=\"7\"/><path d=\"M49 90l-11 22q22 6 44 0L71 90z\" fill=\"#FFC933\"/><ellipse cx=\"60\" cy=\"64\" rx=\"32\" ry=\"27\" fill=\"#FFDFC4\"/><path d=\"M29 59q4-19 31-19t31 19q-16 0-25-12-11 13-37 12z\" fill=\"#5A2F1C\"/><path d=\"M34 77h4M82 77h4\" stroke-width=\"6.5\" stroke=\"#FF9E9E\"/><path d=\"M42 89q18 9 36 0l1 7q-19 10-38 0zM64 99l9 9-12 1z\" fill=\"#FFF4DC\" stroke=\"#0B7A52\"/><path d=\"M23 48Q10 25 48 16q42-9 50 16 3 15-10 14-33-8-65 2z\" stroke-width=\"6.4\" stroke=\"#FFEFE2\"/><g stroke=\"#A81F1A\"><path d=\"M62 15l3-8\" stroke-width=\"4\"/><path d=\"M23 48Q10 25 48 16q42-9 50 16 3 15-10 14-33-8-65 2z\" fill=\"#E8362D\"/></g><path d=\"M33 30q9-7 21-8\" stroke-width=\"4\" stroke=\"#FF8E7E\"/><g stroke=\"#3B1D10\" stroke-width=\"3\"><path d=\"M45 67v2M75 67v2\" stroke-width=\"10\"/><path d=\"M46.6 65.5h.01m30 0h.01\" stroke-width=\"3.8\" stroke=\"#fff\"/><path d=\"M51 76h18q-1 10-9 10t-9-10z\" fill=\"#C8302A\"/></g></g></svg>";
  var W = 1080, H = 1440;
  var FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

  // the QR code of a text as a square of booleans
  function matrix(text) {
    var q = window.qrcode(0, 'M');
    q.addData(text); q.make();
    var n = q.getModuleCount(), rows = [];
    for (var r = 0; r < n; r++) { var row = []; for (var c = 0; c < n; c++) row.push(q.isDark(r, c)); rows.push(row); }
    return rows;
  }
  // drawn on whole pixels, with the quiet margin scanners need
  function drawQr(ctx, text, x, y, size) {
    var m = matrix(text), n = m.length, quiet = 3, cell = Math.floor(size / (n + quiet * 2)), full = cell * (n + quiet * 2);
    var ox = x + Math.floor((size - full) / 2), oy = y + Math.floor((size - full) / 2);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#0B1915';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) ctx.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell);
  }
  function rounded(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hexagon(ctx, cx, cy, r) {
    ctx.beginPath();
    for (var i = 0; i < 6; i++) { var a = Math.PI / 3 * i; ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    ctx.closePath();
  }
  function image(src) {
    return new Promise(function (ok) { var im = new Image(); im.onload = function () { ok(im); }; im.onerror = function () { ok(null); }; im.src = src; });
  }
  // opt: { link, total (questions in the bank), cards }
  function poster(opt) {
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    return image('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(MASCOT)).then(function (mascot) {
      // page
      x.fillStyle = '#EEF4F0'; x.fillRect(0, 0, W, H);
      // green top
      var g = x.createLinearGradient(0, 0, 0, 640); g.addColorStop(0, '#00B877'); g.addColorStop(1, '#00935F');
      x.fillStyle = g; rounded(x, 0, -80, W, 700, 80); x.fill();
      x.fillStyle = 'rgba(255,255,255,.10)'; hexagon(x, 960, 90, 170); x.fill(); hexagon(x, 110, 560, 120); x.fill();
      // kicker
      x.font = '700 34px ' + FONT; x.textBaseline = 'middle';
      var kick = 'examen civique · 中文题库 · 非官方', kw = x.measureText(kick).width + 56;
      x.fillStyle = 'rgba(0,0,0,.20)'; rounded(x, 72, 84, kw, 64, 32); x.fill();
      x.fillStyle = '#FFFFFF'; x.fillText(kick, 100, 117);
      // title
      x.textBaseline = 'alphabetic'; x.fillStyle = '#FFFFFF'; x.font = '900 104px ' + FONT;
      x.fillText('法国公民考试', 72, 300);
      x.fillStyle = '#FFC933'; x.fillText('用中文看懂', 72, 430);
      x.fillText('每一题', 72, 560);
      if (mascot) x.drawImage(mascot, 640, 250, 400, 400);
      // what is inside
      x.fillStyle = '#FFFFFF'; rounded(x, 56, 668, W - 112, 372, 44); x.fill();
      x.strokeStyle = '#D5E2DB'; x.lineWidth = 4; rounded(x, 56, 668, W - 112, 372, 44); x.stroke();
      var rows = [['#FF6B5E', (opt.total || 617) + ' 道题，逐题中文翻译和讲解'], ['#8B5CF6', '40 题模拟考试，和正式考试一样'], ['#2F8CFF', '中文考点速记，考生机经'], ['#FF9F1C', '多年卡、十年卡、入籍都能练']];
      rows.forEach(function (r, i) {
        var cy = 730 + i * 82;
        x.fillStyle = r[0]; hexagon(x, 116, cy, 22); x.fill();
        x.fillStyle = '#0B1915'; x.font = '700 44px ' + FONT; x.textBaseline = 'middle'; x.fillText(r[1], 160, cy + 2);
      });
      // scan
      x.fillStyle = '#FFFFFF'; rounded(x, 56, 1072, W - 112, 300, 44); x.fill();
      x.strokeStyle = '#00A66C'; x.lineWidth = 6; rounded(x, 56, 1072, W - 112, 300, 44); x.stroke();
      drawQr(x, opt.link, 84, 1092, 260);
      x.textBaseline = 'alphabetic'; x.fillStyle = '#00704A'; x.font = '900 68px ' + FONT; x.fillText('扫码免费试用', 384, 1180);
      x.fillStyle = '#0B1915'; x.font = '600 38px ' + FONT; x.fillText('长按识别二维码，微信里直接打开', 384, 1246);
      x.fillStyle = '#5B6B64'; x.font = '600 36px ' + FONT; x.fillText('不用下载 · kaocivique.com', 384, 1308);
      // footer
      x.fillStyle = '#5B6B64'; x.font = '500 28px ' + FONT; x.textAlign = 'center';
      x.fillText('非官方网站，与法国政府和考试机构无关。官方备考资料免费。', W / 2, 1412);
      x.textAlign = 'left';
      return cv;
    });
  }
  // how to put the site on the phone's home screen
  function guide(opt) {
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var x = cv.getContext('2d');
    return image('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(MASCOT)).then(function (mascot) {
      x.fillStyle = '#EEF4F0'; x.fillRect(0, 0, W, H);
      var g = x.createLinearGradient(0, 0, 0, 380); g.addColorStop(0, '#00B877'); g.addColorStop(1, '#00935F');
      x.fillStyle = g; rounded(x, 0, -80, W, 440, 80); x.fill();
      x.fillStyle = 'rgba(255,255,255,.10)'; hexagon(x, 980, 60, 150); x.fill();
      x.textBaseline = 'alphabetic'; x.fillStyle = '#FFFFFF'; x.font = '900 84px ' + FONT; x.fillText('把题库放到', 72, 150);
      x.fillStyle = '#FFC933'; x.fillText('手机桌面', 72, 258);
      x.fillStyle = '#FFFFFF'; x.font = '700 38px ' + FONT; x.fillText('像 App 一样，一点就开，不用再找网址', 72, 326);
      if (mascot) x.drawImage(mascot, 760, 60, 290, 290);
      var steps = [
        ['在微信里打开的，先换到浏览器', ['点右上角  ···', '选“在默认浏览器中打开”'], 'dots'],
        ['苹果手机（Safari）', ['点底部中间的分享按钮', '往下找“添加到主屏幕”，点“添加”'], 'share'],
        ['安卓手机（Chrome 等）', ['点右上角  ⋮', '选“添加到主屏幕”或“安装应用”'], 'more'],
        ['以后从桌面图标打开', ['第一次要重新登录', '买过的：填付款邮箱，自动解锁'], 'tap']
      ];
      steps.forEach(function (s, i) {
        var y = 396 + i * 196;
        x.fillStyle = '#FFFFFF'; rounded(x, 56, y, W - 112, 176, 36); x.fill();
        x.strokeStyle = '#D5E2DB'; x.lineWidth = 4; rounded(x, 56, y, W - 112, 176, 36); x.stroke();
        x.fillStyle = '#00A66C'; x.beginPath(); x.arc(126, y + 88, 42, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#FFFFFF'; x.font = '900 52px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(i + 1), 126, y + 91); x.textAlign = 'left';
        x.textBaseline = 'alphabetic'; x.fillStyle = '#0B1915'; x.font = '900 44px ' + FONT; x.fillText(s[0], 196, y + 62);
        x.fillStyle = '#34453E'; x.font = '600 36px ' + FONT; x.fillText(s[1][0], 196, y + 112); x.fillText(s[1][1], 196, y + 156);
        // a small picture of the button to look for
        var ix = 900, iy = y + 88;
        x.strokeStyle = '#00704A'; x.fillStyle = '#00704A'; x.lineWidth = 7; x.lineCap = 'round'; x.lineJoin = 'round';
        if (s[2] === 'dots') { [-34, 0, 34].forEach(function (d) { x.beginPath(); x.arc(ix + d, iy, 9, 0, Math.PI * 2); x.fill(); }); }
        else if (s[2] === 'more') { [-34, 0, 34].forEach(function (d) { x.beginPath(); x.arc(ix, iy + d, 9, 0, Math.PI * 2); x.fill(); }); }
        else if (s[2] === 'share') {
          x.beginPath(); x.moveTo(ix - 26, iy - 8); x.lineTo(ix - 34, iy - 8); x.lineTo(ix - 34, iy + 46); x.lineTo(ix + 34, iy + 46); x.lineTo(ix + 34, iy - 8); x.lineTo(ix + 26, iy - 8); x.stroke();
          x.beginPath(); x.moveTo(ix, iy + 18); x.lineTo(ix, iy - 46); x.moveTo(ix - 18, iy - 28); x.lineTo(ix, iy - 46); x.lineTo(ix + 18, iy - 28); x.stroke();
        } else {
          rounded(x, ix - 40, iy - 40, 80, 80, 20); x.fillStyle = '#00A66C'; x.fill();
          x.fillStyle = '#FFC933'; hexagon(x, ix, iy, 24); x.fill();
        }
      });
      // scan
      var by = 1188;
      x.fillStyle = '#FFFFFF'; rounded(x, 56, by, W - 112, 204, 36); x.fill();
      x.strokeStyle = '#00A66C'; x.lineWidth = 6; rounded(x, 56, by, W - 112, 204, 36); x.stroke();
      drawQr(x, opt.link, 78, by + 12, 180);
      x.textBaseline = 'alphabetic'; x.fillStyle = '#00704A'; x.font = '900 54px ' + FONT; x.fillText('还没打开过？扫码进入', 290, by + 84);
      x.fillStyle = '#5B6B64'; x.font = '600 36px ' + FONT; x.fillText('法国公民考试中文题库 · kaocivique.com', 290, by + 146);
      x.fillStyle = '#5B6B64'; x.font = '500 26px ' + FONT; x.textAlign = 'center';
      x.fillText('非官方网站，与法国政府和考试机构无关。', W / 2, 1424); x.textAlign = 'left';
      return cv;
    });
  }
  // the QR code alone, for people who make their own poster
  function qrOnly(link, size) {
    var cv = document.createElement('canvas'); cv.width = cv.height = size || 1024;
    drawQr(cv.getContext('2d'), link, 0, 0, cv.width);
    return cv;
  }
  window.Poster = { poster: poster, guide: guide, qrOnly: qrOnly, matrix: matrix };
})();
