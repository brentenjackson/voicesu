/**
 * End-to-end browser test.
 *
 * Chrome is fed a WAV of synthesized /i/, /ɑ/, /u/ as a fake microphone, then
 * driven over CDP through four page loads:
 *   1. as shipped: AudioWorklet + Worker capture, LPC tracking the fixture
 *      vowels, and the MFCC engine if models/mfcc_readout.json exists;
 *   2. with tiny fixture weights served in place of that file: MFCC plumbing,
 *      the legend, the primary-engine picker and per-engine calibration;
 *   3. with AudioContext refusing 11,025 Hz: the worker's decimation path;
 *   4. with AudioWorkletNode deleted: the main-thread fallback still tracks.
 *
 * Run via test/e2e.sh, which handles the server and browser lifecycle.
 */
import fs from 'node:fs';
import { PRESETS } from '../js/vowels.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8000';
const CDP = process.env.CDP_URL ?? 'http://localhost:9222';
const SHOT = process.argv[2];

const ROOT = new URL('..', import.meta.url);
const WEIGHTS = 'models/mfcc_readout.json';
const HAS_WEIGHTS = fs.existsSync(new URL(WEIGHTS, ROOT));
const PROBE = 'models/w2v2_probe.onnx';
const HAS_PROBE = fs.existsSync(new URL(PROBE, ROOT)) && fs.existsSync(new URL('models/w2v2_probe.json', ROOT));
const TINY = fs.readFileSync(new URL('test/fixtures/mfcc_readout.tiny.json', ROOT));
const CAL_KEY = 'voicesu.calibration.v1';

// Must match test/fixtures/make_vowel_wav.py.
const EXPECTED = [
  { symbol: 'i', f1: 280, f2: 2250 },
  { symbol: 'ɑ', f1: 730, f2: 1090 },
  { symbol: 'u', f1: 310, f2: 870 },
];
const TOL = (want) => Math.max(60, want * 0.08);

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target -- is Chrome running with --remote-debugging-port?');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const pageErrors = [];
const consoleErrors = [];
let servedWeights = null; // body for WEIGHTS while run 2 intercepts it

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  // Workers (the analysis worker) attach as child sessions; watch them too.
  if (msg.method === 'Target.attachedToTarget') {
    send('Runtime.enable', {}, msg.params.sessionId).catch(() => {});
  }
  if (msg.method === 'Fetch.requestPaused') {
    send('Fetch.fulfillRequest', {
      requestId: msg.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: servedWeights.toString('base64'),
    }).catch(() => {});
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description
      ?? msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const { url, text } = msg.params.entry;
    // Until the weights are exported the page's fetch of them 404s by design,
    // and Chrome logs every 404 as an error.
    if (!HAS_WEIGHTS && url?.endsWith(WEIGHTS)) return;
    consoleErrors.push(`[log] ${text}`);
  }
};

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId && { sessionId }) }));
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a page expression until it's truthy. */
async function waitFor(expr, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    if (await evaluate(expr)) return true;
  }
  return false;
}

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const setSelect = (sel, value) => evaluate(`(() => {
  const el = document.getElementById('${sel}');
  el.value = '${value}';
  el.dispatchEvent(new Event('change'));
})()`);

/** One snapshot of the live readouts. */
const readouts = () => evaluate(`(() => {
  const num = (id) => parseFloat(document.getElementById(id)?.textContent) || 0;
  return {
    lpc: { f1: num('f1-lpc'), f2: num('f2-lpc') },
    mfcc: { f1: num('f1-mfcc'), f2: num('f2-mfcc') },
    w2v2: { f1: num('f1-w2v2'), f2: num('f2-w2v2') },
    f0: num('f0'),
    vowel: document.getElementById('vowelBig').textContent,
    source: document.getElementById('vowelSrc').textContent,
    voiced: document.getElementById('voiceDot').classList.contains('on'),
  };
})()`);

async function sample(n, ms) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await readouts());
    await sleep(ms);
  }
  return out;
}

let prelude = null;

/**
 * Fresh page load. `weights`: serve this body for WEIGHTS. `script`: run
 * before the page's own, to take a browser feature away.
 */
