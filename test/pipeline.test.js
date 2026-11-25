// The capture pipeline without a browser: fixed-hop framing and decimation,
// the shared Analyzer, the engine registry, the worker's message protocol,
// and the tracker's bookkeeping for engines with their own audio.
import fs from 'node:fs';
import { Framer, FRAME, HOP_SECONDS, analysisRate, lowpassHz } from '../js/framer.js';
import { Analyzer } from '../js/analysis.js';
import { ENGINES, loadEngines, checkMfccWeights } from '../js/engines/registry.js';
import { synth, normalize } from './synth.js';

const TINY = JSON.parse(fs.readFileSync(new URL('./fixtures/mfcc_readout.tiny.json', import.meta.url)));
const spec = (name) => ENGINES.find((s) => s.name === name);

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

/** How many frames a stream of n analysis-rate samples yields. */
const frameCount = (n, hop) => (n < FRAME ? 0 : 1 + Math.floor((n - FRAME) / hop));

/** Feed `x` to a framer in chunks of the given sizes (cycled); collect copies of every frame. */
function frames(framer, x, sizes) {
  const out = [];
  for (let i = 0, k = 0; i < x.length; k++) {
    const n = sizes[k % sizes.length];
    framer.push(x.subarray(i, i + n), (f) => out.push(f.slice()));
    i += n;
  }
  return out;
}

// 1. Rates and the filter corner the capture graph uses.
console.log('Analysis rate:');
for (const [sr, decim, eff] of [[11025, 1, 11025], [44100, 4, 11025], [48000, 4, 12000], [96000, 9, 96000 / 9]]) {
  const r = analysisRate(sr);
  check(r.decim === decim && r.effSr === eff, `${sr} Hz -> decimate by ${r.decim}, analyze at ${r.effSr.toFixed(0)} Hz`);
}
check(lowpassHz(11025) === 5200 && lowpassHz(8000) === 3700, 'low-pass at min(5200, sr/2 - 300)');

// 2. Framing: the first frame once FRAME samples exist, then one per 1/60 s.
console.log('\nFraming:');
{
  const sr = 11025;
  const hop = sr * HOP_SECONDS; // 183.75
  const ramp = Float64Array.from({ length: sr }, (_, i) => i); // sample value = its index
  const got = frames(new Framer(1, hop), ramp, [128]);

  const want = [];
  for (let due = FRAME; due <= sr; due += hop) want.push(Math.ceil(due) - 1); // index of each frame's last sample
  check(got.length === want.length, `${got.length} frames in 1 s at ${sr} Hz (want ${want.length}: one, then every ${hop} samples)`);
  check(got.every((f, k) => f[FRAME - 1] === want[k] && f[0] === want[k] - FRAME + 1),
    'each frame is the latest 512 samples, oldest first, ending on its hop boundary');

  const odd = frames(new Framer(1, hop), ramp, [1, 7, 333, 128, 64, 2000, 5]);
  check(odd.length === got.length && odd.every((f, k) => f.every((v, i) => v === got[k][i])),
    'frames are identical however the worklet happens to chunk the audio');
}

// 3. Decimation: 48 kHz keeps every 4th sample, counting from the first.
console.log('\nDecimation:');
{
  const ramp = Float64Array.from({ length: 48000 }, (_, i) => i);
  const { decim, effSr } = analysisRate(48000);
  const got = frames(new Framer(decim, effSr * HOP_SECONDS), ramp, [384]);
  check(got.length === frameCount(effSr, 200), `${got.length} frames in 1 s at ${effSr} Hz`);
  check(got.every((f) => f.every((v, i) => v % 4 === 0 && (i === 0 || v - f[i - 1] === 4))),
    'frames hold samples 0, 4, 8, ... of the hardware stream');
}

