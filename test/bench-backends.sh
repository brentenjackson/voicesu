#!/usr/bin/env bash
# Time both back ends in a headless Chrome worker: test/bench-backends.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT=8125
CDP_PORT=9335

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
[ -z "$CHROME" ] && { echo "SKIP: no Chrome/Chromium found" >&2; exit 0; }

cleanup() {
  [ -n "${CHROME_PID:-}" ] && { kill "$CHROME_PID" 2>/dev/null; wait "$CHROME_PID" 2>/dev/null; } || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

(cd "$ROOT" && python3 serve.py "$PORT" >"$WORK/server.log" 2>&1) &
SERVER_PID=$!
"$CHROME" --headless=new --remote-debugging-port="$CDP_PORT" --user-data-dir="$WORK/profile" \
  --no-first-run --no-default-browser-check --disable-gpu about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://localhost:$CDP_PORT/json/version" >/dev/null && break
  sleep 0.25
done

URL="http://localhost:$PORT/test/bench-backends.html" CDP_URL="http://localhost:$CDP_PORT" node --input-type=module -e '
const targets = await (await fetch(`${process.env.CDP_URL}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable");
await send("Page.navigate", { url: process.env.URL });
for (let t = 0; t < 600; t++) {
  await new Promise((r) => setTimeout(r, 500));
  const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__bench ?? null)", returnByValue: true });
  const v = JSON.parse(r.result.value);
  if (v?.error) { console.log(v.error); process.exit(1); }
  if (v) {
    console.log(v.markdown);
    console.log(`\nModule compile ${v.compileMs.toFixed(2)} ms, instantiate ${v.instMs.toFixed(2)} ms`);
    console.log(v.userAgent);
    process.exit(0);
  }
}
console.log("timed out"); process.exit(1);
'
