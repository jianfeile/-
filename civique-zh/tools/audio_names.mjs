// File names of the recordings and the text handed to the voice. The same functions are in site/app.js
// (akey, clipName, forVoice); tools/test.cjs checks that both sides agree.
export function akey(t) { return String(t).normalize('NFC').replace(/[’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase(); }
export function clipName(t) {
  const s = akey(t); let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = (Math.imul(b + c, 0x9e3779b1) ^ (b >>> 15)) >>> 0; }
  return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
}
const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function fromRoman(r) { let n = 0; for (let i = 0; i < r.length; i++) { const a = ROMAN[r[i]], b = ROMAN[r[i + 1]] || 0; n += a < b ? -a : a; } return n; }
export function forVoice(text) {
  return String(text)
    .replace(/\b([IVXLC]+)(er|re|e|ème|eme)\b/g, (m, r, suf) => { const n = fromRoman(r); return n > 0 && n < 400 ? n + (suf === 'ème' || suf === 'eme' ? 'e' : suf) : m; })
    .replace(/\b(Louis|Napoléon|Charles|François|Henri|Philippe|Clovis|Jean|Léon|Pie|Benoît)(-[A-Z][a-zé]+)?\s+([IVXLC]{1,6})\b/g, (m, name, extra, r) => { const n = fromRoman(r); return n > 0 && n < 100 ? name + (extra || '') + ' ' + n : m; })
    .replace(/[«»]/g, ' ').replace(/\s+/g, ' ').trim();
}
