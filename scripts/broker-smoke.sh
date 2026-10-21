#!/usr/bin/env bash
# Live test of the broker panel against a fake bridge.
#
# What this proves: the panel probes, finds the broker's OWN symbol names (with suffixes),
# reports named errors, and puts real bars on the chart.
# What it does NOT prove: that the real bridge works with MetaTrader. That needs Windows.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18131}"
BRIDGE_PORT="${BRIDGE_PORT:-18700}"
LOG=/tmp/brokertest.log
CACHE=/tmp/broker-cache-$$
mkdir -p "$CACHE"

cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  [[ -n "${BRIDGE_PID:-}" ]] && kill "$BRIDGE_PID" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

echo "=== building ==="
export NODE_OPTIONS=--max-old-space-size=1600
npx vite build > /tmp/vb-br.log 2>&1 || { echo "vite build FAILED"; tail -5 /tmp/vb-br.log; exit 1; }
npx tsc -p tsconfig.main.json > /tmp/tsc-br.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-br.log; exit 1; }
node scripts/postbuild-main.mjs >> /tmp/vb-br.log 2>&1

echo "=== starting the fake bridge on :$BRIDGE_PORT ==="
python3 scripts/fake-bridge.py --port "$BRIDGE_PORT" > /tmp/fakebridge.log 2>&1 &
BRIDGE_PID=$!
for _ in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$BRIDGE_PORT/health" | grep -q connected; then break; fi
  sleep 0.3
done
curl -s "http://127.0.0.1:$BRIDGE_PORT/health" && echo " <- bridge up"

echo "=== launching electron on :$PORT ==="
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &

READY=0
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl; then
    READY=1; break
  fi
  sleep 0.5
done
[ "$READY" = "1" ] || { echo "FAIL: no debugger"; tail -15 "$LOG"; exit 1; }
export FX_PORT=$PORT FX_BRIDGE_PORT=$BRIDGE_PORT

node --input-type=module <<'JS'
const PORT = process.env.FX_PORT;
const BRIDGE = `http://127.0.0.1:${process.env.FX_BRIDGE_PORT}`;
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3200);

// React controlled inputs ignore a plain `.value = x` assignment: its synthetic event system
// restores the state value on the next render, so the handler runs but the state never changes.
// The native setter is the only way to make React see a real change.
const setNative = `
window.__setNative = (sel, value) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const proto = el instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : (el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
};
`;
await evalJs(setNative);

console.log("0. SESSION STARTED:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  // wait for the start screen to exist at all: it renders while the provider probe is still
  // in flight, and clicking a disabled button silently does nothing
  for (let i = 0; i < 40 && !document.querySelector('[data-panel="start"]'); i++) await w(200);
  document.querySelector('[data-mode="replay"]')?.click();
  await w(400);
  // 1m needs a FILE, so the go button is disabled there - pick a downloadable interval
  document.querySelector('[data-interval="5"]')?.click();
  // then wait for the button to become ENABLED rather than guessing how long that takes
  let tries = 0;
  while (tries++ < 40) {
    const b = document.querySelector('[data-action="start-go"]');
    if (b && !b.disabled) break;
    await w(250);
  }
  // Click, and if the screen stays, say WHY. Starting a replay fetches the provider, and the
  // provider is rate-limited on this host, so this can legitimately fail - the test must report
  // that rather than hanging or silently passing.
  let attempts = 0;
  const seen = [];
  while (attempts++ < 4) {
    const b = document.querySelector('[data-action="start-go"]');
    if (!b) break;
    if (!b.disabled) b.click();
    for (let i = 0; i < 20; i++) {
      await w(300);
      if (!document.querySelector('[data-panel="start"]')) break;
    }
    if (!document.querySelector('[data-panel="start"]')) break;
    const st = document.querySelector('.status')?.textContent ?? '';
    if (st) seen.push(st.slice(0, 60));
    await w(1500);
  }
  return JSON.stringify({
    startGone: !document.querySelector('[data-panel="start"]'),
    hasChart: !!document.querySelector('.chart-host'),
    attempts,
    // if the session refused to start, this says whether the provider was the reason
    reasons: seen.slice(0, 2),
  });
})()`));

console.log("1. THE BROKER TAB EXISTS:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-tab="broker"]')?.click();
  await w(600);
  const sel = document.querySelector('[data-field="br-adapter"]');
  return JSON.stringify({
    panel: !!document.querySelector('[data-panel="broker"]'),
    adapters: sel ? [...sel.options].map(o => o.value) : [],
    windowsWarning: !!document.querySelector('[data-note="br-windows"]'),
    securityNote: (document.querySelector('[data-note="br-security"]')?.textContent ?? '').slice(0, 60),
  });
})()`));

