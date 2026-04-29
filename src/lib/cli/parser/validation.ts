import { getInputLabel } from "@wiggler/lib/cli/parser/tokens";
import { CliUsageError } from "@wiggler/lib/cli/parser/types";
import { formatCommandUsage } from "@wiggler/lib/cli/render";
import type {
  CliAnyCommandDefinition,
  CliOptionDefinition,
  CliPositionalDefinition,
} from "@wiggler/lib/cli/types";
import { ZodError } from "zod";

/**
 * Validates and coerces all option values for a parsed command, returning a
 * plain object keyed by `option.key`. Throws `CliUsageError` when a required
 * option is missing or when the Zod schema rejects the raw value.
 */
export function validateOptions(
  appName: string,
  command: CliAnyCommandDefinition,
  options: readonly CliOptionDefinition[],
  rawOptionValues: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    options.map((option) => [
      option.key,
      validateInputValue({
        appName,
        command,
        input: option,
        rawValue: rawOptionValues.get(option.key),
        missingMessage: `missing required option ${option.long}`,
      }),
    ]),
  );
}

/**
 * Validates and coerces all positional argument values for a parsed command,
 * returning a plain object keyed by `positional.key`. Throws `CliUsageError`
 * when a required positional is missing or the schema rejects the raw value.
 */
export function validatePositionals(
  appName: string,
  command: CliAnyCommandDefinition,
  positionals: readonly CliPositionalDefinition[],
  rawPositionals: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    positionals.map((positional, index) => [
      positional.key,
      validateInputValue({
        appName,
        command,
        input: positional,
        rawValue: rawPositionals[index],
        missingMessage: `missing required argument ${positional.valueName}`,
      }),
    ]),
  );
}

function validateInputValue({
  appName,
  command,
  input,
  rawValue,
  missingMessage,
}: {
  appName: string;
  command: CliAnyCommandDefinition;
  input: CliOptionDefinition | CliPositionalDefinition;
  rawValue: unknown;
  missingMessage: string;
}): unknown {
  if (rawValue === undefined && !input.schema.safeParse(undefined).success) {
    throw new CliUsageError(
      missingMessage,
      formatCommandUsage(appName, command),
    );
  }

  try {
    return input.schema.parse(rawValue);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new CliUsageError(
        `${getInputLabel(input)} is invalid: ${error.issues[0]?.message ?? "invalid value"}`,
        formatCommandUsage(appName, command),
      );
    }

    throw error;
  }
}
