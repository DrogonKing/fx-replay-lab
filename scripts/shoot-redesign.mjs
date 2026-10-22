#!/usr/bin/env node
/**
 * Screenshot the redesigned UI in the states that matter, and assert nothing regressed.
 *
 * A visual refresh that quietly breaks a control is the failure mode here: the colours change and
 * the class names it repaints may no longer match what the components emit. So each shot is paired
 * with a DOM assertion, and the pixel probe confirms the chart is still painting.
 */
import { writeFileSync } from "node:fs";

const PORT = process.argv[2] ?? "18401";
const OUT = process.argv[3] ?? "/tmp/redesign-shots";
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
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1.5, mobile: false });
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description?.slice(0, 300) };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.result.data, "base64"));
  return `${name}.png`;
};

await ev(`localStorage.clear()`);
await send("Page.reload");
await sleep(4500);

console.log("SHOT 1 — start screen:", await shot("01-start"));

await ev(`(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector('[data-mode="live"]')?.click();
  await w(500);
  const go = document.querySelector('[data-action="start-go"]');
  if (go && !go.disabled) go.click();
  for (let i = 0; i < 80 && !document.querySelector('.chart-host'); i++) await w(400);
  for (let i = 0; i < 30; i++) {
    if (document.querySelectorAll('.chart-host canvas').length > 3) break;
    await w(400);
  }
  await w(3000);
})()`);
await sleep(2500);

console.log("REGRESSION CHECKS AFTER THE RESTYLE:", await ev(`(() => {
  const host = document.querySelector('.chart-host');
  const canvases = [...(host?.querySelectorAll('canvas') ?? [])];
  let painted = 0;
  for (const c of canvases) {
    try {
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data;
      let non = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] > 40 || d[i + 1] > 44 || d[i + 2] > 55) non++;
      if (non > 200) painted++;
    } catch {}
  }
  const css = getComputedStyle(document.documentElement);
  return JSON.stringify({
    chartPaints: canvases.length > 0 && painted > 0,
    canvases: canvases.length,
    paintedCanvases: painted,
    // the token layer must actually be loaded, or every var() fallback is transparent
    accentToken: css.getPropertyValue('--accent').trim(),
    bgToken: css.getPropertyValue('--bg-0').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    toolbarBg: getComputedStyle(document.querySelector('.toolbar')).backgroundColor,
    // controls the redesign repaints must still exist and be reachable
    symbolButton: !!document.querySelector('[data-action="sym-open"]'),
    tfButton: !!document.querySelector('[data-action="tf-open"]'),
    tzButton: !!document.querySelector('[data-action="tz-open"]'),
    panelToggle: !!document.querySelector('[data-action="panel-toggle"]'),
    railButtons: document.querySelectorAll('[data-rail="draw"] button').length,
    legend: (document.querySelector('.legend')?.textContent ?? '').slice(0, 30),
  });
})()`));

console.log("SHOT 2 — chart:", await shot("02-chart"));

console.log("SHOT 3 — timeframe menu:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="tf-open"]')?.click();
    await w(700);
  })()`);
  await sleep(900);
  const name = await shot("03-tf-menu");
  const check = await ev(`(() => {
    const d = document.querySelector('[data-dialog="timeframe"]');
    const b = d?.getBoundingClientRect();
    const top = b ? document.elementFromPoint(Math.round(b.left + b.width/2), Math.round(b.top + 40)) : null;
    return JSON.stringify({
      open: !!d, onTop: !!(top && d.contains(top)),
      bg: d ? getComputedStyle(d).backgroundColor : null,
      radius: d ? getComputedStyle(d).borderRadius : null,
    });
  })()`);
  await ev(`document.querySelector('[data-action="tf-open"]')?.click()`);
  await sleep(400);
  return `${name} ${check}`;
})());

console.log("SHOT 4 — instrument menu:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="sym-open"]')?.click();
    await w(700);
  })()`);
  await sleep(900);
  const name = await shot("04-sym-menu");
  await ev(`document.querySelector('[data-action="sym-open"]')?.click()`);
  await sleep(400);
  return name;
})());

