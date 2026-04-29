import { parseOptionToken } from "@wiggler/lib/cli/parser/tokens";
import {
  CliUsageError,
  type ParsedCommandInput,
} from "@wiggler/lib/cli/parser/types";
import {
  validateOptions,
  validatePositionals,
} from "@wiggler/lib/cli/parser/validation";
import { formatCommandUsage } from "@wiggler/lib/cli/render";
import type { CliAnyCommandDefinition } from "@wiggler/lib/cli/types";

/**
 * Parses a raw `argv` array against a command definition, resolving options and
 * positional arguments into typed values. Supports long options with `--key=val`
 * or `--key val` syntax, short options, boolean flags, and `--` to terminate
 * option parsing. Throws `CliUsageError` (which includes the formatted usage
 * string) on unknown options, duplicate options, missing values, or too many
 * positional arguments. All parsed values are validated and coerced by the
 * option/positional's Zod schema before being returned.
 */
export function parseCommandArgv(
  appName: string,
  command: CliAnyCommandDefinition,
  argv: readonly string[],
): ParsedCommandInput {
  const options = command.options ?? [];
  const positionals = command.positionals ?? [];
  const longOptions = new Map(options.map((option) => [option.long, option]));
  const shortOptions = new Map(
    options.flatMap((option) =>
      option.short ? [[option.short, option] as const] : [],
    ),
  );
  const rawOptionValues = new Map<string, unknown>();
  const rawPositionals: string[] = [];
  let parsingPositionalsOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token) {
      continue;
    }

    if (!parsingPositionalsOnly && token === "--") {
      parsingPositionalsOnly = true;
      continue;
    }

    if (!parsingPositionalsOnly && token.startsWith("-")) {
      const parsedOption = parseOptionToken(token, longOptions, shortOptions);

      if (!parsedOption.option) {
        throw new CliUsageError(
          `unknown option for ${command.name}: ${token}`,
          formatCommandUsage(appName, command),
        );
      }

      if (rawOptionValues.has(parsedOption.option.key)) {
        throw new CliUsageError(
          `duplicate option for ${command.name}: ${parsedOption.option.long}`,
          formatCommandUsage(appName, command),
        );
      }

      if (parsedOption.option.kind === "flag") {
        rawOptionValues.set(parsedOption.option.key, true);
        continue;
      }

      const value = parsedOption.inlineValue ?? argv[index + 1];

      if (value === undefined) {
        throw new CliUsageError(
          `missing value for option ${parsedOption.option.long}`,
          formatCommandUsage(appName, command),
        );
      }

      if (parsedOption.inlineValue === undefined) {
        index += 1;
      }

      rawOptionValues.set(parsedOption.option.key, value);
      continue;
    }

    rawPositionals.push(token);
  }

  if (rawPositionals.length > positionals.length) {
    throw new CliUsageError(
      `unexpected argument for ${command.name}: ${rawPositionals[positionals.length]}`,
      formatCommandUsage(appName, command),
    );
  }

  return {
    options: validateOptions(appName, command, options, rawOptionValues),
    positionals: validatePositionals(
      appName,
      command,
      positionals,
      rawPositionals,
    ),
  };
}
