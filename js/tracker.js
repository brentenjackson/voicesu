// Microphone capture, and where the per-frame analysis runs.
//
// Preferred path: mic -> high-pass -> low-pass -> AudioWorklet, which copies
// the filtered signal to a module Worker (js/analysis-worker.js). The worker
// frames it at a fixed hop and runs the voicing gate and the synchronous
// engines; this thread only receives results and renders them. An
// AnalyserNode hangs off the same chain to feed the spectrum scope.
//
// Fallback, for browsers without AudioWorklet or module Workers: pull the
// latest frame from that AnalyserNode once per animation frame and analyze it
// here, as voicesu originally did. Same Analyzer, same engines.
//
// Engines with their own audio (`ownAudio` in the registry) always live on
// this thread: start(stream) needs the MediaStream, which a worker can't hold.

import { defaultLpcOrder } from './engines/lpc.js';
import { Analyzer } from './analysis.js';
import {
  FRAME, TARGET_SR, HOP_SECONDS, HIGHPASS_HZ, analysisRate, lowpassHz,
} from './framer.js';

export class VowelTracker {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.worker = null;   // null on the fallback path
    this.running = false;
    this.mode = '';       // 'worker' or 'main thread', once started
    this.fallbackReason = '';

    this.sr = 0;          // hardware rate
    this.decim = 1;       // decimation factor
    this.effSr = 0;       // effective analysis rate
    this.order = 0;       // LPC order, for the status line

    this.raw = null;      // hardware-rate scratch buffer (fallback path)
    this.frame = new Float64Array(FRAME);
    this.spectrum = null;

    this.entries = [];    // available engines, { spec, assets } as loadEngines() gives them
    this.enabled = new Set();
    this.gate = { rms: 0.008, clarity: 0.5 };
    this.smoothing = 0.35; // exponential smoothing on F1/F2 (0 = none)
    this.local = null;    // Analyzer on this thread
    this.own = new Map(); // ownAudio engines started (or starting), by name