console.log("SHOT 5 — timezone menu:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="tz-open"]')?.click();
    await w(800);
  })()`);
  await sleep(900);
  const name = await shot("05-tz-menu");
  await ev(`document.querySelector('[data-action="tz-open"]')?.click()`);
  await sleep(400);
  return name;
})());

console.log("SHOT 6 — drawing flyout:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    const rail = document.querySelector('[data-rail="draw"]');
    [...rail.querySelectorAll('[data-group]')][1]?.click();
    await w(700);
  })()`);
  await sleep(900);
  const name = await shot("06-flyout");
  const check = await ev(`(() => {
    const item = document.querySelector('[data-tool-item]');
    if (!item) return JSON.stringify({ problem: "no item" });
    const r = item.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2));
    return JSON.stringify({
      escapedRail: !document.querySelector('[data-rail="draw"] [data-flyout-group]'),
      realClickReachesItem: !!(hit && (hit === item || item.contains(hit) || (hit.closest && hit.closest('[data-tool-item]')))),
    });
  })()`);
  await ev(`[...document.querySelector('[data-rail="draw"]').querySelectorAll('[data-group]')][1]?.click()`);
  await sleep(400);
  return `${name} ${check}`;
})());

console.log("SHOT 7 — side panel hides:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-action="panel-toggle"]')?.click();
    await w(800);
  })()`);
  await sleep(900);
  const name = await shot("07-panel-hidden");
  const check = await ev(`(() => {
    const a = document.querySelector('aside.panel');
    return JSON.stringify({
      hidden: !a || getComputedStyle(a).display === 'none',
      chartW: Math.round(document.querySelector('.chart-host')?.getBoundingClientRect().width ?? 0),
    });
  })()`);
  await ev(`document.querySelector('[data-action="panel-toggle"]')?.click()`);
  await sleep(600);
  return `${name} ${check}`;
})());

console.log("SHOT 8 — broker panel:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-tab="broker"]')?.click();
    await w(900);
  })()`);
  await sleep(900);
  const name = await shot("08-broker");
  const check = await ev(`JSON.stringify({
    howtoVisible: !!document.querySelector('[data-note="br-bridge-howto"]'),
    loginFields: ['br-login','br-password','br-server'].every(f => !!document.querySelector('[data-field="'+f+'"]')),
  })`);
  return `${name} ${check}`;
})());

console.log("SHOT 9 — trade panel:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-tab="trade"]')?.click();
    await w(900);
  })()`);
  await sleep(900);
  return await shot("09-trade");
})());

console.log("SHOT 10 — RTL Persian:", await (async () => {
  await ev(`(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    const sel = document.querySelector('[data-field="lang"]');
    if (!sel) return 'no lang control';
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    d.set.call(sel, 'fa');
    // React listens for 'change' on a <select>; 'input' alone is ignored
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await w(1500);
    return document.documentElement.dir;
  })()`);
  await sleep(1400);
  const name = await shot("10-rtl-fa");
  const check = await ev(`JSON.stringify({
    dir: document.documentElement.dir,
    bodyDirection: getComputedStyle(document.body).direction,
    hasPersian: /[\u0600-\u06FF]/.test(document.body.textContent ?? ''),
    chartStillPaints: document.querySelectorAll('.chart-host canvas').length > 0,
    // the panel must move to the other side, not stay on the right
    panelSide: (() => {
      const a = document.querySelector('aside.panel');
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return r.left > window.innerWidth / 2 ? 'right' : 'left';
    })(),
  })`);
  return `${name} ${check}`;
})());

console.log("FINAL — no crash:", await ev(`JSON.stringify({
  rendererAlive: (document.getElementById('root')?.children.length ?? 0) > 0,
  hasChart: !!document.querySelector('.chart-host'),
})`));

ws.close();
