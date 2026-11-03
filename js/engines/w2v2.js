// wav2vec 2.0 probe engine.
//
// The research code exports wav2vec 2.0, cut after the layer its probe reads,
// with the ridge readout inside the ONNX graph (models/w2v2_probe*.onnx). This
// engine keeps the last 400 ms of 16 kHz audio from its own AudioContext and
// asks a worker for an estimate every 100 ms, or as soon as the previous one
// finishes if inference is slower. process() never waits: it returns the
// latest finished estimate, gated by the voicing measured on the LPC frame.

import { barkToHz, FormantSmoother } from './readout.js';

const SR = 16000;

export class W2v2Engine {
  constructor(opts = {}) {
    this.name = 'w2v2';
    this.label = 'wav2vec 2.0';
    this.modelUrl = opts.modelUrl ?? 'models/w2v2_probe.onnx';
    this.metaUrl = opts.metaUrl ?? 'models/w2v2_probe.json';
    this.providers = opts.providers;
    this.ctx = null;
    this.worker = null;
    this.ring = null;
    this.filled = 0;
    this.busy = false;
    this.nextId = 0;
    this.smoother = new FormantSmoother();
    this.latest = { f1: 0, f2: 0, f3: 0, confidence: 0, updated: false };
    this.fresh = false;
    this.voiced = false;
    this.stats = { inferMs: 0, latencyMs: 0, updatesPerSec: 0, loadMs: 0, threads: 1 };
    this._resultTimes = [];
  }

  async start(stream) {
    const meta = await (await fetch(this.metaUrl)).json();
    const n = Math.round((meta.contextMs / 1000) * SR);
    this.ring = new Float32Array(n);
    this.filled = 0;

    this.worker = new Worker(new URL('./w2v2-worker.js', import.meta.url));
    const ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          this.stats.loadMs = e.data.loadMs;
          this.stats.threads = e.data.threads;
          resolve();
        } else if (e.data.type === 'error') reject(new Error(e.data.message));
      };
    });
    this.worker.postMessage({ type: 'init', modelUrl: new URL(this.modelUrl, location.href).href, providers: this.providers });
    await ready;
    this.worker.onmessage = (e) => this._onResult(e.data);

    this.ctx = new AudioContext({ sampleRate: SR });
    await this.ctx.audioWorklet.addModule(new URL('./w2v2-capture.js', import.meta.url));
    const src = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'w2v2-capture');
    node.port.onmessage = (e) => this._onAudio(e.data);
    src.connect(node);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  _onAudio(chunk) {
    const ring = this.ring;
    ring.copyWithin(0, chunk.length);
    ring.set(chunk, ring.length - chunk.length);
    this.filled = Math.min(ring.length, this.filled + chunk.length);
    if (!this.busy && this.filled === ring.length) {
      this.busy = true;
      // currentTime marks the end of the newest chunk, give or take one render quantum
      this.worker.postMessage({ type: 'run', id: this.nextId++, wave: ring.slice(), endTime: this.ctx.currentTime });
    }
  }

  _onResult(msg) {
    this.busy = false;
    if (msg.type !== 'result') return;
    const now = performance.now();
    this.stats.inferMs = msg.inferMs;
    this.stats.latencyMs = (this.ctx.currentTime - msg.endTime) * 1000;
    this._resultTimes.push(now);
    while (this._resultTimes.length && now - this._resultTimes[0] > 2000) this._resultTimes.shift();
    this.stats.updatesPerSec = this._resultTimes.length / 2;
    if (!this.voiced) return;
    const [f1, f2] = this.smoother.push(barkToHz(msg.bark[0]), barkToHz(msg.bark[1]));
    this.latest = { f1, f2, f3: 0, confidence: 1, updated: true };
    this.fresh = true;
  }

  process(frame, voicing) {
    this.voiced = voicing.voiced;
    if (!voicing.voiced) {
      this.smoother.gap();
      return { ...this.latest, confidence: 0, updated: false };
    }
    const out = { ...this.latest, confidence: voicing.clarity, updated: this.fresh };
    this.fresh = false;
    return out;
  }

  reset() {
    this.smoother.reset();
    this.latest = { f1: 0, f2: 0, f3: 0, confidence: 0, updated: false };
  }

  async stop() {
    if (this.worker) this.worker.terminate();
    if (this.ctx) await this.ctx.close();
    this.worker = null;
    this.ctx = null;
    this.busy = false;
  }
}
