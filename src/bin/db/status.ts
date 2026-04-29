import { defineCommand } from "@wiggler/lib/cli";
import { formatMigrationStatus } from "@wiggler/lib/db/formatMigrationStatus";
import { runMigrationCommand } from "@wiggler/lib/db/runMigrationCommand";

/**
 * Prints current database migration state.
 */
export const dbStatusCommand = defineCommand({
  name: "db:status",
  summary: "Show database migration status",
  description:
    "Inspect which PostgreSQL schema migrations are already applied and which are still pending.",
  examples: ["bun wiggler db:status"],
  output:
    "Prints the discovered migrations and whether each one is applied or pending.",
  sideEffects: "Connects to PostgreSQL and reads migration metadata.",
  async run({ io }) {
    const output = await runMigrationCommand(async ({ migrator }) => {
      const migrations = await migrator.getMigrations();
      return formatMigrationStatus(migrations);
    });

    io.writeStdout(`${output}\n`);
  },
});
