import type {
  CliAnyCommandDefinition,
  CliAppDefinition,
  CliOptionDefinition,
  CliPositionalDefinition,
  CompletionShell,
} from "@wiggler/lib/cli/types";

export function buildCompletionScript(
  appName: string,
  shell: CompletionShell,
): string {
  if (shell === "bash") {
    return `# ${appName} bash completion
_${appName}_completion() {
  local start_index=0

  if [[ "\${COMP_WORDS[0]}" == "${appName}" ]]; then
    start_index=1
  elif [[ "\${COMP_WORDS[1]}" == "run" && "\${COMP_WORDS[2]}" == "${appName}" ]]; then
    start_index=3
  elif [[ "\${COMP_WORDS[1]}" == "${appName}" ]]; then
    start_index=2
  else
    return 0
  fi

  local current_word
  current_word="\${COMP_WORDS[COMP_CWORD]}"
  local args=()
  local i

  for ((i = start_index; i < COMP_CWORD; i++)); do
    args+=("\${COMP_WORDS[i]}")
  done

  local suggestions
  suggestions=$(bun --silent ${appName} __complete "\${args[@]}" "$current_word")
  if [[ -z "$suggestions" ]]; then
    return 0
  fi
  COMPREPLY=($(compgen -W "$suggestions" -- "$current_word"))
  return 0
}

complete -o nosort -F _${appName}_completion bun
complete -o nosort -F _${appName}_completion ${appName}
`;
  }

  return `# ${appName} zsh completion
_${appName}_completion() {
  local -a args
  local -i start_index
  local -i i
  local current_word

  if [[ "$words[1]" == "${appName}" ]]; then
    start_index=2
  elif [[ "$words[2]" == "run" && "$words[3]" == "${appName}" ]]; then
    start_index=4
  elif [[ "$words[2]" == "${appName}" ]]; then
    start_index=3
  else
    return 0
  fi

  args=()
  for ((i = start_index; i < CURRENT; i++)); do
    args+=("$words[i]")
  done

  current_word="$words[CURRENT]"
  args+=("$current_word")

  local -a suggestions
  suggestions=("\${(@f)$(bun --silent ${appName} __complete "\${args[@]}")}")
  if (( \${#suggestions[@]} == 0 )); then
    return 0
  fi
  compadd -- $suggestions
  return 0
}

compdef _${appName}_completion bun
compdef _${appName}_completion ${appName}
`;
}

export function formatTopLevelUsage(appName: string): string {
  return `bun ${appName} <command>`;
}

export function formatCommandUsage(
  appName: string,
  command: CliAnyCommandDefinition,
): string {
  const segments = [`bun ${appName} ${command.name}`];

  for (const positional of command.positionals ?? []) {
    segments.push(formatPositionalUsage(positional));
  }

  for (const option of command.options ?? []) {
    segments.push(formatOptionUsage(option));
  }

  return segments.join(" ");
}

export function renderAppHelp(app: CliAppDefinition): string {
  const visibleCommands = [...app.commands]
    .filter((command) => !command.hidden)
    .sort((left, right) => left.name.localeCompare(right.name));
  const lines = [app.name];

  if (app.summary) {
    lines.push("", app.summary);
  }

  lines.push(
    "",
    "Usage:",
    `  ${formatTopLevelUsage(app.name)}`,
    `  bun ${app.name} help <command>`,
    "",
    "Commands:",
    ...visibleCommands.map(
      (command) => `  ${command.name.padEnd(22, " ")} ${command.summary}`,
    ),
    "",
    "Namespace Pattern:",
    "  Use <namespace>:<action> names such as market:current or audit:latest.",
    "",
    "Examples:",
    `  bun ${app.name} market:current --asset BTC`,
    `  bun ${app.name} help collect:start`,
    `  bun ${app.name} completion zsh`,
  );

  return lines.join("\n");
}

export function renderCommandHelp(
  appName: string,
  command: CliAnyCommandDefinition,
): string {
  const lines = [command.name, "", command.summary, "", command.description];

  lines.push("", "Usage:", `  ${formatCommandUsage(appName, command)}`);

  if ((command.positionals?.length ?? 0) > 0) {
    lines.push("", "Arguments:");
    for (const positional of command.positionals ?? []) {
      lines.push(
        `  ${formatPositionalLabel(positional).padEnd(20, " ")} ${formatInputDescription(positional)}`,
      );
    }
  }

  const optionLines = buildOptionHelpLines(command.options ?? []);
  if (optionLines.length > 0) {
    lines.push("", "Options:", ...optionLines);
  }

  if (command.output) {
    lines.push("", "Output:", `  ${command.output}`);
  }

  if (command.sideEffects) {
    lines.push("", "Side Effects:", `  ${command.sideEffects}`);
  }

  if ((command.examples?.length ?? 0) > 0) {
    lines.push(
      "",
      "Examples:",
      ...(command.examples ?? []).map((example) => `  ${example}`),
    );
  }

  return lines.join("\n");
}

function buildOptionHelpLines(
  options: readonly CliOptionDefinition[],
): readonly string[] {
  return options.map((option) => {
    const labels: string[] = [option.long];

    if (option.kind === "value") {
      labels[0] = `${option.long} ${option.valueName}`;
    }

    if (option.short) {
      labels.push(
        option.kind === "value"
          ? `${option.short} ${option.valueName}`
          : option.short,
      );
    }

    return `  ${labels.join(", ").padEnd(20, " ")} ${formatInputDescription(option)}`;
  });
}

function formatOptionUsage(option: CliOptionDefinition): string {
  const optionUsage =
    option.kind === "value"
      ? `${option.long} ${option.valueName}`
      : option.long;

  return isOptionalInput(option) ? `[${optionUsage}]` : optionUsage;
}

function formatPositionalUsage(positional: CliPositionalDefinition): string {
  return isOptionalInput(positional)
    ? `[${positional.valueName}]`
    : positional.valueName;
}

function formatPositionalLabel(positional: CliPositionalDefinition): string {
  return positional.valueName;
}

function formatInputDescription(
  input: CliOptionDefinition | CliPositionalDefinition,
): string {
  const details = [getInputDescription(input)];

  if (!isOptionalInput(input)) {
    details.push("Required.");
  }

  if ((input.choices?.length ?? 0) > 0) {
    details.push(`Choices: ${input.choices?.join(", ")}.`);
  }

  return details.join(" ");
}

function getInputDescription(
  input: CliOptionDefinition | CliPositionalDefinition,
): string {
  return (
    input.description ?? input.schema.description ?? "No description provided."
  );
}

function isOptionalInput(
  input: CliOptionDefinition | CliPositionalDefinition,
): boolean {
  return input.schema.safeParse(undefined).success;
}
