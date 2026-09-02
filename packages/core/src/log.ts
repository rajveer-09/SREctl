type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that stamps every line with the given fields. */
  child(fields: Record<string, unknown>): Logger;
}

function emit(min: Level, bound: Record<string, unknown>, level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < RANK[min]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...bound,
    ...fields,
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(min: Level = "info", bound: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit(min, bound, "debug", m, f),
    info: (m, f) => emit(min, bound, "info", m, f),
    warn: (m, f) => emit(min, bound, "warn", m, f),
    error: (m, f) => emit(min, bound, "error", m, f),
    child: (f) => createLogger(min, { ...bound, ...f }),
  };
}
