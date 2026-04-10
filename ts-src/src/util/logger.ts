const PREFIX = '[youdaonote]';

let verbose = process.env.YOUDAONOTE_VERBOSE === '1' || process.env.YOUDAONOTE_VERBOSE === 'true';

export function setVerbose(v: boolean): void {
  verbose = v;
}

export const logger = {
  info(...args: unknown[]): void {
    console.log(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
  debug(...args: unknown[]): void {
    if (verbose) console.log(PREFIX, '[debug]', ...args);
  },
};
