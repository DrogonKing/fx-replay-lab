#!/usr/bin/env bash
# Prove risk-based sizing in the running app:
#   1. the risk controls exist and the lots field is read-only in risk mode
#   2. 1% of $10,000 with a 500-point gold stop sizes to 0.20 lots
#   3. the ORDER PLACED matches the computed size, not the stale 0.10 default
#   4. a risk budget too small for the minimum lot REFUSES and disables Buy/Sell
#      (the old lotsForRisk rounded up and silently over-risked)
#   5. widening the risk percentage scales the size proportionally
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxrisk.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1
PORT=$(( 9300 + RANDOM % 400 ))

timeout 180 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=$PORT --fx-test >> "$LOG" 2>&1 &
APP=$!
READY=0
for i in $(seq 1 45); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { READY=1; break; }
  sleep 1
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 600) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

// helpers injected once
await evalJs(`(() => {
  const H = window.__h = {
    set(el, v) {
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
        : el.type === 'checkbox' ? window.HTMLInputElement.prototype
        : window.HTMLInputElement.prototype;
      if (el.type === 'checkbox') { el.click(); return; }
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    label(name) {
      return [...document.querySelectorAll('.order-form label')].find(l =>
        l.textContent.trim().toLowerCase().startsWith(name));
    },
  };
  return 'ok';
})()`);

console.log("1. CONTROLS:", await evalJs(`(async () => {
  document.querySelector('.rail-tab[data-tab="trade"]')?.click();
  await new Promise(r=>setTimeout(r,600));
  // data-* attributes, not label text: the UI may be in either language
  return JSON.stringify({
    hasLots: !!document.querySelector('[data-field="lots"]'),
    hasRiskToggle: !!document.querySelector('[data-field="size-by-risk"]'),
    hasSl: !!document.querySelector('[data-field="sl"]'),
    hasBuy: !!document.querySelector('[data-action="buy"]'),
  });
})()`));

console.log("2. RISK MODE ON, 1% + 500pts:", await evalJs(`(async () => {
  const H = window.__h;
  // price first so the panel has one
  window.__fxlab.session.setPrice(1991.71, 1704288600);
  await new Promise(r=>setTimeout(r,300));

  const riskBox = document.querySelector('[data-field="size-by-risk"]');
  if (!riskBox) return 'no risk toggle';
  riskBox.click();
  await new Promise(r=>setTimeout(r,500));

  // stop = 500 points, risk = 1%
  H.set(document.querySelector('[data-field="sl"]'), '500');
  await new Promise(r=>setTimeout(r,300));
  H.set(document.querySelector('[data-field="risk-percent"]'), '1');
  await new Promise(r=>setTimeout(r,600));

  const lotsInput = document.querySelector('[data-field="lots"]');
  const atRisk = document.querySelector('[data-kv="at-risk"]')?.textContent;

  return JSON.stringify({
    lotsShown: lotsInput?.value,
    readOnly: lotsInput?.readOnly,
    atRisk: atRisk?.replace(/\\s+/g,' ').trim(),
  });
})()`));

console.log("3. ORDER SIZE MATCHES:", await evalJs(`(async () => {
  const H = window.__fxlab;
  const before = H.state().positions.length;
  // capture the balance BEFORE the trade: after it, commission has already moved it
  const balanceBefore = H.state().balance;
  const buyBtn = document.querySelector('[data-action="buy"]')?.closest('button');
  buyBtn.click();
  await new Promise(r=>setTimeout(r,900));
  const s = H.state();
  // Expected size from the LIVE balance, floored to the lot step. Rounding up would risk
  // more than 1%, which is the whole point of the module.
  const bal = balanceBefore;
  // per lot = SL price distance * contract size = 5.00 * 100 = $500, not $5
  const exact = (bal * 0.01) / (5 * 100);
  const expected = Math.floor(exact / 0.01) * 0.01;
  return JSON.stringify({
    positionsBefore: before,
    positionsAfter: s.positions.length,
    balance: bal,
    exact,
    lotsOpened: s.positions[0]?.lots,
    expected: Number(expected.toFixed(2)),
    matches: Math.abs((s.positions[0]?.lots ?? 0) - expected) < 1e-9,
  });
})()`));

console.log("4. OVER-BUDGET REFUSES:", await evalJs(`(async () => {
  const H = window.__h;
  // close what we opened so the balance is clean for the next check
  window.__fxlab.session.closeAll();
  await new Promise(r=>setTimeout(r,400));

  // a budget far too small: 0.001% of ~$10000 with a 500-point stop
  H.set(document.querySelector('[data-field="risk-percent"]'), '0.001');
  await new Promise(r=>setTimeout(r,700));

  const lotsInput = document.querySelector('[data-field="lots"]');
  const buyBtn = document.querySelector('[data-action="buy"]')?.closest('button');
  const warn = [...document.querySelectorAll('.trade-panel .warn-box')].map(w=>w.textContent.trim());

  return JSON.stringify({
    lotsShown: lotsInput?.value,
    buyDisabled: buyBtn?.disabled,
    warnings: warn,
  });
})()`));

console.log("5. SCALES WITH RISK %:", await evalJs(`(async () => {
  const H = window.__h;
  const out = {};
  for (const pct of ['0.5', '1', '2']) {
    H.set(document.querySelector('[data-field="risk-percent"]'), pct);
    await new Promise(r=>setTimeout(r,500));
    out[pct + '%'] = document.querySelector('[data-field="lots"]')?.value;
  }
  return JSON.stringify(out);
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-risk.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-risk.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
