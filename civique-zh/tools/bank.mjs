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
const LEVELS = ['csp', 'cr', 'nat'];
// free sample: knowledge questions per theme and per level, situational questions per theme, study cards per theme
const FREE_K = 6, FREE_S = 3, FREE_CARDS = 1;
const SKIP = ['free_ids.json', 'sources.json', 'cards.json', 'recall.json', 'free_cards.json'];

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
    if (!f.endsWith('.json') || SKIP.includes(f)) continue;
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
    // questions shared by several exams first: they serve several audiences at once
    for (const it of know.filter((x) => x.levels.length >= 2).sort((a, b) => b.levels.length - a.levels.length).slice(0, FREE_K)) free.add(it.id);
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

// study cards: content/cards.json = [{ id, theme, title, lead, points[], terms[[fr, zh]], src[] }]
function loadCards(dir) {
  const f = join(dir, 'cards.json');
  if (!existsSync(f)) return [];
  const cards = JSON.parse(readFileSync(f, 'utf8'));
  const errs = [], seen = new Set();
  for (const c of cards) {
    const bad = (m) => errs.push((c.id || '?') + ': ' + m);
    if (!c.id || seen.has(c.id)) bad('missing or duplicate id');
    seen.add(c.id);
    if (!THEMES.includes(c.theme)) bad('theme');
    if (typeof c.title !== 'string' || !zh.test(c.title)) bad('title');
    if (typeof c.lead !== 'string') bad('lead');
    if (!Array.isArray(c.points) || !c.points.length || c.points.some((x) => typeof x !== 'string' || !zh.test(x))) bad('points');
    if (!Array.isArray(c.terms) || c.terms.some((v) => !Array.isArray(v) || v.length !== 2)) bad('terms');
    if (!Array.isArray(c.src)) bad('src');
  }
  if (errs.length) { errs.slice(0, 30).forEach((e) => console.error('  ' + e)); die(errs.length + ' card errors'); }
  return cards.map((c, i) => ({ c, i })).sort((a, b) => THEMES.indexOf(a.c.theme) - THEMES.indexOf(b.c.theme) || a.i - b.i).map((x) => x.c);
}
// recollections of real sessions: content/recall.json = [{ when: "YYYY-MM", level?, note?, items: [{ ref: "<question id>", like? } | { text, kind?, theme? }] }]
// No names, accounts or links: only the month, the exam and what was asked.
function loadRecall(dir, items) {
  const f = join(dir, 'recall.json');
  if (!existsSync(f)) return [];
  const by = new Map(items.map((it) => [it.id, it]));
  const sessions = JSON.parse(readFileSync(f, 'utf8'));
  const errs = [];
  sessions.forEach((r, n) => {
    const bad = (m) => errs.push('recall #' + (n + 1) + ': ' + m);
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(r.when || '')) bad('when must be YYYY-MM');
    if (r.level && !LEVELS.includes(r.level)) bad('level');
    if (!Array.isArray(r.items) || !r.items.length) bad('items');
    for (const x of r.items || []) {
      if (x.ref ? !by.has(x.ref) : !(typeof x.text === 'string' && zh.test(x.text))) bad('item needs a known ref or a Chinese text: ' + JSON.stringify(x).slice(0, 60));
      if (!x.ref && x.theme && !THEMES.includes(x.theme)) bad('theme');
    }
    if (/@|https?:|xhs|小红书号|微信号/i.test(JSON.stringify(r))) bad('must not contain accounts or links');
  });
  if (errs.length) { errs.slice(0, 30).forEach((e) => console.error('  ' + e)); die(errs.length + ' recall errors'); }
  return sessions.slice().sort((a, b) => b.when.localeCompare(a.when)).map((r) => ({
    w: r.when, l: r.level || '', n: r.note || '',
    i: r.items.map((x) => {
      if (!x.ref) return { x: x.text, k: x.kind === 'situation' ? 's' : 'c', t: x.theme || '' };
      const it = by.get(x.ref);
      return Object.assign({ r: it.id, q: it.q, k: it.kind === 'situation' ? 's' : 'c', t: it.theme }, x.like ? { like: 1 } : {});
    }),
  }));
}

