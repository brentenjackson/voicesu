// Pilot logging for the classmate study: per-frame engine outputs and pitch,
// never audio. The participant downloads the log themselves at the end.

export const PILOT_TASK = [
  { key: 'closeFront', symbol: 'i', prompt: 'hold “ee” (heed)', seconds: 3 },
  { key: 'closeBack', symbol: 'u', prompt: 'hold “oo” (who’d)', seconds: 3 },
  { key: 'openFront', symbol: 'a', prompt: 'hold “a” (had)', seconds: 3 },
  { key: 'openBack', symbol: 'ɑ', prompt: 'hold “ah” (father)', seconds: 3 },
  { key: 'glide-i-a', symbol: 'i→ɑ', prompt: 'glide slowly from “ee” to “ah”', seconds: 4 },
  { key: 'glide-i-u', symbol: 'i→u', prompt: 'glide slowly from “ee” to “oo”', seconds: 4 },
];

export class PilotLogger {
  constructor() {
    this.frames = [];
    this.segment = null;
    this.started = 0;
    this.meta = {};
  }

  begin(meta) {
    this.frames = [];
    this.meta = { ...meta, startedAt: new Date().toISOString(), userAgent: navigator.userAgent };
    this.started = performance.now();
  }

  /** Mark which task step the following frames belong to (null between steps). */
  setSegment(key) { this.segment = key; }

  /**
   * One analysis frame. `voicing` is measureVoicing() output; `results` maps
   * engine name -> { f1, f2, updated }. Only numbers are kept.
   */
  record(voicing, results) {
    if (!this.segment) return;
    const row = {
      t: Math.round(performance.now() - this.started),
      seg: this.segment,
      voiced: voicing.voiced ? 1 : 0,
      f0: Math.round(voicing.f0),
      clarity: Math.round(voicing.clarity * 1000) / 1000,
    };
    for (const [name, r] of Object.entries(results)) {
      row[`${name}_f1`] = Math.round(r.f1);
      row[`${name}_f2`] = Math.round(r.f2);
      row[`${name}_new`] = r.updated ? 1 : 0;
    }
    this.frames.push(row);
  }

  /** The log as a JSON file the participant saves; nothing is uploaded. */
  download(filename = 'voicesu-pilot.json') {
    const blob = new Blob([JSON.stringify({ meta: this.meta, frames: this.frames })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
