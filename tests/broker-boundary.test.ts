import { describe, it, expect } from "vitest";
// The URL guard lives in main, and testing it is the whole point of this file, so the import is
// deliberate. The eslint rule that fires here exists to keep src/CORE free of main-only code —
// a test that guards main's boundary is the opposite case, not a violation. Scoped disable
// rather than a weakened rule.
// eslint-disable-next-line no-restricted-imports
import { bridgeUrlAllowed } from "../src/main/net.js";
import { timeframeToMinutes } from "../src/renderer/panels/BrokerPanel.js";

describe("bridgeUrlAllowed", () => {
  it("allows loopback over http, which the general allowlist forbids", () => {
    expect(bridgeUrlAllowed("http://127.0.0.1:8765/health")).toBe(true);
    expect(bridgeUrlAllowed("http://localhost:8765/candles?symbol=EURUSD")).toBe(true);
  });

  it("REFUSES a remote host, so a hostile URL cannot reach the internet", () => {
    expect(bridgeUrlAllowed("http://evil.example.com:8765/health")).toBe(false);
    expect(bridgeUrlAllowed("http://127.0.0.1.evil.com/health")).toBe(false);
    // a lookalike IP that is not loopback
    expect(bridgeUrlAllowed("http://127.0.0.2:8765/health")).toBe(false);
  });

  it("REFUSES https to loopback, because the bridge is plain http", () => {
    expect(bridgeUrlAllowed("https://127.0.0.1:8765/health")).toBe(false);
  });

  it("only allows the paths the bridge actually serves", () => {
    expect(bridgeUrlAllowed("http://127.0.0.1:8765/nope")).toBe(false);
    expect(bridgeUrlAllowed("http://127.0.0.1:8765/orders")).toBe(false);
    expect(bridgeUrlAllowed("http://127.0.0.1:8765/timeframes")).toBe(true);
    expect(bridgeUrlAllowed("http://127.0.0.1:8765/symbols")).toBe(true);
  });

  it("is safe on a malformed URL", () => {
    expect(bridgeUrlAllowed("not a url")).toBe(false);
    expect(bridgeUrlAllowed("")).toBe(false);
  });

  it("does not allow a userinfo trick that disguises the real host", () => {
    // http://127.0.0.1@evil.com/ actually connects to evil.com
    expect(bridgeUrlAllowed("http://127.0.0.1@evil.com/health")).toBe(false);
  });
});

describe("timeframeToMinutes", () => {
  it("maps minutes", () => {
    expect(timeframeToMinutes("M1")).toBe(1);
    expect(timeframeToMinutes("M15")).toBe(15);
  });

  it("maps hours", () => {
    expect(timeframeToMinutes("H1")).toBe(60);
    expect(timeframeToMinutes("H4")).toBe(240);
  });

  it("maps days", () => {
    expect(timeframeToMinutes("D1")).toBe(1440);
  });

  it("falls back to 1 for anything unparseable, rather than NaN", () => {
    expect(timeframeToMinutes("junk")).toBe(1);
  });
});
