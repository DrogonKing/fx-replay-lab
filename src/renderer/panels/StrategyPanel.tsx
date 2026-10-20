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
import type { BacktestResult } from "../../core/backtest.js";
import type {
  OptimizationResult, WalkForwardResult, MonteCarloResult,
} from "../../core/optimize.js";
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

  const req = (): unknown => ({
    series: payload(series),
    code,
    params: {},
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
      const train = Math.max(200, Math.floor(series.length / 4));
      const test = Math.max(100, Math.floor(series.length / 8));
      const r = (await api.walkForward(
        req(), [{ name: "fast", from: 5, to: 13, step: 4 }], train, test,
      )) as WalkForwardResult;
      setWf(r);
      setMsg(`${r.windows.length} windows; out-of-sample net ${r.combinedTest.netProfit.toFixed(2)}`);
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
          <div className="row">
            {tab === "backtest" && (
              <button onClick={() => void doBacktest()} disabled={busy}>▶ Run</button>
            )}
            {tab === "optimize" && (
              <button onClick={() => void doOptimize()} disabled={busy}>⚙ Optimize</button>
            )}
            {tab === "walkforward" && (
              <button onClick={() => void doWalkForward()} disabled={busy}>↻ Walk-forward</button>
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
        <div className="scroll">
          <div className="kv"><span>windows</span><b>{wf.windows.length}</b></div>
          <div className="kv"><span>OOS net</span><b>{wf.combinedTest.netProfit.toFixed(2)}</b></div>
          <div className="kv"><span>OOS trades</span><b>{wf.combinedTest.tradeCount}</b></div>
          <table className="grid">
            <thead><tr><th>train net</th><th>test net</th><th>params</th></tr></thead>
            <tbody>
              {wf.windows.map((w, i) => (
                <tr key={i}>
                  <td>{w.trainStats.netProfit.toFixed(0)}</td>
                  <td className={w.testStats.netProfit >= 0 ? "up" : "down"}>{w.testStats.netProfit.toFixed(0)}</td>
                  <td>{Object.entries(w.bestParams).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
