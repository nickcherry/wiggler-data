import { defineCommand } from "@wiggler/lib/cli";
import { formatMigrationResults } from "@wiggler/lib/db/formatMigrationResults";
import { runMigrationCommand } from "@wiggler/lib/db/runMigrationCommand";

/**
 * Applies all pending database migrations.
 */
export const dbMigrateCommand = defineCommand({
  name: "db:migrate",
  summary: "Apply pending database migrations",
  description:
    "Run all pending PostgreSQL schema migrations against the configured database.",
  examples: [
    "bun wiggler db:migrate",
    "DATABASE_URL=postgres://localhost:5432/wiggler bun wiggler db:migrate",
  ],
  output: "Prints the executed migration names and final status.",
  sideEffects:
    "Connects to PostgreSQL and mutates database schema by applying pending migrations.",
  async run({ io }) {
    const resultSet = await runMigrationCommand(async ({ migrator }) =>
      migrator.migrateToLatest(),
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
  return new Error("Database migration failed.");
}
