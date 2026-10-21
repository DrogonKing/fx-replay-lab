/**
 * Strategy tester, optimizer, walk-forward, Monte Carlo and Pine.
 *
 * ALL execution happens in the main process over IPC. The renderer's CSP
 * (`script-src 'self'`, no unsafe-eval) is deliberate and blocking `new Function`
 * is the point: a strategy is JavaScript, and evaluating it inside the UI would
 * make any imported text code-executable. Results arrive here as plain data and
 * are only rendered.
 */
import React, { useState } from "react";
import { useI18n } from "../i18n-context.js";
import type { BacktestResult } from "../../core/backtest.js";
import type {
  OptimizationResult, WalkForwardResult, MonteCarloResult,
} from "../../core/optimize.js";
import { OptimizerHeatmap } from "./OptimizerHeatmap.js";
import type { RunResult } from "../../core/pine/runtime.js";
import type { Account, CandleSeries } from "../../core/types.js";

/**
 * Default example strategy.
 *
 * The periods come from `c.p` with concrete fallbacks, so the same script works
 * when run directly (params empty) and when the optimizer sweeps fast/slow.
 */
const DEFAULT_STRATEGY = `// EMA crossover — sweep "fast" and "slow" from the optimizer tab
const fastN = c.p.fast || 9;
const slowN = c.p.slow || 21;
const fast = c.ind("EMA", fastN);
const slow = c.ind("EMA", slowN);
if (isNaN(fast) || isNaN(slow)) return;

// seed on the first evaluable bar so the very first crossover counts
if (c.s.pf === undefined) { c.s.pf = fast; c.s.ps = slow; return; }

const up = c.s.pf <= c.s.ps && fast > slow;
const dn = c.s.pf >= c.s.ps && fast < slow;

if (up && c.pos.length === 0) c.buy(0.10, 6, 12);
if (dn && c.pos.length > 0) c.closeAll();

c.s.pf = fast;
c.s.ps = slow;`;

const DEFAULT_PINE = `//@version=5
indicator("EMA Cross", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
up = ta.crossover(fast, slow)
dn = ta.crossunder(fast, slow)
plot(fast, title="Fast")
plot(slow, title="Slow")
plotshape(up, title="Buy", style=shape.triangleup, text="BUY")
plotshape(dn, title="Sell", style=shape.triangledown, text="SELL")`;

interface Bridge {
  backtest(req: unknown): Promise<unknown>;
  optimize(req: unknown, axes: unknown, maxRuns: number, metric: string): Promise<unknown>;
  walkForward(req: unknown, axes: unknown, train: number, test: number): Promise<unknown>;
  monteCarlo(pnls: number[], start: number): Promise<unknown>;
  pine(payload: unknown, source: string): Promise<unknown>;
}

function bridge(): Bridge | null {
  const w = globalThis as unknown as { fxlab?: Bridge };
  return w.fxlab ?? null;
}

/** Convert the columnar series into the plain arrays IPC can carry. */
function payload(series: CandleSeries): {
  time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[];
} {
  return {
    time: Array.from(series.time.subarray(0, series.length)),
    open: Array.from(series.open.subarray(0, series.length)),
    high: Array.from(series.high.subarray(0, series.length)),
    low: Array.from(series.low.subarray(0, series.length)),
    close: Array.from(series.close.subarray(0, series.length)),
    volume: Array.from(series.volume.subarray(0, series.length)),
  };
}

interface Props {
  series: CandleSeries;
  account: Account;
  symbolId: string;
}

type Tab = "backtest" | "optimize" | "walkforward" | "montecarlo" | "pine";

