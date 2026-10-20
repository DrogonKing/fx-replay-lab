/**
 * Symbol manager.
 *
 * The shipped list is hardcoded: 8 instruments. A broker's real contract size, lot step or
 * spread for anything else is not in this repo and cannot be guessed — and a wrong contract
 * size silently multiplies every P&L by that factor. This panel lets the user add one, with
 * validation that refuses rather than repairs.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n-context.js";
import { DEFAULT_SYMBOLS } from "../../core/symbol.js";
import {
  mergeSymbols, specFromForm, parseSymbols, serialiseSymbols, describeSymbol,
  validateSymbol,
} from "../../core/symbol-manager.js";
import type { SymbolSpec } from "../../core/types.js";

interface SymbolsApi {
  loadSymbols?: () => Promise<{ raw: string | null; updatedAt: number | null }>;
  saveSymbols?: (s: unknown) => Promise<{ ok: boolean }>;
}

const api = (): SymbolsApi =>
  (globalThis as unknown as { fxlab?: SymbolsApi }).fxlab ?? {};

const BLANK = {
  name: "", digits: "2", contractSize: "100", lotMin: "0.01", lotMax: "100",
  lotStep: "0.01", spread: "0", commissionPerLot: "0",
};

export function SymbolsPanel(): JSX.Element {
  const { t } = useI18n();
  const [custom, setCustom] = useState<SymbolSpec[]>([]);
  const [form, setForm] = useState<Record<string, string>>({ ...BLANK });
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const a = api();
    if (!a.loadSymbols) { setLoaded(true); return; }
    void a.loadSymbols().then((res) => {
      if (res.raw === null) { setLoaded(true); return; }
      try {
        const parsed = parseSymbols(JSON.parse(res.raw));
        setCustom(parsed.value);
        if (parsed.rejected.length > 0) {
          setMsg(`${parsed.rejected.length} stored symbol(s) dropped: ${parsed.rejected[0]}`);
        }
      } catch (e) {
        setMsg(`stored symbols are unreadable: ${(e as Error).message}`);
      }
      setLoaded(true);
    });
  }, []);

  const all = useMemo(() => mergeSymbols(custom), [custom]);

  const persist = (next: SymbolSpec[]): void => {
    setCustom(next);
    void api().saveSymbols?.(serialiseSymbols(next));
  };

  const add = (): void => {
    const { spec, check } = specFromForm(form);
    if (!spec) {
      setMsg(Object.entries(check.errors).map(([k, v]) => `${k}: ${v}`).join(" · "));
      return;
    }
    if (all.some((s) => s.name.toLowerCase() === spec.name.toLowerCase())) {
      // replacing a BUILT-IN is allowed and useful (correcting a contract size), so say so
      const isBuiltIn = DEFAULT_SYMBOLS.some((s) => s.name === spec.name);
      if (!isBuiltIn) {
        setMsg(`${spec.name} already exists`);
        return;
      }
      setMsg(`${spec.name} overrides the built-in`);
    } else {
      setMsg(`${spec.name} added`);
    }
    persist([...custom.filter((c) => c.name !== spec.name), spec]);
    setForm({ ...BLANK });
  };

  const remove = (name: string): void => {
    const isBuiltIn = DEFAULT_SYMBOLS.some((s) => s.name === name);
    if (isBuiltIn) {
      setMsg(`${name} is a built-in; add a custom version to override it instead`);
      return;
    }
    persist(custom.filter((c) => c.name !== name));
    setMsg(`${name} removed`);
  };

  return (
    <div className="symbols-panel">
      <h2>{t("sym.title")}</h2>

      <table className="grid">
        <thead>
          <tr>
            <th>{t("sym.name")}</th>
            <th>{t("sym.contract")}</th>
            <th>{t("sym.spread")}</th>
            <th>{t("sym.lots")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {all.map((s) => {
            const isCustom = custom.some((c) => c.name === s.name);
            return (
              <tr key={s.name} data-symbol={s.name}>
                <td>
                  {s.name}
                  {isCustom && <span className="tag-custom"> {t("sym.custom")}</span>}
                </td>
                <td>{s.contractSize}</td>
                <td>{s.spread}</td>
                <td>{s.lotMin}–{s.lotMax}/{s.lotStep}</td>
                <td>
                  {isCustom ? (
                    <button className="mini" data-action={`del-${s.name}`} onClick={() => remove(s.name)}>✕</button>
                  ) : (
                    <span className="msg">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>{t("sym.addTitle")}</h3>
      <div className="sym-form">
        {([
          ["name", "sym.name"], ["digits", "sym.digits"], ["contractSize", "sym.contract"],
          ["lotMin", "sym.lotMin"], ["lotMax", "sym.lotMax"], ["lotStep", "sym.lotStep"],
          ["spread", "sym.spread"], ["commissionPerLot", "sym.commission"],
        ] as Array<[string, string]>).map(([field, label]) => (
          <label key={field}>
            {t(label)}
            <input
              data-field={`sym-${field}`}
              value={form[field] ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
              inputMode={field === "name" ? "text" : "decimal"}
            />
          </label>
        ))}
        <button data-action="sym-add" onClick={add}>{t("sym.add")}</button>
      </div>

      {msg && <p className="msg" data-note="symbols">{msg}</p>}
      <p className="msg">
        {t("sym.demoNote")}
      </p>
    </div>
  );
}
