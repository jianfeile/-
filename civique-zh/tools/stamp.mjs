#!/usr/bin/env node
// Writes a short fingerprint of each script and style sheet into the pages that load them (app.js?v=1a2b3c4d5e), so a
// phone never keeps an old file after a release: the page itself is always fetched fresh, and a changed file has a new
// address. Run before every commit that touches site/:   node tools/stamp.mjs      (--check only tells whether it is up to date)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const check = process.argv.includes('--check');
let stale = 0;
for (const page of ['index.html', 'admin-old.html', 'sales.html']) {
  const before = readFileSync(join(SITE, page), 'utf8');
  const after = before.replace(/\b(src|href)="([\w./-]+\.(?:js|css))(?:\?v=[0-9a-f]+)?"/g, (m, attr, file) =>
    attr + '="' + file + '?v=' + createHash('sha256').update(readFileSync(join(SITE, file))).digest('hex').slice(0, 10) + '"');
  if (after !== before) { stale++; if (!check) writeFileSync(join(SITE, page), after); }
}
if (check && stale) { console.error('stamps are out of date: run node tools/stamp.mjs'); process.exit(1); }
console.log(check ? 'stamps are up to date' : stale + ' page(s) restamped');
