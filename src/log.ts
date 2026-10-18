/** Minimal leveled logger. Writes to stderr only so stdout/stdio transports stay clean. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel, write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Logger {
  const emit = (at: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[at] < ORDER[level]) return;
    const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
    write(`${new Date().toISOString()} ${at.toUpperCase()} ${message}${suffix}`);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
