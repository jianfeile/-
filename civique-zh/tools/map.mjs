#!/usr/bin/env node
// Draws the map of 考前一页: writes the `map` object of site/data/sheet.json (outline paths and projected labels).
//
// Outline: Natural Earth 1:50m admin-0 countries (public domain, naturalearthdata.com) as packaged by the npm
// module `world-atlas` (ISC licence), read and simplified with `topojson-client` / `topojson-simplify` (ISC).
// Nothing from these packages is copied into the repository except the simplified outline this script prints.
//
// How to run (the packages are NOT dependencies of the site; install them anywhere outside the repository):
//   mkdir /tmp/mapdeps && cd /tmp/mapdeps && npm init -y && npm install world-atlas topojson-client topojson-simplify
//   node tools/map.mjs /tmp/mapdeps            # rewrites the "map" key of site/data/sheet.json
//   node tools/map.mjs /tmp/mapdeps --print    # prints the object instead
//
// Projection: equirectangular with a cos(latitude) correction at 46.5°N, the same for the outline and every label.
// Rivers are smoothed lines through a handful of real coordinates (source, towns on the course, mouth): a sketch,
// and the page says so. Every label names the question or study card that supports it (`s`), see LABELS below.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deps = process.argv[2];
if (!deps) { console.error('usage: node tools/map.mjs <dir where world-atlas and topojson-client are installed> [--print]'); process.exit(1); }
const require = createRequire(join(resolve(deps), 'x.js'));
const topojson = { ...require('topojson-client'), ...require('topojson-simplify') };
const world = require('world-atlas/countries-50m.json');

// ---- projection
const W = 340, LON0 = -5.75, LAT0 = 52.15, K = 30.4, COS = Math.cos(46.5 * Math.PI / 180);
const px = (lon) => (lon - LON0) * COS * K, py = (lat) => (LAT0 - lat) * K;
const r1 = (v) => Math.round(v * 10) / 10;
const H_MAP = Math.ceil(py(40.62));           // bottom of the drawing (south of Corsica)
const inBox = ([lon, lat]) => lon > -6 && lon < 10.2 && lat > 41 && lat < 51.6;

// ---- outline: simplify the shared arcs once so that the fill, the coast and the borders stay on the same points
const FR = '250';
let topo = topojson.presimplify(world);
topo = topojson.simplify(topo, 0.0035);        // triangle area in square degrees: about 330 points for France
const countries = topo.objects.countries;
const fr = countries.geometries.find((g) => g.id === FR);
const pathOf = (line, close) => {
  let d = '', x0 = 0, y0 = 0;
  line.forEach(([lon, lat], i) => {
    const x = r1(px(lon)), y = r1(py(lat));
    if (!i) d += 'M' + x + ' ' + y;
    else if (x !== x0 || y !== y0) { const dx = r1(x - x0), dy = r1(y - y0); d += 'l' + dx + (dy < 0 ? '' : ' ') + dy; }
    if (!i || x !== x0 || y !== y0) { x0 = x; y0 = y; }
  });
  return d + (close ? 'z' : '');
};
const span = (line) => { const xs = line.map((p) => px(p[0])), ys = line.map((p) => py(p[1])); return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)); };
const polys = topojson.feature(topo, fr).geometry.coordinates.filter((p) => p[0].every(inBox) && span(p[0]) > 6);   // mainland and Corsica; islets dropped
const land = polys.map((p) => pathOf(p[0], true)).join('');
const lines = (filter) => topojson.mesh(topo, { type: 'GeometryCollection', geometries: [fr] }, filter).coordinates.filter((l) => l.every(inBox) && span(l) > 6);
// with only France in the collection every arc is seen once: (a, b) are both France, so tell coast from border
// by asking the whole world instead
const isFr = (g) => g.id === FR;
const coast = topojson.mesh(topo, countries, (a, b) => a === b && isFr(a)).coordinates.filter((l) => l.every(inBox) && span(l) > 6).map((l) => pathOf(l)).join('');
const border = topojson.mesh(topo, countries, (a, b) => a !== b && (isFr(a) || isFr(b))).coordinates.filter((l) => l.every(inBox)).map((l) => pathOf(l)).join('');
void lines;

// ---- rivers: Catmull-Rom through real points, written as cubic Béziers
const smooth = (pts) => {
  const p = pts.map(([lat, lon]) => [px(lon), py(lat)]);
  let d = 'M' + r1(p[0][0]) + ' ' + r1(p[0][1]);
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[Math.max(0, i - 1)], b = p[i], c = p[i + 1], e = p[Math.min(p.length - 1, i + 2)];
    d += 'C' + [b[0] + (c[0] - a[0]) / 6, b[1] + (c[1] - a[1]) / 6, c[0] - (e[0] - b[0]) / 6, c[1] - (e[1] - b[1]) / 6, c[0], c[1]].map(r1).join(' ');
  }
  return d;
};

