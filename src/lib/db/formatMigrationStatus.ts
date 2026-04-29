import type { MigrationInfo } from "kysely";

/**
 * Formats discovered migration state into stable CLI output.
 */
export function formatMigrationStatus(
  migrations: readonly MigrationInfo[],
): string {
  const lines = ["migration status"];

  if (migrations.length === 0) {
    lines.push("No migrations found.");
    return lines.join("\n");
  }

  for (const migration of migrations) {
    lines.push(`${migration.executedAt ? "applied" : "pending"}: ${migration.name}`);
  }

  return lines.join("\n");
}
