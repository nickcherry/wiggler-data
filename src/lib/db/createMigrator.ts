import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseClient } from "@wiggler/lib/db/types";
import { FileMigrationProvider, Migrator } from "kysely";

const migrationFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Creates the shared Kysely migrator for the repository's PostgreSQL schema.
 */
export function createMigrator(db: DatabaseClient): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });
}
