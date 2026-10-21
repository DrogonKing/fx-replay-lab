# The side panel toggle, and the chart that never mounted

Two things were wrong, and the second one was much bigger than the first.

## The panel had no way to close

The right-hand panel was always rendered and always took 280px. For a charting workspace that is a
real cost: there was no way to get the full width.

Added:

- a toggle button in the toolbar (`▤` open / `▢` closed), with `aria-pressed` state
- **F2**, the shortcut the platform this mirrors uses for the same action
- the preference is remembered, so a chart-only user does not close it on every launch
- the freed width goes to the chart: measured **1116px → 1396px**, exactly the 280 the panel gave up

The grid is declared twice (`styles.css` has 2 columns, `styles-draw.css` has 3 with the rail), so
the collapse rule lives in the file imported last. A rule in the earlier file would have been
overridden and silently done nothing. `:has()` keys off the aside's own `data-panel-open`
attribute, so no second class is needed on the root.

## The real find: the chart had never mounted

While screenshotting the toggle, the chart came out **blank**. That could have been a headless
artifact, so it was measured instead of eyeballed: reading the canvas pixels.

```
canvasCount: 0
.chart-host: childCount 0, innerHTML ""
legend: "GC=F·H1·O 4147.30 H 4147.90 L 4139.70"   <- live data was arriving
```

The legend showed live OHLC while `.chart-host` was **completely empty**. The app was fetching
bars and painting nothing.

### Cause

```js
useEffect(() => {
  if (!chartHost.current) return;
  const chart = createChart(chartHost.current, { ... });
  ...
}, []);          // <- ran exactly once
```

The effect ran once, on the first render — which is the **start screen**, where `.chart-host` does
not exist. `chartHost.current` was `null`, the effect returned immediately, and it never ran again
when the user picked a mode and the host mounted. The chart was therefore never created, in any
session.

This also explains the blank canvas in the screenshot that prompted this work.

### Fix, and the bug the fix introduced

`chartHost` was a plain `useRef`, which mutates silently and never re-renders, so the effect had
no way to know the host had arrived. Changed to a callback ref and keyed the effect on a counter
the ref bumps.

The **first version of that fix was worse than the bug**:

```jsx
<div ref={(el) => { chartHost.current = el; setChartReady((n) => n + 1); }} />
```

An inline ref callback is a new function on every render, so React detaches and re-attaches it each
time, and the `setState` inside it triggered another render. React error **#185, "Maximum update
depth exceeded"** — and now the chart did not mount *and* the UI threw.

Found by capturing `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` over CDP rather than
guessing why the host was still empty. Fixed with a `useCallback` ref of stable identity that only
bumps state when the node actually changes.

### Verified after the fix

```
canvasCount: 7               (main series, price scale, time scale, overlay…)
panel open   : main canvas 1050 x 800   painted: true
panel hidden : main canvas 1330 x 800   painted: true
legend       : GC=F · H1 · O 4147.30 ...
```

The chart paints, and it keeps painting after the resize the toggle causes — which was the specific
risk of letting the panel collapse.

## Why the pixel probe matters

A headless screenshot can be blank for environmental reasons, so "the chart looks empty" is not
evidence. Counting pixels that differ from the background is:

- an empty chart: ~0 non-background pixels
- a chart with candles: hundreds to thousands

The probe reads the canvas's own `getImageData`, sampling every 4th pixel, and reports
`painted: nonBg > 200`. That is what turned "the screenshot looks odd" into "the chart never
mounted", and it is the assertion that stays useful.

## Test commands

```bash
bash scripts/panel-toggle-smoke.sh      # 7 live scenarios, incl. persistence and F2
bash scripts/probe-canvas.sh            # pixel proof, panel open / hidden / restored
node scripts/probe-console.mjs <port>   # console + exceptions while a session starts
```

## What was learned about the tests

The panel test initially failed in a confusing way because it inherited `localStorage` from a
previous run and started with the panel already hidden, so every direction was reversed. It now
resets the stored preference and reloads first. **A test that inherits state is testing the last
run, not the feature.**
