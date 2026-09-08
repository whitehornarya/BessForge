import { generateFeeders } from '../client/src/lib/nextera/feeders';
import type { Pt } from '../client/src/lib/nextera/types';

const properCross = (a: Pt, b: Pt, c: Pt, d2: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d2), o3 = o(c, d2, a), o4 = o(c, d2, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
};

const a2erW = {
  id: 'inv-a2er-W', kind: 'inverter' as const, label: 'PCS W',
  x: 40, y: 40, rotation: 0, length: 22, width: 8,
};
const a2erE = {
  id: 'inv-a2er-E', kind: 'inverter' as const, label: 'PCS E',
  x: 100, y: 40, rotation: 0, length: 22, width: 8,
};
const a2erBess = [a2erW, a2erE].flatMap(p => [1, 2].map(k => ({
  id: `bess-${p.id}-${k}`, kind: 'bess' as const, label: 'CON',
  x: p.x - 22, y: p.y + (k === 1 ? -6 : 6), rotation: 0, length: 16, width: 8,
})));
const a2erFence: Pt[] = [
  { x: -40, y: -40 }, { x: 280, y: -40 },
  { x: 280, y: 260 }, { x: -40, y: 260 },
];
const a2erSub: Pt = { x: 70, y: 220 };
const a2erFeeders = generateFeeders({
  fence: a2erFence, boundary: { polygon: a2erFence },
  equipment: [a2erW, a2erE, ...a2erBess],
  cables: [a2erW, a2erE].map(p => ({
    id: `mv-drop-${p.id}`, class: 'MV' as const,
    pts: [{ x: p.x, y: p.y }, { x: p.x, y: p.y - 5 }],
  })),
  aisles: [{ x: 160, y: 40, length: 200, width: 24, rotation: Math.PI / 2 }],
  roads: [], tracedPcsUnits: 2,
} as any, a2erSub, 5, { maxPerFeeder: 1, approach: 'N' });
const wHome = a2erFeeders.find(f => f.inverterIds.includes('inv-a2er-W'))?.segments.slice(-1)[0]?.pts ?? [];
const eHome = a2erFeeders.find(f => f.inverterIds.includes('inv-a2er-E'))?.segments.slice(-1)[0]?.pts ?? [];
let cross = 0;
for (let i = 0; i < wHome.length - 1; i++) {
  for (let j = 0; j < eHome.length - 1; j++) {
    if (properCross(wHome[i], wHome[i + 1], eHome[j], eHome[j + 1])) cross++;
  }
}
console.log('a2er cross', cross);
console.log('W', wHome.map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('→'));
console.log('E', eHome.map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('→'));

const gapL = {
  id: 'inv-gap-L', kind: 'inverter' as const, label: 'PCS L',
  x: 20, y: 40, rotation: 0, length: 22, width: 8,
};
const gapR = {
  id: 'inv-gap-R', kind: 'inverter' as const, label: 'PCS R',
  x: 180, y: 40, rotation: 0, length: 22, width: 8,
};
const gapBess = [gapL, gapR].flatMap(p => [1, 2].map(k => ({
  id: `bess-${p.id}-${k}`, kind: 'bess' as const, label: 'CON',
  x: p.x - 22, y: p.y + (k === 1 ? -6 : 6), rotation: 0, length: 16, width: 8,
})));
const gapFeeders = generateFeeders({
  fence: a2erFence, boundary: { polygon: a2erFence },
  equipment: [gapL, gapR, ...gapBess],
  cables: [gapL, gapR].map(p => ({
    id: `mv-drop-${p.id}`, class: 'MV' as const,
    pts: [{ x: p.x, y: p.y }, { x: p.x, y: p.y - 5 }],
  })),
  aisles: [{ x: 100, y: 40, length: 200, width: 24, rotation: Math.PI / 2 }],
  roads: [], tracedPcsUnits: 2,
} as any, { x: 100, y: 220 }, 5, { maxPerFeeder: 1, approach: 'N' });
const gapBox = { x1: 50, x2: 150, y1: 25, y2: 55 };
let through = 0;
for (const f of gapFeeders) {
  const home = f.segments.slice(-1)[0]?.pts ?? [];
  console.log(f.inverterIds[0], home.map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('→'));
  for (let i = 0; i < home.length - 1; i++) {
    const a = home[i], b = home[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(2, Math.ceil(len / 4));
    for (let s = 1; s < n; s++) {
      const t = s / n;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x > gapBox.x1 && x < gapBox.x2 && y > gapBox.y1 && y < gapBox.y2) through++;
    }
  }
}
console.log('throughGap', through);
