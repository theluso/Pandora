const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const paint = {
  debug: (s) => `\x1b[90m${s}\x1b[0m`,
  info: (s) => `\x1b[36m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  error: (s) => `\x1b[31m${s}\x1b[0m`,
};

function emit(level, scope, message, extra) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  const head = `${paint[level](level.toUpperCase().padEnd(5))} \x1b[90m${time}\x1b[0m [${scope}]`;
  if (extra !== undefined) console.log(head, message, extra);
  else console.log(head, message);
}

export function logger(scope) {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}
