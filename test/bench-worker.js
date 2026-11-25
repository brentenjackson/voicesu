// Runs test/bench-core.js inside a module Worker, where the demo's analysis runs.
import { compileDsp, WasmDsp } from '../js/engines/wasm.js';
import { runBench, syntheticFrames, table } from './bench-core.js';

const SR = 11025;
let t0 = performance.now();
const module = await compileDsp();
const compileMs = performance.now() - t0;
t0 = performance.now();
const dsp = await WasmDsp.create(module);
const instMs = performance.now() - t0;
const frames = syntheticFrames(SR, 512);
const result = runBench({ frames, sr: SR, dsp, now: () => performance.now() });
self.postMessage({
  markdown: table(result, `Chrome worker, ${frames.length} synthetic frames`),
  compileMs, instMs, userAgent: navigator.userAgent,
});
