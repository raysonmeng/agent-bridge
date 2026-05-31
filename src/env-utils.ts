export function parsePositiveIntEnv(
  name: string,
  fallback: number,
  log: (message: string) => void = () => {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;

  // Use Number() (not parseInt) so values like "1.5" and "10abc" fail validation
  // instead of being silently truncated to 1 or 10. Number.isInteger then enforces
  // the integer constraint; >0 enforces positivity; the MAX_SAFE_INTEGER guard
  // blocks IEEE rounding from silently accepting values beyond the safe range.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > Number.MAX_SAFE_INTEGER) {
    log(
      `Invalid ${name}=${JSON.stringify(raw)} (must be a positive integer within ` +
      `Number.MAX_SAFE_INTEGER); falling back to ${fallback}`,
    );
    return fallback;
  }

  return parsed;
}
