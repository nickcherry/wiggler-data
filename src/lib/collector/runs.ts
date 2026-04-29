import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Inserts a new collector run row in `running` status and returns the row id.
 */
export async function startCollectorRun(
  db: DatabaseClient,
  args: Readonly<{
    runId: string;
    assetSymbol: string;
    mode: string;
    config: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await db
    .insertInto("collector_runs")
    .values({
      run_id: args.runId,
      asset_symbol: args.assetSymbol,
      mode: args.mode,
      started_at: new Date(),
      status: "running",
      config: args.config,
    })
    .execute();
}

/**
 * Closes the collector run with a terminal status.
 */
export async function finishCollectorRun(
  db: DatabaseClient,
  args: Readonly<{
    runId: string;
    status: "stopped" | "error" | "completed";
    error?: string | null;
  }>,
): Promise<void> {
  await db
    .updateTable("collector_runs")
    .set({
      stopped_at: new Date(),
      status: args.status,
      error: args.error ?? null,
    })
    .where("run_id", "=", args.runId)
    .execute();
}
