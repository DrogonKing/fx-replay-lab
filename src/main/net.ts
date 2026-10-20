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

export function hostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
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
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // leave as text; the adapter reports bad-payload
    }
    const retry = res.headers.get("retry-after");
    return {
      status: res.status,
      body,
      ...(retry ? { retryAfterSeconds: Number(retry) } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