// ---- what is on the map. [lat, lon] of the place; dx, dy move the label (map units), a = text-anchor.
// s = where the bank supports it: a question id (its correct answer or its explanation) or a study card id.
const LABELS = {
  seas: [
    { k: '北海', fr: 'mer du Nord', at: [51.62, 1.7], s: 'H068' },
    { k: '英吉利海峡', fr: 'la Manche', at: [50.15, -2.4], s: 'H071' },
    { k: '大西洋', fr: 'océan Atlantique', at: [46.0, -3.6], s: 'H023' },
    { k: '地中海', fr: 'mer Méditerranée', at: [42.3, 4.9], s: 'H030' }
  ],
  lands: [   // the 8 neighbours of K-CK5-02 / H069, and England across the Channel (H071)
    { k: '英国', fr: 'Angleterre', at: [51.55, -2.6], s: 'H071' },
    { k: '比利时', fr: 'Belgique', at: [50.72, 4.75], s: 'H077' },
    { k: '卢森堡', fr: 'Luxembourg', at: [50.02, 6.2], s: 'H078' },
    { k: '德国', fr: 'Allemagne', at: [50.45, 8.45], s: 'K-CK5-02' },
    { k: '瑞士', fr: 'Suisse', at: [47.0, 8.15], s: 'K-CK5-02' },
    { k: '意大利', fr: 'Italie', at: [44.85, 8.6], s: 'H069' },
    { k: '摩纳哥', fr: 'Monaco', at: [43.74, 7.42], dx: 3, dy: 13, a: 'start', dot: 1, s: 'K-CK5-02' },
    { k: '西班牙', fr: 'Espagne', at: [41.95, -0.9], s: 'K-CK5-02' },
    { k: '安道尔', fr: 'Andorre', at: [42.52, 1.55], dx: 0, dy: 15, a: 'middle', dot: 1, s: 'K-CK5-02' }
  ],
  cities: [
    { k: '巴黎', fr: 'Paris', at: [48.857, 2.352], cap: 1, dx: 7, dy: -5, a: 'start', s: 'H025' },
    { k: '里尔', fr: 'Lille', at: [50.63, 3.06], dx: -6, dy: 4, a: 'end', s: 'K-CK5-03' },
    { k: '勒阿弗尔', fr: 'Le Havre', at: [49.49, 0.11], dx: -3, dy: 14, a: 'middle', s: 'H070' },
    { k: '雷恩', fr: 'Rennes', at: [48.11, -1.68], dx: -6, dy: 4, a: 'end', s: 'H134' },
    { k: '南特', fr: 'Nantes', at: [47.22, -1.55], dx: 2, dy: 15, a: 'middle', s: 'K-CK5-03' },
    { k: '斯特拉斯堡', fr: 'Strasbourg', at: [48.58, 7.75], dx: -6, dy: -5, a: 'end', s: 'I077' },
    { k: '里昂', fr: 'Lyon', at: [45.76, 4.84], dx: -6, dy: 2, a: 'end', s: 'H133' },
    { k: '波尔多', fr: 'Bordeaux', at: [44.84, -0.58], dx: 7, dy: -3, a: 'start', s: 'H083' },
    { k: '图卢兹', fr: 'Toulouse', at: [43.6, 1.44], dx: 7, dy: 1, a: 'start', s: 'K-CK5-03' },
    { k: '马赛', fr: 'Marseille', at: [43.3, 5.37], dx: -2, dy: -7, a: 'middle', s: 'H131' },
    { k: '尼斯', fr: 'Nice', at: [43.7, 7.27], dx: -3, dy: -7, a: 'middle', s: 'H031' }
  ],
  rivers: [
    { k: '塞纳河', fr: 'la Seine', pts: [[47.49, 4.72], [48.3, 4.08], [48.857, 2.352], [49.44, 1.1], [49.45, 0.25]], at: [48.45, 3.5], dx: 0, dy: 12, a: 'middle', s: 'H076' },
    { k: '卢瓦尔河', fr: 'la Loire', pts: [[44.84, 4.22], [46.04, 4.07], [46.99, 3.16], [47.9, 1.91], [47.39, 0.69], [47.22, -1.55], [47.28, -2.18]], at: [47.6, 0.9], dx: 0, dy: -5, a: 'middle', s: 'H021' },
    { k: '加龙河', fr: 'la Garonne', pts: [[42.7, 0.75], [43.6, 1.44], [44.2, 0.62], [44.84, -0.58], [45.55, -1.05]], at: [44.0, 0.2], dx: 0, dy: 0, a: 'middle', s: 'K-CK5-02' },
    { k: '罗讷河', fr: 'le Rhône', pts: [[46.1, 7.07], [46.4, 6.9], [46.2, 6.15], [45.76, 4.84], [44.93, 4.89], [43.95, 4.81], [43.68, 4.63], [43.35, 4.84]], at: [44.4, 4.85], dx: 5, dy: 4, a: 'start', s: 'K-CK5-02' },
    { k: '莱茵河', fr: 'le Rhin', pts: [[47.66, 9.18], [47.56, 7.59], [48.58, 7.8], [49.0, 8.28], [49.49, 8.46]], at: [48.05, 7.6], dx: 6, dy: 4, a: 'start', sea: 1, s: 'K-CK5-02' }
  ],
  mounts: [   // peaks: where the little chevrons are drawn; at: where the name goes
    { k: '比利牛斯山', fr: 'les Pyrénées', peaks: [[43.0, -0.75], [42.83, 0.15], [42.72, 1.0], [42.55, 2.1]], at: [43.05, -0.3], dx: 0, dy: -8, a: 'middle', s: 'H073' },
    { k: '阿尔卑斯山', fr: 'les Alpes', peaks: [[45.35, 6.55], [44.85, 6.5], [44.35, 6.75]], at: [44.85, 6.5], dx: -8, dy: 4, a: 'end', s: 'H033' },
    { k: '中央高原', fr: 'Massif central', peaks: [[45.55, 2.85], [45.1, 2.75], [44.7, 2.95]], at: [44.45, 3.0], dx: 0, dy: 4, a: 'middle', s: 'K-CK5-02' },
    { k: '汝拉山', fr: 'le Jura', peaks: [[46.45, 5.95], [46.85, 6.35]], at: [46.85, 6.0], dx: -8, dy: 0, a: 'end', s: 'K-CK5-02' },
    { k: '孚日山', fr: 'les Vosges', peaks: [[47.95, 6.95], [48.35, 7.1]], at: [48.15, 6.85], dx: -8, dy: 5, a: 'end', s: 'K-CK5-02' }
  ],
  tops: [
    { k: '勃朗峰', fr: 'mont Blanc', at: [45.833, 6.865], dx: -8, dy: -1, a: 'end', s: 'H126' }
  ],
  isles: [
    { k: '科西嘉', fr: 'Corse', at: [41.0, 9.0], dx: 0, dy: 0, a: 'middle', s: 'H032' }
  ]
};
// the five overseas departments (K-CK5-01), listed under the map by sea
const DOM = [
  { sea: '加勒比海', s: 'H125', items: [{ k: '瓜德罗普', fr: 'Guadeloupe' }, { k: '马提尼克', fr: 'Martinique' }] },
  { sea: '南美洲', s: 'H128', items: [{ k: '圭亚那', fr: 'Guyane' }] },
  { sea: '印度洋', s: 'H127', items: [{ k: '留尼汪', fr: 'La Réunion' }, { k: '马约特', fr: 'Mayotte' }] }
];

