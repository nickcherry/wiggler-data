import {
  CliUsageError,
  getCompletionSuggestions,
  isHelpFlag,
  parseCommandArgv,
} from "@wiggler/lib/cli/parser";
import {
  buildCompletionScript,
  formatTopLevelUsage,
  renderAppHelp,
  renderCommandHelp,
} from "@wiggler/lib/cli/render";
import type {
  CliAnyCommandDefinition,
  CliApp,
  CliAppDefinition,
  CliCommandDefinition,
  CliFlagOptionDefinition,
  CliIo,
  CliOptionDefinition,
  CliPositionalDefinition,
  CliValueOptionDefinition,
  CompletionShell,
} from "@wiggler/lib/cli/types";
import { z } from "zod";

const defaultIo: CliIo = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

class CliApplication implements CliApp {
  readonly #definition: CliAppDefinition;
  readonly #commands: readonly CliAnyCommandDefinition[];
  readonly #commandsByName: ReadonlyMap<string, CliAnyCommandDefinition>;

  constructor(definition: CliAppDefinition) {
    this.#definition = definition;
    this.#commands = createBuiltInCommands(definition, () => this).concat(
      definition.commands,
    );
    this.#commandsByName = new Map(
      this.#commands.map((command) => [command.name, command]),
    );

    validateCommands(this.#commands);
  }

  async run(argv: readonly string[], io: CliIo = defaultIo): Promise<void> {
    const commandName = argv[0];

    if (!commandName || isHelpFlag(commandName)) {
      io.writeStdout(`${renderAppHelp(this.#appDefinition)}\n`);
      return;
    }

    const command = this.#commandsByName.get(commandName);

    if (!command) {
      throw new CliUsageError(
        `unknown command: ${commandName}`,
        formatTopLevelUsage(this.#definition.name),
      );
    }

    const rawArgv = argv.slice(1);
    if (rawArgv.some(isHelpFlag)) {
      io.writeStdout(`${renderCommandHelp(this.#definition.name, command)}\n`);
      return;
    }

    if (command.name === "__complete") {
      await command.run({
        io,
        options: {},
        positionals: {},
        rawArgv,
      });
      return;
    }

    const parsed = parseCommandArgv(this.#definition.name, command, rawArgv);
    await command.run({
      io,
      options: parsed.options,
      positionals: parsed.positionals,
      rawArgv,
    });
  }

  async runWithErrorBoundary(
    argv: readonly string[],
    io: CliIo = defaultIo,
  ): Promise<void> {
    try {
      await this.run(argv, io);
    } catch (error: unknown) {
      if (error instanceof CliUsageError) {
        io.writeStderr(`error: ${error.message}\n`);
        if (error.usage) {
          io.writeStderr(`usage: ${error.usage}\n`);
        }
        process.exit(1);
      }

      io.writeStderr(`${String(error)}\n`);
      process.exit(1);
    }
  }

  get #appDefinition(): CliAppDefinition {
    return { ...this.#definition, commands: this.#commands };
  }

  renderAppHelp(): string {
    return renderAppHelp(this.#appDefinition);
  }

  renderCommandHelp(commandName: string): string {
    const command = this.#commandsByName.get(commandName);

    if (!command) {
      throw new CliUsageError(
        `unknown command: ${commandName}`,
        formatTopLevelUsage(this.#definition.name),
      );
    }

    return renderCommandHelp(this.#definition.name, command);
  }

  renderCompletionScript(shell: CompletionShell): string {
    return buildCompletionScript(this.#definition.name, shell);
  }

  getCompletionSuggestions(words: readonly string[]): readonly string[] {
    return getCompletionSuggestions(this.#commands, words);
  }
}

export function createCli(definition: CliAppDefinition): CliApp {
  return new CliApplication(definition);
}

export function defineCommand<
  const TOptions extends readonly CliOptionDefinition[],
  const TPositionals extends readonly CliPositionalDefinition[],
>(
  command: CliCommandDefinition<TOptions, TPositionals>,
): CliCommandDefinition<TOptions, TPositionals> {
  return command;
}

export function defineFlagOption<
  const TKey extends string,
  TSchema extends z.ZodTypeAny,
>(
  option: Omit<CliFlagOptionDefinition<TKey, TSchema>, "kind">,
): CliFlagOptionDefinition<TKey, TSchema> {
  return { ...option, kind: "flag" };
}

export function defineValueOption<
  const TKey extends string,
  TSchema extends z.ZodTypeAny,
>(
  option: Omit<CliValueOptionDefinition<TKey, TSchema>, "kind">,
): CliValueOptionDefinition<TKey, TSchema> {
  return { ...option, kind: "value" };
}

export function definePositional<
  const TKey extends string,
  TSchema extends z.ZodTypeAny,
>(
  positional: CliPositionalDefinition<TKey, TSchema>,
): CliPositionalDefinition<TKey, TSchema> {
  return positional;
}

function createBuiltInCommands(
  definition: CliAppDefinition,
  getApp: () => CliApplication,
): readonly CliAnyCommandDefinition[] {
  return [
    defineCommand({
      name: "help",
      summary: "Show CLI help",
      description:
        "Print top-level help or detailed help for a specific command without running the command.",
      positionals: [
        definePositional({
          key: "commandName",
          valueName: "COMMAND",
          schema: z.string().optional().describe("Command name to inspect."),
        }),
      ],
      examples: [
        `bun ${definition.name} help`,
        `bun ${definition.name} help candles:sync`,
      ],
      output: "Prints CLI help text to stdout.",
      sideEffects: "None.",
      async run({ io, positionals }) {
        const app = getApp();
        const commandName = positionals.commandName;

        if (typeof commandName === "string" && commandName.length > 0) {
          io.writeStdout(`${app.renderCommandHelp(commandName)}\n`);
          return;
        }

        io.writeStdout(`${app.renderAppHelp()}\n`);
      },
    }),
    defineCommand({
      name: "completion",
      summary: "Print a shell completion script",
      description:
        "Generate a shell completion script for the Samos CLI. The script supports both `bun samos ...` and `bun run samos ...` invocation styles.",
      positionals: [
        definePositional({
          key: "shell",
          valueName: "SHELL",
          choices: ["bash", "zsh"],
          schema: z
            .enum(["bash", "zsh"])
            .describe("Shell to generate completion for."),
        }),
      ],
      examples: [
        `bun ${definition.name} completion zsh >> ~/.zshrc`,
        `bun ${definition.name} completion bash`,
      ],
      output: "Prints a shell completion script to stdout.",
      sideEffects: "None.",
      async run({ io, positionals }) {
        io.writeStdout(
          getApp().renderCompletionScript(positionals.shell),
        );
      },
    }),
    defineCommand({
      name: "__complete",
      summary: "Internal completion entrypoint",
      description: "Internal command used by shell completion.",
      hidden: true,
      output: "Prints completion suggestions, one per line.",
      sideEffects: "None.",
      async run({ io, rawArgv }) {
        const suggestions = getApp().getCompletionSuggestions(rawArgv);

        if (suggestions.length > 0) {
          io.writeStdout(`${suggestions.join("\n")}\n`);
        }
      },
    }),
  ];
}

function validateCommands(commands: readonly CliAnyCommandDefinition[]): void {
  const names = new Set<string>();

  for (const command of commands) {
    if (names.has(command.name)) {
      throw new Error(`duplicate CLI command definition: ${command.name}`);
    }

    names.add(command.name);
    validateCommandOptions(command);
  }
}

function validateCommandOptions(command: CliAnyCommandDefinition): void {
  const reservedFlags = new Set(["--help", "-h"]);
  const seenFlags = new Set<string>();
  const seenKeys = new Set<string>();

  for (const option of command.options ?? []) {
    if (seenKeys.has(option.key)) {
      throw new Error(`duplicate option key in ${command.name}: ${option.key}`);
    }

    seenKeys.add(option.key);

    for (const flag of [option.long, ...(option.short ? [option.short] : [])]) {
      if (reservedFlags.has(flag)) {
        throw new Error(`reserved CLI flag used in ${command.name}: ${flag}`);
      }

      if (seenFlags.has(flag)) {
        throw new Error(`duplicate option flag in ${command.name}: ${flag}`);
      }

      seenFlags.add(flag);
    }
  }
}
