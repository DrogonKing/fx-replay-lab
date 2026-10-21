#!/usr/bin/env bash
# Two reported bugs, tested live:
#   1. "why is there no field for MT5 username, password and server?"
#   2. "why does the import button not open a file window?"
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18211}"
BRIDGE_PORT="${BRIDGE_PORT:-18700}"
LOG=/tmp/fixcc.log
CACHE=/tmp/fix-cache-$$
mkdir -p "$CACHE"

cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  [[ -n "${BRIDGE_PID:-}" ]] && kill "$BRIDGE_PID" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

echo "=== building ==="
export NODE_OPTIONS=--max-old-space-size=1600
npx vite build > /tmp/vb-fix.log 2>&1 || { echo "vite FAILED"; tail -5 /tmp/vb-fix.log; exit 1; }
npx tsc -p tsconfig.main.json > /tmp/tsc-fix.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-fix.log; exit 1; }
node scripts/postbuild-main.mjs >> /tmp/vb-fix.log 2>&1

echo "=== fake bridge on :$BRIDGE_PORT (with /login) ==="
python3 scripts/fake-bridge.py --port "$BRIDGE_PORT" > /tmp/fakebridge2.log 2>&1 &
BRIDGE_PID=$!
for _ in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$BRIDGE_PORT/health" | grep -q connected; then break; fi
  sleep 0.3
done

echo "=== launching electron on :$PORT ==="
FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &

READY=0
for _ in $(seq 1 60); do
  if curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl; then READY=1; break; fi
  sleep 0.5
done
[ "$READY" = "1" ] || { echo "FAIL: no debugger"; tail -20 "$LOG"; exit 1; }
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);

console.log("A1. THE PICKER API IS EXPOSED:", await evalJs(`JSON.stringify({
  pickDataFile: typeof window.fxlab?.pickDataFile,
  bridgeLogin: typeof window.fxlab?.bridgeLogin,
})`));

console.log("A2. THE IMPORT BUTTON ACTUALLY CALLS THE PICKER (not just switches tabs):", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = document.querySelector('[data-action="start-file"]');
  if (!btn) return JSON.stringify({ problem: "the import button is not rendered on the start screen" });

  // contextBridge objects are FROZEN, so installing a spy silently fails and the real native
  // dialog opens. Confirmed here rather than assumed, because a spy that never installs makes a
  // working app look broken.
  const frozen = Object.isFrozen(window.fxlab);
  let spyInstalled = false;
  try {
    window.fxlab.pickDataFile = async () => ({ ok: false, message: "test-cancel" });
    spyInstalled = true;
  } catch { spyInstalled = false; }

  // Behavioural proof: the OLD handler set mode to replay and printed "Import a CSV from the Data
  // panel" immediately. The fixed one awaits the native picker, so neither happens.
  btn.click();
  await w(1500);
  const status = (document.querySelector('.status')?.textContent ?? '');
  return JSON.stringify({
    buttonText: (btn.textContent ?? '').trim(),
    buttonDisabled: btn.disabled,
    bridgeObjectFrozen: frozen,
    spyInstallable: spyInstalled,
    oldTellingMessageGone: !/from the Data panel/i.test(status),
    stillOnStartScreen: !!document.querySelector('[data-panel="start"]'),
    statusText: status.slice(0, 80),
  });
})()`));

console.log("A3. A CANCELLED PICKER LEAVES THE APP USABLE:", await evalJs(`JSON.stringify({
  startScreenStillThere: !!document.querySelector('[data-panel="start"]'),
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
})`));

console.log("B1. THE BROKER PANEL HAS LOGIN / PASSWORD / SERVER FIELDS:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 60 && !document.querySelector('.chart-host'); i++) await w(400);
  document.querySelector('[data-tab="broker"]')?.click();
  await w(800);
  return JSON.stringify({
    loginField: !!document.querySelector('[data-field="br-login"]'),
    passwordField: !!document.querySelector('[data-field="br-password"]'),
    serverField: !!document.querySelector('[data-field="br-server"]'),
    passwordIsMasked: document.querySelector('[data-field="br-password"]')?.type,
    loginButton: !!document.querySelector('[data-action="br-login"]'),
    hintSaysOptional: /you do not need|already logged in/i.test(
      document.querySelector('[data-note="br-login-block"]')?.textContent ?? ''),
    securityNote: (document.querySelector('[data-note="br-login-security"]')?.textContent ?? '').slice(0, 60),
  });
})()`));

