/**
 * Parses duration shorthand like "30s", "5m", "1h", "24h", "1d" into milliseconds.
 */
export function parseDurationMs(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(
      `Unsupported duration: "${input}". Expected forms like 500ms, 30s, 5m, 24h, 7d.`,
    );
  }
  const [, valueRaw, unit] = match;
  if (!valueRaw || !unit) {
    throw new Error(`Unsupported duration: "${input}".`);
  }
  const value = Number(valueRaw);
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unsupported duration unit: "${unit}".`);
  }
}

/**
 * Renders a duration in milliseconds into a short human label.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "n/a";
  }
  const abs = Math.abs(ms);
  if (abs < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (abs < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (abs < 3_600_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
