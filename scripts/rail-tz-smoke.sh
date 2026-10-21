#!/usr/bin/env bash
# Two reported bugs, proven before fixing:
#   1. "the timezone list opens onto the black chart instead of below the button"
#   2. "none of the tools on the left work"
#
# Both are layout/stacking problems, which is why they are measured from the DOM: computed style,
# bounding boxes, and hit-testing at the button's centre. Vision can see the symptom; only
# elementFromPoint can say what is actually on top.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-18221}"
LOG=/tmp/rail.log
CACHE=/tmp/rail-cache-$$
mkdir -p "$CACHE"

cleanup() {
  pkill -f "remote-debugging-port=$PORT" 2>/dev/null
  rm -rf "$CACHE"
}
trap cleanup EXIT

export NODE_OPTIONS=--max-old-space-size=1600
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "=== building ==="
  npx vite build > /tmp/vb-rail.log 2>&1 || { echo "vite FAILED"; tail -5 /tmp/vb-rail.log; exit 1; }
  npx tsc -p tsconfig.main.json > /tmp/tsc-rail.log 2>&1 || { echo "tsc FAILED"; tail -5 /tmp/tsc-rail.log; exit 1; }
  node scripts/postbuild-main.mjs >> /tmp/vb-rail.log 2>&1
fi

FXLAB_DATA_DIR="$CACHE" \
  xvfb-run -a --server-args="-screen 0 1700x1050x24" \
  npx electron dist/main/main.js --remote-debugging-port="$PORT" --no-sandbox \
  > "$LOG" 2>&1 &

for _ in $(seq 1 60); do
  curl -s "http://127.0.0.1:$PORT/json/list" | grep -q webSocketDebuggerUrl && break
  sleep 0.5
done
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
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 400) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3500);

console.log("SETUP:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
  return JSON.stringify({ hasChart: !!document.querySelector('.chart-host') });
})()`));

console.log("T1. WHERE IS THE TIMEZONE DIALOG, AND WHO IS ON TOP OF IT:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-action="tz-open"]')?.click();
  await w(700);
  const dlg = document.querySelector('[data-dialog="timezone"]');
  const btn = document.querySelector('[data-action="tz-open"]');
  if (!dlg) return JSON.stringify({ problem: "dialog did not open" });

  const db = dlg.getBoundingClientRect();
  const bb = btn.getBoundingClientRect();
  const cs = getComputedStyle(dlg);

  // what is actually painted at a point INSIDE the dialog's visible area?
  const midX = Math.round(db.left + db.width / 2);
  const midY = Math.round(db.top + Math.min(db.height - 10, 60));
  const topEl = document.elementFromPoint(midX, midY);

  // is the dialog clipped by an ancestor with overflow hidden/auto?
  let clippedBy = null;
  for (let el = dlg.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      if (db.bottom > r.bottom + 1 || db.right > r.right + 1) {
        clippedBy = { cls: el.className, overflow: s.overflow, elBottom: Math.round(r.bottom), dlgBottom: Math.round(db.bottom) };
        break;
      }
    }
  }

  return JSON.stringify({
    dialogTop: Math.round(db.top),
    dialogBottom: Math.round(db.bottom),
    dialogHeight: Math.round(db.height),
    buttonBottom: Math.round(bb.bottom),
    // must sit BELOW the button, not over the chart
    belowButton: db.top >= bb.bottom - 2,
    zIndex: cs.zIndex,
    position: cs.position,
    // the element receiving the click at the dialog's own coordinates
    topElementAtDialog: topEl ? (topEl.className || topEl.tagName) : null,
    dialogIsOnTop: !!(topEl && (topEl === dlg || dlg.contains(topEl))),
    clippedByAncestor: clippedBy,
    viewportHeight: window.innerHeight,
    dialogOverflowsViewport: db.bottom > window.innerHeight,
  });
})()`));

console.log("T2. THE LEFT RAIL HAS NO STYLES AT ALL:", await evalJs(`(() => {
  const rail = document.querySelector('[data-rail="draw"]');
  if (!rail) return JSON.stringify({ problem: "rail not in the DOM" });
  const cs = getComputedStyle(rail);
  const r = rail.getBoundingClientRect();
  const btn = rail.querySelector('.tool-btn');
  const bs = btn ? getComputedStyle(btn) : null;
  return JSON.stringify({
    railClass: rail.className,
    // a rail with no CSS sits as a plain block in the grid, stacked over the chart
    railPosition: cs.position,
    railWidth: Math.round(r.width),
    railHeight: Math.round(r.height),
    railLeft: Math.round(r.left),
    railTop: Math.round(r.top),
    railBottom: Math.round(r.bottom),
    // a vertical rail should be narrow and tall; a full-width block is the bug
    looksLikeVerticalRail: r.width <= 60 && r.height > 200,
    buttonsFound: rail.querySelectorAll('.tool-btn').length,
    buttonStyled: bs ? { width: bs.width, height: bs.height, display: bs.display } : null,
    // does the rail cover the chart instead of sitting beside it?
    overlapsChart: (() => {
      const ch = document.querySelector('.chart-host')?.getBoundingClientRect();
      if (!ch) return null;
      return !(r.right <= ch.left || r.left >= ch.right || r.bottom <= ch.top || r.top >= ch.bottom);
    })(),
  });
})()`));

