/**
 * Network egress for the renderer.
 *
 * The renderer's CSP is `connect-src 'none'`, which is deliberate: no page code
 * may open a socket. Live mode therefore goes through IPC to this module, where
 * the request is made once, validated, and returned. That keeps the strict CSP
 * (a malicious CSV description cannot exfiltrate anything) while still allowing
 * the "online = live chart" behaviour the app needs.
 *
 * Offline mode never calls this at all, so "no network" is enforced structurally
 * rather than by a flag someone might forget to check.
 */
import { net } from "electron";

export interface FetchResult {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
}

const ALLOWED_HOSTS = new Set([
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "stooq.com",
  "stooq.pl",
]);

/**
 * Is this a local bridge URL?
 *
 * The MT5 bridge listens on loopback over plain HTTP, which `hostAllowed` forbids on purpose.
 * Rather than loosening the general rule, local bridge access is its own narrow exception:
 * loopback only, http only, and only the paths the bridge actually serves. A hostile URL that
 * slipped through could still not reach any other host.
 */
export function bridgeUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
    return ["/health", "/symbols", "/timeframes", "/candles", "/login", "/shutdown"].includes(u.pathname);
  } catch {
    return false;
  }
}

export function hostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Bodies larger than this are truncated rather than buffered. 8MB is far above any real payload. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body, stopping at MAX_BODY_BYTES.
 *
 * Truncation is reported to the caller as a parse failure (the text will not be valid JSON), which
 * the adapters already handle as a bad payload - an honest outcome, unlike silently accepting 2GB.
 */
async function readCapped(res: Response, controller: AbortController): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_BODY_BYTES))));
        controller.abort();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Perform a GET and parse JSON.
 *
 * Only allow-listed HTTPS hosts are reachable, so even if a bug let a hostile URL
 * through, it could not reach an arbitrary server.
 */
export async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 15_000,
): Promise<FetchResult> {
  if (!hostAllowed(url)) {
    throw new Error(`blocked host: ${new URL(url).hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    /*
      Read the body with a cap and a deadline.

      Two bugs lived here:
        - res.text() buffered whatever arrived, with no limit. One misbehaving provider returning a
          multi-gigabyte body would take the whole app down, and nothing in the codebase would point
          at why.
        - the abort timer used to be cleared as soon as the headers landed, so a server that sent
          headers and then stalled held the request open forever with the timeout already cancelled.
      The timer now stays armed until the body is fully read, and the read itself stops at MAX_BODY.
    */
    const text = await readCapped(res, controller);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // leave as text; the adapter reports bad-payload
    }
    const retry = res.headers.get("retry-after");
    const retrySeconds = retry === null ? NaN : Number(retry);
    return {
      status: res.status,
      body,
      // an unparseable Retry-After is not "retry in NaN seconds"
      ...(Number.isFinite(retrySeconds) && retrySeconds > 0 ? { retryAfterSeconds: retrySeconds } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
