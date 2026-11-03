// One analysis frame through the voicing gate and every enabled engine.
//
// The same code runs in the analysis worker and, on browsers without
// AudioWorklet or module Workers, on the main thread. Results are plain
// objects so they survive postMessage.

import { measureVoicing } from './engines/lpc.js';

export class Analyzer {
  /** @param {number} sr  analysis sample rate of the frames passed in */
  constructor(sr) {
    this.sr = sr;
    this.gate = { rms: 0.008, clarity: 0.5 };
    this.smoothing = null; // null = leave each engine's own default
    this.engines = new Map(); // name -> { spec, engine }
    this.enabled = new Set();
  }

  /** Register a built engine; `spec` is its registry entry. */
  add(spec, engine) {
    if (this.smoothing !== null) spec.setSmoothing?.(engine, this.smoothing);
    this.engines.set(spec.name, { spec, engine });
  }

  remove(name) { this.engines.delete(name); }

  /** Any of { gate, smoothing, enabled: [names] }; absent keys are left alone. */
  configure({ gate, smoothing, enabled } = {}) {
    if (gate) Object.assign(this.gate, gate);
    if (smoothing !== undefined && smoothing !== null) {
      this.smoothing = smoothing;
      for (const { spec, engine } of this.engines.values()) spec.setSmoothing?.(engine, smoothing);
    }
    if (enabled) {
      // A re-enabled engine starts clean rather than from whatever it last saw.
      for (const name of enabled) {
        if (!this.enabled.has(name)) this.engines.get(name)?.engine.reset();
      }
      this.enabled = new Set(enabled);
    }
  }

  /** Voicing once, then every enabled engine on the same frame. */
  analyze(frame) {
    const voicing = measureVoicing(frame, this.sr, this.gate);
    return { voicing, results: this.run(frame, voicing) };
  }

  /** Enabled engines only, with voicing measured elsewhere. -> { name: Result } */
  run(frame, voicing) {
    const results = {};
    for (const [name, { engine }] of this.engines) {
      if (this.enabled.has(name)) results[name] = plainResult(engine.process(frame, voicing));
    }
    return results;
  }
}

/** The interface's Result fields, plus the LPC extras the spectrum scope draws. */
function plainResult(r) {
  const out = {
    f1: r.f1, f2: r.f2, f3: r.f3 ?? 0,
    confidence: r.confidence ?? 0, updated: !!r.updated,
  };
  if (r.envelope) {
    out.envelope = r.envelope;
    out.formants = r.formants;
  }
  return out;
}
