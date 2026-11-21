#!/usr/bin/env node
// Question-bank tool: validates the master content, writes the free sample and the encrypted bank,
// manages unlock codes, and can export the master content back out of the encrypted bank.
//
//   node tools/bank.mjs build  --content <dir> (--new | --code XXXX-XXXX-XXXX) [--consulted YYYY-MM-DD]
//        --consulted: the day the official question list was last checked (shown on the site); kept from the last build if omitted
//   node tools/bank.mjs codes  <n> --code XXXX-XXXX-XXXX      add n unlock codes, print them
//   node tools/bank.mjs revoke <code> --code XXXX-XXXX-XXXX   remove one code (existing devices keep working until the key is rotated with build --new)
//   node tools/bank.mjs export --code XXXX-XXXX-XXXX [--out <dir>]
//   node tools/bank.mjs check  --code XXXX-XXXX-XXXX
//   node tools/bank.mjs key    --code XXXX-XXXX-XXXX          print the bank key (the CONTENT_KEY secret of the unlock function)
//
// No dependencies; needs Node 18+.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv, randomInt, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'site', 'data');
const BANK = join(DATA, 'bank.json');
const FREE = join(DATA, 'free.json');
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ITER = 150000;
const THEMES = ['principes', 'institutions', 'droits', 'histoire', 'societe'];
const LEVELS = ['csp', 'cr'];
// free sample: knowledge questions per theme and per level, situational questions per theme
const FREE_K = 6, FREE_S = 3;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf('--' + name); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const die = (m) => { console.error('ERROR: ' + m); process.exit(1); };
const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

export function normCode(s) {
  const c = String(s || '').toUpperCase().split('').filter((ch) => ALPHA.includes(ch)).join('');
  return c.length === 12 ? c : null;
}
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12);
function newCode() { let c = ''; for (let i = 0; i < 12; i++) c += ALPHA[randomInt(ALPHA.length)]; return c; }

// One slow derivation gives both the lookup id and the wrapping key, so the id is no shortcut for guessing.
function derive(code, salt, iter) {
  const bits = pbkdf2Sync(code, salt, iter, 64, 'sha256');
  return { wrapKey: bits.subarray(0, 32), id: bits.subarray(32, 40).toString('hex') };
}
function seal(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);   // ciphertext || tag, as WebCrypto expects
  return { iv: b64(iv), ct: b64(ct) };
}
function open(key, ivB64, ctB64) {
  const buf = unb64(ctB64);
  const d = createDecipheriv('aes-256-gcm', key, unb64(ivB64));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}
function loadBank() { if (!existsSync(BANK)) die('no bank yet: run build --new first'); return JSON.parse(readFileSync(BANK, 'utf8')); }
function contentKey(bank, codeArg) {
  const code = normCode(codeArg);
  if (!code) die('give a valid unlock code with --code XXXX-XXXX-XXXX');
  const { wrapKey, id } = derive(code, unb64(bank.kdf.salt), bank.kdf.iter);
  const e = bank.keys[id];
  if (!e) die('this code is not in the bank');
  return open(wrapKey, e.iv, e.wk);
}
function addCode(bank, K) {
  const code = newCode();
  const { wrapKey, id } = derive(code, unb64(bank.kdf.salt), bank.kdf.iter);
  const s = seal(wrapKey, K);
  bank.keys[id] = { iv: s.iv, wk: s.ct };
  return fmtCode(code);
}

