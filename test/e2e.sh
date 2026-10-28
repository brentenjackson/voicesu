#!/usr/bin/env bash
# Drive the real page in headless Chrome with a synthesized vowel WAV as the mic.
# Usage: test/e2e.sh [screenshot.png]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PORT=8123
CDP_PORT=9333
SHOT="${1:-}"

CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then
  echo "SKIP: no Chrome/Chromium found" >&2
  exit 0
fi

cleanup() {
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Generating fixture audio…"
python3 "$ROOT/test/fixtures/make_vowel_wav.py" "$WORK/vowels.wav"

python3 "$ROOT/serve.py" "$PORT" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

"$CHROME" --headless=new --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$WORK/profile" \
  --no-first-run --no-default-browser-check --disable-gpu \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream \
  --use-file-for-fake-audio-capture="$WORK/vowels.wav" \
  --autoplay-policy=no-user-gesture-required \
  --window-size=1400,900 about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$CDP_PORT/json/version" >/dev/null && break
  sleep 0.25
done

BASE_URL="http://localhost:$PORT" CDP_URL="http://localhost:$CDP_PORT" \
  node "$ROOT/test/e2e.mjs" $SHOT
