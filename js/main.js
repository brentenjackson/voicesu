// UI wiring: engine toggles and readouts, calibration flow, animation loop.

import { VowelTracker } from './tracker.js';
import { ChartRenderer, ScopeRenderer } from './chart.js';
import { PRESETS, CORNERS, buildCalibration, formantsToChart, nearestVowel } from './vowels.js';
import { ENGINES, loadEngines } from './engines/registry.js';
import { compileDsp } from './engines/wasm.js';
import { ENGINE_COLORS } from './engines/index.js';
import { loadCalibration, saveCalibration, CornerCapture } from './calibration.js';
import { PilotLogger, PILOT_TASK } from './pilot.js';

const $ = (id) => document.getElementById(id);

const tracker = new VowelTracker();
const chart = new ChartRenderer($('chart'));
const scope = new ScopeRenderer($('scope'));

// One record per registered engine. Each has its own calibration and its own
// cursor; the rendered cursor lags the raw measurement -- that's what gives it
// the weighty, osu-like glide instead of jittering around.
const engines = ENGINES.map((spec, slot) => ({
  spec,
  slot,
  name: spec.name,
  label: spec.label,
  color: ENGINE_COLORS[spec.name] ?? '#c8cde0',
  available: !spec.load,           // anything with a load() waits for it
  enabled: !!spec.defaultOn,
  failed: false,                   // couldn't be built or started this session
  note: spec.load ? 'loading…' : '',
  assets: null,
  calibration: buildCalibration(loadCalibration(spec.name)),
  cursor: newCursor(),
}));
const byName = new Map(engines.map((e) => [e.name, e]));

let primary = 'lpc'; // the user's pick for the big readout
let running = false;

const isActive = (e) => e.available && e.enabled && !e.failed;
const activeEngines = () => engines.filter(isActive);
const activeNames = () => activeEngines().map((e) => e.name);

/** The user's pick if it's on, else the first engine that is. */
function primaryEngine() {
  const e = byName.get(primary);
  return e && isActive(e) ? e : activeEngines()[0] ?? null;
}

function newCursor() { return { backness: 0.5, height: 0.5, strength: 0 }; }

// ---------------------------------------------------------------- engines

// ---------------------------------------------------------------- processing back end

const BACKEND_KEY = 'voicesu.backend';
const BACKEND_LABELS = { js: 'JavaScript', wasm: 'WebAssembly' };

// Compiled once here; the analysis worker instantiates its own copy.
const dspLoaded = compileDsp().then((module) => {
  tracker.dspModule = module;
}).catch((err) => {
  $('backend').querySelector('option[value="wasm"]').disabled = true;
  $('backendNote').textContent = `WebAssembly unavailable: ${err.message}`;
  if (tracker.backend === 'wasm') setBackend('js');
});

function setBackend(backend) {
  $('backend').value = backend;
  try { localStorage.setItem(BACKEND_KEY, backend); } catch { /* private mode */ }
  tracker.configure({ backend });
}

tracker.onBackend = (backend, note) => {
  $('backend').value = backend;
  $('backendNote').textContent = note;
};

$('backend').addEventListener('change', (e) => setBackend(e.target.value));

const enginesLoaded = loadEngines(ENGINES).then((loaded) => {
  for (const { spec, assets, available, note } of loaded) {
    Object.assign(byName.get(spec.name), { assets, available, note });
  }
  tracker.configure({ enabled: activeNames() });
  renderEngines();
});

function buildEngineRows() {
  for (const e of engines) {
    const row = document.createElement('div');
    row.className = 'engine';
    row.id = `engine-${e.name}`;
    row.style.setProperty('--c', e.color);
    row.innerHTML = `
      <label class="engine-name"><input type="checkbox" id="use-${e.name}"><i class="swatch"></i>${e.label}</label>
      <b id="f1-${e.name}">—</b><b id="f2-${e.name}">—</b>
      <small class="engine-note" id="note-${e.name}"></small>`;
    $('engines').appendChild(row);
    $(`use-${e.name}`).addEventListener('change', (ev) => setEnabled(e, ev.target.checked));
  }
}

function setEnabled(e, on) {
  e.enabled = on;
  // An ownAudio engine that failed to start gets another go when re-checked.
  if (e.spec.ownAudio && e.failed) { e.failed = false; e.note = ''; }
  e.cursor = newCursor();
  chart.clearTrail(e.name);
  tracker.configure({ enabled: activeNames() });
  renderEngines();
}

tracker.onEngineStatus = (name, status, detail) => {
  const e = byName.get(name);
  e.failed = status === 'error';
  e.note = { loading: 'loading…', error: `unavailable: ${detail}` }[status] ?? '';
  if (e.failed) tracker.configure({ enabled: activeNames() });
  renderEngines();
};

