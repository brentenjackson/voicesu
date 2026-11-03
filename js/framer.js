// Fixed-hop framing of the captured signal: the analysis worker's clock.
//
// The research harness emulates this exactly, so the rules are spelled out:
//   - the input is the hardware-rate signal after the capture graph's biquads
//     (high-pass at HIGHPASS_HZ, low-pass at lowpassHz(effSr));
//   - it is decimated by an integer factor by keeping every `decim`-th sample,
//     counting from the first sample captured -- the low-pass is the
//     anti-alias filter, there is no other;
//   - the first frame is emitted as soon as FRAME analysis-rate samples exist,
//     then one every effSr * HOP_SECONDS samples. The hop is fractional
//     (183.75 at 11,025 Hz), so each frame ends on the first sample at or past
//     its due time and the cadence averages exactly 60 per second;
//   - a frame is the latest FRAME samples, oldest first.
//
// No DOM, no audio API: runs in the worker and in the unit tests.

// LPC formant analysis works best on a ~11 kHz signal (Praat's default is to
// resample to 2 * 5500 Hz). We ask the browser for it directly, and decimate
// if it hands us something else.
export const TARGET_SR = 11025;
export const FRAME = 512; // ~46 ms at 11 kHz
export const HOP_SECONDS = 1 / 60;

/** Cut rumble / DC below the lowest plausible F1. */
export const HIGHPASS_HZ = 60;

/** Anti-alias ahead of decimation (and it kills HF hiss either way). */
export function lowpassHz(effSr) {
  return Math.min(5200, effSr / 2 - 300);
}

/** The integer decimation that lands closest to TARGET_SR. */
export function analysisRate(sr) {
  const decim = Math.max(1, Math.round(sr / TARGET_SR));
  return { decim, effSr: sr / decim };
}

export class Framer {
  /**
   * @param {number} decim  keep every decim-th input sample
   * @param {number} hop    analysis-rate samples between frames; fractional is
   *                        fine (effSr * HOP_SECONDS)
   * @param {number} size   frame length at the analysis rate
   */
  constructor(decim, hop, size = FRAME) {
    this.decim = decim;
    this.size = size;
    this.hop = hop;
    this.ring = new Float64Array(size);
    this.out = new Float64Array(size);
    this.pos = 0;    // next write index in the ring
    this.count = 0;  // analysis-rate samples seen
    this.skip = 0;   // input samples to drop before the next kept one
    this.due = size; // emit once count reaches this
  }

  /**
   * Feed one chunk of hardware-rate audio, any length. `onFrame(frame)` runs
   * for every frame that falls due inside it; the array is reused, so copy it
   * if you need it past the callback.
   */
  push(chunk, onFrame) {
    for (let i = 0; i < chunk.length; i++) {
      if (this.skip > 0) { this.skip--; continue; }
      this.skip = this.decim - 1;

      this.ring[this.pos] = chunk[i];
      this.pos = (this.pos + 1) % this.size;
      this.count++;
      if (this.count >= this.due) {
        this.due += this.hop;
        onFrame(this.frame());
      }
    }
  }

  /** Unroll the ring, oldest sample first. */
  frame() {
    const n = this.size;
    for (let i = 0; i < n; i++) this.out[i] = this.ring[(this.pos + i) % n];
    return this.out;
  }
}
