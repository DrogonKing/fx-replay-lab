/**
 * The toolbar's timeframe control, as a menu rather than a <select>.
 *
 * A native select cannot express "pin a favourite to the top", which is the whole point of this
 * control: a user who lives on M15 should reach M15 in one click, not by scrolling a list every
 * time. A select also cannot show why an option is unavailable beyond a disabled row, and it
 * closes on every interaction, so favouriting one frame at a time is impossible.
 *
 * Layout mirrors the platform this app follows: a single button showing the current frame, opening
 * a panel with favourites first, then every main frame, then a field for a custom frame.
 */
import React, { useEffect, useRef, useState } from "react";
import type { Timeframe } from "../core/types.js";
import { canAggregate } from "../core/resolution.js";
import { useI18n } from "./i18n-context.js";

export interface TimeframeMenuProps {
  current: Timeframe;
  /** every frame to list, current custom one included */
  frames: Timeframe[];
  /** the resolution the loaded data actually has */
  baseFrame: Timeframe;
  favourites: string[];
  onToggleFavourite: (label: string) => void;
  onChoose: (f: Timeframe) => void;
  /** called instead of onChoose when the frame cannot be built from the loaded bars */
  onReject: (f: Timeframe) => void;
  /** returns true when the custom label was accepted */
  onCustom: (label: string) => boolean;
}

export function TimeframeMenu({
  current, frames, baseFrame, favourites, onToggleFavourite, onChoose, onReject, onCustom,
}: TimeframeMenuProps): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const customRef = useRef<HTMLInputElement | null>(null);

  // Close on an outside click, or the menu eats the next click on the chart.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /**
   * Anchored like the timezone picker: the toolbar scrolls (`overflow-x: auto`), which clips
   * absolutely-positioned children. Fixed positioning plus measured coordinates is the only
   * arrangement that survives that, and the same bug was already fixed once in this toolbar.
   */
  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    const measure = (): void => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({
        left: Math.max(4, Math.min(r.left, window.innerWidth - 300)),
        top: r.bottom + 6,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  useEffect(() => {
    if (open) customRef.current?.focus();
  }, [open]);

  const favFrames = frames.filter((f) => favourites.includes(f.label));
  const otherFrames = frames.filter((f) => !favourites.includes(f.label));

  const pick = (f: Timeframe): void => {
    if (!canAggregate(baseFrame, f)) { onReject(f); return; }
    onChoose(f);
    setOpen(false);
  };

  const row = (f: Timeframe): JSX.Element => {
    const usable = canAggregate(baseFrame, f);
    const isFav = favourites.includes(f.label);
    return (
      <li key={f.label} className="tf-row" data-tf-row={f.label} data-usable={usable ? "yes" : "no"}>
        <button
          className={"tf-pick" + (f.label === current.label ? " on" : "")}
          data-tf-pick={f.label}
          disabled={!usable}
          title={usable ? f.label : t("tf.needsFiner").replace("{base}", baseFrame.label)}
          onClick={() => pick(f)}
        >
          {f.label}
        </button>
        <button
          className={"tf-star" + (isFav ? " on" : "")}
          data-tf-fav={f.label}
          title={isFav ? t("tf.unpin") : t("tf.pin")}
          aria-pressed={isFav}
          onClick={(e) => { e.stopPropagation(); onToggleFavourite(f.label); }}
        >
          {isFav ? "★" : "☆"}
        </button>
      </li>
    );
  };

  return (
    <div className="tf-menu" ref={boxRef} data-panel="timeframe">
      <button
        ref={buttonRef}
        className="tf-button"
        data-action="tf-open"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("tf.buttonHint")}
        onClick={() => setOpen((o) => !o)}
      >
        <span data-field="tf-current">{current.label}</span>
        <span className="tf-caret">▾</span>
      </button>

      {open && (
        <div
          className="tf-dialog"
          role="menu"
          data-dialog="timeframe"
          style={anchor ? { left: `${anchor.left}px`, top: `${anchor.top}px` } : { visibility: "hidden" }}
        >
          {favFrames.length > 0 && (
            <>
              <div className="tf-section">{t("tf.favourites")}</div>
              <ul className="tf-list" data-list="tf-favourites">{favFrames.map(row)}</ul>
              <div className="tf-sep" />
              <div className="tf-section">{t("tf.all")}</div>
            </>
          )}
          <ul className="tf-list" data-list="tf-all">{otherFrames.map(row)}</ul>

          <div className="tf-sep" />
          <div className="tf-custom">
            <input
              ref={customRef}
              data-field="tf-custom"
              placeholder={t("tf.customPlaceholder")}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (onCustom(customInput.trim())) { setCustomInput(""); setOpen(false); }
              }}
            />
            <button
              data-action="tf-custom-add"
              onClick={() => {
                if (onCustom(customInput.trim())) { setCustomInput(""); setOpen(false); }
              }}
            >
              +
            </button>
          </div>
          <p className="tf-foot" data-note="tf-foot">
            {t("tf.foot").replace("{base}", baseFrame.label)}
          </p>
        </div>
      )}
    </div>
  );
}

/** The instrument picker, mirroring the timeframe menu so the toolbar has one control language. */
export interface SymbolMenuProps {
  symbols: Array<{ id: string; label: string }>;
  current: string;
  onChoose: (id: string) => void;
}

export function SymbolMenu({ symbols, current, onChoose }: SymbolMenuProps): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) { setAnchor(null); return; }
    const measure = (): void => {
      const el = buttonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ left: Math.max(4, Math.min(r.left, window.innerWidth - 260)), top: r.bottom + 6 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  const label = symbols.find((s) => s.id === current)?.label ?? current;

  return (
    <div className="tf-menu" ref={boxRef} data-panel="symbol">
      <button
        ref={buttonRef}
        className="tf-button sym-button"
        data-action="sym-open"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span data-field="sym-current" data-symbol={current}>{label}</span>
        <span className="tf-caret">▾</span>
      </button>

      {open && (
        <div
          className="tf-dialog sym-dialog"
          role="menu"
          data-dialog="symbol"
          style={anchor ? { left: `${anchor.left}px`, top: `${anchor.top}px` } : { visibility: "hidden" }}
        >
          <div className="tf-section">{t("sym.instrument")}</div>
          <ul className="tf-list" data-list="symbols">
            {symbols.map((s) => (
              <li key={s.id} className="tf-row" data-sym-row={s.id}>
                <button
                  className={"tf-pick" + (s.id === current ? " on" : "")}
                  data-sym-pick={s.id}
                  onClick={() => { onChoose(s.id); setOpen(false); }}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Pinned frames, remembered across launches. */
export function loadTfFavourites(): string[] {
  try {
    const raw = localStorage.getItem("fxlab.tfFavourites");
    if (!raw) return ["M15", "H1"];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return ["M15", "H1"];
  }
}

export function saveTfFavourites(list: string[]): void {
  try {
    localStorage.setItem("fxlab.tfFavourites", JSON.stringify(list));
  } catch {
    // storage unavailable; the pins still work for this session
  }
}
