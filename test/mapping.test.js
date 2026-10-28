// Verify the formant -> chart mapping: corners, regions, and monotonicity.
import { PRESETS, buildCalibration, formantsToChart, nearestVowel } from '../js/vowels.js';

const cal = buildCalibration(PRESETS.male);
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// 1. The calibration corners must pin to the corners of the quadrilateral.
console.log('Corners:');
for (const [key, wantB, wantH] of [
  ['closeFront', 0, 0], ['closeBack', 1, 0], ['openFront', 0, 1], ['openBack', 1, 1],
]) {
  const [f1, f2] = PRESETS.male[key];
  const p = formantsToChart(f1, f2, cal);
  check(
    Math.abs(p.backness - wantB) < 0.02 && Math.abs(p.height - wantH) < 0.02,
    `${key.padEnd(11)} back=${p.backness.toFixed(2)} (want ${wantB})  height=${p.height.toFixed(2)} (want ${wantH})`
  );
}

// 2. Peterson-Barney adult-male vowels must land in the right region.
// Ranges, not exact nodes: English lax vowels genuinely sit off the cardinal
// positions, so demanding an exact node match would be testing the wrong thing.
console.log('\nRegions (backness 0=front 1=back, height 0=close 1=open):');
const CASES = [
  { label: 'i  heed',  f1: 280, f2: 2250, b: [-0.1, 0.15], h: [-0.1, 0.15] },
  { label: 'ɪ  hid',   f1: 400, f2: 1920, b: [-0.1, 0.35], h: [0.10, 0.50] },
  { label: 'ɛ  head',  f1: 550, f2: 1770, b: [-0.1, 0.35], h: [0.40, 0.85] },
  { label: 'æ  had',   f1: 690, f2: 1660, b: [-0.1, 0.30], h: [0.80, 1.10] },
  { label: 'ɑ  hod',   f1: 730, f2: 1090, b: [0.70, 1.10], h: [0.80, 1.10] },
  { label: 'ʌ  hud',   f1: 640, f2: 1190, b: [0.50, 1.05], h: [0.60, 1.00] },
  { label: 'ɔ  hawed', f1: 570, f2: 840,  b: [0.75, 1.30], h: [0.30, 0.80] },
  { label: 'ʊ  hood',  f1: 440, f2: 1020, b: [0.60, 1.10], h: [0.10, 0.50] },
  { label: 'u  who',   f1: 310, f2: 870,  b: [0.85, 1.10], h: [-0.1, 0.15] },
  { label: 'ə  schwa', f1: 500, f2: 1500, b: [0.20, 0.75], h: [0.30, 0.75] },
];
for (const c of CASES) {
  const p = formantsToChart(c.f1, c.f2, cal);
  const near = nearestVowel(p.backness, p.height);
  check(
    p.backness >= c.b[0] && p.backness <= c.b[1] && p.height >= c.h[0] && p.height <= c.h[1],
    `${c.label}  back=${p.backness.toFixed(2)} ∈[${c.b}]  height=${p.height.toFixed(2)} ∈[${c.h}]` +
    `  nearest [${near.vowel.s.join(' ')}]`
  );
}

// 3. Monotonicity: raising F1 must open the vowel; raising F2 must front it.
console.log('\nMonotonicity:');
let prevH = -Infinity, monoH = true;
for (let f1 = 250; f1 <= 900; f1 += 50) {
  const h = formantsToChart(f1, 1500, cal).height;
  if (h < prevH) monoH = false; // ties allowed: clamp saturation
  prevH = h;
}
check(monoH, 'height never decreases as F1 rises (F2 fixed at 1500)');

let prevB = Infinity, monoB = true;
for (let f2 = 800; f2 <= 2600; f2 += 100) {
  const b = formantsToChart(500, f2, cal).backness;
  if (b > prevB) monoB = false; // ties allowed: clamp saturation
  prevB = b;
}
check(monoB, 'backness never increases as F2 rises (F1 fixed at 500)');

// 4. Every preset must place its own corners correctly -- catches a preset typo.
console.log('\nAll presets self-consistent:');
for (const [name, ref] of Object.entries(PRESETS)) {
  const c = buildCalibration(ref);
  let ok = true;
  for (const [key, wb, wh] of [
    ['closeFront', 0, 0], ['closeBack', 1, 0], ['openFront', 0, 1], ['openBack', 1, 1],
  ]) {
    const p = formantsToChart(ref[key][0], ref[key][1], c);
    if (Math.abs(p.backness - wb) > 0.02 || Math.abs(p.height - wh) > 0.02) ok = false;
  }
  check(ok, `${name} preset maps its own corners to the quad corners`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