async function load({ weights = null, script = null } = {}) {
  servedWeights = weights;
  if (weights) await send('Fetch.enable', { patterns: [{ urlPattern: `*${WEIGHTS}` }] });
  else await send('Fetch.disable');
  if (prelude) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: prelude });
  prelude = script
    ? (await send('Page.addScriptToEvaluateOnNewDocument', { source: script })).identifier
    : null;
  await send('Page.navigate', { url: BASE });
  await sleep(1000);
  // Engines whose load() is still in flight show "loading…".
  await waitFor(`!document.getElementById('note-mfcc')?.textContent.includes('loading')`);
}

async function startMic(where) {
  await evaluate(`document.getElementById('toggle').click()`);
  await waitFor(`/Listening|failed/.test(document.getElementById('status').textContent)`);
  const status = await evaluate(`document.getElementById('status').textContent`);
  check(/Listening/.test(status) && where.test(status), status.trim());
  await sleep(800); // let the first frames and the smoothing settle
}

/** LPC readouts follow the fixture through all three vowels. */
function checkTracking(samples) {
  const voiced = samples.filter((s) => s.voiced && s.lpc.f1 > 0);
  check(voiced.length >= samples.length * 0.9,
    `sustained voicing detected on ${voiced.length}/${samples.length} samples`);
  check(voiced.every((s) => Math.abs(s.f0 - 120) < 8),
    'F0 recovered as ~120 Hz throughout (fixture pitch)');

  for (const want of EXPECTED) {
    // Frames whose nearest-vowel readout (following LPC) names this vowel.
    const hits = voiced.filter((s) => s.vowel.split(' / ').includes(want.symbol));
    if (hits.length === 0) {
      check(false, `[${want.symbol}] never became the nearest vowel`);
      continue;
    }
    const f1 = median(hits.map((h) => h.lpc.f1));
    const f2 = median(hits.map((h) => h.lpc.f2));
    check(
      Math.abs(f1 - want.f1) < TOL(want.f1) && Math.abs(f2 - want.f2) < TOL(want.f2),
      `LPC [${want.symbol}] ${hits.length} frames — F1 ${f1} (want ${want.f1}±${TOL(want.f1).toFixed(0)}), ` +
      `F2 ${f2} (want ${want.f2}±${TOL(want.f2).toFixed(0)})`
    );
  }
  return voiced;
}

function checkErrors() {
  check(pageErrors.length === 0, `no uncaught exceptions, page or worker${pageErrors.length ? `: ${pageErrors}` : ''}`);
  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors}` : ''}`);
  pageErrors.length = 0;
  consoleErrors.length = 0;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send('Browser.grantPermissions', { origin: BASE, permissions: ['audioCapture'] });

// ------------------------------------------------------------ 1. as shipped

console.log(`Run 1: as shipped (${WEIGHTS} ${HAS_WEIGHTS ? 'present' : 'absent'})\n`);
await load();

console.log('Static render:');
const initial = await evaluate(`({
  title: document.title,
  chart: !!document.getElementById('chart'),
  scope: !!document.getElementById('scope'),
  calButtons: document.querySelectorAll('#calRow button').length,
  readout: document.getElementById('calReadout').textContent.trim(),
  lpcOn: document.getElementById('use-lpc').checked,
  mfccOn: document.getElementById('use-mfcc').checked,
  mfccDisabled: document.getElementById('use-mfcc').disabled,
  mfccNote: document.getElementById('note-mfcc').textContent,
  legend: [...document.querySelectorAll('#legend li')].map((li) => li.textContent),
})`);
check(initial.chart && initial.scope, 'both canvases present');
check(initial.calButtons === 4, `four calibration buttons (got ${initial.calButtons})`);
check(initial.readout.length > 0, `calibration readout populated: ${initial.readout.replace(/\s+/g, ' ')}`);
check(initial.lpcOn, 'LPC toggle on by default');
if (HAS_WEIGHTS) {
  check(initial.mfccOn && !initial.mfccDisabled, 'MFCC toggle offered and on (weights found)');
} else {
  check(initial.mfccDisabled && !initial.mfccOn && /weights not exported yet/.test(initial.mfccNote),
    `MFCC toggle disabled with a note: "${initial.mfccNote}"`);
}
check(initial.legend.includes('LPC'), `legend names the active engines: ${initial.legend.join(', ')}`);

