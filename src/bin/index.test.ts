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
    expect(names).toContain("candles:sync");
    expect(names).toContain("candles:status");
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
    expect(help).toContain("candles:sync");
    expect(help).toContain("candles:status");
  });
});
