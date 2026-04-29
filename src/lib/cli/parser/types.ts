export class CliUsageError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export type ParsedCommandInput = {
  readonly options: Record<string, unknown>;
  readonly positionals: Record<string, unknown>;
};