console.log("T3. CLICKING A TOOL BUTTON — WHO RECEIVES THE CLICK:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const rail = document.querySelector('[data-rail="draw"]');
  const btn = rail?.querySelector('[data-tool="cursor"]');
  if (!btn) return JSON.stringify({ problem: "no cursor button" });
  const r = btn.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return JSON.stringify({
    buttonBox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    // if this is not the button (or inside it), a click physically cannot reach it
    hitElement: hit ? (hit.className || hit.tagName) : null,
    clickReachesButton: !!(hit && (hit === btn || btn.contains(hit))),
  });
})()`));

console.log("T4. CLICKING A TOOL FAMILY CHANGES THE ACTIVE TOOL:", await evalJs(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const rail = document.querySelector('[data-rail="draw"]');
  // an item inside an opened group: this is the real path a user takes
  const groups = [...(rail?.querySelectorAll('[data-group]') ?? [])];
  const groupButton = groups[1] ?? groups[0];
  if (!groupButton) return JSON.stringify({ problem: "no tool groups" });
  groupButton.click();
  await w(500);
  // the flyout must be portalled OUT of the rail, or the rail's overflow still clips it
  const flyout = document.querySelector('[data-flyout-group]');
  const item = document.querySelector('[data-tool-item]');
  if (!item) return JSON.stringify({
    problem: "no items after opening a group",
    groupClicked: groupButton.textContent?.trim(),
    flyoutInDom: !!flyout,
  });
  const flyoutInRail = !!rail.querySelector('[data-flyout-group]');
  const kind = item.getAttribute('data-tool-item');
  // use a real mouse event at the item's coordinates, not .click(), so hit-testing is involved
  const r = item.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  item.click();
  await w(600);
  const status = document.querySelector('.status')?.textContent ?? '';
  return JSON.stringify({
    group: groupButton.textContent?.trim(),
    kind,
    itemBox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    // this is the assertion that matters: a REAL mouse click must land on the item, not the chart
    hitAtItemCentre: hit ? (hit.className || hit.tagName) : null,
    clickWouldReachItem: !!(hit && (hit === item || item.contains(hit) || (hit.closest && hit.closest('[data-tool-item]')))),
    flyoutEscapedRail: !flyoutInRail,
    // the toolbar shows the active tool name; if it stays empty nothing was selected
    activeToolLabel: (document.querySelector('.active-tool')?.textContent ?? '').trim(),
    selected: (document.querySelector('.active-tool')?.textContent ?? '').length > 0,
    statusSample: status.slice(0, 50),
  });
})()`));

console.log("T5. A REAL MOUSE CLICK (CDP Input, not .click()) SELECTS A TOOL:", await (async () => {
  // coordinates of a tool item inside an opened flyout
  const box = await evalJs(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    const rail = document.querySelector('[data-rail="draw"]');
    // close anything open, then open the second family deterministically
    [...rail.querySelectorAll('[data-group]')][1]?.click();
    await w(500);
    const item = document.querySelector('[data-tool-item]');
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             kind: item.getAttribute('data-tool-item') };
  })()`);
  if (!box) return JSON.stringify({ problem: "no item to click" });

  // reset the active tool so a pass cannot be inherited from the previous step
  await evalJs(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-tool="cursor"]')?.click();
    await w(300);
    [...document.querySelectorAll('[data-group]')][1]?.click();
    await w(500);
  })()`);
  const before = await evalJs(`(document.querySelector('.active-tool')?.textContent ?? '').trim()`);

  // a genuine press/release at the item's real coordinates
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(700);

  const after = await evalJs(`(document.querySelector('.active-tool')?.textContent ?? '').trim()`);
  return JSON.stringify({
    clickedAt: { x: box.x, y: box.y },
    kind: box.kind,
    activeBefore: before || "(none)",
    activeAfter: after || "(none)",
    // the whole point: a real mouse click must change the tool
    realClickSelectedTool: after !== "" && after !== before,
  });
})());

console.log("T6. NO RENDERER CRASH:", await evalJs(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
})`));

ws.close();
JS

echo
echo "=== renderer errors ==="
grep -iE 'error|cannot read|is not a function' "$LOG" \
  | grep -viE 'bus.cc|net::ERR|devtools|Autofill|GPU|gpu_|Missing X|dbus|favicon|NODE_OPTION' | head -5
echo "(nothing above = clean)"