// ---------- content ----------
const zh = /[一-鿿]/;
function loadContent(dir) {
  if (!existsSync(dir)) die('content folder not found: ' + dir);
  const items = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f === 'free_ids.json' || f === 'sources.json') continue;
    const arr = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!Array.isArray(arr)) die(f + ': expected an array');
    items.push(...arr);
  }
  const errs = [], seen = new Set();
  for (const it of items) {
    const id = it.id, bad = (m) => errs.push(id + ': ' + m);
    if (!id || seen.has(id)) { errs.push('missing or duplicate id ' + id); continue; }
    seen.add(id);
    if (!THEMES.includes(it.theme)) bad('theme');
    if (!Array.isArray(it.levels) || !it.levels.length || it.levels.some((l) => !LEVELS.includes(l))) bad('levels');
    if (!['connaissance', 'situation'].includes(it.kind)) bad('kind');
    if (typeof it.q !== 'string' || it.q.trim().length < 8) bad('q');
    if (typeof it.qz !== 'string' || !zh.test(it.qz)) bad('qz');
    for (const k of ['opts', 'optsz']) {
      if (!Array.isArray(it[k]) || it[k].length !== 4 || it[k].some((x) => typeof x !== 'string' || !x.trim())) bad(k);
    }
    if (Array.isArray(it.opts) && new Set(it.opts.map((o) => o.trim().toLowerCase())).size !== 4) bad('options are not all different');
    if (typeof it.explain !== 'string' || !zh.test(it.explain)) bad('explain');
    if (!Array.isArray(it.vocab) || it.vocab.some((v) => !Array.isArray(v) || v.length !== 2)) bad('vocab');
  }
  if (errs.length) { errs.slice(0, 50).forEach((e) => console.error('  ' + e)); die(errs.length + ' content errors'); }
  const order = (it) => THEMES.indexOf(it.theme) * 2 + (it.kind === 'situation' ? 1 : 0);
  items.sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
  return items;
}
// deterministic pick so the free sample stays the same from build to build
function pickFree(items, dir) {
  const f = join(dir, 'free_ids.json');
  if (existsSync(f)) {
    const ids = JSON.parse(readFileSync(f, 'utf8')).filter((id) => items.some((it) => it.id === id));
    if (ids.length) return new Set(ids);
  }
  const rank = (id) => createHash('sha256').update('free:' + id).digest('hex');
  const free = new Set();
  for (const t of THEMES) {
    const know = items.filter((it) => it.theme === t && it.kind === 'connaissance').sort((a, b) => rank(a.id).localeCompare(rank(b.id)));
    // questions valid for both cards first: they serve both audiences
    for (const it of know.filter((x) => x.levels.length === 2).slice(0, FREE_K)) free.add(it.id);
    for (const lv of LEVELS) {
      let have = know.filter((x) => free.has(x.id) && x.levels.includes(lv)).length;
      for (const it of know) { if (have >= FREE_K) break; if (!free.has(it.id) && it.levels.includes(lv)) { free.add(it.id); have++; } }
    }
    const situ = items.filter((it) => it.theme === t && it.kind === 'situation').sort((a, b) => rank(a.id).localeCompare(rank(b.id)));
    for (const it of situ.slice(0, FREE_S)) free.add(it.id);
  }
  writeFileSync(f, JSON.stringify([...free].sort(), null, 1));
  return free;
}
function compact(it, srcIndex) {
  const o = { id: it.id, t: it.theme, l: it.levels, k: it.kind === 'situation' ? 's' : 'c', q: it.q, qz: it.qz, o: it.opts, oz: it.optsz, e: it.explain, v: it.vocab };
  if (srcIndex && it.src && srcIndex.has(it.src)) o.s = srcIndex.get(it.src);
  return o;
}
function counts(items) {
  const c = {};
  for (const lv of LEVELS) { c[lv] = {}; for (const t of THEMES) c[lv][t] = { c: 0, s: 0 }; }
  for (const it of items) for (const lv of it.levels) c[lv][it.theme][it.kind === 'situation' ? 's' : 'c']++;
  return c;
}

