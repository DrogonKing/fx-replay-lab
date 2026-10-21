import { describe, it, expect } from "vitest";
// eslint-disable-next-line no-restricted-imports
import { bridgeOrigin } from "../src/main/broker-fetch.js";
// eslint-disable-next-line no-restricted-imports
import { bridgeUrlAllowed } from "../src/main/net.js";

describe("bridgeOrigin", () => {
  it("leaves a bare origin alone", () => {
    expect(bridgeOrigin("http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765");
    expect(bridgeOrigin("http://localhost:9000")).toBe("http://localhost:9000");
  });

  it("STRIPS an endpoint path, which is what a user pastes from a curl example", () => {
    // the bug this fixes: appending /health to this produced /health/health, which the allowlist
    // refused, and the message blamed the host
    expect(bridgeOrigin("http://127.0.0.1:8765/health")).toBe("http://127.0.0.1:8765");
    expect(bridgeOrigin("http://127.0.0.1:8765/symbols")).toBe("http://127.0.0.1:8765");
    expect(bridgeOrigin("http://127.0.0.1:8765/candles?symbol=EURUSD&timeframe=M1"))
      .toBe("http://127.0.0.1:8765");
  });

  it("tolerates trailing slashes and whitespace", () => {
    expect(bridgeOrigin("  http://127.0.0.1:8765/  ")).toBe("http://127.0.0.1:8765");
    expect(bridgeOrigin("http://127.0.0.1:8765///")).toBe("http://127.0.0.1:8765");
  });

  it("returns something the validator can judge when the input is junk", () => {
    expect(bridgeOrigin("not a url")).toBe("not a url");
    expect(bridgeUrlAllowed(`${bridgeOrigin("not a url")}/health`)).toBe(false);
  });

  it("produces URLs the allowlist accepts, from every form a user might paste", () => {
    const pasted = [
      "http://127.0.0.1:8765",
      "http://127.0.0.1:8765/",
      "http://127.0.0.1:8765/health",
      "http://127.0.0.1:8765/candles?symbol=EURUSD",
      "http://localhost:8765/symbols",
    ];
    for (const p of pasted) {
      expect(bridgeUrlAllowed(`${bridgeOrigin(p)}/health`), p).toBe(true);
    }
  });

  it("still refuses a remote host after normalisation", () => {
    expect(bridgeUrlAllowed(`${bridgeOrigin("http://evil.example.com/health")}/health`)).toBe(false);
  });
});
