#!/usr/bin/env node
// Lists every French text the app can read aloud, with the file name of its recording.
//   node tools/audio.mjs --content <dir with the question and card JSON files> > clips.json
// Then: python tools/audio_gen.py clips.json site/audio <voice.onnx>   (see that file)
// The recordings replace the phone's own voice, which many phones do not have for French. The app looks a clip up
// by a key computed from the text (same functions as in site/app.js: akey, clipName, forVoice); a missing clip falls
// back to the phone's voice, so the list only needs to cover what is commonly tapped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const at = process.argv.indexOf('--content');
if (at < 0) { console.error('usage: node tools/audio.mjs --content <dir> > clips.json'); process.exit(1); }
const dir = process.argv[at + 1];

import { akey, clipName, forVoice } from './audio_names.mjs';
const WORD_RE = /([A-Za-zÀ-ÿœæŒÆ]+['’])|([A-Za-zÀ-ÿœæŒÆ]+(?:-[A-Za-zÀ-ÿœæŒÆ]+)*)/g;

const clips = new Map();     // file name -> { t: text for the voice, kind }
function add(text, kind) {
  const t = String(text || '').trim(); if (!t) return;
  const name = clipName(t), old = clips.get(name);
  if (old && akey(old.src) !== akey(t)) throw new Error('two texts share a file name: ' + old.src + ' / ' + t);
  if (!old) clips.set(name, { k: name, t: forVoice(t), src: t, kind });
}
function words(text) {
  let m, prev = null; WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) {
    const w = m[0];
    if (prev && prev.end === m.index) add(prev.w + w, 'word');        // "l'" + "infraction": read together, as the app does
    if (!/['’]$/.test(w)) add(w, 'word');
    prev = /['’]$/.test(w) ? { w, end: m.index + w.length } : null;
  }
}
for (const L of ['A', 'B', 'C', 'D']) add(L, 'letter');
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  let data; try { data = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) { continue; }
  if (!Array.isArray(data)) continue;
  for (const x of data) {
    if (x && typeof x.q === 'string' && Array.isArray(x.opts)) {
      add(x.q, 'stem'); words(x.q);
      for (const o of x.opts) { add(o, 'option'); words(o); }
      for (const v of x.vocab || []) add(v[0], 'vocab');
    } else if (x && Array.isArray(x.terms)) {
      for (const v of x.terms) add(v[0], 'vocab');
    }
  }
}
const out = [...clips.values()].map(({ k, t, kind }) => ({ k, t, kind }));
process.stdout.write(JSON.stringify(out));
const count = {}; for (const c of out) count[c.kind] = (count[c.kind] || 0) + 1;
console.error(out.length + ' clips', JSON.stringify(count));
