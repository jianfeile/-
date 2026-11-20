#!/usr/bin/env node
// Renders site/icon.svg to the PNG sizes the manifest and iOS need.  node tools/icons.cjs
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const SITE = path.resolve(__dirname, '..', 'site');
(async () => {
  const svg = fs.readFileSync(path.join(SITE, 'icon.svg'), 'utf8');
  const b = await chromium.launch();
  for (const size of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p.setContent('<style>html,body{margin:0}svg{display:block;width:' + size + 'px;height:' + size + 'px}</style>' + svg);
    await p.screenshot({ path: path.join(SITE, 'icon-' + size + '.png') });
    await p.close();
  }
  await b.close();
  console.log('icons written');
})();