console.log('\nMicrophone:');
await startMic(/in a worker/);

// Sample across the full 9 s loop of the fixture.
const run1 = await sample(30, 300);
console.log('\nTracking (AudioWorklet -> Worker):');
const voiced1 = checkTracking(run1);

console.log('\nMFCC with exported weights:');
if (HAS_WEIGHTS) {
  const withMfcc = voiced1.filter((s) => s.mfcc.f1 > 0 && s.mfcc.f2 > 0);
  check(withMfcc.length >= voiced1.length * 0.9,
    `MFCC F1/F2 readouts on ${withMfcc.length}/${voiced1.length} voiced samples`);
  for (const want of EXPECTED) {
    const hits = withMfcc.filter((s) => s.vowel.split(' / ').includes(want.symbol));
    if (hits.length) {
      console.log(`      [${want.symbol}] MFCC F1 ${median(hits.map((h) => h.mfcc.f1))}, ` +
        `F2 ${median(hits.map((h) => h.mfcc.f2))} (fixture ${want.f1}/${want.f2}; accuracy not asserted)`);
    }
  }
} else {
  console.log(`SKIP  ${WEIGHTS} not found, so no MFCC readouts to check (run 2 covers the plumbing)`);
}

console.log('\nErrors:');
checkErrors();

// ------------------------------------------------------------ 2. fixture weights

console.log('\nRun 2: fixture weights served for the MFCC engine\n');
// A calibration saved before engines existed, under the original key.
await evaluate(`localStorage.clear(); localStorage.setItem('${CAL_KEY}', '${JSON.stringify(PRESETS.female)}')`);
await load({ weights: TINY });

const calRow = (name) => `document.querySelector('#calReadout tr[data-engine="${name}"]')?.textContent ?? ''`;
const before = await evaluate(`({
  mfccOn: document.getElementById('use-mfcc').checked,
  legend: [...document.querySelectorAll('#legend li')].map((li) => li.textContent),
  calLpc: ${calRow('lpc')},
  calMfcc: ${calRow('mfcc')},
})`);
check(before.mfccOn, 'MFCC toggle on once its weights load');
check(before.legend.join() === 'LPC,MFCC', `legend: ${before.legend.join(', ')}`);
check(before.calLpc.includes('310/2790'), `LPC uses the calibration under the original key: ${before.calLpc}`);
check(before.calMfcc.includes('280/2250'), `MFCC starts from the male preset: ${before.calMfcc}`);

console.log('\nMicrophone:');
await startMic(/in a worker/);

console.log('\nMFCC readouts:');
const run2 = (await sample(10, 250)).filter((s) => s.voiced);
check(run2.length >= 8 && run2.every((s) => Math.abs(s.mfcc.f1 - 500) <= 1 && Math.abs(s.mfcc.f2 - 1500) <= 1),
  `MFCC row shows the fixture readout, 500/1500 Hz (${run2.length} voiced samples)`);
check(run2.every((s) => s.lpc.f1 > 0 && s.lpc.f2 > 0), 'LPC row keeps tracking alongside it');
check(run2.every((s) => s.source === 'LPC'), 'nearest-vowel readout follows LPC by default');

console.log('\nPrimary engine:');
await setSelect('primary', 'mfcc');
await sleep(500);
const run2b = (await sample(6, 250)).filter((s) => s.voiced);
// 500/1500 Hz on the male preset is the schwa node (see mapping.test.js).
check(run2b.length > 0 && run2b.every((s) => s.source === 'MFCC' && s.vowel === 'ə'),
  `picking MFCC moves the big readout to it: ${[...new Set(run2b.map((s) => `${s.source} ${s.vowel}`))]}`);

if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`      screenshot -> ${SHOT}`);
}
await setSelect('primary', 'lpc');

