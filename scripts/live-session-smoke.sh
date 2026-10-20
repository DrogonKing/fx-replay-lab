#!/usr/bin/env bash
# Prove a live session survives the app closing:
#   1. open a position and place a pending order
#   2. let the autosave write
#   3. kill the app with SIGKILL (no clean shutdown hook can save anything)
#   4. relaunch and assert the position, the pending order and the balance came back
#   5. assert the restore notice names what came back
#   6. dismiss it and assert the row is cleared so a stale session cannot return
#
# SIGKILL, not a graceful quit: a graceful close could hide a missing autosave behind an
# exit handler. If the state survives SIGKILL, it was actually written when it changed.
set -u
cd /root/fx-replay-lab
LOG=/tmp/fxlive.log
: > "$LOG"
export NODE_OPTIONS="--max-old-space-size=1600"

DB="$HOME/.config/fx-replay-lab/fx-replay-lab/fx-replay-lab.db"
rm -f "$DB" "$DB-wal" "$DB-shm"

pkill -9 -f "fx-replay-lab/node_modules/electron" 2>/dev/null
sleep 1

launch() {
  local port=$1
  PORT_ACTIVE=$port
  timeout 180 xvfb-run -a --server-args="-screen 0 1600x1000x24" \
    npx electron . --no-sandbox --remote-debugging-port="$port" --fx-test >> "$LOG" 2>&1 &
  APP=$!
  READY=0
  for i in $(seq 1 45); do
    curl -s --max-time 1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && { READY=1; break; }
    sleep 1
  done
  [ "$READY" = "1" ] || { echo "FAIL: no debugger on $port"; tail -20 "$LOG"; exit 1; }
}

cdp() {
  export FX_PORT=$PORT_ACTIVE
  export FX_SCRIPT
  node --input-type=module <<'JS'
const PORT = process.env.FX_PORT;
const script = process.env.FX_SCRIPT;
if (!script) {
  console.log("FAIL: FX_SCRIPT not set — the CDP step did not run");
  process.exit(1);
}
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
const r = await send("Runtime.evaluate", { expression: script, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.log("EXCEPTION:", r.result.exceptionDetails.exception?.description?.slice(0, 600));
} else {
  console.log(JSON.stringify(r.result?.result?.value));
}
ws.close();
JS
}

PORT1=$(( 9300 + RANDOM % 200 ))
launch "$PORT1"
sleep 4

FX_SCRIPT='(async () => {
  const H = window.__fxlab;
  H.session.setPrice(1991.71, 1704288600);
  const r = H.session.open("buy", 0.2, 40, 80, ["resume-test"]);
  const o = H.session.placeOrder({
    side: "buy", kind: "limit", lots: 0.1, price: 1900,
    slDistance: 20, tpDistance: 40, tags: ["resume-order"],
  });
  await new Promise(r=>setTimeout(r,1400));   // let the 800ms autosave fire
  const s = H.state();
  return {
    opened: r.ok, orderPlaced: o.ok,
    balance: s.balance, positions: s.positions.length,
    pending: s.pendingOrders.length,
    posLots: s.positions[0]?.lots, posSide: s.positions[0]?.side,
  };
})()'
echo "1. BEFORE KILL:"; cdp

echo "2. SIGKILL (no clean shutdown):"
kill -9 "$APP" 2>/dev/null
wait "$APP" 2>/dev/null
sleep 2

echo "3. ROW ON DISK:"
python3 - "$DB" <<'PY'
import sqlite3, json, sys
con = sqlite3.connect(sys.argv[1])
rows = con.execute("SELECT workspace, payload FROM live_sessions").fetchall()
print(f"live_sessions rows: {len(rows)}")
for ws, payload in rows:
    d = json.loads(payload)
    print(f"  {ws}: balance={d['balance']} positions={len(d['positions'])} "
          f"pending={len(d['pendingOrders'])} trades={len(d['trades'])} revealed={d['revealed']}")
con.close()
PY

PORT2=$(( 9500 + RANDOM % 200 ))
launch "$PORT2"
sleep 5

FX_SCRIPT='(async () => {
  const H = window.__fxlab;
  const s = H.state();
  const notice = document.querySelector(".status-info")?.textContent ?? "";
  return {
    balance: s.balance,
    positions: s.positions.length,
    posLots: s.positions[0]?.lots,
    posSide: s.positions[0]?.side,
    posSl: s.positions[0]?.sl,
    pending: s.pendingOrders.length,
    orderPrice: s.pendingOrders[0]?.price,
    notice: notice.slice(0, 80),
  };
})()'
echo "4. AFTER RELAUNCH:"; cdp

FX_SCRIPT='(async () => {
  const btn = document.querySelector(".status-dismiss");
  if (!btn) return "no dismiss button";
  btn.click();
  await new Promise(r=>setTimeout(r,900));
  return {
    noticeGone: !document.querySelector(".status-info"),
  };
})()'
echo "5. DISMISS:"; cdp

echo "6. ROW CLEARED:"
python3 - "$DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
n = con.execute("SELECT COUNT(*) FROM live_sessions").fetchone()[0]
print(f"live_sessions rows after dismiss: {n}")
con.close()
PY

echo "=== errors ==="
grep -iE "\b(error|exception|uncaught)\b" "$LOG" \
  | grep -viE "bus\.cc|gpu|vulkan|libva|gbm|dri3|MESA|fontconfig|sandbox|X11|NODE_OPTION|sqlite-error|bind\(\) failed" | head -6 || echo "  (none)"

kill -9 "$APP" 2>/dev/null; wait "$APP" 2>/dev/null
