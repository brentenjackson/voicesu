// Benchmark core, shared by the Node runner (test/bench-backends.mjs) and the
// browser one (test/bench-backends.html): time the per-frame pipeline on the
// JavaScript and WebAssembly back ends, on identical frames.
//
// Three stages, each timed over the whole frame set many times (batch timing,
// since browser timers are coarse), backends interleaved trial by trial so
// drift in clock speed hits both alike:
//   voicing   measureVoicing: RMS and the autocorrelation pitch detector
//   lpc       LpcEngine.analyzeFrame: LPC, root finding, formant filtering
//   pipeline  what the analysis worker does per frame with LPC on:
//             voicing, then the engine's full process() (gate, median,
//             smoothing, the scope's envelope)

import { LpcEngine, measureVoicing } from '../js/engines/lpc.js';
import { lpcEnvelope } from '../js/dsp.js';
import { WasmLpcEngine } from '../js/engines/wasm.js';
import { synth, normalize } from './synth.js';

const GATE = { rms: 0.008, clarity: 0.5 };

/** Seven vowels at f0 from 100 to 400 Hz, plus a few unvoiced frames: 120 frames. */
export function syntheticFrames(sr = 11025, n = 512) {
  const vowels = [
    [280, 2250, 2900], [730, 1090, 2440], [310, 870, 2250], [550, 1770, 2490],
    [690, 1660, 2490], [450, 2750, 3400], [1000, 1450, 3300],
  ];
  const frames = [];
  for (const [f1, f2, f3] of vowels) {
    for (let f0 = 100; f0 < 420; f0 += 20) {
      const x = synth([{ f: f1, bw: 60 }, { f: f2, bw: 90 }, { f: f3, bw: 120 }, { f: 3500, bw: 200 }], f0, n, sr);
      frames.push(normalize(x, 0.4));
    }
  }
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  for (let k = 0; k < 8; k++) {
    frames.push(k % 2 ? new Float64Array(n) : Float64Array.from({ length: n }, () => 0.05 * rand()));
  }
  return frames;
}

/**
 * @param frames  Float64Array frames at `sr`
 * @param dsp     a WasmDsp instance
 * @param now     millisecond clock (performance.now)
 * Returns { [backend]: { [stage]: { us, trials: [us per frame] } } }.
 */
export function runBench({ frames, sr, dsp, now, passes = Math.max(1, Math.round(12000 / frames.length)), trials = 9 }) {
  const voicing = {
    js: (f) => measureVoicing(f, sr, GATE),
    wasm: (f) => dsp.measureVoicing(f, sr, GATE),
  };
  const engine = {
    js: () => new LpcEngine(sr),
    wasm: () => new WasmLpcEngine(sr, dsp),
  };
  const stages = {
    voicing: (b) => { const v = voicing[b]; return (f) => v(f); },
    lpc: (b) => { const e = engine[b](); return (f) => e.analyzeFrame(f); },
    pipeline: (b) => {
      const v = voicing[b];
      const e = engine[b]();
      return (f) => e.process(f, v(f));
    },
  };

  const out = { js: {}, wasm: {} };
  let sink = 0; // keeps the JIT from discarding the work
  for (const [stage, make] of Object.entries(stages)) {
    const times = { js: [], wasm: [] };
    for (let t = -2; t < trials; t++) { // two warm-up trials, discarded
      for (const b of t % 2 ? ['js', 'wasm'] : ['wasm', 'js']) {
        const run = make(b);
        const t0 = now();
        for (let p = 0; p < passes; p++) {
          for (let i = 0; i < frames.length; i++) {
            const r = run(frames[i]);
            sink += r?.f0 ?? r?.f1 ?? r?.formants?.length ?? 0;
          }
        }
        const us = ((now() - t0) * 1000) / (passes * frames.length);
        if (t >= 0) times[b].push(us);
      }
    }
    for (const b of ['js', 'wasm']) {
      const sorted = [...times[b]].sort((x, y) => x - y);
      out[b][stage] = { us: sorted[Math.floor(sorted.length / 2)], trials: times[b] };
    }
  }
  // The scope's LPC envelope, which process() computes on every voiced frame;
  // JavaScript on both back ends, timed once for the breakdown.
  const models = frames.map((f) => new LpcEngine(sr).analyzeFrame(f).model).filter(Boolean);
  const env = [];
  for (let t = -2; t < trials; t++) {
    const t0 = now();
    for (let p = 0; p < passes; p++) for (const m of models) sink += lpcEnvelope(m.a, m.gain, sr, 256)[0];
    if (t >= 0) env.push(((now() - t0) * 1000) / (passes * models.length));
  }
  env.sort((x, y) => x - y);
  out.envelopeUs = env[Math.floor(env.length / 2)];
  out.voicedShare = models.length / frames.length;
  out.sink = sink;
  return out;
}

/** Markdown table of a runBench() result. */
export function table(result, label) {
  const lines = [
    `| Stage (${label}) | JavaScript, µs/frame | WebAssembly, µs/frame | Speed-up |`,
    '|---|---:|---:|---:|',
  ];
  for (const stage of ['voicing', 'lpc', 'pipeline']) {
    const js = result.js[stage].us;
    const wa = result.wasm[stage].us;
    lines.push(`| ${stage} | ${js.toFixed(1)} | ${wa.toFixed(1)} | ${(js / wa).toFixed(2)}× |`);
  }
  const p = result.js.pipeline.us;
  const w = result.wasm.pipeline.us;
  lines.push('', `At 60 frames a second the full pipeline uses ${(p * 60 / 1e4).toFixed(2)}% of one core on ` +
    `JavaScript and ${(w * 60 / 1e4).toFixed(2)}% on WebAssembly.`);
  lines.push(`The spectrum view's LPC envelope, JavaScript on both back ends and part of the pipeline, ` +
    `costs ${result.envelopeUs.toFixed(1)} µs per voiced frame.`);
  return lines.join('\n');
}
