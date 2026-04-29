#!/usr/bin/env bun

import { analyzeWindowCommand } from "@wiggler/bin/analyze/window";
import { auditBookCommand } from "@wiggler/bin/audit/book";
import { auditGapsCommand } from "@wiggler/bin/audit/gaps";
import { auditLatestCommand } from "@wiggler/bin/audit/latest";
import { auditMarketCommand } from "@wiggler/bin/audit/market";
import { auditPricesCommand } from "@wiggler/bin/audit/prices";
import { backtestTriggerCommand } from "@wiggler/bin/backtest/trigger";
import { collectPolymarketCommand } from "@wiggler/bin/collect/polymarket";
import { collectStartCommand } from "@wiggler/bin/collect/start";
import { dbMigrateCommand } from "@wiggler/bin/db/migrate";
import { dbResetCommand } from "@wiggler/bin/db/reset";
import { dbRollbackCommand } from "@wiggler/bin/db/rollback";
import { dbStatusCommand } from "@wiggler/bin/db/status";
import { doctorCommand } from "@wiggler/bin/doctor";
import { exportSnapshotsCommand } from "@wiggler/bin/export/snapshots";
import { marketBySlugCommand } from "@wiggler/bin/market/bySlug";
import { marketCurrentCommand } from "@wiggler/bin/market/current";
import { marketDiscoverCommand } from "@wiggler/bin/market/discover";
import { marketResolveCommand } from "@wiggler/bin/market/resolve";
import { marketWindowsCommand } from "@wiggler/bin/market/windows";
import { tailBooksCommand } from "@wiggler/bin/tail/books";
import { tailPricesCommand } from "@wiggler/bin/tail/prices";
import { createCli } from "@wiggler/lib/cli";

export const wigglerCommands = [
  doctorCommand,
  dbMigrateCommand,
  dbStatusCommand,
  dbRollbackCommand,
  dbResetCommand,
  marketCurrentCommand,
  marketBySlugCommand,
  marketDiscoverCommand,
  marketWindowsCommand,
  marketResolveCommand,
  collectStartCommand,
  collectPolymarketCommand,
  auditLatestCommand,
  auditMarketCommand,
  auditGapsCommand,
  auditBookCommand,
  auditPricesCommand,
  analyzeWindowCommand,
  backtestTriggerCommand,
  exportSnapshotsCommand,
  tailBooksCommand,
  tailPricesCommand,
] as const;

export const wigglerCli = createCli({
  name: "wiggler",
  summary:
    "wiggler: Polymarket Up/Down 5m market discovery + Coinbase/Binance asset price snapshots + audit tooling.",
  commands: wigglerCommands,
});

if (import.meta.main) {
  await wigglerCli.runWithErrorBoundary(process.argv.slice(2));
}