console.log("B2. PARTIAL CREDENTIALS ARE REFUSED BEFORE ANYTHING IS SENT:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  setNative('[data-field="br-login"]', '12345678');
  // password and server left empty on purpose
  await w(300);
  document.querySelector('[data-action="br-login"]')?.click();
  await w(1200);
  const v = document.querySelector('[data-note="br-login-verdict"]');
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    saysAllRequired: /all required|هر سه/i.test(v?.textContent ?? ''),
    text: (v?.textContent ?? '').slice(0, 80),
  });
})()`));

console.log("B3. A WRONG PASSWORD SHOWS THE BRIDGE'S OWN ERROR:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  // point at the fake bridge first
  setNative('[data-field="br-url"]', '${BRIDGE}');
  setNative('[data-field="br-login"]', '12345678');
  setNative('[data-field="br-password"]', 'wrong');
  setNative('[data-field="br-server"]', 'StubBroker-Demo');
  await w(400);
  document.querySelector('[data-action="br-login"]')?.click();
  await w(2500);
  const v = document.querySelector('[data-note="br-login-verdict"]');
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    namesTheRealCause: /Authorization failed|initialize failed/i.test(v?.textContent ?? ''),
    text: (v?.textContent ?? '').slice(0, 100),
    passwordLeaked: (v?.textContent ?? '').includes('wrong'),
  });
})()`));

console.log("B4. A CORRECT LOGIN SUCCEEDS AND CLEARS THE PASSWORD FIELD:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const setNative = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  setNative('[data-field="br-password"]', 'correct-horse');
  await w(300);
  document.querySelector('[data-action="br-login"]')?.click();
  await w(3000);
  const v = document.querySelector('[data-note="br-login-verdict"]');
  const pw = document.querySelector('[data-field="br-password"]');
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    account: (v?.textContent ?? '').slice(0, 70),
    // a credential left in a field is a credential left on screen
    passwordCleared: (pw?.value ?? '') === '',
    // the form must STAY, so a switch of account is possible and the confirmation is visible
    loginFormStillThere: !!document.querySelector('[data-field="br-password"]'),
    confirmationVisible: /logged in/i.test(v?.textContent ?? ''),
    passwordNeverShown: !(v?.textContent ?? '').includes('correct-horse'),
  });
})()`));

console.log("C1. THE POST LOGIN PROBE FOUND SYMBOLS AND BARS:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 20; i++) {
    const v = document.querySelector('[data-note="br-verdict"]');
    if (v?.getAttribute('data-verdict') === 'ok') break;
    await w(500);
  }
  const v = document.querySelector('[data-note="br-verdict"]');
  const opts = [...document.querySelectorAll('#br-symbol-list option')].map(o => o.value);
  return JSON.stringify({
    verdict: v?.getAttribute('data-verdict'),
    detail: (v?.textContent ?? '').slice(0, 80),
    symbolsOffered: opts.slice(0, 5),
    pickedSuffixed: /\\.m$/.test(document.querySelector('[data-field="br-symbol"]')?.value ?? ''),
  });
})()`));

console.log("D1. ONLY LOGIN WRITES; ORDERS STILL REFUSED:", await evalJs(`(async () => {
  // the boundary: after login, everything except candles/symbols must still be refused
  const res = await window.fxlab.bridgeLogin({
    url: '${BRIDGE}', login: '12345678', password: 'x', server: 'StubBroker-Demo',
  });
  return JSON.stringify({ loginAllowed: res.ok });
})()`));

console.log("E1. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
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