export function StrategyPanel({ series, account, symbolId }: Props): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("backtest");
  const [code, setCode] = useState(DEFAULT_STRATEGY);
  const [pineCode, setPineCode] = useState(DEFAULT_PINE);
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [opt, setOpt] = useState<OptimizationResult | null>(null);
  const [wf, setWf] = useState<WalkForwardResult | null>(null);
  const [mc, setMc] = useState<MonteCarloResult | null>(null);
  const [pineOut, setPineOut] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  /**
   * Strategy parameters.
   *
   * Was hardcoded to `{}`, so there was no way to run a backtest with a chosen parameter set
   * — which made "apply the best parameters" impossible and the optimizer's output
   * unactionable.
   */
  const [params, setParams] = useState<Record<string, number>>({});

  /**
   * Walk-forward window sizes.
   *
   * Defaults are a compromise: with fewer than about three windows a walk-forward cannot say
   * anything (one lucky or unlucky segment looks like a result), so the train size starts at a
   * quarter of the series and the test at an eighth, which gives roughly four windows on typical
   * data. The user can change both.
   */
  const [wfTrain, setWfTrain] = useState(() => Math.max(200, Math.floor(0 / 4)));
  const [wfTest, setWfTest] = useState(() => Math.max(100, Math.floor(0 / 8)));
  const [wfAxis, setWfAxis] = useState<{ name: string; from: number; to: number; step: number }>(
    { name: "fast", from: 5, to: 20, step: 5 },
  );
  const [wfReady, setWfReady] = useState(false);

  // Seed the sizes from the loaded series the first time data arrives, so the fields start at
  // something sensible instead of zero.
  React.useEffect(() => {
    if (wfReady || series.length === 0) return;
    setWfTrain(Math.max(200, Math.floor(series.length / 4 / 100) * 100));
    setWfTest(Math.max(100, Math.floor(series.length / 8 / 50) * 50));
    setWfReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.length]);

  const req = (): unknown => ({
    series: payload(series),
    code,
    params,
    account,
    symbol: symbolId,
  });

  const doBacktest = async (): Promise<void> => {
    const api = bridge();
    if (!api) { setMsg("no bridge — not running in Electron"); return; }
    setBusy(true);
    setMsg("");
    try {
      const r = (await api.backtest(req())) as BacktestResult;
      setBt(r);
      setMsg(`${r.stats.tradeCount} trades, net ${r.stats.netProfit.toFixed(2)}`);
      if (r.stats.tradeCount > 0) {
        setMc((await api.monteCarlo(
          r.trades.map((t) => t.pnl), account.startingBalance,
        )) as MonteCarloResult);
      }
    } catch (e) {
      setMsg(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doOptimize = async (): Promise<void> => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    try {
      const r = (await api.optimize(req(), [
        { name: "fast", from: 5, to: 15, step: 2 },
        { name: "slow", from: 18, to: 30, step: 4 },
      ], 200, "netProfit")) as OptimizationResult;
      setOpt(r);
      setMsg(`${r.totalRuns} runs in ${r.durationMs}ms${r.truncated ? " (capped)" : ""}`);
    } catch (e) {
      setMsg(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doWalkForward = async (): Promise<void> => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    try {
      // explicit sizes, not fractions of the data: a user who is told "train 2000 bars" can reason
      // about whether that is enough for their timeframe, and cannot reason about "length/4".
      const train = Math.max(100, Math.floor(wfTrain / 100) * 100);
      const test = Math.max(50, Math.floor(wfTest / 50) * 50);
      if (train + test > series.length) {
        setMsg(t("wf.tooLong").replace("{n}", String(series.length)));
        return;
      }
      const r = (await api.walkForward(req(), [wfAxis], train, test)) as WalkForwardResult;
      setWf(r);
      setMsg(t("wf.done")
        .replace("{w}", String(r.windows.length))
        .replace("{net}", r.combinedTest.netProfit.toFixed(2)));
    } catch (e) {
      setMsg(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const doPine = async (): Promise<void> => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    try {
      const r = (await api.pine(payload(series), pineCode)) as RunResult;
      setPineOut(r);
      setMsg(r.errors.length > 0
        ? `${r.errors.length} error(s)`
        : `${r.plots.length} series, ${r.shapes.length} shapes`);
    } catch (e) {
      // a parse error is thrown, not returned: show it verbatim
      setMsg(`error: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': /, "")}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="strategy-panel">
      <div className="tabs">
        {(["backtest", "optimize", "walkforward", "montecarlo", "pine"] as Tab[]).map((t) => (
          <button
            key={t}
            className={tab === t ? "tab active" : "tab"}
            onClick={() => setTab(t)}
          >
            {t === "walkforward" ? "walk-fwd" : t === "montecarlo" ? "monte" : t}
          </button>
        ))}
      </div>

      {(tab === "backtest" || tab === "optimize" || tab === "walkforward") && (
        <>
          <textarea
            className="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
          />
          {tab === "walkforward" && (
            <div className="row" data-note="wf-controls">
              <label>
                {t("wf.trainBars")}{" "}
                <input
                  type="number" data-field="wf-train" className="w-20"
                  min={100} step={100} value={wfTrain}
                  onChange={(e) => setWfTrain(Number(e.target.value))}
                />
              </label>
              <label>
                {t("wf.testBars")}{" "}
                <input
                  type="number" data-field="wf-test" className="w-20"
                  min={50} step={50} value={wfTest}
                  onChange={(e) => setWfTest(Number(e.target.value))}
                />
              </label>
              <label>
                {t("wf.axis")}{" "}
                <select
                  data-field="wf-axis"
                  value={wfAxis.name}
                  onChange={(e) => setWfAxis({ ...wfAxis, name: e.target.value })}
                >
                  <option value="fast">fast</option>
                  <option value="slow">slow</option>
                </select>
              </label>
              {(() => {
                const windows = Math.max(0, Math.floor(series.length / Math.max(1, wfTrain + wfTest)));
                // the count is shown in the colour of what it means: fewer than three windows is
                // not a small result, it is no result
                const cls = windows < 3 ? "msg down" : "msg";
                return (
                  <span className={cls} data-field="wf-estimate" data-few={windows < 3 ? "yes" : "no"}>
                    {windows < 3
                      ? t("wf.tooFewShort").replace("{w}", String(windows))
                      : t("wf.estimate").replace("{w}", String(windows))}
                  </span>
                );
              })()}
            </div>
          )}
          <div className="row">
            {tab === "backtest" && (
              <button onClick={() => void doBacktest()} disabled={busy}>▶ Run</button>
            )}
            {tab === "optimize" && (
              <button onClick={() => void doOptimize()} disabled={busy}>⚙ Optimize</button>
            )}
            {tab === "walkforward" && (
              <button data-action="wf-run" onClick={() => void doWalkForward()} disabled={busy}>
                ⟳ {t("wf.run")}
              </button>
            )}
            <span className="msg">{busy ? "working…" : msg}</span>
          </div>
        </>
      )}

      {tab === "pine" && (
        <>
          <textarea
            className="code"
            value={pineCode}
            onChange={(e) => setPineCode(e.target.value)}
            spellCheck={false}
          />
          <div className="row">
            <button onClick={() => void doPine()} disabled={busy}>▶ Compile &amp; run</button>
            <span className="msg">{busy ? "working…" : msg}</span>
          </div>
          {pineOut && pineOut.errors.length > 0 && (
            <ul className="errors">
              {pineOut.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {pineOut && pineOut.inputs.length > 0 && (
            <div className="inputs">
              <h4>Inputs</h4>
              {pineOut.inputs.map((inp) => (
                <div className="kv" key={inp.name}>
                  <span>{inp.title}</span><b>{String(inp.defval)}</b>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "backtest" && bt && <StatsTable result={bt} />}

      {tab === "optimize" && opt && (
        <div className="scroll">
          <OptimizerHeatmap
            result={opt}
            onApply={(params) => {
              // Applying a parameter set only fills the fields: the user still presses RUN.
              // Silently re-running would replace the result they are looking at.
              setParams(params);
              setMsg(`applied ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" ")} — press Run`);
            }}
          />

          <table className="grid">
            <thead><tr><th>#</th><th>params</th><th>net</th><th>PF</th><th>win%</th><th>DD%</th></tr></thead>
            <tbody>
              {opt.ranked.slice(0, 25).map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                  <td className={r.stats.netProfit >= 0 ? "up" : "down"}>{r.stats.netProfit.toFixed(0)}</td>
                  <td>{Number.isFinite(r.stats.profitFactor) ? r.stats.profitFactor.toFixed(2) : "∞"}</td>
                  <td>{r.stats.winRate.toFixed(0)}</td>
                  <td>{r.stats.maxDrawdownPct.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "walkforward" && wf && (
        <div className="scroll" data-panel="walkforward">
          <div className="kv"><span>windows</span><b data-field="wf-windows">{wf.windows.length}</b></div>
          <div className="kv">
            <span>OOS net</span>
            <b data-field="wf-oos-net" className={wf.combinedTest.netProfit >= 0 ? "up" : "down"}>
              {wf.combinedTest.netProfit.toFixed(2)}
            </b>
          </div>
          <div className="kv"><span>OOS trades</span><b>{wf.combinedTest.tradeCount}</b></div>
          <div className="kv">
            <span>OOS win rate</span><b>{wf.combinedTest.winRate.toFixed(1)}%</b>
          </div>

          {/*
            The verdict is the point. A table of numbers with no conclusion leaves the user to
            interpret it, and that is exactly where curve fitting gets believed: a profitable
            training column next to a losing test column looks like bad luck rather than a
            warning. Counting how many windows held up says it plainly.
          */}
          {(() => {
            const n = wf.windows.length;
            const trainUp = wf.windows.filter((w) => w.trainStats.netProfit > 0).length;
            const testUp = wf.windows.filter((w) => w.testStats.netProfit > 0).length;
            let verdict: string;
            let kind: "up" | "down" | "";
            if (n === 0) {
              verdict = t("wf.noWindows");
              kind = "";
            } else if (n < 3) {
              // With one or two windows there is no way to tell a result from luck, so claiming
              // "curve fitting" or "consistent" would be overclaiming from a sample of one.
              verdict = t("wf.tooFew");
              kind = "";
            } else if (trainUp > 0 && testUp === 0) {
              verdict = t("wf.curveFit");
              kind = "down";
            } else if (testUp === n) {
              verdict = t("wf.consistent");
              kind = "up";
            } else if (testUp <= Math.floor(n / 2)) {
              verdict = t("wf.weak");
              kind = "down";
            } else {
              verdict = t("wf.mixed");
              kind = "";
            }
            return (
              <p className={`msg ${kind}`} data-note="wf-verdict" data-kind={kind || "neutral"}>
                {verdict}
                {" "}
                <span data-field="wf-counts">
                  ({t("wf.trainUp")} {trainUp}/{n}, {t("wf.testUp")} {testUp}/{n})
                </span>
              </p>
            );
          })()}

          <table className="grid">
            <thead><tr><th>{t("wf.train")}</th><th>{t("wf.test")}</th><th>{t("wf.params")}</th></tr></thead>
            <tbody>
              {wf.windows.map((w, i) => {
                // A window whose train result was positive and whose test result was negative is
                // the single most informative row, so it is marked rather than left to the eye.
                const flipped = w.trainStats.netProfit > 0 && w.testStats.netProfit < 0;
                return (
                  <tr key={i} data-window={i} data-flipped={flipped ? "yes" : "no"}>
                    <td className={w.trainStats.netProfit >= 0 ? "up" : "down"}>
                      {w.trainStats.netProfit.toFixed(0)}
                    </td>
                    <td className={w.testStats.netProfit >= 0 ? "up" : "down"}>
                      {w.testStats.netProfit.toFixed(0)}
                    </td>
                    <td>
                      {Object.entries(w.bestParams).map(([k, v]) => `${k}=${v}`).join(" ")}
                      {flipped && <b className="down" title={t("wf.flippedHint")}> ⚠</b>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="msg" data-note="wf-foot">{t("wf.foot")}</p>
        </div>
      )}

      {tab === "montecarlo" && (
        <div>
          {!mc && <p className="msg">Run a backtest first.</p>}
          {mc && (
            <>
              <div className="kv"><span>P(loss)</span><b>{(mc.probLoss * 100).toFixed(1)}%</b></div>
              <div className="kv"><span>worst final</span><b>{mc.worstFinal.toFixed(2)}</b></div>
              <div className="kv"><span>best final</span><b>{mc.bestFinal.toFixed(2)}</b></div>
              <div className="kv"><span>p5 / p50 / p95 end</span>
                <b>
                  {mc.p5.at(-1)?.toFixed(0)} / {mc.p50.at(-1)?.toFixed(0)} / {mc.p95.at(-1)?.toFixed(0)}
                </b>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatsTable({ result }: { result: BacktestResult }): JSX.Element {
  const s = result.stats;
  const rows: Array<[string, string]> = [
    ["trades", String(s.tradeCount)],
    ["net profit", s.netProfit.toFixed(2)],
    ["win rate", `${s.winRate.toFixed(1)}%`],
    ["profit factor", Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"],
    ["max drawdown", `${s.maxDrawdown.toFixed(2)} (${s.maxDrawdownPct.toFixed(1)}%)`],
    ["expectancy", s.expectancy.toFixed(2)],
    ["avg win / loss", `${s.avgWin.toFixed(2)} / ${s.avgLoss.toFixed(2)}`],
    ["streaks (W/L)", `${s.maxWinStreak} / ${s.maxLossStreak}`],
    ["Sharpe", s.sharpe.toFixed(2)],
    ["Sortino", s.sortino.toFixed(2)],
    ["MAE / MFE", `${s.avgMae.toFixed(1)} / ${s.avgMfe.toFixed(1)}`],
    ["ending balance", s.endingBalance.toFixed(2)],
  ];
  return (
    <div className="stats">
      {rows.map(([k, v]) => (
        <div className="kv" key={k}><span>{k}</span><b>{v}</b></div>
      ))}
      {result.errors.length > 0 && (
        <ul className="errors">
          {result.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}