// 4. Framer -> Analyzer on the 48 kHz decimation path, both sync engines at once.
console.log('\nAnalyzer, 48 kHz input (decimation fallback):');
{
  const { decim, effSr } = analysisRate(48000);
  const vowel = normalize(synth(
    [{ f: 730, bw: 60 }, { f: 1090, bw: 90 }, { f: 2440, bw: 120 }, { f: 3500, bw: 200 }],
    150, 24000, 48000), 0.5);

  const an = new Analyzer(effSr);
  an.configure({ smoothing: 0.35, enabled: ['lpc', 'mfcc'] });
  an.add(spec('lpc'), spec('lpc').create(effSr));
  an.add(spec('mfcc'), spec('mfcc').create(effSr, TINY));

  let last = null;
  let n = 0;
  new Framer(decim, effSr * HOP_SECONDS).push(vowel, (f) => { last = an.analyze(f); n++; });
  const { voicing, results } = last;
  check(voicing.voiced && Math.abs(voicing.f0 - 150) < 8,
    `voiced, F0 ${voicing.f0.toFixed(0)} (want 150) after ${n} frames`);
  const lpc = results.lpc;
  check(lpc.updated && Math.abs(lpc.f1 - 730) < 73 && Math.abs(lpc.f2 - 1090) < 109,
    `LPC [ɑ] F1 ${lpc.f1.toFixed(0)} (want 730), F2 ${lpc.f2.toFixed(0)} (want 1090)`);
  check(lpc.envelope?.length === 256 && lpc.formants.length >= 2, 'LPC result carries the envelope and formants for the scope');
  const mf = results.mfcc;
  check(mf.updated && Math.abs(mf.f1 - 500) < 0.5 && Math.abs(mf.f2 - 1500) < 0.5,
    `MFCC fixture readout F1 ${mf.f1.toFixed(1)}, F2 ${mf.f2.toFixed(1)} (want 500, 1500)`);
  check(!('envelope' in mf), 'MFCC result is just the interface fields');

  // Gate, smoothing and toggles reach the engines.
  an.configure({ smoothing: 0.7 });
  const eng = (name) => an.engines.get(name).engine;
  check(eng('lpc').smoothing === 0.7 && eng('mfcc').smoother.smoothing === 0.7, 'smoothing slider reaches both engines');

  const frame0 = Float64Array.from({ length: FRAME }, (_, i) => vowel[i * decim]);
  an.configure({ enabled: ['lpc'] });
  const off = an.analyze(frame0);
  check(!('mfcc' in off.results) && 'lpc' in off.results, 'a disabled engine is not run');

  an.configure({ enabled: ['lpc', 'mfcc'] });
  check(eng('mfcc').smoother.f1 === 0, 're-enabling an engine resets its temporal state');

  an.configure({ gate: { rms: 1 } });
  const gated = an.analyze(frame0);
  check(!gated.voicing.voiced && !gated.results.lpc.updated && !gated.results.mfcc.updated,
    'raising the voicing gate stops every engine updating together');
}

// 5. Registry: loading never throws; bad weights fail at create().
console.log('\nRegistry:');
{
  // Node can't fetch a page-relative URL, which is exactly the "not exported" case.
  const loaded = await loadEngines();
  const by = Object.fromEntries(loaded.map((l) => [l.spec.name, l]));
  check(by.lpc.available, 'LPC is always available');
  check(!by.mfcc.available && by.mfcc.note === 'weights not exported yet',
    `MFCC without weights: unavailable, "${by.mfcc.note}"`);
  check(checkMfccWeights(TINY) === TINY, 'fixture weights pass the shape check');
  let threw = '';
  try { spec('mfcc').create(11025, { features: { nCoeffs: 13 }, readout: TINY.readout }); } catch (e) { threw = e.message; }
  check(/malformed/.test(threw), `mismatched weights are refused at create(): ${threw}`);

  // A GMR readout (one component, x and y independent) predicts its y mean.
  const D = TINY.readout.inputMean.length;
  const eye = Array.from({ length: D + 2 }, (_, i) => Array.from({ length: D + 2 }, (_, j) => +(i === j)));
  const gmr = {
    features: {},
    readout: {
      kind: 'gmr', inputMean: TINY.readout.inputMean, inputScale: TINY.readout.inputScale, dx: D,
      weights: [1], means: [[...Array(D).fill(0), ...TINY.readout.intercept]], covariances: [eye],
    },
  };
  const g = spec('mfcc').create(11025, gmr).process(
    Float64Array.from({ length: FRAME }, (_, i) => Math.sin(i / 3)), { voiced: true, clarity: 1 });
  check(Math.round(g.f1) === 500 && Math.round(g.f2) === 1500,
    `a GMR readout passes the check too: F1 ${g.f1.toFixed(0)}, F2 ${g.f2.toFixed(0)}`);
}

