import {
  analyzeCompletionContext,
  getAvailableOptionFlags,
} from "@wiggler/lib/cli/parser/context";
import { filterAndSort } from "@wiggler/lib/cli/parser/tokens";
import type { CliAnyCommandDefinition } from "@wiggler/lib/cli/types";

/**
 * Generates shell tab-completion suggestions for the current `argv` state.
 * The last element of `argv` is the token being typed (may be empty); all
 * preceding tokens are treated as completed. When no command has been entered
 * yet, suggests visible command names. Once a command is identified, delegates
 * to `analyzeCompletionContext` to determine whether to suggest option values,
 * positional choices, or remaining option flags. Filters all candidates to
 * those matching the current token prefix and deduplicates before returning.
 */
export function getCompletionSuggestions(
  commands: readonly CliAnyCommandDefinition[],
  argv: readonly string[],
): readonly string[] {
  const visibleCommands = commands.filter((command) => !command.hidden);
  const currentToken = argv.at(-1) ?? "";
  const completedTokens =
    currentToken.length === 0 ? argv : argv.slice(0, argv.length - 1);

  if (completedTokens.length === 0) {
    return filterAndSort(
      visibleCommands.map((command) => command.name),
      currentToken,
    );
  }

  const commandName = completedTokens[0];
  const command = visibleCommands.find(
    (candidate) => candidate.name === commandName,
  );

  if (!command) {
    return filterAndSort(
      visibleCommands.map((candidate) => candidate.name),
      currentToken,
    );
  }

  const context = analyzeCompletionContext(command, completedTokens.slice(1));

  if (context.kind === "option-value") {
    return filterAndSort(context.option.choices ?? [], currentToken);
  }

  if (!currentToken.startsWith("-")) {
    const positional = (command.positionals ?? [])[context.positionalIndex];
    const choices = positional?.choices ?? [];

    return [
      ...filterAndSort(choices, currentToken),
      ...filterAndSort(
        getAvailableOptionFlags(command, context.usedOptionKeys),
        currentToken,
      ),
    ];
  }

  return filterAndSort(
    getAvailableOptionFlags(command, context.usedOptionKeys),
    currentToken,
  );
}
