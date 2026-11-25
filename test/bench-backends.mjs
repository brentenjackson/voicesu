// Time the per-frame pipeline on both back ends in Node (V8, like Chrome).
//
//   node test/bench-backends.mjs                 synthetic frames (test/bench-core.js)
//   node test/bench-backends.mjs index.json audio.f32
//                                                frames from a research-harness bundle
//                                                (the 1,668 Hillenbrand steady states)
//
// Also reports module size and compile/instantiate time, and checks that the
// two back ends agree on every frame it timed.

import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compileDsp, WasmDsp, DSP_WASM_URL, WasmLpcEngine } from '../js/engines/wasm.js';
import { LpcEngine } from '../js/engines/lpc.js';
import { runBench, syntheticFrames, table } from './bench-core.js';

const SR = 11025;
const N = 512;

/** One 512-sample frame centred on each point of a harness bundle (index.json + audio.f32). */
function bundleFrames(indexPath, audioPath) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (index.sr !== SR) throw new Error(`bundle is at ${index.sr} Hz; need ${SR}`);
  const buf = readFileSync(audioPath);
  const audio = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const frames = [];
  for (const tok of index.tokens) {
    const c = tok.points[0];
    const f = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const j = c - N / 2 + i;
      f[i] = j >= 0 && j < tok.length ? audio[tok.offset + j] : 0;
    }
    frames.push(f);
  }
  return frames;
}

const [indexPath, audioPath] = process.argv.slice(2);
const frames = indexPath ? bundleFrames(indexPath, audioPath) : syntheticFrames(SR, N);
const label = indexPath ? `${frames.length} Hillenbrand frames` : `${frames.length} synthetic frames`;

let t0 = performance.now();
const module = await compileDsp();
const compileMs = performance.now() - t0;
t0 = performance.now();
const dsp = await WasmDsp.create(module);
const instMs = performance.now() - t0;

// Agreement on these very frames
let worst = 0;
let mismatch = 0;
for (const f of frames) {
  const a = new LpcEngine(SR).analyzeFrame(f);
  const b = new WasmLpcEngine(SR, dsp).analyzeFrame(f);
  if (a.formants.length !== b.formants.length) { mismatch++; continue; }
  a.formants.forEach((p, i) => { worst = Math.max(worst, Math.abs(p.freq - b.formants[i].freq)); });
}

const result = runBench({ frames, sr: SR, dsp, now: () => performance.now() });
console.log(`Node ${process.version}, ${label}\n`);
console.log(table(result, `Node, ${label}`));
console.log(`\nModule: ${statSync(DSP_WASM_URL).size} bytes; compile ${compileMs.toFixed(2)} ms, instantiate ${instMs.toFixed(2)} ms.`);
console.log(`Agreement: ${mismatch} frames with different formant counts; largest formant difference ${worst.toExponential(1)} Hz.`);
