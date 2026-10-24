import { createStore, delMany, keys, getMany, set, type UseStore } from 'idb-keyval';

/**
 * The debug log: lines kept on this device, to be exported for analysis. Warnings and errors are always kept;
 * with the debug log switched on (Settings), everything else too. Lines go to memory first and are written in
 * chunks (every few seconds, at once for an error, and when the page is hidden); past the limits the oldest
 * chunks go (rotation). Nothing leaves the device unless exported. Document text and keys are never logged.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

/** One write at most this big; past it, written at once. */
const CHUNK_CHARS = 16 * 1024;
/** Kept in all: the oldest chunks go past this. */
export const LOG_MAX_CHARS = 4 * 1024 * 1024;
const MAX_CHUNKS = 600;
/** A line longer than this is cut (a stack, a big object). */
const LINE_CHARS = 2000;
const FLUSH_MS = 3000;

let on = false;
let buffer: string[] = [];
let buffered = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let store: UseStore | null | undefined;
/** Chunks written (key → size), oldest first: known once read at the first write. */
let chunks: Map<string, number> | null = null;
let writing: Promise<void> = Promise.resolve();
/** This window's mark on its lines (several windows write to the one log). */
const tab = Math.random().toString(36).slice(2, 6);

function db(): UseStore | null {
  if (store !== undefined) return store;
  store = typeof indexedDB === 'undefined' ? null : createStore('tessel-log', 'chunks');
  return store;
}

/** Whether everything is logged (Settings → Debug log), or warnings and errors only. */
export function setLogging(enabled: boolean) {
  if (enabled === on) return;
  on = enabled;
  write('info', 'log', enabled ? 'debug log on' : 'debug log off');
}

export const logging = () => on;

/** Never logged: keys and passwords. */
const SECRET = /key|password|token|secret|authorization/i;
/** What people typed or what documents say (a note, a field, the words of a page): its size only. */
const TYPED = /^(contents|text|value|words|lines|body|query|q)$/i;
const typed = (x: unknown) => (typeof x === 'string' ? `(${x.length} chars)` : Array.isArray(x) ? `(${x.length} items)` : x === null ? 'null' : '(…)');

/** A short, safe picture of a value: sizes for bytes, cut strings, the shape of objects (never their contents in full). */
export function brief(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v.length > 80 ? JSON.stringify(`${v.slice(0, 80)}…`) : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'function') return 'fn';
  if (v instanceof ArrayBuffer) return `[${v.byteLength} B]`;
  if (ArrayBuffer.isView(v)) return `[${v.byteLength} B]`;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return `[blob ${v.size} B]`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (Array.isArray(v)) return depth > 1 ? `[${v.length}]` : `[${v.slice(0, 5).map((x) => brief(x, depth + 1)).join(', ')}${v.length > 5 ? `, …${v.length}` : ''}]`;
  if (typeof v === 'object') {
    if (depth > 1) return '{…}';
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{${entries
      .slice(0, 8)
      .map(([k, x]) => `${k}: ${SECRET.test(k) ? '•••' : TYPED.test(k) ? typed(x) : brief(x, depth + 1)}`)
      .join(', ')}${entries.length > 8 ? ', …' : ''}}`;
  }
  return typeof v;
}

function write(level: Level, scope: string, message: string, data?: unknown) {
  if (!on && (level === 'debug' || level === 'info')) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${tab} ${scope.padEnd(8)} ${message}${data === undefined ? '' : ` ${brief(data)}`}`;
  if (line.length > LINE_CHARS) line = `${line.slice(0, LINE_CHARS)}…`;
  buffer.push(line);
  buffered += line.length + 1;
  if (level === 'error' || buffered >= CHUNK_CHARS) void flush();
  else timer ??= setTimeout(() => void flush(), FLUSH_MS);
}

