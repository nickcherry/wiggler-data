import { defineCommand } from "@wiggler/lib/cli";
import { formatMigrationResults } from "@wiggler/lib/db/formatMigrationResults";
import { runMigrationCommand } from "@wiggler/lib/db/runMigrationCommand";

/**
 * Rolls back the latest executed database migration.
 */
export const dbRollbackCommand = defineCommand({
  name: "db:rollback",
  summary: "Roll back one database migration",
  description:
    "Run the down method for the latest executed PostgreSQL schema migration.",
  examples: ["bun wiggler db:rollback"],
  output: "Prints the rolled-back migration names and final status.",
  sideEffects:
    "Connects to PostgreSQL and mutates database schema by rolling back one migration step.",
  async run({ io }) {
    const resultSet = await runMigrationCommand(async ({ migrator }) =>
      migrator.migrateDown(),
    );

    io.writeStdout(`${formatMigrationResults(resultSet)}\n`);

    if (resultSet.error) {
      throw toError(resultSet.error);
    }
  },
});

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("Database rollback failed.");
}