const place = (o) => {
  const out = { k: o.k, fr: o.fr, x: r1(px(o.at[1]) + (o.dx || 0)), y: r1(py(o.at[0]) + (o.dy || 0)), s: o.s };
  if (o.a) out.a = o.a;
  if (o.cap) out.cap = 1;
  if (o.sea) out.sea = 1;   // the label sits outside the land: no land-coloured halo
  if (o.dx !== undefined || o.dot || o.cap) out.p = [r1(px(o.at[1])), r1(py(o.at[0]))];   // the dot itself
  if (o.pts) out.d = smooth(o.pts);
  if (o.peaks) out.pk = o.peaks.map(([lat, lon]) => [r1(px(lon)), r1(py(lat))]);
  return out;
};
const map = {
  note: 'generated by tools/map.mjs (outline: Natural Earth 1:50m, public domain, via world-atlas). Do not edit by hand.',
  w: W, h: H_MAP, land, coast, border, dom: DOM
};
Object.keys(LABELS).forEach((g) => { map[g] = LABELS[g].map(place); });

const points = (land.match(/[Ml]/g) || []).length;
if (process.argv.includes('--print')) console.log(JSON.stringify(map, null, 1));
else {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data', 'sheet.json');
  const sheet = JSON.parse(readFileSync(file, 'utf8'));
  sheet.map = map;
  writeFileSync(file, JSON.stringify(sheet));
}
console.error('map: ' + W + ' x ' + H_MAP + ', outline ' + points + ' points, ' + Math.round(JSON.stringify(map).length / 102.4) / 10 + ' KB of data');