    this.state = emptyState();
    this.onFrame = null;        // (state) after every analysis frame
    this.onEngineStatus = null; // (name, 'loading' | 'ready' | 'error', detail)
  }

  /** Any of { enabled: [names], gate: { rms }, smoothing }. Fine before start(). */
  configure({ enabled, gate, smoothing } = {}) {
    if (gate) Object.assign(this.gate, gate);
    if (smoothing !== undefined) this.smoothing = smoothing;
    if (enabled) {
      this.enabled = new Set(enabled);
      for (const name of Object.keys(this.state.results)) {
        if (!this.enabled.has(name)) delete this.state.results[name];
      }
      if (!this.enabled.has('lpc')) {
        this.state.envelope = null;
        this.state.formants = [];
      }
    }
    if (!this.running) return;

    const update = { enabled: enabled && [...this.enabled], gate, smoothing };
    this.local.configure(update);
    this.worker?.postMessage({ type: 'configure', ...update, sendFrames: this.wantsFrames() });
    if (enabled) this.syncOwnAudio();
  }

  /** @param {Array} entries  available engines: [{ spec, assets }] */
  async start(entries) {
    this.entries = entries;
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
    ({ decim: this.decim, effSr: this.effSr } = analysisRate(this.sr));
    this.order = defaultLpcOrder(this.effSr);

    const src = this.ctx.createMediaStreamSource(this.stream);

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = HIGHPASS_HZ;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpassHz(this.effSr);
    lp.Q.value = 0.707;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = nextPow2(FRAME * this.decim);
    this.analyser.smoothingTimeConstant = 0.5;

    src.connect(hp).connect(lp).connect(this.analyser);

    this.raw = new Float32Array(this.analyser.fftSize);
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
    this.state = emptyState();

    this.local = new Analyzer(this.effSr);
    this.local.configure({ gate: this.gate, smoothing: this.smoothing, enabled: [...this.enabled] });

    const sync = entries.filter((e) => !e.spec.ownAudio);
    try {
      await this.startWorker(lp, sync);
      this.mode = 'worker';
    } catch (err) {
      this.worker?.terminate();
      this.worker = null;
      this.mode = 'main thread';
      this.fallbackReason = err.message;
      for (const { spec, assets } of sync) {
        try {
          this.local.add(spec, spec.create(this.effSr, assets));
        } catch (e) {
          this.onEngineStatus?.(spec.name, 'error', e.message);
        }
      }
    }

    this.running = true;
    this.syncOwnAudio();
  }

  /** Worklet + worker. Throws, leaving nothing connected, if either is missing. */
  async startWorker(source, sync) {
    if (typeof AudioWorkletNode !== 'function' || !this.ctx.audioWorklet) {
      throw new Error('no AudioWorklet');
    }
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url).href);

    // A browser without module Workers runs this as a classic script, trips
    // on the first import and fires 'error' -- which lands us on the fallback.
    const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    this.worker = worker;
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => {
        e.preventDefault();
        reject(new Error(e.message || 'analysis worker failed to load'));
      };
    });

    // The worklet talks to the worker directly, over this channel.
    const channel = new MessageChannel();
    worker.postMessage({
      type: 'init',
      sr: this.sr,
      decim: this.decim,
      engines: sync.map(({ spec, assets }) => ({ name: spec.name, assets })),
      enabled: [...this.enabled],
      gate: this.gate,
      smoothing: this.smoothing,
      sendFrames: this.wantsFrames(),
      port: channel.port2,
    }, [channel.port2]);

    const { errors } = await ready;
    worker.onmessage = (e) => this.receive(e.data);
    worker.onerror = null;
    for (const [name, message] of Object.entries(errors)) {
      this.onEngineStatus?.(name, 'error', message);
    }

    const node = new AudioWorkletNode(this.ctx, 'voicesu-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0, // a sink; Chrome still pulls it without a destination
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { batch: Math.max(128, Math.round((this.sr * HOP_SECONDS) / 2)) },
    });
    node.port.postMessage({ port: channel.port1 }, [channel.port1]);
    source.connect(node);
  }

  async stop() {
    this.running = false;
    const stopping = [...this.own.keys()].map((name) => this.stopOwn(name));
    this.worker?.terminate();
    this.worker = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    await Promise.all(stopping);
    this.ctx = null;
    this.stream = null;
    this.local = null;
    this.state.voiced = false;
  }

  /**
   * Once per animation frame: refresh the scope's spectrum and, on the
   * fallback path, pull and analyze a frame. Returns the latest state.
   */
  tick() {
    if (!this.running) return this.state;
    this.analyser.getFloatFrequencyData(this.spectrum);
    this.state.spectrum = this.spectrum;
    if (this.worker) return this.state;

    this.analyser.getFloatTimeDomainData(this.raw);
    // Decimate from the tail of the buffer (most recent samples).
    const start = this.raw.length - FRAME * this.decim;
    for (let i = 0; i < FRAME; i++) this.frame[i] = this.raw[start + i * this.decim];
    const { voicing, results } = this.local.analyze(this.frame);
    this.ingest(voicing, results);
    return this.state;
  }

  /** A message from the worker. */
  receive(msg) {
    if (msg.type !== 'frame' || !this.running) return;
    const { voicing, results } = msg;
    // ownAudio engines see the same frame and voicing the worker's engines did.
    if (msg.frame) Object.assign(results, this.local.run(msg.frame, voicing));
    this.ingest(voicing, results);
  }

  /** Fold one analysis frame into `state`, whichever path produced it. */
  ingest(voicing, results) {
    const st = this.state;
    st.voiced = voicing.voiced;
    st.rms = voicing.rms;
    st.f0 = voicing.f0;
    st.clarity = voicing.clarity;
    for (const [name, r] of Object.entries(results)) {
      if (!this.enabled.has(name)) continue; // in flight when it was switched off
      // Engines hold F1/F2 through gaps; hold F3 the same way.
      const f3 = r.updated ? r.f3 : st.results[name]?.f3 ?? 0;
      st.results[name] = { f1: r.f1, f2: r.f2, f3, confidence: r.confidence, updated: r.updated };
    }
    // The spectrum view keeps the last voiced LPC envelope through silence.
    if (results.lpc?.envelope && this.enabled.has('lpc')) {
      st.envelope = results.lpc.envelope;
      st.formants = results.lpc.formants;
    }
    this.onFrame?.(st);
  }

  // ---------------------------------------------------------- ownAudio engines

  wantsFrames() {
    return this.entries.some((e) => e.spec.ownAudio && this.enabled.has(e.spec.name));
  }

  /** Start enabled ownAudio engines and stop disabled ones. */
  syncOwnAudio() {
    for (const entry of this.entries) {
      const { name, ownAudio } = entry.spec;
      if (!ownAudio) continue;
      const want = this.running && this.enabled.has(name);
      if (want && !this.own.has(name)) this.startOwn(entry);
      else if (!want && this.own.has(name)) this.stopOwn(name);
    }
  }

  /** Never awaited: a model that takes seconds to load shouldn't hold up the mic. */
  async startOwn({ spec, assets }) {
    let engine;
    try {
      engine = spec.create(this.effSr, assets);
      this.own.set(spec.name, engine);
      this.onEngineStatus?.(spec.name, 'loading');
      await engine.start(this.stream);
    } catch (err) {
      if (engine && this.own.get(spec.name) !== engine) return; // switched off meanwhile
      this.own.delete(spec.name);
      this.onEngineStatus?.(spec.name, 'error', err.message);
      return;
    }
    if (this.own.get(spec.name) !== engine) {
      // Switched off, or the mic stopped, while it was loading.
      await Promise.resolve(engine.stop()).catch(() => {});
      return;
    }
    this.local.add(spec, engine);
    this.onEngineStatus?.(spec.name, 'ready');
  }

  async stopOwn(name) {
    const engine = this.own.get(name);
    this.own.delete(name);
    // One still loading is stopped by startOwn once its start() settles.
    if (!this.local?.engines.has(name)) return;
    this.local.remove(name);
    await Promise.resolve(engine.stop()).catch(() => {});
  }
}

function emptyState() {
  return {
    voiced: false, rms: 0, f0: 0, clarity: 0,
    results: {},            // name -> { f1, f2, f3, confidence, updated }, enabled engines only
    envelope: null,         // LPC's, for the spectrum scope
    formants: [],
    spectrum: null,
  };
}

function nextPow2(n) {
  let p = 32;
  while (p < n) p *= 2;
  return Math.min(p, 32768);
}
