import { VowelTracker } from './tracker.js';
import { ChartRenderer, ScopeRenderer } from './chart.js';
import { PRESETS, CORNERS, buildCalibration, formantsToChart, nearestVowel } from './vowels.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'voicesu.calibration.v1';

const tracker = new VowelTracker();
const chart = new ChartRenderer($('chart'));
const scope = new ScopeRenderer($('scope'));

let calibration = loadCalibration();
// The rendered cursor lags the raw measurement -- that's what gives it the
// weighty, osu-like glide instead of jittering around.
let cursor = { backness: 0.5, height: 0.5 };
let strength = 0;
let running = false;

// ---------------------------------------------------------------- calibration

function loadCalibration() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return buildCalibration(JSON.parse(raw));
  } catch { /* fall through to preset */ }
  return buildCalibration(PRESETS.male);
}

function applyRef(ref, persist = true) {
  calibration = buildCalibration(ref);
  if (persist) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(ref)); } catch { /* private mode */ }
  }
  renderCalReadout();
}

function renderCalReadout() {
  const r = calibration.ref;
  $('calReadout').textContent = CORNERS
    .map((c) => `${c.symbol} ${Math.round(r[c.key][0])}/${Math.round(r[c.key][1])}`)
    .join('   ');
}

/** Hold one vowel for a few seconds; take the median of every voiced frame. */
const calState = { active: false, corner: null, samples: [], until: 0 };

function startCalibration(corner, seconds = 2.5) {
  if (!running) { setStatus('Start the mic first.', true); return; }
  calState.active = true;
  calState.corner = corner;
  calState.samples = [];
  calState.until = performance.now() + seconds * 1000;
  $('calStatus').textContent = `Hold [${corner.symbol}]…`;
}

function tickCalibration(state) {
  if (!calState.active) return;
  if (state.voiced && state.f1 && state.f2) calState.samples.push([state.f1, state.f2]);

  const left = (calState.until - performance.now()) / 1000;
  if (left > 0) {
    $('calStatus').textContent =
      `Hold [${calState.corner.symbol}]… ${left.toFixed(1)}s (${calState.samples.length} frames)`;
    return;
  }

  calState.active = false;
  if (calState.samples.length < 8) {
    $('calStatus').textContent = 'Not enough voiced audio — try again, louder.';
    return;
  }
  const med = (idx) => {
    const s = calState.samples.map((p) => p[idx]).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const { key, symbol } = calState.corner;
  const ref = { ...calibration.ref, [key]: [med(0), med(1)] };
  applyRef(ref);
  $('calStatus').textContent =
    `Captured [${symbol}]: F1 ${Math.round(ref[key][0])} Hz, F2 ${Math.round(ref[key][1])} Hz`;
}

// ---------------------------------------------------------------- main loop

function loop() {
  requestAnimationFrame(loop);
  const state = tracker.analyze();
  tickCalibration(state);

  let target = null;
  let active = null;

  if (state.voiced && state.f1 && state.f2) {
    const pos = formantsToChart(state.f1, state.f2, calibration);
    // Clamp a little outside the quad so extreme vowels still read as "at the edge".
    target = {
      backness: clamp(pos.backness, -0.12, 1.12),
      height: clamp(pos.height, -0.12, 1.12),
    };
    const near = nearestVowel(target.backness, target.height);
    active = near.vowel;
    strength = Math.min(1, state.rms / 0.06);
  } else {
    strength *= 0.9;
  }

  if (target) {
    const ease = Number($('ease').value);
    cursor.backness += (target.backness - cursor.backness) * ease;
    cursor.height += (target.height - cursor.height) * ease;
    chart.pushTrail(cursor.backness, cursor.height);
  }

  chart.draw(running ? { ...cursor, strength } : null, active);
  if (running) scope.draw(state, tracker.effSr / 2);
  updateReadouts(state, active);
}

function updateReadouts(state, active) {
  $('vowelBig').textContent = state.voiced && active ? active.s.join(' / ') : '—';
  $('f1').textContent = state.f1 ? `${Math.round(state.f1)} Hz` : '—';
  $('f2').textContent = state.f2 ? `${Math.round(state.f2)} Hz` : '—';
  $('f0').textContent = state.voiced && state.f0 ? `${Math.round(state.f0)} Hz` : '—';
  $('clarity').textContent = state.clarity ? state.clarity.toFixed(2) : '—';
  $('level').style.width = `${Math.min(100, (state.rms / 0.12) * 100)}%`;
  $('voiceDot').classList.toggle('on', !!state.voiced);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ---------------------------------------------------------------- wiring

$('toggle').addEventListener('click', async () => {
  if (running) {
    await tracker.stop();
    running = false;
    chart.clearTrail();
    $('toggle').textContent = 'Start microphone';
    $('toggle').classList.remove('active');
    setStatus('Stopped.');
    return;
  }
  try {
    setStatus('Requesting microphone…');
    await tracker.start();
    running = true;
    $('toggle').textContent = 'Stop';
    $('toggle').classList.add('active');
    setStatus(`Listening — ${tracker.sr} Hz in, analyzing at ${Math.round(tracker.effSr)} Hz, LPC order ${tracker.order}`);
  } catch (err) {
    setStatus(`Microphone failed: ${err.message}`, true);
  }
});

$('preset').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (p) {
    applyRef(p);
    $('calStatus').textContent = `Loaded ${e.target.value} preset.`;
  }
});

// Calibration buttons are generated from CORNERS so the two can't drift apart.
for (const corner of CORNERS) {
  const btn = document.createElement('button');
  btn.className = 'ghost';
  btn.innerHTML = `<span class="sym">${corner.symbol}</span>${corner.prompt}`;
  btn.addEventListener('click', () => startCalibration(corner));
  $('calRow').appendChild(btn);
}

$('ease').addEventListener('input', (e) => {
  $('easeVal').textContent = Number(e.target.value).toFixed(2);
});
$('gate').addEventListener('input', (e) => {
  tracker.gate.rms = Number(e.target.value);
  $('gateVal').textContent = Number(e.target.value).toFixed(3);
});
$('smooth').addEventListener('input', (e) => {
  tracker.smoothing = Number(e.target.value);
  $('smoothVal').textContent = Number(e.target.value).toFixed(2);
});

window.addEventListener('resize', () => { chart.resize(); scope.resize(); });

renderCalReadout();
$('easeVal').textContent = Number($('ease').value).toFixed(2);
$('gateVal').textContent = Number($('gate').value).toFixed(3);
$('smoothVal').textContent = Number($('smooth').value).toFixed(2);
tracker.gate.rms = Number($('gate').value);
tracker.smoothing = Number($('smooth').value);
loop();
