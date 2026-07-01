// Lightweight in-memory + console logger. Keeps a ring buffer of recent
// events so a future debug screen could surface them, without needing any
// external logging service (none would work offline/free anyway).

export type LogLevel = 'info' | 'warn' | 'error';
export type LogEntry = { level: LogLevel; tag: string; message: string; time: number };

const MAX_ENTRIES = 200;
let buffer: LogEntry[] = [];

function push(level: LogLevel, tag: string, message: string) {
  const entry: LogEntry = { level, tag, message, time: Date.now() };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${tag}] ${message}`);
}

export const logger = {
  info: (tag: string, message: string) => push('info', tag, message),
  warn: (tag: string, message: string) => push('warn', tag, message),
  error: (tag: string, message: string) => push('error', tag, message),
  getRecent: (n = 50) => buffer.slice(-n),
  clear: () => { buffer = []; },
};
