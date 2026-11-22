#!/usr/bin/env node
// Writes the whole app as one page fragment (styles, scripts and the free sample inline) for places that
// cannot serve separate files. The encrypted bank stays a separate file: data/bank.json next to the page.
//   node tools/preview.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const read = (f) => readFileSync(join(SITE, f), 'utf8');
const out = process.argv[2];
if (!out) { console.error('usage: node tools/preview.mjs <out.html>'); process.exit(1); }
const index = read('index.html');
const landing = /<div id="app">[\s\S]*?<\/div>\s*(?=<script)/.exec(index)[0].trim();
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const page = [
  '<title>公民考试中文题库</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<style>\n' + read('app.css') + '</style>',
  landing,
  '<script>\n' + safe(read('config.js')) + 'window.CIVIQUE_CONFIG.api = \'\'; window.CIVIQUE_CONFIG.offline = false;\n</script>',   // no function next to a one-file page
  '<script>window.CIVIQUE_FREE = ' + safe(JSON.stringify(JSON.parse(read('data/free.json')))) + ';</script>',
  '<script>window.CIVIQUE_CENTRES = ' + safe(JSON.stringify(JSON.parse(read('data/centres.json')))) + ';</script>',
  '<script>\n' + safe(read('app.js')) + '</script>',
].join('\n');
writeFileSync(out, page);
console.log('wrote ' + out + ' (' + Math.round(page.length / 1024) + ' KB)');
