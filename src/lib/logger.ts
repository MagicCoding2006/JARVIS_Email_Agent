/** Minimal structured logger — no dependency, JSON-ish console output. */

type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function emit(level: Level, scope: string, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const color = COLORS[level];
  const head = `${color}${ts} ${level.toUpperCase().padEnd(5)} [${scope}]${RESET}`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`${head} ${msg}`, meta);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${head} ${msg}`);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, meta?: unknown) => emit("debug", scope, msg, meta),
    info: (msg: string, meta?: unknown) => emit("info", scope, msg, meta),
    warn: (msg: string, meta?: unknown) => emit("warn", scope, msg, meta),
    error: (msg: string, meta?: unknown) => emit("error", scope, msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