/** Toggles, notes, legend, primary picker and calibration table, from `engines`. */
function renderEngines() {
  for (const e of engines) {
    const box = $(`use-${e.name}`);
    box.disabled = !e.available;
    box.checked = e.available && e.enabled;
    $(`note-${e.name}`).textContent = e.note;
    $(`engine-${e.name}`).classList.toggle('off', !isActive(e));
  }

  $('legend').replaceChildren(...activeEngines().map((e) => {
    const li = document.createElement('li');
    li.style.setProperty('--c', e.color);
    li.innerHTML = `<i class="swatch"></i>${e.label}`;
    return li;
  }));

  const lead = primaryEngine();
  const pick = $('primary');
  pick.replaceChildren(...activeEngines().map((e) => new Option(e.label, e.name)));
  pick.value = lead?.name ?? '';
  pick.disabled = activeEngines().length < 2;
  $('vowelSrc').textContent = lead?.label ?? '';
  $('vowelSrc').style.color = lead?.color ?? '';

  renderCalReadout();
}

// ---------------------------------------------------------------- calibration

function setRef(e, ref) {
  e.calibration = buildCalibration(ref);
  saveCalibration(e.name, ref);
}

function renderCalReadout() {
  const head = `<thead><tr><th></th>${CORNERS.map((c) => `<th>${c.symbol}</th>`).join('')}</tr></thead>`;
  const rows = engines.filter((e) => e.available).map((e) => {
    const cells = CORNERS.map((c) => {
      const [f1, f2] = e.calibration.ref[c.key];
      return `<td>${Math.round(f1)}/${Math.round(f2)}</td>`;
    });
    return `<tr data-engine="${e.name}"><th style="color:${e.color}">${e.label}</th>${cells.join('')}</tr>`;
  });
  $('calReadout').innerHTML = `${head}<tbody>${rows.join('')}</tbody>`;
}

/** Hold one vowel for a few seconds; every engine that's on takes its own median. */
let capture = null;

function startCalibration(corner, seconds = 2.5) {
  if (!running) { setStatus('Start the mic first.', true); return; }
  capture = new CornerCapture(corner, activeNames(), performance.now() + seconds * 1000);
  $('calStatus').textContent = `Hold [${corner.symbol}]…`;
}

// Sampled per analysis frame, not per animation frame, so a busy or hidden
// tab doesn't change how many frames a corner gets. The pilot log shares it.
const pilot = new PilotLogger();
tracker.onFrame = (state) => {
  capture?.push(state);
  pilot.record(state, state.results);
};

/** Walk through PILOT_TASK, a second's pause between steps, logging each one. */
async function runPilot() {
  if (!running) { $('pilotStatus').textContent = 'Start the mic first.'; return; }
  const id = $('pilotId').value.trim() || 'unnumbered';
  pilot.begin({ participant: id, engines: activeNames() });
  $('pilotRun').disabled = true;
  $('pilotSave').disabled = true;
  for (const step of PILOT_TASK) {
    for (let left = step.seconds; left > 0; left -= 0.1) {
      pilot.setSegment(step.key);
      $('pilotStatus').textContent = `[${step.symbol}] ${step.prompt}… ${left.toFixed(1)} s`;
      await new Promise((r) => setTimeout(r, 100));
    }
    pilot.setSegment(null);
    $('pilotStatus').textContent = 'Pause…';
    await new Promise((r) => setTimeout(r, 1000));
  }
  $('pilotStatus').textContent = `Done: ${pilot.frames.length} frames logged. Save the log if you'd like to share it.`;
  $('pilotRun').disabled = false;
  $('pilotSave').disabled = false;
}

$('pilotRun').addEventListener('click', runPilot);
$('pilotSave').addEventListener('click', () => {
  pilot.download(`voicesu-pilot-${pilot.meta.participant}.json`);
});

function tickCalibration() {
  if (!capture) return;
  const left = (capture.until - performance.now()) / 1000;
  if (left > 0) {
    $('calStatus').textContent =
      `Hold [${capture.corner.symbol}]… ${left.toFixed(1)}s (${capture.frames} frames)`;
    return;
  }

  const { key, symbol } = capture.corner;
  const got = [];
  const short = [];
  for (const [name, med] of Object.entries(capture.medians())) {
    const e = byName.get(name);
    if (!med) { short.push(e.label); continue; }
    setRef(e, { ...e.calibration.ref, [key]: med });
    got.push(`${e.label} ${Math.round(med[0])}/${Math.round(med[1])}`);
  }
  capture = null;
  renderCalReadout();
  $('calStatus').textContent = got.length
    ? `Captured [${symbol}], F1/F2 Hz: ${got.join(' · ')}` +
      (short.length ? ` — too few frames from ${short.join(', ')}` : '')
    : 'Not enough voiced audio — try again, louder.';
}

// ---------------------------------------------------------------- main loop