// 6. The worker's protocol, driven directly: init -> ready -> frames.
console.log('\nWorker protocol:');
{
  const posted = [];
  globalThis.self = { postMessage: (msg) => posted.push(msg) };
  await import('../js/analysis-worker.js');
  const port = {};
  self.onmessage({ data: {
    type: 'init', sr: 11025, decim: 1,
    engines: [{ name: 'lpc' }, { name: 'mfcc', assets: TINY }, { name: 'bogus' }],
    enabled: ['lpc', 'mfcc'], gate: { rms: 0.008, clarity: 0.5 }, smoothing: 0.35,
    sendFrames: false, port,
  } });
  await new Promise((r) => setTimeout(r, 0)); // init is async: it may instantiate WebAssembly
  const ready = posted.shift();
  check(ready.type === 'ready' && Object.keys(ready.errors).join() === 'bogus',
    'ready, reporting the one engine it could not build');

  const vowel = Float32Array.from(normalize(synth(
    [{ f: 280, bw: 60 }, { f: 2250, bw: 90 }, { f: 2900, bw: 120 }, { f: 3600, bw: 200 }],
    120, 11025, 11025), 0.5));
  const fed = 128 * 43; // half a second, in render-quantum chunks
  for (let i = 0; i < fed; i += 128) port.onmessage({ data: vowel.subarray(i, i + 128) });
  const frameMsgs = posted.filter((m) => m.type === 'frame');
  const last = frameMsgs.at(-1);
  check(frameMsgs.length === frameCount(fed, 11025 / 60),
    `${frameMsgs.length} frame messages for half a second of audio`);
  check(last.voicing.voiced && last.results.lpc.updated && Math.abs(last.results.lpc.f2 - 2250) < 180,
    `LPC [i] from the worker: F1 ${last.results.lpc.f1.toFixed(0)}, F2 ${last.results.lpc.f2.toFixed(0)}`);
  check(Math.round(last.results.mfcc.f1) === 500 && !('frame' in last), 'MFCC from the worker; no frame copy unless asked');

  self.onmessage({ data: { type: 'configure', enabled: ['lpc'], sendFrames: true } });
  posted.length = 0;
  for (let i = fed; i < fed + 1024; i += 128) port.onmessage({ data: vowel.subarray(i, i + 128) });
  const after = posted.at(-1);
  check(after.frame?.length === FRAME && !('mfcc' in after.results),
    'configure: toggles apply, and the frame is sent once an ownAudio engine needs it');

  // The same worker on the WebAssembly back end, then switched back live.
  const { compileDsp } = await import('../js/engines/wasm.js');
  posted.length = 0;
  const port2 = {};
  self.onmessage({ data: {
    type: 'init', sr: 11025, decim: 1, engines: [{ name: 'lpc' }], enabled: ['lpc'],
    gate: { rms: 0.008, clarity: 0.5 }, smoothing: 0.35, sendFrames: false, port: port2,
    backend: 'wasm', dspModule: await compileDsp(),
  } });
  await new Promise((r) => setTimeout(r, 20));
  check(posted.shift()?.backend === 'wasm', 'init on WebAssembly: ready reports the wasm back end');
  for (let i = 0; i < fed; i += 128) port2.onmessage({ data: vowel.subarray(i, i + 128) });
  const wasmLast = posted.filter((m) => m.type === 'frame').at(-1);
  check(wasmLast.backend === 'wasm' && wasmLast.ms >= 0 && Math.abs(wasmLast.results.lpc.f1 - last.results.lpc.f1) < 1e-6
    && Math.abs(wasmLast.results.lpc.f2 - last.results.lpc.f2) < 1e-6,
    `LPC [i] on WebAssembly matches JavaScript: F1 ${wasmLast.results.lpc.f1.toFixed(0)}, F2 ${wasmLast.results.lpc.f2.toFixed(0)}`);
  posted.length = 0;
  self.onmessage({ data: { type: 'configure', backend: 'js' } });
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 1024; i += 128) port2.onmessage({ data: vowel.subarray(i, i + 128) });
  check(posted[0]?.type === 'backend' && posted[0].backend === 'js' && posted.at(-1).backend === 'js',
    'configure { backend }: switches live and says so');
}

