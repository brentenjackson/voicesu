// Synthesize vowels with known resonances, check the pipeline recovers them.
import { lpc, formantsFromLpc, preEmphasis, hamming, detectPitch } from '../js/dsp.js';
import { synth as synthAt } from './synth.js';

const SR = 11025;
const N = 512;
const synth = (formants, f0, n, sr = SR) => synthAt(formants, f0, n, sr);

const CASES = [
  { name: 'i  (close front)', f1: 280, f2: 2250, f3: 2900 },
  { name: 'ɑ  (open back)',   f1: 730, f2: 1090, f3: 2440 },
  { name: 'u  (close back)',  f1: 310, f2: 870,  f3: 2250 },
  { name: 'ɛ  (open-mid fr)', f1: 550, f2: 1770, f3: 2490 },
  { name: 'æ  (near-open)',   f1: 690, f2: 1660, f3: 2490 },
];

const win = hamming(N);
let failures = 0;

console.log(`LPC formant recovery @ ${SR} Hz, frame ${N}, order 13\n`);
for (const c of CASES) {
  for (const f0 of [100, 150, 220]) {
    const sig = synth(
      [{ f: c.f1, bw: 60 }, { f: c.f2, bw: 90 }, { f: c.f3, bw: 120 }, { f: 3500, bw: 200 }],
      f0, N
    );
    // Normalize, then run the exact production path.
    let peak = 0;
    for (const v of sig) peak = Math.max(peak, Math.abs(v));
    const norm = Float64Array.from(sig, (v) => v / peak);

    const emph = preEmphasis(norm);
    for (let i = 0; i < N; i++) emph[i] *= win[i];

    const model = lpc(emph, 13);
    const fs = formantsFromLpc(model.a, SR, { minF: 150, maxF: 5000, maxBw: 500 });

    const gotF1 = fs[0]?.freq ?? 0;
    const gotF2 = fs[1]?.freq ?? 0;
    const e1 = Math.abs(gotF1 - c.f1);
    const e2 = Math.abs(gotF2 - c.f2);
    // 8% relative error is well inside what matters for chart position.
    const ok = e1 < Math.max(50, c.f1 * 0.08) && e2 < Math.max(50, c.f2 * 0.08);
    if (!ok) failures++;

    const pitch = detectPitch(norm, SR);
    const pitchOk = Math.abs(pitch.f0 - f0) / f0 < 0.06;
    if (!pitchOk) failures++;

    console.log(
      `${ok && pitchOk ? 'PASS' : 'FAIL'}  ${c.name}  f0=${f0}  ` +
      `F1 ${gotF1.toFixed(0)} (want ${c.f1}, err ${e1.toFixed(0)})  ` +
      `F2 ${gotF2.toFixed(0)} (want ${c.f2}, err ${e2.toFixed(0)})  ` +
      `f0est ${pitch.f0.toFixed(0)} clarity ${pitch.clarity.toFixed(2)}`
    );
  }
}


// Decimation fallback: browsers that won't grant an 11 kHz AudioContext hand us
// 44.1/48 kHz, and tracker.js decimates by an integer factor. Same path, so it
// needs the same guarantees -- a silent break here only shows up in Firefox.
console.log('\nDecimation fallback (48 kHz hardware -> 12 kHz analysis):');
const HW_SR = 48000;
const DECIM = Math.round(HW_SR / SR);       // 4, matching tracker.js
const EFF_SR = HW_SR / DECIM;               // 12000
const ORDER = Math.min(24, Math.max(8, Math.round(EFF_SR / 1000) + 2));

for (const c of CASES) {
  const hw = synth(
    [{ f: c.f1, bw: 60 }, { f: c.f2, bw: 90 }, { f: c.f3, bw: 120 }, { f: 3500, bw: 200 }],
    150, N * DECIM, HW_SR
  );
  // Straight subsampling, as in tracker.js -- the graph's biquad is the anti-alias filter.
  const dec = new Float64Array(N);
  for (let i = 0; i < N; i++) dec[i] = hw[i * DECIM];

  let peak = 0;
  for (const v of dec) peak = Math.max(peak, Math.abs(v));
  const norm = Float64Array.from(dec, (v) => v / peak);

  const emph = preEmphasis(norm);
  for (let i = 0; i < N; i++) emph[i] *= win[i];

  const model = lpc(emph, ORDER);
  const fs = formantsFromLpc(model.a, EFF_SR, { minF: 150, maxF: 5000, maxBw: 500 });
  const gotF1 = fs[0]?.freq ?? 0;
  const gotF2 = fs[1]?.freq ?? 0;
  const e1 = Math.abs(gotF1 - c.f1), e2 = Math.abs(gotF2 - c.f2);
  const ok = e1 < Math.max(60, c.f1 * 0.1) && e2 < Math.max(60, c.f2 * 0.1);
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name}  order=${ORDER}  ` +
    `F1 ${gotF1.toFixed(0)} (want ${c.f1})  F2 ${gotF2.toFixed(0)} (want ${c.f2})`
  );
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
