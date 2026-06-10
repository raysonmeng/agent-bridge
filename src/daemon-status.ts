import type { DaemonStatus } from "./control-protocol";

export type DaemonStatusPath = "/healthz" | "/readyz";

export const DAEMON_STATUS_FETCH_TIMEOUT_MS = 1000;

export async function fetchDaemonStatus(
  port: number,
  path: DaemonStatusPath = "/healthz",
  timeoutMs = DAEMON_STATUS_FETCH_TIMEOUT_MS,
): Promise<DaemonStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as DaemonStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