// ---------- commands ----------
if (cmd === 'build') {
  const dir = resolve(opt('content') || join(ROOT, 'content'));
  const items = loadContent(dir);
  // optional table of official source sheets: content/sources.json = { "<file name used in src>": ["title", "url"] }
  const srcFile = join(dir, 'sources.json');
  const sources = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : {};
  const used = [...new Set(items.map((it) => it.src).filter((s) => sources[s]))].sort();
  const srcIndex = new Map(used.map((s, i) => [s, i]));
  const srcTable = used.map((s) => sources[s]);
  const freeIds = pickFree(items, dir);
  let bank, K, firstCode = null;
  if (opt('new')) {
    bank = { v: 1, kdf: { salt: b64(randomBytes(16)), iter: ITER }, keys: {} };
    K = randomBytes(32);
    firstCode = addCode(bank, K);
  } else {
    bank = loadBank();
    K = contentKey(bank, opt('code'));
  }
  const all = items.map((it) => compact(it, srcIndex));
  const sealed = seal(K, Buffer.from(JSON.stringify({ qs: all, src: srcTable }), 'utf8'));
  bank.iv = sealed.iv; bank.ct = sealed.ct; bank.n = all.length;
  const today = new Date().toISOString().slice(0, 10);
  bank.built = today;
  let consulted = typeof opt('consulted') === 'string' ? opt('consulted') : null;
  if (!consulted && existsSync(FREE)) { try { consulted = JSON.parse(readFileSync(FREE, 'utf8')).consulted || null; } catch { consulted = null; } }
  if (!consulted) consulted = today;
  const freeQs = all.filter((q) => freeIds.has(q.id));
  // the free file carries its own small source table
  const freeSrcIdx = [...new Set(freeQs.map((q) => q.s).filter((s) => s !== undefined))];
  const free = {
    v: 1, built: today, consulted,
    meta: { counts: counts(items), total: all.length, free: freeQs.length },
    src: freeSrcIdx.map((i) => srcTable[i]),
    qs: freeQs.map((q) => (q.s === undefined ? q : { ...q, s: freeSrcIdx.indexOf(q.s) })),
  };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(BANK, JSON.stringify(bank));
  writeFileSync(FREE, JSON.stringify(free));
  console.log(`built: ${all.length} questions (${freeQs.length} free), ${Object.keys(bank.keys).length} code(s) valid`);
  for (const lv of LEVELS) console.log('  ' + lv + ': ' + THEMES.map((t) => `${t} ${free.meta.counts[lv][t].c}+${free.meta.counts[lv][t].s}`).join(', '));
  if (firstCode) console.log('FIRST UNLOCK CODE (keep it private, it is needed for every later command): ' + firstCode);
} else if (cmd === 'codes') {
  const n = parseInt(args[1], 10);
  if (!(n > 0 && n <= 5000)) die('usage: codes <n> --code XXXX-XXXX-XXXX');
  const bank = loadBank();
  const K = contentKey(bank, opt('code'));
  const out = [];
  for (let i = 0; i < n; i++) out.push(addCode(bank, K));
  writeFileSync(BANK, JSON.stringify(bank));
  console.log(out.join('\n'));
  console.error(`added ${n} codes; ${Object.keys(bank.keys).length} valid in total`);
} else if (cmd === 'revoke') {
  const bank = loadBank();
  contentKey(bank, opt('code'));
  const target = normCode(args[1]);
  if (!target) die('usage: revoke <code> --code XXXX-XXXX-XXXX');
  const { id } = derive(target, unb64(bank.kdf.salt), bank.kdf.iter);
  if (!bank.keys[id]) die('that code is not in the bank');
  delete bank.keys[id];
  writeFileSync(BANK, JSON.stringify(bank));
  console.log('revoked; ' + Object.keys(bank.keys).length + ' codes remain');
} else if (cmd === 'key') {
  const bank = loadBank();
  console.log(b64(contentKey(bank, opt('code'))));
} else if (cmd === 'export' || cmd === 'check') {
  const bank = loadBank();
  const K = contentKey(bank, opt('code'));
  const data = JSON.parse(open(K, bank.iv, bank.ct).toString('utf8'));
  if (cmd === 'check') {
    console.log(`ok: ${data.qs.length} questions decrypt, ${Object.keys(bank.keys).length} codes valid, built ${bank.built}`);
  } else {
    const out = resolve(opt('out') || join(ROOT, 'content'));
    mkdirSync(out, { recursive: true });
    const items = data.qs.map((q) => ({ id: q.id, theme: q.t, levels: q.l, kind: q.k === 's' ? 'situation' : 'connaissance', q: q.q, qz: q.qz, opts: q.o, optsz: q.oz, explain: q.e, vocab: q.v, src: q.s === undefined ? '' : (data.src[q.s] || [])[1] || '' }));
    writeFileSync(join(out, 'all.json'), JSON.stringify(items, null, 1));
    const sources = {}; for (const s of data.src || []) sources[s[1]] = s;
    writeFileSync(join(out, 'sources.json'), JSON.stringify(sources, null, 1));
    if (existsSync(FREE)) writeFileSync(join(out, 'free_ids.json'), JSON.stringify(JSON.parse(readFileSync(FREE, 'utf8')).qs.map((q) => q.id).sort(), null, 1));
    console.log(`exported ${items.length} questions to ${out}`);
  }
} else if (import.meta.url === 'file://' + process.argv[1]) {
  console.log('commands: build | codes | revoke | export | check | key   (see the header of this file)');
}
