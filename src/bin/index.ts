#!/usr/bin/env bun

import { candlesStatusCommand } from "@wiggler/bin/candles/status";
import { candlesSyncCommand } from "@wiggler/bin/candles/sync";
import { candlesVwapCommand } from "@wiggler/bin/candles/vwap";
import { dbMigrateCommand } from "@wiggler/bin/db/migrate";
import { dbResetCommand } from "@wiggler/bin/db/reset";
import { dbRollbackCommand } from "@wiggler/bin/db/rollback";
import { dbStatusCommand } from "@wiggler/bin/db/status";
import { doctorCommand } from "@wiggler/bin/doctor";
import { createCli } from "@wiggler/lib/cli";

export const wigglerCommands = [
  doctorCommand,
  dbMigrateCommand,
  dbStatusCommand,
  dbRollbackCommand,
  dbResetCommand,
  candlesSyncCommand,
  candlesStatusCommand,
  candlesVwapCommand,
] as const;

export const wigglerCli = createCli({
  name: "wiggler",
  summary:
    "wiggler: historical OHLCV candle ingestion across CEX REST endpoints, with idempotent upserts and resumable syncs.",
  commands: wigglerCommands,
});

if (import.meta.main) {
  await wigglerCli.runWithErrorBoundary(process.argv.slice(2));
}