export const log = {
  debug: (scope: string, message: string, data?: unknown) => write('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) => write('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => write('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => write('error', scope, message, data),
};

/** Writes what is buffered; the oldest chunks go past the limits. */
export function flush(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (!buffer.length) return writing;
  const text = `${buffer.join('\n')}\n`;
  buffer = [];
  buffered = 0;
  writing = writing.then(async () => {
    const s = db();
    if (!s) return;
    try {
      if (!chunks) chunks = await known(s);
      // Sorted by time: the oldest first, whatever window wrote them.
      const key = `${Date.now().toString().padStart(14, '0')}-${tab}-${Math.random().toString(36).slice(2, 6)}`;
      await set(key, text, s);
      chunks.set(key, text.length);
      let total = [...chunks.values()].reduce((n, x) => n + x, 0);
      const gone: string[] = [];
      for (const [k, size] of chunks) {
        if (total <= LOG_MAX_CHARS && chunks.size - gone.length <= MAX_CHUNKS) break;
        gone.push(k);
        total -= size;
      }
      if (gone.length) {
        await delMany(gone, s);
        for (const k of gone) chunks.delete(k);
      }
    } catch {
      // Storage full or gone: the log is the last thing to stop the app.
    }
  });
  return writing;
}

async function known(s: UseStore): Promise<Map<string, number>> {
  const ks = ((await keys<string>(s)) as string[]).sort();
  const values = await getMany<string | undefined>(ks, s);
  return new Map(ks.map((k, i) => [k, values[i]?.length ?? 0]));
}

/** Everything kept, oldest first, as one text. */
export async function readLog(): Promise<string> {
  await flush();
  const s = db();
  if (!s) return '';
  const ks = ((await keys<string>(s)) as string[]).sort();
  return (await getMany<string | undefined>(ks, s)).filter(Boolean).join('');
}

/** How much is kept (characters, about bytes). */
export async function logSize(): Promise<number> {
  await flush();
  const s = db();
  if (!s) return 0;
  chunks ??= await known(s);
  return [...chunks.values()].reduce((n, x) => n + x, 0);
}

export async function clearLog(): Promise<void> {
  await flush();
  const s = db();
  if (!s) return;
  const ks = (await keys<string>(s)) as string[];
  await delMany(ks, s);
  chunks = new Map();
}

/**
 * Logs a call's start, end and time, or its failure, for each function of `obj` (the storage, the folders, the
 * engine): what was asked and how it went, with arguments in brief.
 */
export function traced<T extends object>(scope: string, obj: T): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      return (...args: unknown[]) => {
        const started = performance.now();
        const call = `${prop}(${args.map((a) => brief(a, 1)).join(', ')})`;
        let out: unknown;
        try {
          out = v.apply(target, args);
        } catch (e) {
          log.warn(scope, `${call} threw`, e);
          throw e;
        }
        if (out instanceof Promise)
          return out.then(
            (r) => (on && log.debug(scope, `${call} ${Math.round(performance.now() - started)} ms`, r === undefined ? undefined : brief(r, 1)), r),
            (e: unknown) => {
              log.warn(scope, `${call} failed after ${Math.round(performance.now() - started)} ms`, e);
              throw e;
            },
          );
        if (on) log.debug(scope, call);
        return out;
      };
    },
  });
}

let watching = false;

/** Uncaught errors, rejected promises, the console's warnings and errors, and the page hidden or shown. */
export function watchErrors(info: Record<string, unknown>) {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  log.info('app', 'start', info);
  window.addEventListener('error', (e) => log.error('uncaught', e.message, { at: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack }));
  window.addEventListener('unhandledrejection', (e) => log.error('rejected', String(e.reason?.message ?? e.reason), { stack: e.reason?.stack }));
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      write(level, 'console', args.map((a) => (typeof a === 'string' ? a : brief(a))).join(' '));
      original(...args);
    };
  }
  document.addEventListener('visibilitychange', () => {
    log.debug('app', document.visibilityState);
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => void flush());
}
