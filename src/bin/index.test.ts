import { wigglerCli, wigglerCommands } from "@wiggler/bin/index";
import { describe, expect, test } from "bun:test";

describe("wiggler command registry", () => {
  test("registers the expected command surface", () => {
    const names = wigglerCommands.map((command) => command.name);
    expect(names).toContain("doctor");
    expect(names).toContain("db:migrate");
    expect(names).toContain("db:status");
    expect(names).toContain("db:rollback");
    expect(names).toContain("db:reset");
    expect(names).toContain("market:current");
    expect(names).toContain("market:by-slug");
    expect(names).toContain("market:discover");
    expect(names).toContain("market:windows");
    expect(names).toContain("market:resolve");
    expect(names).toContain("collect:start");
    expect(names).toContain("collect:polymarket");
    expect(names).toContain("audit:latest");
    expect(names).toContain("audit:market");
    expect(names).toContain("audit:gaps");
    expect(names).toContain("audit:book");
    expect(names).toContain("audit:prices");
    expect(names).toContain("analyze:window");
    expect(names).toContain("backtest:trigger");
    expect(names).toContain("export:snapshots");
    expect(names).toContain("tail:books");
    expect(names).toContain("tail:prices");
  });

  test("renders top-level help with the registered commands", async () => {
    const stdout: string[] = [];
    await wigglerCli.run([], {
      writeStdout(text) {
        stdout.push(text);
      },
      writeStderr() {},
    });
    const help = stdout.join("");
    expect(help).toContain("doctor");
    expect(help).toContain("db:migrate");
    expect(help).toContain("collect:start");
    expect(help).toContain("audit:latest");
    expect(help).toContain("audit:prices");
    expect(help).toContain("analyze:window");
    expect(help).toContain("backtest:trigger");
    expect(help).toContain("tail:prices");
  });
});
