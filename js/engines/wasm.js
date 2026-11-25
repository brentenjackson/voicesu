// WebAssembly back end for the per-frame pipeline: the voicing measure and the
// LPC formant analysis, from wasm/src/lib.rs (a line-for-line port of
// js/dsp.js and the analysis in js/engines/lpc.js).
//
// The module has no imports and allocates nothing: we copy each frame into
// its buffer, call one export, and read the results out of linear memory.
// Everything around it (the median filter, smoothing, the envelope for the
// scope) is LpcEngine's own JavaScript, so both back ends behave alike.

import { LpcEngine } from './lpc.js';

export const DSP_WASM_URL = new URL('../../wasm/formants.wasm', import.meta.url);

/**
 * Compile the module once. The result can be posted to a worker, which then
 * instantiates its own copy with WasmDsp.create().
 */
export async function compileDsp(url = DSP_WASM_URL) {
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return WebAssembly.compile(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return WebAssembly.compile(await res.arrayBuffer());
}

export class WasmDsp {
  /** @param {WebAssembly.Module} module  from compileDsp() */
  static async create(module) {
    return new WasmDsp(await WebAssembly.instantiate(module, {}));
  }

  constructor(instance) {
    this.kind = 'wasm';
    this.x = instance.exports;
    this.max = this.x.max_frame();
    this.aAt = this.x.a_at();
    this.fAt = this.x.f_at();
    this.outLen = this.x.out_len();
    this.buf = null;
    // Handed to the Analyzer in place of the JavaScript measureVoicing.
    this.measureVoicing = this.measureVoicing.bind(this);
  }

  /** Views onto linear memory, rebuilt if the memory ever grows (it doesn't today). */
  load(frame) {
    const buf = this.x.memory.buffer;
    if (buf !== this.buf) {
      this.buf = buf;
      this.frame = new Float64Array(buf, this.x.frame_ptr(), this.max);
      this.out = new Float64Array(buf, this.x.out_ptr(), this.outLen);
    }
    if (frame.length > this.max) throw new Error(`frame longer than ${this.max} samples`);
    this.frame.set(frame);
  }

  /** Same result as measureVoicing() in js/engines/lpc.js. */
  measureVoicing(frame, sr, gate) {
    this.load(frame);
    this.x.voicing(frame.length, sr);
    const o = this.out;
    return { rms: o[0], f0: o[1], clarity: o[2], voiced: o[0] >= gate.rms && o[2] >= gate.clarity };
  }

  /** Same result as LpcEngine.analyzeFrame(): { model: { a, gain } | null, formants }. */
  lpcFormants(frame, sr, order, minF, maxF, maxBw) {
    this.load(frame);
    const k = this.x.lpc_formants(frame.length, sr, order, minF, maxF, maxBw);
    if (k < 0) return { model: null, formants: [] };
    const o = this.out;
    const formants = [];
    for (let i = 0; i < k; i++) formants.push({ freq: o[this.fAt + 2 * i], bw: o[this.fAt + 2 * i + 1] });
    return { model: { a: o.slice(this.aAt, this.aAt + order + 1), gain: o[0] }, formants };
  }
}

/** The LPC engine with its per-frame analysis in WebAssembly. */
export class WasmLpcEngine extends LpcEngine {
  constructor(sr, dsp, opts = {}) {
    super(sr, opts);
    this.dsp = dsp;
  }

  analyzeFrame(frame) {
    return this.dsp.lpcFormants(frame, this.sr, this.order, this.minF, this.maxF, this.maxBw);
  }
}
