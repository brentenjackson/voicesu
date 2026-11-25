// The WebAssembly back end against the JavaScript one, frame by frame: same
// voicing, same LPC coefficients, same formants, and the same smoothed
// output from the full engine. Differences may only come from rounding in the
// math library (atan2, log, hypot), so the tolerances are tight.
import { compileDsp, WasmDsp, WasmLpcEngine } from '../js/engines/wasm.js';
import { LpcEngine, measureVoicing } from '../js/engines/lpc.js';
import { synth, normalize } from './synth.js';

const SR = 11025;
const N = 512;
const GATE = { rms: 0.008, clarity: 0.5 };

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const dsp = await WasmDsp.create(await compileDsp());

// Vowels across the pitch range, plus frames that exercise the edge cases.
const VOWELS = [
  [280, 2250, 2900], [730, 1090, 2440], [310, 870, 2250], [550, 1770, 2490],
  [690, 1660, 2490], [450, 2750, 3400], [1000, 1450, 3300],
];
const frames = [];
for (const [f1, f2, f3] of VOWELS) {
  for (const f0 of [90, 120, 160, 220, 300, 400, 500]) {
    const x = synth([{ f: f1, bw: 60 }, { f: f2, bw: 90 }, { f: f3, bw: 120 }, { f: 3500, bw: 200 }], f0, N, SR);
    frames.push({ name: `${f1}/${f2} at ${f0} Hz`, x: normalize(x, 0.4) });
  }
}
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
frames.push({ name: 'white noise', x: Float64Array.from({ length: N }, () => 0.1 * rand()) });
frames.push({ name: 'silence', x: new Float64Array(N) });
frames.push({ name: 'one click', x: Float64Array.from({ length: N }, (_, i) => (i === 100 ? 1 : 0)) });

console.log(`Per frame, ${frames.length} frames:`);
let worstVoicing = 0, worstA = 0, worstF = 0, mismatched = 0;
for (const { name, x } of frames) {
  const vj = measureVoicing(x, SR, GATE);
  const vw = dsp.measureVoicing(x, SR, GATE);
  const dv = Math.max(Math.abs(vj.rms - vw.rms), Math.abs(vj.f0 - vw.f0), Math.abs(vj.clarity - vw.clarity));
  worstVoicing = Math.max(worstVoicing, dv);
  if (vj.voiced !== vw.voiced) { mismatched++; console.log(`      voicing differs on ${name}`); }

  const js = new LpcEngine(SR).analyzeFrame(x);
  const wa = new WasmLpcEngine(SR, dsp).analyzeFrame(x);
  if ((js.model === null) !== (wa.model === null) || js.formants.length !== wa.formants.length) {
    mismatched++;
    console.log(`      ${name}: JS ${js.formants.length} formants, wasm ${wa.formants.length}`);
    continue;
  }
  if (js.model) {
    for (let i = 0; i < js.model.a.length; i++) worstA = Math.max(worstA, Math.abs(js.model.a[i] - wa.model.a[i]));
  }
  js.formants.forEach((p, i) => {
    worstF = Math.max(worstF, Math.abs(p.freq - wa.formants[i].freq), Math.abs(p.bw - wa.formants[i].bw));
  });
}
check(mismatched === 0, 'same silence handling, voicing decisions and formant counts on every frame');
check(worstVoicing < 1e-9, `voicing (rms, f0, clarity) within ${worstVoicing.toExponential(1)}`);
check(worstA < 1e-9, `LPC coefficients within ${worstA.toExponential(1)}`);
check(worstF < 1e-6, `formant frequencies and bandwidths within ${worstF.toExponential(1)} Hz`);

// The whole engine: gate, median filter and smoothing over a stream of frames.
console.log('\nFull engine over a gliding stream:');
{
  const js = new LpcEngine(SR);
  const wa = new WasmLpcEngine(SR, dsp);
  let worst = 0;
  for (let step = 0; step < 60; step++) {
    const t = step / 59;
    const f1 = 300 + 400 * t, f2 = 2200 - 1100 * t;
    const x = normalize(synth([{ f: f1, bw: 60 }, { f: f2, bw: 90 }, { f: 2500, bw: 120 }, { f: 3500, bw: 200 }],
      130, N, SR), 0.4);
    const v = measureVoicing(x, SR, GATE);
    const a = js.process(x, v), b = wa.process(x, v);
    worst = Math.max(worst, Math.abs(a.f1 - b.f1), Math.abs(a.f2 - b.f2));
  }
  check(worst < 1e-6, `smoothed F1/F2 identical within ${worst.toExponential(1)} Hz over 60 frames`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
