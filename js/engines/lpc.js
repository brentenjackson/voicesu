// LPC formant engine: the original voicesu analysis, as a reusable engine.
//
// The browser tracker and the offline research harness both run this class,
// so a number measured offline is a number for the code in the demo.

import {
  preEmphasis, hamming, rms, lpc, formantsFromLpc, detectPitch, lpcEnvelope,
  MedianFilter,
} from '../dsp.js';

/** Rule of thumb: 2 poles per expected formant, plus a couple for spectral tilt. */
export function defaultLpcOrder(sr) {
  return Math.min(24, Math.max(8, Math.round(sr / 1000) + 2));
}

/** Voicing gate shared by every engine: frame energy and pitch clarity. */
export function measureVoicing(frame, sr, gate) {
  const level = rms(frame);
  const pitch = detectPitch(frame, sr);
  return {
    rms: level,
    f0: pitch.f0,
    clarity: pitch.clarity,
    voiced: level >= gate.rms && pitch.clarity >= gate.clarity,
  };
}

export class LpcEngine {
  /**
   * @param {number} sr  analysis sample rate of the frames passed in
   * @param {object} opts  order, minF, maxF, maxBw, smoothing, medianSize
   */
  constructor(sr, opts = {}) {
    this.name = 'lpc';
    this.label = 'LPC';
    this.sr = sr;
    this.order = opts.order ?? defaultLpcOrder(sr);
    this.minF = opts.minF ?? 150;
    this.maxF = opts.maxF ?? Math.min(5000, sr / 2 - 150);
    this.maxBw = opts.maxBw ?? 500;
    this.smoothing = opts.smoothing ?? 0.35; // exponential smoothing on F1/F2 (0 = none)
    this.window = null;
    this.f1Med = new MedianFilter(opts.medianSize ?? 5);
    this.f2Med = new MedianFilter(opts.medianSize ?? 5);
    this.f1 = 0;
    this.f2 = 0;
  }

  /**
   * One frame, no voicing gate and no temporal filtering: the formant
   * estimator on its own. Returns the LPC model and every accepted resonance.
   */
  analyzeFrame(frame) {
    if (!this.window || this.window.length !== frame.length) this.window = hamming(frame.length);
    const emph = preEmphasis(frame);
    for (let i = 0; i < emph.length; i++) emph[i] *= this.window[i];
    const model = lpc(emph, this.order);
    if (!model) return { model: null, formants: [] };
    const formants = formantsFromLpc(model.a, this.sr, {
      minF: this.minF, maxF: this.maxF, maxBw: this.maxBw,
    });
    return { model, formants };
  }

  /**
   * The demo pipeline for one frame: skip unvoiced frames, take the lowest
   * two resonances, median-filter them, reject implausible pairs, smooth.
   * `voicing` comes from measureVoicing() on the same frame.
   */
  process(frame, voicing) {
    const out = {
      f1: this.f1, f2: this.f2, f3: 0, confidence: 0,
      formants: [], envelope: null, updated: false,
    };
    if (!voicing.voiced) {
      this.f1Med.reset();
      this.f2Med.reset();
      return out;
    }

    const { model, formants } = this.analyzeFrame(frame);
    if (!model) return out;
    out.envelope = lpcEnvelope(model.a, model.gain, this.sr, 256);
    out.formants = formants;
    if (formants.length < 2) return out;

    const f1 = this.f1Med.push(formants[0].freq);
    const f2 = this.f2Med.push(formants[1].freq);

    // F2 must sit above F1 by a sane margin or the pole pairing went wrong.
    if (f2 - f1 < 60) return out;

    const k = this.smoothing;
    this.f1 = this.f1 ? this.f1 * k + f1 * (1 - k) : f1;
    this.f2 = this.f2 ? this.f2 * k + f2 * (1 - k) : f2;
    out.f1 = this.f1;
    out.f2 = this.f2;
    out.f3 = formants.length > 2 ? formants[2].freq : 0;
    out.confidence = voicing.clarity;
    out.updated = true;
    return out;
  }

  reset() {
    this.f1Med.reset();
    this.f2Med.reset();
    this.f1 = 0;
    this.f2 = 0;
  }
}