console.log("2. PROBING A BRIDGE THAT IS NOT RUNNING GIVES A USEFUL ERROR:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  window.__setNative('[data-field="br-url"]', 'http://127.0.0.1:18999');
  await w(300);
  document.querySelector('[data-action="br-test"]')?.click();
  await w(3500);
  const v = document.querySelector('[data-note="br-verdict"]');
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    // a dead bridge must say "is the bridge running?", not just fail
    saysHowToFix: /bridge running|could not reach/i.test(v?.textContent ?? ''),
    text: (v?.textContent ?? '').slice(0, 110),
  });
})()`));

console.log("3. PROBING THE REAL FAKE BRIDGE FINDS THE BROKER'S OWN SUFFIXED NAMES:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  window.__setNative('[data-field="br-url"]', '${BRIDGE}');
  await w(300);
  document.querySelector('[data-action="br-test"]')?.click();
  await w(5000);
  const v = document.querySelector('[data-note="br-verdict"]');
  const symEl = document.querySelector('[data-field="br-symbol"]');
  const options = [...document.querySelectorAll('#br-symbol-list option')].map(o => o.value);
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    detail: (v?.textContent ?? '').slice(0, 90),
    pickedSymbol: symEl?.value,
    // the panel must pick a name the BROKER lists, never a hardcoded guess. Both "EURUSD" and
    // "EURUSD.m" exist here, so preferring the exact name is right; a real broker that only has
    // "EURUSD.m" would get the suffix.
    pickedFromBrokerList: options.includes(symEl?.value ?? ''),
    // with no plain EURUSD offered, it must land on a suffixed name
    usedSuffix: /EURUSD(\.|_|#)/i.test(symEl?.value ?? ''),
    offeredOptions: options.slice(0, 6),
    loadEnabled: !document.querySelector('[data-action="br-load"]')?.disabled,
  });
})()`));

console.log("4. A WRONG SYMBOL GIVES THE BRIDGE'S NAMED ERROR, NOT A SILENT EMPTY CHART:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  window.__setNative('[data-field="br-symbol"]', 'NOPEUSD');
  await w(300);
  document.querySelector('[data-action="br-load"]')?.click();
  await w(3000);
  const status = document.querySelector('.status')?.textContent ?? '';
  return JSON.stringify({
    status: status.slice(0, 120),
    namesTheSymbol: /NOPEUSD/.test(status),
    // the chart must NOT have been replaced with nothing
    chartStillThere: !!document.querySelector('.chart-host'),
  });
})()`));

console.log("5. LOADING REAL BARS FROM THE BRIDGE PUTS THEM ON THE CHART:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  window.__setNative('[data-field="br-symbol"]', 'EURUSD.m');
  await w(300);
  const barsBefore = document.querySelector('[data-bars]')?.getAttribute('data-bars');
  document.querySelector('[data-action="br-load"]')?.click();
  await w(5000);
  const barsAfter = document.querySelector('[data-bars]')?.getAttribute('data-bars');
  const status = document.querySelector('.status')?.textContent ?? '';
  return JSON.stringify({
    barsBefore, barsAfter,
    changed: barsBefore !== barsAfter,
    status: status.slice(0, 90),
    rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  });
})()`));

console.log("6. A NON-LOOPBACK URL IS REFUSED BY MAIN (the security boundary):", await evalJs(`(async () => {
  const res = await window.fxlab.testBridge('http://evil.example.com:8765/health');
  return JSON.stringify({
    ok: res.ok,
    refused: /not a local bridge address|not allowed/i.test(res.error ?? ''),
    error: (res.error ?? '').slice(0, 90),
  });
})()`));

console.log("7. OANDA REJECTS A FAKE TOKEN WITH AN ACTIONABLE 401 MESSAGE:", await evalJs(`(async () => {
  const res = await window.fxlab.fetchOandaCandles({
    token: 'not-a-real-token-12345',
    accountId: '101-004-1234567-001',
    symbol: 'EURUSD', intervalMinutes: 5,
    from: Math.floor(Date.now()/1000) - 86400,
    to: Math.floor(Date.now()/1000),
    price: 'mid', practice: true,
  });
  return JSON.stringify({
    ok: res.ok,
    mentions401: /401/.test(res.error ?? ''),
    // the token must never appear in an error string
    leakedToken: (res.error ?? '').includes('not-a-real-token-12345'),
    error: (res.error ?? '').slice(0, 110),
  });
})()`));

console.log("8. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  railActive: document.querySelector('.rail-tab.active')?.getAttribute('data-tab'),
})`));

ws.close();
JS

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon' | head -6
echo "(nothing above = clean)"
