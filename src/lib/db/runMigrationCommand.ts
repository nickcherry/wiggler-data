import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { createMigrator } from "@wiggler/lib/db/createMigrator";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import type { DatabaseClient } from "@wiggler/lib/db/types";
import type { Migrator } from "kysely";

type MigrationCommandContext = {
  readonly db: DatabaseClient;
  readonly migrator: Migrator;
};

/**
 * Runs a migration command with a shared database lifecycle.
 */
export async function runMigrationCommand<T>(
  handler: (context: MigrationCommandContext) => Promise<T>,
): Promise<T> {
  const db = createDatabase();

  try {
    const migrator = createMigrator(db);
    return await handler({ db, migrator });
  } finally {
    await destroyDatabase(db);
  }
}
