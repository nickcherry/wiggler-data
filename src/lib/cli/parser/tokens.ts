import type {
  CliOptionDefinition,
  CliPositionalDefinition,
} from "@wiggler/lib/cli/types";

/**
 * Parses a single CLI token into an option definition and optional inline value.
 * Handles both `--long=value` (splits on first `=`) and `-s` short forms.
 * Returns an empty object when the token does not match any known option.
 */
export function parseOptionToken(
  token: string,
  longOptions: ReadonlyMap<string, CliOptionDefinition>,
  shortOptions: ReadonlyMap<string, CliOptionDefinition>,
): {
  readonly option?: CliOptionDefinition;
  readonly inlineValue?: string;
} {
  if (token.startsWith("--")) {
    const [optionToken, inlineValue] = token.split("=", 2);

    return {
      option: optionToken ? longOptions.get(optionToken) : undefined,
      inlineValue,
    };
  }

  return { option: shortOptions.get(token) };
}

/**
 * Filters a list of completion candidates to those starting with `prefix`,
 * deduplicates, and sorts alphabetically. Used by the shell completion system
 * to narrow suggestions based on what the user has typed so far.
 */
export function filterAndSort(
  values: readonly string[],
  prefix: string,
): readonly string[] {
  return [...new Set(values)]
    .filter((value) => value.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Returns the human-readable label for a CLI input definition: the `long`
 * option name (e.g., `--output`) for options, or the `valueName` for
 * positional arguments.
 */
export function getInputLabel(
  input: CliOptionDefinition | CliPositionalDefinition,
): string {
  return "long" in input ? input.long : input.valueName;
}
