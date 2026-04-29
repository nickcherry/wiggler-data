import { parseOptionToken } from "@wiggler/lib/cli/parser/tokens";
import type {
  CliAnyCommandDefinition,
  CliOptionDefinition,
} from "@wiggler/lib/cli/types";

export type CompletionContext =
  | {
      readonly kind: "option-value";
      readonly option: Extract<CliOptionDefinition, { kind: "value" }>;
      readonly positionalIndex: number;
      readonly usedOptionKeys: ReadonlySet<string>;
    }
  | {
      readonly kind: "normal";
      readonly positionalIndex: number;
      readonly usedOptionKeys: ReadonlySet<string>;
    };

/**
 * Analyzes a partial `argv` (everything before the cursor token) to determine
 * what the shell-completion system should suggest next. Returns an
 * `option-value` context when the last token is an option expecting a value
 * argument, or a `normal` context carrying the current positional index and
 * the set of option keys already provided. Used to drive context-sensitive
 * tab completion.
 */
export function analyzeCompletionContext(
  command: CliAnyCommandDefinition,
  argv: readonly string[],
): CompletionContext {
  const options = command.options ?? [];
  const longOptions = new Map(options.map((option) => [option.long, option]));
  const shortOptions = new Map(
    options.flatMap((option) =>
      option.short ? [[option.short, option] as const] : [],
    ),
  );
  const usedOptionKeys = new Set<string>();
  let positionalIndex = 0;
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
        continue;
      }

      usedOptionKeys.add(parsedOption.option.key);

      if (parsedOption.option.kind === "value") {
        if (parsedOption.inlineValue === undefined) {
          const nextToken = argv[index + 1];

          if (nextToken === undefined) {
            return {
              kind: "option-value",
              option: parsedOption.option,
              positionalIndex,
              usedOptionKeys,
            };
          }

          index += 1;
        }
      }

      continue;
    }

    positionalIndex += 1;
  }

  return { kind: "normal", positionalIndex, usedOptionKeys };
}

/**
 * Returns the option flags (long and short forms) that have not yet been used
 * in the current invocation. Always prepends `--help` and `-h` regardless of
 * whether the command defines them explicitly.
 */
export function getAvailableOptionFlags(
  command: CliAnyCommandDefinition,
  usedOptionKeys: ReadonlySet<string>,
): readonly string[] {
  const optionFlags = (command.options ?? [])
    .filter((option) => !usedOptionKeys.has(option.key))
    .flatMap((option) => [
      option.long,
      ...(option.short ? [option.short] : []),
    ]);

  return ["--help", "-h", ...optionFlags];
}