console.log('\nCalibration:');
// Start the capture as the fixture's /i/ begins, so the 2.5 s window sits
// inside its 3 s segment. LPC's F2 marks the onset whatever the calibration.
const lpcF2 = `parseFloat(document.getElementById('f2-lpc').textContent)`;
await waitFor(`${lpcF2} < 1500`, 10000);
await waitFor(`${lpcF2} > 2000`, 10000);
await evaluate(`document.querySelector('#calRow button').click()`); // [i], close front
await sleep(3000);
const cal = await evaluate(`({
  lpc: JSON.parse(localStorage.getItem('${CAL_KEY}')),
  mfcc: JSON.parse(localStorage.getItem('${CAL_KEY}.mfcc')),
  status: document.getElementById('calStatus').textContent,
})`);
console.log(`      ${cal.status}`);
const [mf1, mf2] = cal.mfcc?.closeFront ?? [0, 0];
check(Math.abs(mf1 - 500) <= 1 && Math.abs(mf2 - 1500) <= 1,
  `one capture stores MFCC's own median under its key: ${Math.round(mf1)}/${Math.round(mf2)}`);
const [lf1, lf2] = cal.lpc?.closeFront ?? [0, 0];
const ee = EXPECTED[0];
check(Math.abs(lf1 - ee.f1) < TOL(ee.f1) && Math.abs(lf2 - ee.f2) < TOL(ee.f2),
  `…and LPC's under the original key: ${Math.round(lf1)}/${Math.round(lf2)} (fixture [i] ${ee.f1}/${ee.f2})`);
check(['closeBack', 'openFront', 'openBack'].every((k) => JSON.stringify(cal.lpc[k]) === JSON.stringify(PRESETS.female[k])),
  'LPC\'s other corners are untouched');

await setSelect('preset', 'child');
const preset = await evaluate(`[localStorage.getItem('${CAL_KEY}'), localStorage.getItem('${CAL_KEY}.mfcc')]`);
check(preset.every((v) => v === JSON.stringify(PRESETS.child)), 'a preset applies to every engine');

console.log('\nWhile running:');
const legendNow = `[...document.querySelectorAll('#legend li')].map((li) => li.textContent).join()`;
await evaluate(`document.getElementById('use-mfcc').click()`);
await sleep(300);
const mfccOff = await evaluate(`[${legendNow}, document.getElementById('f1-mfcc').textContent]`);
check(mfccOff[0] === 'LPC' && mfccOff[1] === '—', 'switching MFCC off drops its legend entry and readout');
await evaluate(`document.getElementById('use-mfcc').click()`);
await sleep(500);
check(Math.abs((await readouts()).mfcc.f1 - 500) <= 1, '…and switching it back on resumes it');

// Lift the slider's ceiling so the gate can shut out the fixture entirely.
const setGate = (v) => evaluate(`(() => {
  const g = document.getElementById('gate');
  g.max = '1';
  g.value = '${v}';
  g.dispatchEvent(new Event('input'));
})()`);
await setGate(1);
await sleep(400);
check((await sample(4, 150)).every((s) => !s.voiced), 'the voicing-gate slider reaches the worker');
await setGate(0.008);
await sleep(400);
check((await sample(3, 150)).some((s) => s.voiced), '…in both directions');

await evaluate(`document.getElementById('toggle').click()`);
await waitFor(`/Stopped/.test(document.getElementById('status').textContent)`);
await startMic(/in a worker/);
const again = (await sample(4, 200)).filter((s) => s.voiced);
check(again.length > 0 && again.every((s) => s.lpc.f1 > 0 && Math.abs(s.mfcc.f1 - 500) <= 1),
  'stop, then start again: both engines report');

console.log('\nErrors:');
checkErrors();

// ------------------------------------------------------------ 3. decimation

console.log('\nRun 3: AudioContext ignores the 11,025 Hz request, so the worker decimates\n');
await evaluate('localStorage.clear()');
await load({ script: 'window.AudioContext = class extends AudioContext { constructor() { super(); } };' });

console.log('Microphone:');
await startMic(/^Listening — (?!11025 )\d+ Hz in, analyzing at \d+ Hz in a worker/);

const run3 = await sample(30, 300);
console.log('\nTracking (hardware rate -> integer decimation in the worker):');
checkTracking(run3);

