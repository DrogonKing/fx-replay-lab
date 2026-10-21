/**
 * The timezone picker.
 *
 * Built to match the dialog in the reference: a searchable list where every row is
 * "City (UTC±N)", ordered by offset so it reads as a clock rather than an alphabet. Offsets are
 * computed at the reference instant, so New York shows UTC-4 in July and UTC-5 in January —
 * a hardcoded list would be wrong for half the year.
 *
 * Works identically in live and replay: the reference instant is the chart's current bar time, so
 * the offsets describe the moment being looked at, not the wall clock. Scrolling back to a July
 * replay shows summer offsets, which is what the candles were actually trading under.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n-context.js";
import {
  filterTimezones, timezoneOptions, type TimezoneOption,
} from "../../core/timezone-cities.js";

export interface TimezonePickerProps {
  /** current zone id, e.g. "America/New_York" */
  value: string;
  /** chart time being displayed; offsets are computed here so replay shows period-correct DST */
  referenceEpoch: number;
  onChange: (zone: string) => void;
}

export function TimezonePicker({
  value, referenceEpoch, onChange,
}: TimezonePickerProps): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Recomputed when the reference moment changes, which is what makes DST period-correct.
  const options = useMemo(() => timezoneOptions(referenceEpoch), [referenceEpoch]);
  const filtered = useMemo(() => filterTimezones(options, query), [options, query]);
  const current = options.find((o) => o.zone === value);

  // Close on an outside click. Without this the dialog stays open behind the chart and eats the
  // next click, which feels like the app froze.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(Math.max(0, filtered.findIndex((o) => o.zone === value)));
      // focus after paint, or the input is not there yet
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in range when the query narrows the list.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const choose = (o: TimezoneOption): void => {
    onChange(o.zone);
    setOpen(false);
  };

  /**
   * Screen position for the dialog.
   *
   * The dialog is `position: fixed` because its parent toolbar scrolls (`overflow-x: auto`), which
   * clips absolutely-positioned children — a 378px menu was being cut to the toolbar's 44px and
   * painted over the chart starting at y=0. Fixed positioning escapes that clip, but then the
   * coordinates must be supplied: with none, the dialog renders at the viewport origin.
   */
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    const measure = (): void => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // the dialog is 268px wide and can be ~400px tall; keep it fully on screen
      const width = 268;
      const maxTop = window.innerHeight - 60;
      setAnchor({
        left: Math.max(4, Math.min(r.left, window.innerWidth - width - 8)),
        top: Math.min(r.bottom + 6, maxTop),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[active];
      if (pick) choose(pick);
    }
  };

  return (
    <div className="tz" ref={boxRef} data-panel="timezone">
      <button
        ref={buttonRef}
        className="tz-button"
        data-action="tz-open"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={t("tz.buttonHint")}
      >
        {/* the button states the zone AND its offset, so the offset is readable without opening
            anything — the same information the dialog's check mark conveys */}
        <span data-field="tz-current" data-zone={value}>
          {current ? `${current.city} (${current.offset})` : value}
        </span>
        <span className="tz-caret">▾</span>
      </button>

      {open && (
        <div
          className="tz-dialog"
          role="dialog"
          data-dialog="timezone"
          style={anchor ? { left: `${anchor.left}px`, top: `${anchor.top}px` } : { visibility: "hidden" }}
        >
          <input
            ref={inputRef}
            className="tz-search"
            data-field="tz-search"
            placeholder={t("tz.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />

          {filtered.length === 0 ? (
            <p className="msg" data-note="tz-empty">{t("tz.none")}</p>
          ) : (
            <ul className="tz-list" role="listbox" data-list="timezones">
              {filtered.map((o, i) => (
                <li
                  key={o.zone}
                  role="option"
                  aria-selected={o.zone === value}
                  data-tz={o.zone}
                  data-offset={o.offset}
                  data-dst={o.dst ? "yes" : "no"}
                  data-market={o.market ? "yes" : "no"}
                  className={
                    "tz-row" +
                    (o.zone === value ? " on" : "") +
                    (i === active ? " active" : "")
                  }
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                >
                  <span className="tz-city">
                    {o.market && <span className="tz-dot" title={t("tz.market")} />}
                    {o.city}
                  </span>
                  <span className="tz-offset">
                    {o.offset}
                    {/* DST is shown, not hidden: a one-hour surprise during a session is
                        exactly the kind of thing a trader needs to see coming */}
                    {o.dst && <span className="tz-dst" title={t("tz.dst")}>DST</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="tz-foot" data-note="tz-foot">{t("tz.foot")}</p>
        </div>
      )}
    </div>
  );
}
