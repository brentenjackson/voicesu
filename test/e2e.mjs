/**
 * End-to-end browser test.
 *
 * Chrome is fed a WAV of synthesized /i/, /ɑ/, /u/ as a fake microphone, then
 * driven over CDP: start the mic, sample the live readouts, and assert the
 * tracker recovers the formants it was given and snaps to the right chart nodes.
 *
 * Run via test/e2e.sh, which handles the server and browser lifecycle.
 */
import fs from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:8000';
const CDP = process.env.CDP_URL ?? 'http://localhost:9222';
const SHOT = process.argv[2];

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

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description
      ?? msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(`[log] ${msg.params.entry.text}`);
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Browser.grantPermissions', { origin: BASE, permissions: ['audioCapture'] });
await send('Page.navigate', { url: BASE });
await sleep(1500);

console.log('Static render:');
const initial = await evaluate(`({
  title: document.title,
  chart: !!document.getElementById('chart'),
  scope: !!document.getElementById('scope'),
  calButtons: document.querySelectorAll('#calRow button').length,
  readout: document.getElementById('calReadout').textContent.trim(),
})`);
check(initial.chart && initial.scope, 'both canvases present');
check(initial.calButtons === 4, `four calibration buttons (got ${initial.calButtons})`);
check(initial.readout.length > 0, `calibration readout populated: ${initial.readout}`);

console.log('\nMicrophone:');
await evaluate(`document.getElementById('toggle').click()`);
await sleep(1200);
const status = await evaluate(`document.getElementById('status').textContent`);
check(/Listening/.test(status), status.trim());

// Sample across the full 9 s loop of the fixture.
const samples = [];
for (let i = 0; i < 30; i++) {
  samples.push(await evaluate(`({
    f1: parseFloat(document.getElementById('f1').textContent) || 0,
    f2: parseFloat(document.getElementById('f2').textContent) || 0,
    f0: parseFloat(document.getElementById('f0').textContent) || 0,
    vowel: document.getElementById('vowelBig').textContent,
    voiced: document.getElementById('voiceDot').classList.contains('on'),
  })`));
  await sleep(300);
}

const voiced = samples.filter((s) => s.voiced && s.f1 > 0);
console.log('\nTracking:');
check(voiced.length >= samples.length * 0.9,
  `sustained voicing detected on ${voiced.length}/${samples.length} samples`);
check(voiced.every((s) => Math.abs(s.f0 - 120) < 8),
  'F0 recovered as ~120 Hz throughout (fixture pitch)');

for (const want of EXPECTED) {
  // Frames whose nearest-vowel readout names this vowel.
  const hits = voiced.filter((s) => s.vowel.split(' / ').includes(want.symbol));
  if (hits.length === 0) {
    check(false, `[${want.symbol}] never became the nearest vowel`);
    continue;
  }
  const med = (k) => {
    const v = hits.map((h) => h[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const f1 = med('f1'), f2 = med('f2');
  check(
    Math.abs(f1 - want.f1) < TOL(want.f1) && Math.abs(f2 - want.f2) < TOL(want.f2),
    `[${want.symbol}] ${hits.length} frames — F1 ${f1} (want ${want.f1}±${TOL(want.f1).toFixed(0)}), ` +
    `F2 ${f2} (want ${want.f2}±${TOL(want.f2).toFixed(0)})`
  );
}

console.log('\nErrors:');
check(pageErrors.length === 0, `no uncaught page exceptions${pageErrors.length ? `: ${pageErrors}` : ''}`);
check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors}` : ''}`);

if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log(`\nscreenshot -> ${SHOT}`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
ws.close();
process.exit(failures ? 1 : 0);
