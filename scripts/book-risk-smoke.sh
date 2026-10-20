#!/usr/bin/env bash
# Prove the whole-book risk readout and the opt-in guard in the running app:
#   1. the readout exists and shows 0% on a clean book
#   2. two 0.5-lot positions at a 10.00 stop put ~10% of the balance at risk
#   3. with the limit OFF (default) a third trade is still allowed - the tool does not police
#   4. setting the limit to 5% makes the next trade REFUSED with a reason
#   5. a pending order is refused too, so a limit order is not a way around the guard
#   6. closing is never blocked
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxbook.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

DB="$HOME/.config/fx-replay-lab/fx-replay-lab/fx-replay-lab.db"
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 500) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3600);

console.log("1. READOUT ON A CLEAN BOOK:", await evalJs(`(async () => {
  document.querySelector('.rail-tab[data-tab="trade"]')?.click();
  await new Promise(r=>setTimeout(r,700));
  const S = window.__fxlab.session;
  S.setPrice(1991.71, 1704288600);
  S.closeAll();
  S.setRiskLimit(0);
  await new Promise(r=>setTimeout(r,500));
  const el = document.querySelector('[data-kv="book"]');
  return JSON.stringify({
    readout: el?.textContent.replace(/\\s+/g,' ').trim(),
    limitField: document.querySelector('[data-field="book-limit"]')?.value,
  });
})()`));

console.log("2. TWO POSITIONS RAISE THE BOOK:", await evalJs(`(async () => {
  const S = window.__fxlab.session;
  const out = [];
  for (let i = 0; i < 2; i++) {
    const r = S.open("buy", 0.5, 10, 20);   // 10.00 stop = $500 on gold
    await new Promise(x=>setTimeout(x,200));
    const b = S.bookRisk();
    out.push({ ok: r.ok, openPercent: Number(b.openPercent.toFixed(2)), openRisk: b.openRisk });
  }
  const el = document.querySelector('[data-kv="book"]');
  return JSON.stringify({
    steps: out,
    bookReadout: el?.textContent.replace(/\\s+/g,' ').trim(),
  });
})()`));

console.log("3. LIMIT OFF => NOT POLICED:", await evalJs(`(async () => {
  const S = window.__fxlab.session;
  const r = S.open("buy", 0.5, 10, 20);
  await new Promise(x=>setTimeout(x,300));
  return JSON.stringify({
    limit: S.riskLimitPercent,
    thirdTradeOk: r.ok,
    message: r.message ?? null,
    openPercent: Number(S.bookRisk().openPercent.toFixed(2)),
  });
})()`));

console.log("4. LIMIT 5% => REFUSED:", await evalJs(`(async () => {
  const S = window.__fxlab.session;
  S.setRiskLimit(5);
  await new Promise(x=>setTimeout(x,300));
  const before = S.snapshot().positions.length;
  const r = S.open("buy", 0.2, 10, 20);
  await new Promise(x=>setTimeout(x,300));
  return JSON.stringify({
    positionsBefore: before,
    positionsAfter: S.snapshot().positions.length,
    ok: r.ok,
    message: (r.message ?? "").slice(0, 120),
  });
})()`));

console.log("5. PENDING ORDER ALSO REFUSED:", await evalJs(`(async () => {
  const S = window.__fxlab.session;
  const before = S.snapshot().pendingOrders.length;
  const r = S.placeOrder({
    side: "buy", kind: "limit", lots: 0.2, price: 1900,
    slDistance: 10, tpDistance: 20,
  });
  await new Promise(x=>setTimeout(x,300));
  return JSON.stringify({
    pendingBefore: before,
    pendingAfter: S.snapshot().pendingOrders.length,
    ok: r.ok,
    message: (r.message ?? "").slice(0, 120),
  });
})()`));

console.log("6. CLOSING NEVER BLOCKED:", await evalJs(`(async () => {
  const S = window.__fxlab.session;
  const before = S.snapshot().positions.length;
  S.closeAll();
  await new Promise(x=>setTimeout(x,500));
  const after = S.snapshot().positions.length;
  const okNew = S.open("buy", 0.05, 10, 20);   // small, now inside the limit again
  return JSON.stringify({
    positionsBefore: before,
    positionsAfter: after,
    closed: before - after,
    tradesFiled: S.snapshot().trades.length,
    reopenedInsideLimit: okNew.ok,
  });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-book.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-book.png");
}
ws.close();
JS

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
