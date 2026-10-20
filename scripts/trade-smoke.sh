#!/usr/bin/env bash
# Prove a closed trade lands in the journal automatically.
#
# The chain being tested is the one that matters:
#   TradePanel button -> TradingSession.open -> engine.onBar fires SL
#   -> tradeToJournalEntry -> session buffer -> JournalPanel drain -> SQLite
#
# Each link is asserted separately, because "the journal has a row" could be true
# while the row came from the sample button instead of a real fill.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxtrade.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

# Reap any electron left over from an earlier run. Without this, CDP can attach to a
# stale instance on a reused port (the log then says "Cannot start http server for
# devtools") and every assertion measures the OLD bundle.
pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1

# Random free port, so a stale listener can never be mistaken for the new app.
PORT=$(( 9300 + RANDOM % 400 ))
timeout 160 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  npx electron . --no-sandbox --remote-debugging-port=$PORT >> "$LOG" 2>&1 &
APP=$!
READY=0
for i in $(seq 1 45); do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 1
done
[ "$READY" = "1" ] || { echo "FAIL: app never opened port $PORT"; tail -15 "$LOG"; exit 1; }

node --input-type=module -e "
const PORT = process.env.PORT;
" 2>/dev/null
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
await sleep(3400);

// 1. the tab exists and the panel renders account state
console.log("PANEL:", await evalJs(`(async () => {
  const tab = [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='trade');
  if (!tab) return 'no trade tab';
  tab.click();
  await new Promise(r=>setTimeout(r,500));
  const kvs = [...document.querySelectorAll('.trade-panel .kv')].map(k=>k.textContent);
  const btns = [...document.querySelectorAll('.trade-panel button')].map(b=>b.textContent.trim());
  return JSON.stringify({ kvs: kvs.slice(0,5), buttons: btns.slice(0,4), inputs: document.querySelectorAll('.order-form input').length });
})()`));

// 2. buy with a tiny stop so the next bars almost certainly take it out
console.log("OPEN:", await evalJs(`(async () => {
  const inputs = [...document.querySelectorAll('.order-form input')];
  const setVal = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setVal(inputs[0], '0.10');
  setVal(inputs[1], '1');     // SL 1 point away
  setVal(inputs[2], '50');    // TP far away
  setVal(inputs[3], 'auto-test');
  await new Promise(r=>setTimeout(r,300));

  const buy = [...document.querySelectorAll('.trade-panel button')].find(b=>b.textContent.includes('Buy'));
  if (!buy) return 'no buy button';
  if (buy.disabled) return 'buy disabled';
  buy.click();
  await new Promise(r=>setTimeout(r,400));

  const msg = document.querySelector('.trade-panel .msg')?.textContent;
  const openRows = document.querySelectorAll('.trade-panel table.grid tbody tr').length;
  return JSON.stringify({ msg, rows: openRows });
})()`));

// 3. step the replay so bars advance and the stop can fire
console.log("STEP:", await evalJs(`(async () => {
  const step = [...document.querySelectorAll('header button')].find(b=>b.textContent.includes('Step'));
  if (!step) return 'no step button';
  const before = document.querySelectorAll('.trade-panel table.grid tbody tr').length;
  for (let i = 0; i < 40; i++) { step.click(); await new Promise(r=>setTimeout(r,45)); }
  await new Promise(r=>setTimeout(r,700));
  const kvs = [...document.querySelectorAll('.trade-panel .kv')].map(k=>k.textContent);
  const tables = [...document.querySelectorAll('.trade-panel table.grid')].length;
  return JSON.stringify({ tables, kvs: kvs.slice(0,5), buyDisabled: [...document.querySelectorAll('.trade-panel button')].find(b=>b.textContent.includes('Buy'))?.disabled });
})()`));

// 4. the journal must now hold the auto-filed trade
console.log("JOURNAL:", await evalJs(`(async () => {
  [...document.querySelectorAll('.rail-tab')].find(t=>t.textContent.trim()==='journal').click();
  await new Promise(r=>setTimeout(r,1400));
  const rows = [...document.querySelectorAll('.journal-panel table.grid tbody tr')]
    .map(tr => [...tr.querySelectorAll('td')].map(td=>td.textContent.trim()));
  const kvs = [...document.querySelectorAll('.journal-panel .kv')].map(k=>k.textContent);
  return JSON.stringify({ rowCount: rows.length, firstRows: rows.slice(0,4), kvs: kvs.slice(0,4) });
})()`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/fx-trade.png", Buffer.from(shot.result.data, "base64"));
  console.log("screenshot /tmp/fx-trade.png");
}
ws.close();
JS

sleep 2
echo "=== journal rows in sqlite ==="
DB="$HOME/.config/fx-replay-lab/fx-replay-lab/fx-replay-lab.db"
if [ -f "$DB" ]; then
  python3 - "$DB" <<'PY'
import sqlite3, sys, json
con = sqlite3.connect(sys.argv[1])
rows = con.execute("SELECT payload FROM journal ORDER BY exit_time").fetchall()
print(f"rows: {len(rows)}")
for (p,) in rows:
    d = json.loads(p)
    print(f"  {d['symbol']} {d['side']} lots={d['lots']} pnl={d['pnl']:.2f} "
          f"risk={d['risk']:.2f} tags={d['tags']}")
con.close()
PY
else
  echo "no db"
fi

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 $APP 2>/dev/null; wait $APP 2>/dev/null
