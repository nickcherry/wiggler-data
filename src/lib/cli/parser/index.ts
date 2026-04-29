export { getCompletionSuggestions } from "@wiggler/lib/cli/parser/completion";
export {
  analyzeCompletionContext,
  type CompletionContext,
  getAvailableOptionFlags,
} from "@wiggler/lib/cli/parser/context";
export { parseCommandArgv } from "@wiggler/lib/cli/parser/parsing";
export {
  filterAndSort,
  getInputLabel,
  parseOptionToken,
} from "@wiggler/lib/cli/parser/tokens";
export {
  CliUsageError,
  type ParsedCommandInput,
} from "@wiggler/lib/cli/parser/types";
export {
  validateOptions,
  validatePositionals,
} from "@wiggler/lib/cli/parser/validation";

export function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}