// 7. ownAudio engines -- how wav2vec 2.0 plugs in -- with a stand-in engine.
// The tracker's engine bookkeeping needs no audio graph, so drive it directly.
console.log('\nownAudio engines (stand-in for wav2vec 2.0):');
{
  const { VowelTracker } = await import('../js/tracker.js');
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const built = [];
  class StandIn {
    constructor(loaded) { this.loaded = loaded; this.stream = null; this.stops = 0; this.calls = 0; }
    async start(stream) { await this.loaded; this.stream = stream; }
    async stop() { this.stops++; }
    process() { this.calls++; return { f1: 400, f2: 1600, f3: 0, confidence: 1, updated: true }; }
    reset() {}
  }
  let release;
  const fake = {
    name: 'w2v2', label: 'stand-in', ownAudio: true,
    create: () => { built.push(new StandIn(new Promise((r) => { release = r; }))); return built.at(-1); },
  };

  const t = new VowelTracker();
  const statuses = [];
  t.onEngineStatus = (name, s, detail) => statuses.push(detail ? `${s}: ${detail}` : s);
  // What start() leaves behind, minus the audio graph.
  Object.assign(t, {
    running: true, effSr: 11025, stream: { id: 'mic' },
    local: new Analyzer(11025), entries: [{ spec: fake, assets: null }],
  });

  t.configure({ enabled: ['w2v2'] });
  check(statuses.join() === 'loading' && t.wantsFrames(), 'enabled: start(stream) called, shows loading, frames requested');
  release();
  await settle();
  check(statuses.at(-1) === 'ready' && built[0].stream.id === 'mic', 'ready once start() resolves, holding the mic stream');

  t.receive({ type: 'frame', voicing: { voiced: true, rms: 0.1, f0: 120, clarity: 0.9 }, results: {}, frame: new Float64Array(FRAME) });
  check(built[0].calls === 1 && t.state.results.w2v2?.f1 === 400, 'worker frames reach its process() on the main thread');

  t.configure({ enabled: [] });
  await settle();
  check(built[0].stops === 1 && !('w2v2' in t.state.results) && !t.wantsFrames(), 'switched off: stop() called, readout dropped');

  t.configure({ enabled: ['w2v2'] });
  t.configure({ enabled: [] }); // off again while still loading
  release();
  await settle();
  check(built[1].stops === 1 && statuses.at(-1) === 'loading', 'switched off mid-load: stopped once start() settles, never "ready"');

  fake.create = () => ({ start: async () => { throw new Error('model 404'); } });
  t.configure({ enabled: ['w2v2'] });
  await settle();
  check(statuses.at(-1) === 'error: model 404', 'a start() that throws marks it unavailable');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
