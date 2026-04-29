import type { DatabaseClient } from "@wiggler/lib/db/types";

/**
 * Writes a single heartbeat record for the given collector run/component.
 */
export async function writeHeartbeat(
  db: DatabaseClient,
  args: Readonly<{
    runId: string;
    component: string;
    status: "ok" | "degraded" | "error" | "stopped";
    detailsJson: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await db
    .insertInto("collector_heartbeats")
    .values({
      run_id: args.runId,
      component: args.component,
      heartbeat_at: new Date(),
      status: args.status,
      details: args.detailsJson,
    })
    .execute();
}
