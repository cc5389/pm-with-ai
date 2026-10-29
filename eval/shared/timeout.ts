/** Validate before starting a provider attempt, rather than recording a config error as spend. */
export function timeoutMs(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(
      `${name} must be a positive integer in milliseconds (at most 2147483647).`,
    );
  }
  return value;
}
