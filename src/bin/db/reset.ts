import { defineCommand, defineFlagOption } from "@wiggler/lib/cli";
import { CliUsageError } from "@wiggler/lib/cli/parser";
import { createDatabase } from "@wiggler/lib/db/createDatabase";
import { destroyDatabase } from "@wiggler/lib/db/destroyDatabase";
import { sql } from "kysely";
import { z } from "zod";

const PUBLIC_TABLES = [
  "candle_sync_runs",
  "candle_lookahead_features",
  "candle_vwap",
  "candles",
] as const;

/**
 * Truncates every wiggler application table. Schema is preserved.
 */
export const dbResetCommand = defineCommand({
  name: "db:reset",
  summary: "Truncate all wiggler application tables",
  description:
    "Removes every row from every wiggler-managed table without dropping the schema. Requires --yes to confirm.",
  options: [
    defineFlagOption({
      key: "yes",
      long: "--yes",
      schema: z.boolean().default(false).describe("Confirm destructive truncation."),
    }),
  ],
  examples: ["bun wiggler db:reset --yes"],
  output: "Prints the truncated tables.",
  sideEffects: "Destroys all rows in wiggler tables.",
  async run({ io, options }) {
    if (!options.yes) {
      throw new CliUsageError("Refusing to truncate without --yes confirmation.");
    }

    const db = createDatabase();
    try {
      const tableList = PUBLIC_TABLES.join(", ");
      await sql.raw(`truncate table ${tableList} restart identity cascade`).execute(db);
      io.writeStdout(`truncated: ${tableList}\nstatus: ok\n`);
    } finally {
      await destroyDatabase(db);
    }
  },
});
