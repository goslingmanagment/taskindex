// One JSON line per event, `level` and `time` first. debug/info go to stdout,
// warn/error to stderr; entries below the configured level are dropped.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** @internal for tests */
export type LogFields = Record<string, unknown>;
export type Logger = {
  readonly level: LogLevel;
  debug: (fields: LogFields) => void;
  info: (fields: LogFields) => void;
  warn: (fields: LogFields) => void;
  error: (fields: LogFields) => void;
};
type LogSink = {
  out: (line: string) => void;
  err: (line: string) => void;
};
const order: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const stdio: LogSink = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};
export function createLogger(
  level: LogLevel = 'info',
  sink: LogSink = stdio,
): Logger {
  const write = (entry: LogLevel, fields: LogFields) => {
    if (order[entry] < order[level]) return;
    const line = JSON.stringify({
      level: entry,
      time: new Date().toISOString(),
      ...fields,
    });
    (entry === 'warn' || entry === 'error' ? sink.err : sink.out)(line);
  };
  return {
    level,
    debug: (fields) => write('debug', fields),
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
  };
}
// Diagnostic fields of a thrown value: message, stack, driver code and cause.
// Never the request body, headers, tokens or cookies.
export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error))
    return { message: String(error), stack: undefined };
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  return {
    error: error.name,
    message: error.message,
    stack: error.stack,
    ...(typeof code === 'string' ? { code } : {}),
    ...(cause instanceof Error
      ? { cause: `${cause.name}: ${cause.message}` }
      : cause === undefined
        ? {}
        : { cause: JSON.stringify(cause) }),
  };
}