function loop() {
  requestAnimationFrame(loop);
  const state = tracker.tick();
  tickCalibration();

  const ease = Number($('ease').value);
  const lead = primaryEngine();
  let active = null;
  const cursors = [];

  for (const e of activeEngines()) {
    const r = state.results[e.name];
    const c = e.cursor;
    if (state.voiced && r && r.f1 && r.f2) {
      const pos = formantsToChart(r.f1, r.f2, e.calibration);
      // Clamp a little outside the quad so extreme vowels still read as "at the edge".
      const target = {
        backness: clamp(pos.backness, -0.12, 1.12),
        height: clamp(pos.height, -0.12, 1.12),
      };
      if (e === lead) active = nearestVowel(target.backness, target.height).vowel;
      c.backness += (target.backness - c.backness) * ease;
      c.height += (target.height - c.height) * ease;
      c.strength = Math.min(1, state.rms / 0.06);
      chart.pushTrail(e.name, c.backness, c.height);
    } else {
      c.strength *= 0.9;
    }
    // An engine still loading has no results yet, and so no cursor.
    if (running && r) cursors.push({ ...c, key: e.name, label: e.label, color: e.color, slot: e.slot });
  }
  // The primary engine's cursor paints on top.
  cursors.sort((a, b) => (a.key === lead?.name) - (b.key === lead?.name));

  chart.draw(cursors, active);
  if (running) {
    const lpc = state.results.lpc;
    scope.draw({ ...state, f1: lpc?.f1, f2: lpc?.f2, f3: lpc?.f3 }, tracker.effSr / 2);
  }
  updateReadouts(state, active);
}

function updateReadouts(state, active) {
  $('vowelBig').textContent = state.voiced && active ? active.s.join(' / ') : '—';
  for (const e of engines) {
    const r = isActive(e) ? state.results[e.name] : null;
    $(`f1-${e.name}`).textContent = r?.f1 ? `${Math.round(r.f1)} Hz` : '—';
    $(`f2-${e.name}`).textContent = r?.f2 ? `${Math.round(r.f2)} Hz` : '—';
  }
  $('f0').textContent = state.voiced && state.f0 ? `${Math.round(state.f0)} Hz` : '—';
  $('clarity').textContent = state.clarity ? state.clarity.toFixed(2) : '—';
  $('analysisMs').textContent = running && state.analysisMs
    ? `${state.analysisMs.toFixed(3)} ms (${BACKEND_LABELS[state.backend]})`
    : '—';
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
    capture = null;
    chart.clearTrail();
    for (const e of engines) {
      e.cursor = newCursor();
      if (e.failed) { e.failed = false; e.note = ''; } // next start tries again
    }
    renderEngines();
    $('toggle').textContent = 'Start microphone';
    $('toggle').classList.remove('active');
    setStatus('Stopped.');
    return;
  }
  try {
    setStatus('Requesting microphone…');
    await Promise.all([enginesLoaded, dspLoaded]);
    tracker.configure({ enabled: activeNames() });
    await tracker.start(engines.filter((e) => e.available).map(({ spec, assets }) => ({ spec, assets })));
    running = true;
    $('toggle').textContent = 'Stop';
    $('toggle').classList.add('active');
    const where = tracker.mode === 'worker'
      ? 'in a worker'
      : `on the main thread (${tracker.fallbackReason})`;
    setStatus(`Listening — ${tracker.sr} Hz in, analyzing at ${Math.round(tracker.effSr)} Hz ` +
      `${where}, LPC order ${tracker.order}`);
  } catch (err) {
    setStatus(`Microphone failed: ${err.message}`, true);
  }
});

$('primary').addEventListener('change', (e) => {
  primary = e.target.value;
  renderEngines();
});

$('preset').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (p) {
    // Every engine, including ones that are off or not loaded yet.
    for (const eng of engines) setRef(eng, p);
    renderCalReadout();
    $('calStatus').textContent = `Loaded ${e.target.value} preset for every engine.`;
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
  tracker.configure({ gate: { rms: Number(e.target.value) } });
  $('gateVal').textContent = Number(e.target.value).toFixed(3);
});
$('smooth').addEventListener('input', (e) => {
  tracker.configure({ smoothing: Number(e.target.value) });
  $('smoothVal').textContent = Number(e.target.value).toFixed(2);
});

window.addEventListener('resize', () => { chart.resize(); scope.resize(); });

buildEngineRows();
renderEngines();
$('easeVal').textContent = Number($('ease').value).toFixed(2);
$('gateVal').textContent = Number($('gate').value).toFixed(3);
$('smoothVal').textContent = Number($('smooth').value).toFixed(2);
tracker.configure({
  enabled: activeNames(),
  gate: { rms: Number($('gate').value) },
  smoothing: Number($('smooth').value),
});
try {
  const saved = localStorage.getItem(BACKEND_KEY);
  if (saved && BACKEND_LABELS[saved]) setBackend(saved);
} catch { /* private mode */ }
loop();
