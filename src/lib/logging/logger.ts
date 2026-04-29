import { env } from "@wiggler/constants/env";

type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentThreshold(): number {
  const raw = env.logLevel.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return levelOrder[raw];
  }
  return levelOrder.info;
}

function emit(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
  if (levelOrder[level] < currentThreshold()) {
    return;
  }
  const payload = {
    level,
    time: new Date().toISOString(),
    message,
    ...(fields ?? {}),
  };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(payload)}\n`);
}

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured logger used by long-running collectors and one-shot CLI tasks.
 */
export const logger = {
  debug(message: string, fields?: LogFields): void {
    emit("debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    emit("error", message, fields);
  },
  child(bound: LogFields): {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
  } {
    return {
      debug: (message, fields) => emit("debug", message, { ...bound, ...(fields ?? {}) }),
      info: (message, fields) => emit("info", message, { ...bound, ...(fields ?? {}) }),
      warn: (message, fields) => emit("warn", message, { ...bound, ...(fields ?? {}) }),
      error: (message, fields) => emit("error", message, { ...bound, ...(fields ?? {}) }),
    };
  },
};