// ---------- commands ----------
if (cmd === 'build') {
  const dir = resolve(opt('content') || join(ROOT, 'content'));
  const items = loadContent(dir);
  // optional table of official source sheets: content/sources.json = { "<file name used in src>": ["title", "url"] }
  const srcFile = join(dir, 'sources.json');
  const sources = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : {};
  const cards = loadCards(dir);
  const recall = loadRecall(dir, items);
  const used = [...new Set(items.map((it) => it.src).concat(...cards.map((c) => c.src)).filter((s) => sources[s]))].sort();
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
  const allCards = cards.map((c) => ({ id: c.id, t: c.theme, title: c.title, lead: c.lead, p: c.points, v: c.terms, s: c.src.filter((x) => srcIndex.has(x)).map((x) => srcIndex.get(x)) }));
  let freeCards = new Set();
  const fc = join(dir, 'free_cards.json');
  if (existsSync(fc)) freeCards = new Set(JSON.parse(readFileSync(fc, 'utf8')));
  else for (const t of THEMES) allCards.filter((c) => c.t === t).slice(0, FREE_CARDS).forEach((c) => freeCards.add(c.id));
  const sealed = seal(K, Buffer.from(JSON.stringify({ qs: all, src: srcTable, cards: allCards }), 'utf8'));
  bank.iv = sealed.iv; bank.ct = sealed.ct; bank.n = all.length;
  const today = new Date().toISOString().slice(0, 10);
  bank.built = today;
  let consulted = typeof opt('consulted') === 'string' ? opt('consulted') : null;
  if (!consulted && existsSync(FREE)) { try { consulted = JSON.parse(readFileSync(FREE, 'utf8')).consulted || null; } catch { consulted = null; } }
  if (!consulted) consulted = today;
  const freeQs = all.filter((q) => freeIds.has(q.id));
  // the free file carries its own small source table
  const freeSrcIdx = [...new Set(freeQs.map((q) => q.s).filter((s) => s !== undefined).concat(...allCards.filter((c) => freeCards.has(c.id)).map((c) => c.s)))];
  const free = {
    v: 1, built: today, consulted,
    meta: { counts: counts(items), total: all.length, free: freeQs.length },
    src: freeSrcIdx.map((i) => srcTable[i]),
    qs: freeQs.map((q) => (q.s === undefined ? q : { ...q, s: freeSrcIdx.indexOf(q.s) })),
    // free cards in full, the others as a title only (x: locked, n: number of points)
    cards: allCards.map((c) => (freeCards.has(c.id) ? { ...c, s: c.s.map((i) => freeSrcIdx.indexOf(i)) } : { id: c.id, t: c.t, title: c.title, lead: c.lead, x: 1, n: c.p.length })),
    recall,
  };
  free.meta.cards = allCards.length;
  mkdirSync(DATA, { recursive: true });
  writeFileSync(BANK, JSON.stringify(bank));
  writeFileSync(FREE, JSON.stringify(free));
  console.log(`built: ${all.length} questions (${freeQs.length} free), ${allCards.length} study cards (${freeCards.size} free), ${recall.length} recalled sessions, ${Object.keys(bank.keys).length} code(s) valid`);
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
    const url = (i) => ((data.src || [])[i] || [])[1] || '';
    if ((data.cards || []).length) writeFileSync(join(out, 'cards.json'), JSON.stringify(data.cards.map((c) => ({ id: c.id, theme: c.t, title: c.title, lead: c.lead, points: c.p, terms: c.v, src: (c.s || []).map(url).filter(Boolean) })), null, 1));
    if (existsSync(FREE)) {
      const fr = JSON.parse(readFileSync(FREE, 'utf8'));
      writeFileSync(join(out, 'free_ids.json'), JSON.stringify(fr.qs.map((q) => q.id).sort(), null, 1));
      if ((fr.cards || []).length) writeFileSync(join(out, 'free_cards.json'), JSON.stringify(fr.cards.filter((c) => !c.x).map((c) => c.id), null, 1));
      if ((fr.recall || []).length) writeFileSync(join(out, 'recall.json'), JSON.stringify(fr.recall.map((r) => Object.assign({ when: r.w }, r.l ? { level: r.l } : {}, r.n ? { note: r.n } : {}, { items: r.i.map((x) => (x.r ? Object.assign({ ref: x.r }, x.like ? { like: true } : {}) : Object.assign({ text: x.x, kind: x.k === 's' ? 'situation' : 'connaissance' }, x.t ? { theme: x.t } : {}))) })), null, 1));
    }
    console.log(`exported ${items.length} questions to ${out}`);
  }
} else if (import.meta.url === 'file://' + process.argv[1]) {
  console.log('commands: build | codes | revoke | export | check | key   (see the header of this file)');
}
