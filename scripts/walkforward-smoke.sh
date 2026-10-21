#!/usr/bin/env bash
# Walk-forward in the real UI, on real data.
#
# Verifying the things a green unit test cannot: that the panel renders a verdict, that the
# train/test controls change the result, and that the window count falls when the windows grow.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18191}"
LOG=/tmp/wftest.log
CACHE=/tmp/wf-cache-$$
mkdir -p "$CACHE"

cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

echo "=== building ==="
export NODE_OPTIONS=--max-old-space-size=1600
npx vite build > /tmp/vb-wf.log 2>&1 || { echo "vite FAILED"; tail -5 /tmp/vb-wf.log; exit 1; }
npx tsc -p tsconfig.main.json > /tmp/tsc-wf.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-wf.log; exit 1; }
node scripts/postbuild-main.mjs >> /tmp/vb-wf.log 2>&1

FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &

READY=0
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl; then READY=1; break; fi
  sleep 0.5
done
[ "$READY" = "1" ] || { echo "FAIL: no debugger"; tail -15 "$LOG"; exit 1; }
export FX_PORT=$PORT

node --input-type=module <<'JS'
const PORT = process.env.FX_PORT;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);

console.log("1. GET A SESSION WITH DATA:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
  return JSON.stringify({
    hasChart: !!document.querySelector('.chart-host'),
    bars: document.querySelector('[data-bars]')?.getAttribute('data-bars'),
  });
})()`));

console.log("2. OPEN THE STRATEGY TAB AND FIND THE WALK-FORWARD PANEL:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-tab="strategy"]')?.click();
  await w(800);
  const tabs = [...document.querySelectorAll('.strategy-panel .tabs .tab')].map(b => b.textContent?.trim());
  const wfTab = [...document.querySelectorAll('.strategy-panel .tabs .tab')]
    .find(b => /walk/i.test(b.textContent ?? ''));
  wfTab?.click();
  await w(700);
  return JSON.stringify({
    tabs,
    controlsPresent: !!document.querySelector('[data-note="wf-controls"]'),
    trainField: document.querySelector('[data-field="wf-train"]')?.value,
    testField: document.querySelector('[data-field="wf-test"]')?.value,
    estimateShown: (document.querySelector('[data-field="wf-estimate"]')?.textContent ?? '').trim(),
    estimateFlagsTooFew: document.querySelector('[data-field="wf-estimate"]')?.getAttribute('data-few'),
    runButton: !!document.querySelector('[data-action="wf-run"]'),
  });
})()`));

console.log("3. RUN IT AND CHECK A VERDICT APPEARS:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="wf-run"]')?.click();
  // walk-forward runs many backtests; wait for the verdict node rather than a fixed sleep
  for (let i = 0; i < 60 && !document.querySelector('[data-note="wf-verdict"]'); i++) await w(500);
  const v = document.querySelector('[data-note="wf-verdict"]');
  const n = Number(document.querySelector('[data-field="wf-windows"]')?.textContent ?? 0);
  const text = v?.textContent ?? '';
  // The guard that matters: a confident verdict must not appear on a sample too small to support
  // it. n<3 is "too few", NOT "curve fitting" - that claim needs evidence.
  const claimsCurveFit = /curve fitting/i.test(text);
  const claimsTooFew = /too few|cannot distinguish|fewer than three/i.test(text);
  return JSON.stringify({
    windows: n,
    oosNet: document.querySelector('[data-field="wf-oos-net"]')?.textContent,
    verdictKind: v?.getAttribute('data-kind'),
    verdictText: text.slice(0, 120),
    counts: (document.querySelector('[data-field="wf-counts"]')?.textContent ?? '').trim(),
    rows: document.querySelectorAll('[data-window]').length,
    flippedRows: document.querySelectorAll('[data-flipped="yes"]').length,
    // n=1 must NOT be called curve fitting
    overclaimsOnOneWindow: n < 3 && claimsCurveFit,
    saysTooFew: n < 3 ? claimsTooFew : "n/a",
  });
})()`));

console.log("4. THE CONTROLS ACTUALLY CHANGE THE RUN:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNum = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const windowsBefore = Number(document.querySelector('[data-field="wf-windows"]')?.textContent ?? 0);

  // halve the window sizes: that must produce MORE windows on the same data
  const trainNow = Number(document.querySelector('[data-field="wf-train"]')?.value ?? 0);
  const testNow = Number(document.querySelector('[data-field="wf-test"]')?.value ?? 0);
  setNum('[data-field="wf-train"]', String(Math.max(100, Math.round(trainNow / 2 / 100) * 100)));
  setNum('[data-field="wf-test"]', String(Math.max(50, Math.round(testNow / 2 / 50) * 50)));
  await w(400);
  document.querySelector('[data-action="wf-run"]')?.click();
  await w(6000);
  for (let i = 0; i < 30; i++) {
    const n = Number(document.querySelector('[data-field="wf-windows"]')?.textContent ?? 0);
    if (n > windowsBefore) break;
    await w(500);
  }
  const windowsAfter = Number(document.querySelector('[data-field="wf-windows"]')?.textContent ?? 0);
  return JSON.stringify({
    windowsBefore, windowsAfter,
    moreWindowsWhenSmaller: windowsAfter > windowsBefore,
    trainNowHalf: document.querySelector('[data-field="wf-train"]')?.value,
  });
})()`));

console.log("5. A TOO-LONG WINDOW IS REFUSED, NOT SILENTLY EMPTY:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNum = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  setNum('[data-field="wf-train"]', '999999');
  await w(400);
  document.querySelector('[data-action="wf-run"]')?.click();
  await w(2500);
  const msg = (document.querySelector('.strategy-panel .msg')?.textContent ?? '') || '';
  const allText = document.querySelector('.strategy-panel')?.textContent ?? '';
  return JSON.stringify({
    refused: /longer than the data|reduce one/i.test(allText),
    // and it must NOT have wiped the previous result
    stillHasRows: document.querySelectorAll('[data-window]').length > 0,
  });
})()`));

console.log("6. WITH THREE WINDOWS THE VERDICT MAY MAKE A CLAIM:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNum = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  // small enough for several windows on 510 bars
  setNum('[data-field="wf-train"]', '100');
  setNum('[data-field="wf-test"]', '50');
  await w(500);
  const flagged = document.querySelector('[data-field="wf-estimate"]')?.getAttribute('data-few');
  document.querySelector('[data-action="wf-run"]')?.click();
  await w(7000);
  const n = Number(document.querySelector('[data-field="wf-windows"]')?.textContent ?? 0);
  const v = document.querySelector('[data-note="wf-verdict"]');
  const text = v?.textContent ?? '';
  return JSON.stringify({
    windows: n,
    estimateFlagsTooFew: flagged,
    verdictKind: v?.getAttribute('data-kind'),
    // at n>=3 a specific claim is allowed; at n<3 it must be the "too few" wording
    isSpecificClaim: /curve fitting|held up out of sample|failed out of sample|Mixed/i.test(text),
    isTooFewWording: /cannot distinguish|fewer than three/i.test(text),
    text: text.slice(0, 110),
  });
})()`));

console.log("7. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
})`));

ws.close();
JS

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon|NODE_OPTION' | head -6
echo "(nothing above = clean)"
