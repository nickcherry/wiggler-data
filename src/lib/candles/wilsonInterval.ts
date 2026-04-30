/**
 * Wilson score interval for a binomial proportion. Returns the lower
 * bound at the requested confidence level.
 *
 * The naive estimator `wins / count` is overconfident in small buckets:
 * 17 wins out of 17 looks like 100% but is statistically very different
 * from 1700/1700. Wilson is the standard fix — it shrinks the estimate
 * toward 0.5 in proportion to the bucket's uncertainty, with the
 * shrinkage controlled by the chosen z-score.
 *
 *   z = 1.6449  → 95% one-sided lower bound (~p5 of true rate)
 *   z = 1.96    → 95% two-sided (matches a 95% confidence interval)
 *   z = 2.5758  → 99% two-sided (more conservative)
 *
 * For a trading config that needs "p_win_lower we'd actually trust to
 * size against," 95% one-sided (z=1.6449) is the conventional default.
 *
 * Edge cases:
 *   count = 0     → returns 0 (no evidence)
 *   wins  = 0     → returns 0
 *   wins  = count → returns the Wilson lower bound (always < 1)
 */
export function wilsonLowerBound(
  args: Readonly<{ wins: number; count: number; z?: number }>,
): number {
  if (!Number.isFinite(args.wins) || !Number.isFinite(args.count)) {
    throw new Error("wins/count must be finite numbers");
  }
  if (args.wins < 0 || args.count < 0 || args.wins > args.count) {
    throw new Error(
      `invalid wins/count: wins=${args.wins}, count=${args.count}`,
    );
  }
  if (args.count === 0) {
    return 0;
  }
  const z = args.z ?? 1.6449;
  const n = args.count;
  const p = args.wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = (center - margin) / denom;
  if (lower < 0) {
    return 0;
  }
  if (lower > 1) {
    return 1;
  }
  return lower;
}
