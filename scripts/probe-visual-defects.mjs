#!/usr/bin/env node
/**
 * Check the specific defects a visual review reported, against the DOM.
 *
 * A vision pass is good at spotting "this looks wrong" and bad at naming the cause, so each claim
 * is confirmed here before anything is changed - and a claim that turns out to be a misreading is
 * recorded as such rather than "fixed" into a new bug.
 */
const PORT = process.argv[2] ?? "18411";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = seq++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3200);
await ev(`localStorage.clear()`);
await send("Page.enable");
await send("Page.reload");
await sleep(4200);
await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(400);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 70 && !document.querySelector('.chart-host'); i++) await w(400);
  await w(2500);
})()`);
await sleep(2000);

console.log("D1. THE TAB STRIP — duplicate label, and does it overflow?", await ev(`(() => {
  const tabs = [...document.querySelectorAll('.rail-tab')];
  const strip = document.querySelector('.rail-tabs');
  const labels = tabs.map(t => (t.textContent ?? '').trim());
  const stripW = strip ? Math.round(strip.getBoundingClientRect().width) : 0;
  const scrollW = strip ? Math.round(strip.scrollWidth) : 0;
  return JSON.stringify({
    labels,
    duplicateLabels: labels.filter((l, i) => labels.indexOf(l) !== i),
    tabCount: tabs.length,
    stripWidth: stripW,
    contentWidth: scrollW,
    overflows: scrollW > stripW + 2,
    overflowX: strip ? getComputedStyle(strip).overflowX : null,
    lastTabVisible: (() => {
      const last = tabs[tabs.length - 1];
      if (!last || !strip) return null;
      const lr = last.getBoundingClientRect(), sr = strip.getBoundingClientRect();
      return lr.right <= sr.right + 1;
    })(),
  });
})()`));

console.log("D2. THE TWO PANEL BUTTONS — are they browser defaults?", await ev(`(() => {
  const btns = [...document.querySelectorAll('.panel button')]
    .filter(b => /Reload history|Import CSV/i.test(b.textContent ?? ''));
  return JSON.stringify({
    found: btns.length,
    styles: btns.map(b => {
      const s = getComputedStyle(b);
      return {
        text: (b.textContent ?? '').trim().slice(0, 18),
        background: s.backgroundColor,
        backgroundImage: s.backgroundImage.slice(0, 30),
        color: s.color,
        border: s.borderTopWidth + ' ' + s.borderTopColor,
        width: Math.round(b.getBoundingClientRect().width),
        // a browser default is light-on-dark and heavily styled
        looksNative: s.backgroundColor === 'rgb(239, 239, 239)' || /gradient/.test(s.backgroundImage),
      };
    }),
  });
})()`));

console.log("D3. CHECKBOXES — themed or native?", await ev(`(() => {
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')].slice(0, 4);
  return JSON.stringify({
    count: document.querySelectorAll('input[type="checkbox"]').length,
    samples: boxes.map(b => ({
      appearance: getComputedStyle(b).appearance,
      background: getComputedStyle(b).backgroundColor,
    })),
  });
})()`));

console.log("D4. PRICE PRECISION — FX needs more than 2 decimals:", await ev(`(() => {
  const legend = (document.querySelector('.legend')?.textContent ?? '').trim();
  return JSON.stringify({
    legendText: legend.slice(0, 60),
    // count decimals in the first numeric group
    decimalsShown: (legend.match(/\\.(\\d+)/)?.[1] ?? '').length,
    looksRoundedToTwo: /\\.\\d{1,2}(\\s|$)/.test(legend),
  });
})()`));

console.log("D5. THE STRAY ▶ IN THE UTC CONTROL:", await ev(`(() => {
  const tz = document.querySelector('[data-action="tz-open"]');
  const txt = (tz?.textContent ?? '').trim();
  return JSON.stringify({
    text: txt,
    hasPlayGlyph: /[▶►▸]/.test(txt),
    appPlayButtons: [...document.querySelectorAll('button')].filter(b => /play/i.test(b.getAttribute('title') ?? '')).length,
  });
})()`));

console.log("D6. THE ORPHAN ★ IN THE CHART CORNER:", await ev(`(() => {
  // the rail's favourites button is the last one; is it positioned outside the rail?
  const rail = document.querySelector('[data-rail="draw"]');
  const star = rail?.querySelector('[data-toggle="favourites"], .tool-btn:last-of-type');
  const rr = rail?.getBoundingClientRect();
  const sr = star?.getBoundingClientRect();
  return JSON.stringify({
    railBottom: rr ? Math.round(rr.bottom) : null,
    starBottom: sr ? Math.round(sr.bottom) : null,
    starInsideRail: !!(rr && sr && sr.bottom <= rr.bottom + 1 && sr.left >= rr.left - 1),
  });
})()`));

ws.close();