console.log('\nErrors:');
checkErrors();

// ------------------------------------------------------------ 4. fallback

console.log('\nRun 4: no AudioWorklet, so analysis falls back to the main thread\n');
await load({ script: 'delete window.AudioWorkletNode;' });

console.log('Microphone:');
await startMic(/on the main thread/);

const run4 = await sample(30, 300);
console.log('\nTracking (AnalyserNode, requestAnimationFrame):');
checkTracking(run4);

console.log('\nErrors:');
checkErrors();

// ------------------------------------------------------------ 5. wav2vec 2.0

console.log('\nRun 5: wav2vec 2.0 engine (own 16 kHz capture, ONNX in a worker)\n');
if (!HAS_PROBE) {
  console.log(`SKIP  ${PROBE} not exported, so no wav2vec 2.0 engine to check`);
} else {
  await load();
  await waitFor(`!document.getElementById('note-w2v2')?.textContent.includes('loading')`);
  const w = await evaluate(`({
    offered: !document.getElementById('use-w2v2').disabled,
    on: document.getElementById('use-w2v2').checked,
  })`);
  check(w.offered && !w.on, 'wav2vec 2.0 toggle offered, off by default');
  await evaluate(`document.getElementById('use-w2v2').click()`);
  console.log('Microphone:');
  await startMic(/in a worker/);
  // start() fetches onnxruntime-web from its CDN and the model; give it time.
  await waitFor(`/Hz/.test(document.getElementById('f1-w2v2').textContent) ||
    /unavailable/.test(document.getElementById('note-w2v2').textContent)`, 20000);
  const note = await evaluate(`document.getElementById('note-w2v2').textContent`);
  if (/unavailable/.test(note)) {
    console.log(`SKIP  wav2vec 2.0 engine ${note.trim()} (offline? it loads onnxruntime-web from a CDN)`);
  } else {
    const run5 = (await sample(30, 300)).filter((s) => s.voiced);
    const withW = run5.filter((s) => s.w2v2.f1 > 0 && s.w2v2.f2 > 0);
    check(withW.length >= run5.length * 0.8,
      `wav2vec 2.0 F1/F2 readouts on ${withW.length}/${run5.length} voiced samples`);
    for (const want of EXPECTED) {
      const hits = withW.filter((s) => s.vowel.split(' / ').includes(want.symbol));
      if (hits.length) {
        console.log(`      [${want.symbol}] wav2vec 2.0 F1 ${median(hits.map((h) => h.w2v2.f1))}, ` +
          `F2 ${median(hits.map((h) => h.w2v2.f2))} (fixture ${want.f1}/${want.f2}; accuracy not asserted)`);
      }
    }
  }
  console.log('\nErrors:');
  checkErrors();
}

// ------------------------------------------------------------ 6. WebAssembly back end

console.log('\nRun 6: per-frame pipeline on the WebAssembly back end, then switched live\n');
await load();
await setSelect('backend', 'wasm');
console.log('Microphone:');
await startMic(/in a worker/);
await waitFor(`/WebAssembly/.test(document.getElementById('analysisMs').textContent)`);
const wasmReadout = await evaluate(`document.getElementById('analysisMs').textContent`);
check(/WebAssembly/.test(wasmReadout), `analysis readout names the back end: ${wasmReadout}`);
const run6 = await sample(30, 300);
console.log('\nTracking (WebAssembly in the worker):');
checkTracking(run6);

await setSelect('backend', 'js');
await waitFor(`/JavaScript/.test(document.getElementById('analysisMs').textContent)`);
await sleep(2500); // a fresh two-second window on the new back end
const jsReadout = await evaluate(`document.getElementById('analysisMs').textContent`);
check(/JavaScript/.test(jsReadout), `switched live to JavaScript: ${jsReadout}`);
const afterSwitch = (await sample(10, 300)).filter((s) => s.voiced && s.lpc.f1 > 0);
check(afterSwitch.length >= 8, `still tracking after the switch (${afterSwitch.length}/10 voiced samples)`);

console.log('\nErrors:');
checkErrors();

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
ws.close();
process.exit(failures ? 1 : 0);
