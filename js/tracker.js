// Microphone capture + per-frame vowel analysis.

import {
  preEmphasis, hamming, rms, lpc, formantsFromLpc,
  detectPitch, lpcEnvelope, MedianFilter,
} from './dsp.js';

// LPC formant analysis works best on a ~11 kHz signal (Praat's default is to
// resample to 2 * 5500 Hz). We ask for it directly, and decimate if the browser
// hands us something else.
const TARGET_SR = 11025;
const FRAME = 512; // ~46 ms at 11 kHz

export class VowelTracker {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.running = false;

    this.sr = 0;          // hardware rate
    this.decim = 1;       // decimation factor
    this.effSr = 0;       // effective analysis rate
    this.order = 12;      // LPC order

    this.raw = null;      // hardware-rate scratch buffer
    this.frame = new Float64Array(FRAME);
    this.window = hamming(FRAME);
    this.spectrum = null;

    this.f1Med = new MedianFilter(5);
    this.f2Med = new MedianFilter(5);

    // Smoothed state that the renderer reads.
    this.state = {
      voiced: false, rms: 0, f0: 0, clarity: 0,
      f1: 0, f2: 0, f3: 0,
      formants: [], envelope: null, spectrum: null,
    };

    this.gate = { rms: 0.008, clarity: 0.5 };
    this.smoothing = 0.35; // exponential smoothing on F1/F2 (0 = none)
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // These all mangle formants. Off, if the browser will let us.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_SR });
    } catch {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.sr = this.ctx.sampleRate;
    this.decim = Math.max(1, Math.round(this.sr / TARGET_SR));
    this.effSr = this.sr / this.decim;
    // Rule of thumb: 2 poles per expected formant, plus a couple for spectral tilt.
    this.order = Math.min(24, Math.max(8, Math.round(this.effSr / 1000) + 2));

    const src = this.ctx.createMediaStreamSource(this.stream);

    // Anti-alias ahead of decimation (and it kills HF hiss either way).
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(5200, this.effSr / 2 - 300);
    lp.Q.value = 0.707;

    // Cut rumble / DC below the lowest plausible F1.
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = nextPow2(FRAME * this.decim);
    this.analyser.smoothingTimeConstant = 0.5;

    src.connect(hp).connect(lp).connect(this.analyser);

    this.raw = new Float32Array(this.analyser.fftSize);
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
    this.running = true;
  }

  async stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.f1Med.reset();
    this.f2Med.reset();
    this.state.voiced = false;
  }

  /** Pull one frame and update `this.state`. Call this once per animation frame. */
  analyze() {
    if (!this.running) return this.state;
    const st = this.state;

    this.analyser.getFloatTimeDomainData(this.raw);
    this.analyser.getFloatFrequencyData(this.spectrum);
    st.spectrum = this.spectrum;

    // Decimate from the tail of the buffer (most recent samples).
    const need = FRAME * this.decim;
    const start = this.raw.length - need;
    for (let i = 0; i < FRAME; i++) this.frame[i] = this.raw[start + i * this.decim];

    st.rms = rms(this.frame);

    const pitch = detectPitch(this.frame, this.effSr);
    st.f0 = pitch.f0;
    st.clarity = pitch.clarity;

    const voiced = st.rms >= this.gate.rms && st.clarity >= this.gate.clarity;
    st.voiced = voiced;
    if (!voiced) {
      this.f1Med.reset();
      this.f2Med.reset();
      return st;
    }

    const emph = preEmphasis(this.frame);
    for (let i = 0; i < FRAME; i++) emph[i] *= this.window[i];

    const model = lpc(emph, this.order);
    if (!model) return st;

    st.envelope = lpcEnvelope(model.a, model.gain, this.effSr, 256);

    const fs = formantsFromLpc(model.a, this.effSr, {
      minF: 150,
      maxF: Math.min(5000, this.effSr / 2 - 150),
      maxBw: 500,
    });
    st.formants = fs;
    if (fs.length < 2) return st;

    const f1 = this.f1Med.push(fs[0].freq);
    const f2 = this.f2Med.push(fs[1].freq);

    // F2 must sit above F1 by a sane margin or the pole pairing went wrong.
    if (f2 - f1 < 60) return st;

    const k = this.smoothing;
    st.f1 = st.f1 ? st.f1 * k + f1 * (1 - k) : f1;
    st.f2 = st.f2 ? st.f2 * k + f2 * (1 - k) : f2;
    st.f3 = fs.length > 2 ? fs[2].freq : 0;
    return st;
  }
}

function nextPow2(n) {
  let p = 32;
  while (p < n) p *= 2;
  return Math.min(p, 32768);
}
