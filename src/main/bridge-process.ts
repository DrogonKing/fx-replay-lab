/**
 * Child-process manager for the MetaTrader bridge.
 *
 * The requirement: type account, password and server, press Connect, and it works. No terminal, no
 * `pip install`, no second window. So the app starts the bridge itself, using a Python runtime
 * bundled into the installer.
 *
 * Constraints that shaped this:
 *   - `MetaTrader5` publishes win_amd64 wheels only, so the bridge can only run on Windows.
 *   - The runtime is bundled rather than assumed. A missing interpreter on the user's machine was
 *     half the reason the old Log in button looked broken.
 *   - The bridge binds loopback only and is never exposed beyond 127.0.0.1.
 *   - Readiness is `/health` answering, not the process existing: a bridge that starts and dies on an
 *     ImportError would otherwise look like success and fail later with a confusing message.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface BridgePaths {
  python: string;
  script: string;
  available: boolean;
  /** why it is unavailable, in words a user can act on */
  reason?: string;
}

const DEFAULT_PORT = 8765;

export function bridgePort(): number {
  return DEFAULT_PORT;
}

/**
 * Locate the interpreter and the script.
 *
 * Packaged: both live under `resources/bridge/`, the interpreter at `resources/bridge/python/`.
 * Development: use whatever `python` is on PATH so the bridge can be worked on without the runtime.
 */
export function resolveBridgePaths(): BridgePaths {
  const script = app.isPackaged
    ? join(process.resourcesPath, "bridge", "mt5-bridge.py")
    : join(app.getAppPath(), "bridge", "mt5-bridge.py");

  if (process.platform !== "win32") {
    return {
      python: "",
      script,
      available: false,
      reason:
        "MetaTrader's Python package ships Windows-only binaries, so the bridge cannot run on this " +
        "platform. Charting, replay and backtesting are unaffected — use Import CSV for data.",
    };
  }

  const bundled = app.isPackaged
    ? join(process.resourcesPath, "bridge", "python", "python.exe")
    : join(app.getAppPath(), "bridge", "python", "python.exe");

  if (existsSync(bundled) && existsSync(script)) {
    return { python: bundled, script, available: true };
  }

  if (!app.isPackaged) {
    // dev fallback: the runtime is only bundled for release builds
    return { python: "python", script, available: existsSync(script) };
  }

  return {
    python: bundled,
    script,
    available: false,
    reason: existsSync(script)
      ? "The bundled Python runtime is missing from this build. Reinstall the app."
      : "The bridge script is missing from this build. Reinstall the app.",
  };
}

let child: ChildProcess | null = null;
let logTail = "";

/** The bridge's own stderr, so a Python traceback can be shown instead of swallowed. */
export function bridgeLog(): string {
  return logTail;
}

/**
 * Start the bridge if it is not already alive.
 *
 * Idempotent: calling it twice does not spawn two processes fighting over the port.
 */
export async function startBridge(port = bridgePort(), timeoutMs = 25_000): Promise<{ ok: boolean; error?: string }> {
  if (child && child.exitCode === null) return { ok: true };

  /*
    If something is already answering on the port, use it.

    Spawning unconditionally was a real bug: a bridge left running by a previous session (or by a
    second install) holds the port, the new process dies on EADDRINUSE, and Connect reports
    "the bridge exited on startup" while a perfectly healthy bridge is listening. Discovery before
    start, always.
  */
  const already = await probeHealth(port);
  if (already) return { ok: true };

  const paths = resolveBridgePaths();
  if (!paths.available) return { ok: false, error: paths.reason ?? "the bridge runtime is unavailable" };

  logTail = "";
  try {
    child = spawn(paths.python, [paths.script, "--port", String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, error: `could not start the bridge: ${(e as Error).message}` };
  }

  child.stderr?.on("data", (b: Buffer) => {
    logTail = (logTail + b.toString()).slice(-3000);
  });
  child.stdout?.on("data", (b: Buffer) => {
    logTail = (logTail + b.toString()).slice(-3000);
  });

  const exitState: { seen: boolean; code: number | null } = { seen: false, code: null };
  child.once("exit", (code) => {
    exitState.seen = true;
    exitState.code = code;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitState.seen) {
      const detail = logTail.trim().split("\n").slice(-4).join(" | ");
      stopBridge();
      return {
        ok: false,
        error:
          `the bridge exited on startup (code ${exitState.code}). ` +
          (detail ? `Python said: ${detail}` : "It printed nothing."),
      };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { ok: true };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  stopBridge();
  return { ok: false, error: `the bridge did not answer within ${Math.round(timeoutMs / 1000)}s` };
}

export function stopBridge(): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    // already gone
  }
  child = null;
}

export function bridgeRunning(): boolean {
  return !!child && child.exitCode === null;
}

/** True when a bridge answers on this port, whoever started it. */
async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}
