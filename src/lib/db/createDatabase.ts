import { env } from "@wiggler/constants/env";
import type { Database, DatabaseClient } from "@wiggler/lib/db/types";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";

/**
 * Creates the single PostgreSQL-backed Kysely client for application and migration work.
 */
export function createDatabase(): DatabaseClient {
  const poolConfig: PoolConfig = {
    connectionString: env.databaseUrl,
  };
  const poolMax = env.databasePoolMax;

  if (poolMax !== undefined) {
    poolConfig.max = poolMax;
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool(poolConfig),
    }),
  });
}
