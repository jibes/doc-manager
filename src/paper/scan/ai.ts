import { desktop } from '@/core/lib/desktop';
import { log } from '@/core/lib/log';
import type { Lang } from '@/core/i18n';
import { findDate } from '@/paper/archive/rules';
import { MAX_TAGS_SENT, nameKey, snapName, snapTags, type Vocabulary } from '@/paper/archive/vocabulary';
import { shell, shellRequest } from '@/core/lib/shell';
import { readStored, writeStored } from '@/core/lib/stored';
import type { PdfWord } from './engine/pdf/writer';

/**
 * Reading a scan with an AI model the user chose: the page images and the words read on the device go to the
 * address in Settings; back come corrected lines, text the device missed (handwriting), and what the document
 * is (title, date, sender, type). Off unless set up and switched on for a scan.
 */

/** Anthropic's Messages API, or the Chat Completions API that OpenAI and many others (Ollama, LM Studio, vLLM) speak. */
export type AiApi = 'anthropic' | 'openai';

export type AiSettings = {
  api: AiApi;
  /** Base URL, e.g. https://api.anthropic.com or https://api.openai.com/v1. */
  url: string;
  key: string;
  model: string;
  /** Let the model think before it answers (slower; reading pages rarely needs it). Off unless switched on. */
  thinking?: boolean;
};

export const DEFAULT_AI: AiSettings = { api: 'anthropic', url: '', key: '', model: '' };

/** Names only a home network knows (a router's or a NAS's): as the Android app treats them. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home.arpa', '.internal', '.fritz.box'];

/** This device, the local network (private and link-local addresses) or a local name (one word, .local, .lan, …). */
export function localHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || LOCAL_SUFFIXES.some((s) => h.endsWith(s)) || (!h.includes('.') && !h.includes(':'))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** A whole web address, but over http to somewhere beyond this device and network: the key would go unencrypted. */
function parsed(s: AiSettings): URL | null {
  try {
    const url = new URL(s.url.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host ? url : null;
  } catch {
    return null;
  }
}
export const aiInsecure = (s: AiSettings) => {
  const url = parsed(s);
  return !!url && url.protocol === 'http:' && !localHost(url.hostname);
};

/**
 * The address, when it is a whole web address (https, or http to this device or the local network). Anything else
 * would be taken as a path on the app's own site (the key and the pages would go there), or send them in the clear.
 */
export function aiUrl(s: AiSettings): URL | null {
  const url = parsed(s);
  return url && !aiInsecure(s) ? url : null;
}

export const aiReady = (s: AiSettings) => !!aiUrl(s) && !!s.model.trim();

/** The host pages are sent to, for the note on the switch. */
export const aiHost = (s: AiSettings) => aiUrl(s)?.host ?? s.url.trim();

/** What went wrong, as codes (put in words by aiMessage in i18n). */
export const AI_DECLINED = 'ai:declined';
export const AI_CUT_OFF = 'ai:cut-off';
export const AI_NO_JSON = 'ai:no-json';
export const AI_BAD_URL = 'ai:bad-url';
/** Plain http to an address beyond this device and network. */
export const AI_INSECURE = 'ai:insecure';
/** "ai:unreachable:<host>": no answer at all (offline, wrong address, or a browser rule against the request). */
export const AI_UNREACHABLE = 'ai:unreachable';
export const AI_REDIRECT = 'ai:redirect';
/** The address answered, but not as an AI API does (a login page, a proxy's error page). */
export const AI_NOT_API = 'ai:not-api';
/** "ai:server <status> <what it said>". */
export const AI_SERVER = 'ai:server';

/** A page as sent: its image (upright, as exported) and its lines as read on the device. */
export type AiPage = { jpeg: Blob; lines: { id: string; text: string }[] };

export type AiLine = { id: string; text: string };
/** Text the device missed, with its box in thousandths of the page's width and height. */
export type AiAdded = { text: string; box: number[] };
export type AiResult = {
  title: string;
  /** YYYY-MM-DD, or empty. */
  date: string;
  sender: string;
  type: string;
  keywords: string[];
  pages: { lines: AiLine[]; added: AiAdded[] }[];
};

const strings = { type: 'array', items: { type: 'string' } } as const;
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

/** Every field required and no others: the strict form both APIs accept for structured output. */
export const RESULT_SCHEMA = object({
  title: { type: 'string', description: 'Short and specific, in the document’s language, e.g. "Rechnung 40217"' },
  date: { type: 'string', description: 'The document’s own date as YYYY-MM-DD, e.g. "2026-10-02" for 2 October 2026 (whatever form the document writes it in), or "" if it has none' },
  sender: { type: 'string', description: 'Who issued it (organisation or person), or ""' },
  type: { type: 'string', description: 'What kind of document it is (invoice, receipt, letter, contract, …), in the language asked for' },
  keywords: { ...strings, description: 'Up to three topics to find it by, in the language asked for' },
  pages: {
    type: 'array',
    items: object({
      page: { type: 'integer', description: 'The page’s number, from 1' },
      lines: { type: 'array', items: object({ id: { type: 'string' }, text: { type: 'string' } }) },
      added: { type: 'array', items: object({ text: { type: 'string' }, box: { type: 'array', items: { type: 'number' } } }) },
    }),
  },
});

/** A short example of the reply a schema describes, for a request without structured output (the prompt says it). */
export function shapeOf(schema: object): string {
  type Node = { type?: string; description?: string; properties?: Record<string, Node>; items?: Node };
  const example = (n: Node): unknown => {
    if (n.type === 'object') return Object.fromEntries(Object.entries(n.properties ?? {}).map(([k, v]) => [k, example(v)]));
    if (n.type === 'array') return n.items ? [example(n.items)] : [];
    if (n.type === 'integer' || n.type === 'number') return 1;
    return n.description ?? '';
  };
  return `Reply with one JSON object of this shape:\n${JSON.stringify(example(schema as Node))}`;
}

export function prompt(pages: AiPage[]): string {
  const listed = pages.map((p, i) => `Page ${i + 1}:\n${p.lines.map((l) => `${l.id}\t${l.text}`).join('\n') || '(no text found)'}`).join('\n\n');
  return [
    `The images are the ${pages.length === 1 ? 'page' : `${pages.length} pages`} of one scanned document, in order. Below are the lines a small on-device text recogniser read on each page, each with an id.`,
    '',
    '1. For every line, give its text exactly as it appears on the page: fix misread letters, umlauts and accents, missing or extra spaces. Keep the line’s id. Give "" for a line that is not text (a logo, a stamp, noise), or that repeats another line where the page doesn’t show it again.',
    '2. Under "added", give only text the recogniser missed entirely, such as handwriting (not lines it already read), one entry per line of text, with its box as [x0, y0, x1, y1] in thousandths of the page’s width and height (0,0 is the top left).',
    '3. Describe the document: title, date, sender, type and keywords.',
    'Give one entry in "pages" per page, in order, each with its page number (from 1), also for a page with nothing on it. Reply with the JSON object only.',
    '',
    listed,
  ].join('\n');
}

const base64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Balanced `{…}` spans at the top level of a text, in order (braces inside JSON strings don't count). */
function* objects(text: string): Generator<[number, number]> {
  for (let start = text.indexOf('{'); start >= 0; ) {
    let depth = 0;
    let quoted = false;
    let end = -1;
    for (let i = start; i < text.length && end < 0; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) end = i;
    }
    // An unclosed brace in prose ("use {x") mustn't hide the object after it.
    if (end < 0) start = text.indexOf('{', start + 1);
    else {
      yield [start, end + 1];
      start = text.indexOf('{', end + 1);
    }
  }
}

/** The first top-level object in a reply that parses and `fits` (thinking and notes around it left out). */
function replyObject(text: string, fits: (v: object) => boolean): object | undefined {
  return replyObjects(text).find(fits);
}

/** Every top-level object in a reply that parses (the items of a bare array too), thinking left out. */
function replyObjects(text: string): object[] {
  const paired = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Thinking whose opening tag was the prompt's (some served models): what comes after it is the reply.
  const close = paired.toLowerCase().lastIndexOf('</think>');
  const reply = close < 0 ? paired : paired.slice(close + '</think>'.length);
  const out: object[] = [];
  for (const [a, b] of objects(reply)) {
    try {
      const v = JSON.parse(reply.slice(a, b)) as unknown;
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // Not JSON (a note in braces): try the next one.
    }
  }
  return out;
}

/**
 * The reply's JSON object. A model without structured output may wrap it in prose or a code fence, think aloud
 * first (`<think>…</think>`, which may quote the schema) or add a note with braces after it: the first top-level
 * object that parses and looks like a result.
 */
export function parseResult(text: string, pageCount: number): AiResult {
  const raw = replyObject(text, (v) => 'pages' in v || 'title' in v) as Partial<AiResult> | undefined;
  if (!raw) throw new Error(AI_NO_JSON);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  type Entry = Partial<AiResult['pages'][number]> & { page?: unknown };
  const entries = (Array.isArray(raw.pages) ? raw.pages : []) as Entry[];
  if (pageCount > 0 && !Array.isArray(raw.pages)) throw new Error(AI_NO_JSON);
  // Which page an entry is: the page its lines' ids name ("3.2" is on page 3), else its number, else its place
  // in the list. A model that leaves a blank page out mustn't shift the next page's handwriting onto it; one that
  // counts pages from 0 (the ids still say which) mustn't drop the last page's corrections.
  const fromZero = entries.some((e) => Number(e?.page) === 0);
  const pageOf = (e: Entry, i: number) => {
    const named = [...new Set((e?.lines ?? []).map((l) => Number(String(l?.id ?? '').split('.')[0])).filter(Number.isInteger))];
    if (named.length === 1 && named[0] >= 1 && named[0] <= pageCount) return named[0] - 1;
    const n = Number(e?.page) + (fromZero ? 1 : 0);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) return n - 1;
    return i;
  };
  const byPage = new Map<number, Entry>();
  entries.forEach((e, i) => {
    const at = pageOf(e, i);
    if (!byPage.has(at)) byPage.set(at, e);
  });
  return {
    title: str(raw.title),
    // Asked for as YYYY-MM-DD; a model writing it otherwise ("02.10.2026", with a time) still gives the date.
    date: findDate(str(raw.date)),
    sender: str(raw.sender),
    type: str(raw.type),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(str).filter(Boolean).slice(0, 5) : [],
    pages: Array.from({ length: pageCount }, (_, i) => ({
      lines: (byPage.get(i)?.lines ?? []).filter((l) => typeof l?.id === 'string' && typeof l?.text === 'string'),
      added: (byPage.get(i)?.added ?? []).filter((a) => str(a?.text) && Array.isArray(a?.box) && a.box.length === 4 && a.box.every(Number.isFinite)),
    })),
  };
}

/**
 * fetch, or in the Android app a request made by the app itself: the WebView's page is served from the app's
 * own host, which an address's CORS rules (set up for the web app's address, or for none) don't allow.
 */
async function post(url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<Response> {
  // Logged: where, how much and how it went (not the key, not the pages).
  const started = performance.now();
  const where = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return 'bad address';
    }
  })();
  log.info('ai', `POST ${where} ${init.body.length} chars`);
  try {
    const r = await request(url, init);
    log[r.ok ? 'info' : 'warn']('ai', `${where} → ${r.status} in ${Math.round(performance.now() - started)} ms`);
    return r;
  } catch (e) {
    log.warn('ai', `${where} failed after ${Math.round(performance.now() - started)} ms`, e);
    throw e;
  }
}

/** A redirect isn't followed (it could take the key and the pages elsewhere): said as such, on every platform. */
async function request(url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<Response> {
  const r = await requestOnce(url, init);
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new Error(AI_REDIRECT);
  return r;
}

async function requestOnce(url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<Response> {
  // The desktop app makes the request itself: an address's cross-origin rules don't know the app's origin.
  if (desktop) {
    init.signal?.throwIfAborted();
    const r = await desktop
      .http({ url, method: 'POST', headers: init.headers, body: init.body }, (abort) => init.signal?.addEventListener('abort', abort, { once: true }))
      .catch((e: unknown) => {
        if (init.signal?.aborted) throw init.signal.reason;
        throw new Error(`${AI_UNREACHABLE}:${new URL(url).host}`, { cause: e });
      });
    return new Response(r.body, { status: r.status });
  }
  if (!shell)
    return fetch(url, { method: 'POST', ...init, redirect: 'manual' }).catch((e: unknown) => {
      // No answer at all (offline, a wrong address, or the browser's rules against the request): said as such.
      if (e instanceof TypeError) throw new Error(`${AI_UNREACHABLE}:${new URL(url).host}`);
      throw e;
    });
  // Stopped, the app closes the connection too (no upload goes on unseen).
  const r = await shellRequest<{ status: number; body: string }>('http', { url, method: 'POST', headers: init.headers, body: init.body }, init.signal);
  return new Response(r.body, { status: r.status });
}


/** The data of each server-sent event ("data: …" lines), or null when the reply isn't a stream. */
function events(raw: string): unknown[] | null {
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!lines.length) return null;
  return lines
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== '[DONE]')
    .map((d) => {
      try {
        return JSON.parse(d) as unknown;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The text of an Anthropic reply, streamed (as asked) or whole (a server that doesn't stream). */
export function anthropicReply(raw: string): string {
  type Event = { type: string; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { message?: string } };
  // Declined, or cut off at the length limit (the JSON would be broken).
  const stopped = (reason?: string) => {
    if (reason === 'refusal') throw new Error(AI_DECLINED);
    if (reason === 'max_tokens') throw new Error(AI_CUT_OFF);
  };
  const stream = events(raw) as Event[] | null;
  if (!stream) {
    const message = JSON.parse(raw) as { content?: { type: string; text?: string }[]; stop_reason?: string };
    stopped(message.stop_reason);
    return (message.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  }
  let text = '';
  for (const e of stream) {
    if (e.type === 'error') throw new Error(e.error?.message ?? AI_SERVER);
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text += e.delta.text ?? '';
    if (e.type === 'message_delta') stopped(e.delta?.stop_reason);
  }
  return text;
}

/** The text of a Chat Completions reply, streamed or whole. */
export function openAiReply(raw: string): string {
  type Choice = {
    delta?: { content?: string | null; refusal?: string | null };
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  };
  const stream = events(raw) as { choices?: Choice[]; error?: { message?: string } }[] | null;
  if (!stream) {
    const whole = JSON.parse(raw) as { choices?: Choice[]; error?: { message?: string } };
    // Some servers answer 200 with only an error.
    if (whole.error) throw new Error(whole.error.message ?? AI_SERVER);
    const choice = whole.choices?.[0];
    if (choice?.message?.refusal) throw new Error(AI_DECLINED);
    if (choice?.finish_reason === 'length') throw new Error(AI_CUT_OFF);
    return choice?.message?.content ?? '';
  }
  let text = '';
  for (const e of stream) {
    if (e.error) throw new Error(e.error.message ?? AI_SERVER);
    const choice = e.choices?.[0];
    if (choice?.delta?.refusal) throw new Error(AI_DECLINED);
    if (choice?.finish_reason === 'length') throw new Error(AI_CUT_OFF);
    text += choice?.delta?.content ?? '';
  }
  return text;
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * A rejection worth another try without the structured output: the server names that part of the request (an
 * image it can't take, or a bad key or model, says nothing of these). As a status, or as an error in a reply
 * that started fine ("does not support JSON schema mode", sent in the stream).
 */
const FORMAT_REJECTED = /output_config|response_format|json[ _]schema|json[ _]object|json mode|structured[ _]outputs?|guided_(?:json|grammar)|\bgrammar\b/i;
/** Rejected for its output format, however the server said it. */
const formatRejected = (e: unknown) => e instanceof Error && FORMAT_REJECTED.test(e.message);

/** The output format each address and model took last time (index into the formats tried): later requests start there. */
const formatsTaken = new Map<string, number>();
const formatTaken = {
  // Kept on this device too: a model that rejects the schema only once its reply has started costs a request each time otherwise.
  get: (key: string) => {
    if (formatsTaken.has(key)) return formatsTaken.get(key);
    const n = Number(readStored(`ai-format:${key}`) ?? NaN);
    return Number.isInteger(n) ? n : undefined;
  },
  set: (key: string, n: number) => {
    formatsTaken.set(key, n);
    writeStored(`ai-format:${key}`, String(n));
  },
};
const modelKey = (s: AiSettings) => `${s.api}|${trimSlash(s.url)}|${s.model.trim()}`;
/**
 * Thinking, asked for by each API's own word for it (there is no common one). Off: every way servers know of to
 * turn it off (OpenAI's reasoning_effort, DeepSeek's, GLM's and Kimi's thinking, vLLM's and Qwen's switches); on:
 * the model's own default, or Anthropic's adaptive thinking. A server that rejects one (by its name) is asked
 * again without it, or with its next value; what each model took is kept on this device.
 */
type Hint = { key: string; values: unknown[] };
const OFF_HINTS: Hint[] = [
  { key: 'reasoning_effort', values: ['none', 'minimal'] },
  { key: 'thinking', values: [{ type: 'disabled' }] },
  { key: 'chat_template_kwargs', values: [{ enable_thinking: false, thinking: false }] },
  { key: 'enable_thinking', values: [false] },
];
const thinkingHints = (s: AiSettings): Hint[] =>
  s.api === 'anthropic' ? [{ key: 'thinking', values: [s.thinking ? { type: 'adaptive' } : { type: 'disabled' }] }] : s.thinking ? [] : OFF_HINTS;

const hintsTaken = new Map<string, Record<string, number>>();
/** Which value of each hint a model takes (past the last: none), for this address, model and choice. */
class Hints {
  private readonly hints: Hint[];
  private readonly stored: string;
  private taken: Record<string, number>;
  constructor(s: AiSettings) {
    this.hints = thinkingHints(s);
    this.stored = `ai-hints:${modelKey(s)}|${s.thinking ? 'on' : 'off'}`;
    let kept: Record<string, number> = {};
    try {
      kept = JSON.parse(readStored(this.stored) ?? '{}') as Record<string, number>;
    } catch {
      // Asked as at first.
    }
    this.taken = hintsTaken.get(this.stored) ?? kept;
  }
  private live = () => this.hints.filter((h) => (this.taken[h.key] ?? 0) < h.values.length);
  /** The fields to add to the request. */
  body = () => Object.fromEntries(this.live().map((h) => [h.key, h.values[this.taken[h.key] ?? 0]]));
  /** A rejection that names one of them: the next value (or none) next time. Longer names first (reasoning_effort). */
  rejected(said: string): boolean {
    const text = said.toLowerCase();
    const hit = this.live()
      .sort((a, b) => b.key.length - a.key.length)
      .find((h) => text.includes(h.key));
    if (!hit) return false;
    this.taken = { ...this.taken, [hit.key]: (this.taken[hit.key] ?? 0) + 1 };
    hintsTaken.set(this.stored, this.taken);
    writeStored(this.stored, JSON.stringify(this.taken));
    return true;
  }
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : '');

/** A rejected output length: the model's own maximum, when the server says it. */
const LENGTH_REJECTED = /max_tokens/i;
/** Room for thinking and every line of every page given back (a stream allows this much); less where a model allows less. */
const MAX_TOKENS = [64_000, 32_000, 16_000];

/** A reply read as the API's own, or (a page that isn't one: a login or error page) said so. */
const asReply = (read: () => string) => {
  try {
    return read();
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(AI_NOT_API);
    throw e;
  }
};

/**
 * Anthropic's Messages API over fetch. (The official SDK can't initialise in this app's web bundle: Metro trips
 * over a circular import in it.) Browsers may call it directly with the header below; the key is the user's own.
 */
/** A request: images (JPEG), the instructions, and the JSON schema the reply should follow. */
type Request = { images: Blob[]; text: string; schema: object };
const withShape = (req: Request) => `${req.text}\n\n${shapeOf(req.schema)}`;

/** What a rejection said: an error body's own message ({"error": {"message": …}}, {"detail": …}), else its start. */
export function serverSaid(said: string): string {
  try {
    const body = JSON.parse(said) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? body.detail);
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // Not JSON: a page or plain text.
  }
  return said.slice(0, 200);
}

async function viaAnthropic(s: AiSettings, req: Request, signal?: AbortSignal): Promise<string> {
  const images = await Promise.all(req.images.map(async (jpeg) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await base64(jpeg) } })));
  const body = (structured: boolean, maxTokens: number) =>
    JSON.stringify({
      model: s.model.trim(),
      max_tokens: maxTokens,
      // Streamed: the reply starts at once, so a proxy on the way (Cloudflare gives up after ~100 s without a
      // byte) doesn't cut off a long reading. The whole stream is read before it is used.
      stream: true,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: structured ? req.text : withShape(req) }] }],
      ...(structured ? { output_config: { format: { type: 'json_schema', schema: req.schema } } } : {}),
      ...hints.body(),
    });
  let last = '';
  // A model or server without structured output gets the request again without it (the prompt asks for JSON
  // anyway); one that allows a shorter reply, again with that length.
  let structured = formatTaken.get(modelKey(s)) !== 1;
  let length = 0;
  const hints = new Hints(s);
  for (let tries = 0; tries < 6; tries++) {
    // With or without the /v1 that OpenAI-style addresses carry.
    const res = await post(`${trimSlash(s.url).replace(/\/v1$/, '')}/v1/messages`, {
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(s.key ? { 'x-api-key': s.key } : {}),
      },
      body: body(structured, MAX_TOKENS[length]),
      signal,
    });
    if (res.ok) {
      const raw = await res.text();
      try {
        const text = asReply(() => anthropicReply(raw));
        formatTaken.set(modelKey(s), structured ? 0 : 1);
        return text;
      } catch (e) {
        if (hints.rejected(errorText(e))) continue;
        if (!structured || !formatRejected(e)) throw e;
        structured = false;
        continue;
      }
    }
    const said = await res.text().catch(() => '');
    last = `${res.status} ${serverSaid(said)}`;
    if (res.status !== 400) break;
    if (hints.rejected(said)) continue;
    if (LENGTH_REJECTED.test(said) && length < MAX_TOKENS.length - 1) length++;
    else if (FORMAT_REJECTED.test(said) && structured) structured = false;
    else break;
  }
  throw new Error(`${AI_SERVER} ${last}`);
}

async function viaOpenAi(s: AiSettings, req: Request, signal?: AbortSignal): Promise<string> {
  const images = await Promise.all(req.images.map(async (jpeg) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await base64(jpeg)}` } })));
  const body = (format: unknown) =>
    JSON.stringify({
      model: s.model.trim(),
      // Plain JSON or none: the schema isn't sent, so the prompt gives the shape.
      messages: [{ role: 'user', content: [...images, { type: 'text', text: format === formats[0] ? req.text : withShape(req) }] }],
      stream: true,
      ...(format ? { response_format: format } : {}),
      ...hints.body(),
    });
  // The schema itself where the model takes it; else plain JSON (the prompt describes it); else no format at all.
  const formats = [{ type: 'json_schema', json_schema: { name: 'document', strict: true, schema: req.schema } }, { type: 'json_object' }, null];
  let last = '';
  const hints = new Hints(s);
  // Each try changes one thing: the output format, or a thinking hint the server doesn't know.
  for (let i = formatTaken.get(modelKey(s)) ?? 0, tries = 0; i < formats.length && tries < formats.length + OFF_HINTS.length + 2; i++, tries++) {
    const res = await post(`${trimSlash(s.url)}/chat/completions`, {
      headers: { 'content-type': 'application/json', ...(s.key ? { authorization: `Bearer ${s.key}` } : {}) },
      body: body(formats[i]),
      signal,
    });
    if (res.ok) {
      const raw = await res.text();
      try {
        const text = asReply(() => openAiReply(raw));
        formatTaken.set(modelKey(s), i);
        return text;
      } catch (e) {
        if (hints.rejected(errorText(e))) {
          i--;
          continue;
        }
        // Rejected only once the reply had started (the error in the stream): the next format, too.
        if (i < formats.length - 1 && formatRejected(e)) continue;
        throw e;
      }
    }
    const said = await res.text().catch(() => '');
    last = `${res.status} ${serverSaid(said)}`;
    if ((res.status === 400 || res.status === 422) && hints.rejected(said)) {
      i--;
      continue;
    }
    // Only a rejected request format is worth another try.
    if ((res.status !== 400 && res.status !== 422) || !FORMAT_REJECTED.test(said)) break;
  }
  throw new Error(`${AI_SERVER} ${last}`);
}

/** Sends the pages and returns what the model read. Throws with a message for the user on any failure. */
const send = (s: AiSettings, req: Request, signal?: AbortSignal) => {
  if (aiInsecure(s)) throw new Error(AI_INSECURE);
  if (!aiUrl(s)) throw new Error(AI_BAD_URL);
  return s.api === 'anthropic' ? viaAnthropic(s, req, signal) : viaOpenAi(s, req, signal);
};

export async function readWithAi(s: AiSettings, pages: AiPage[], signal?: AbortSignal): Promise<AiResult> {
  const { known, lang } = await knownWords();
  const text = await send(s, { images: pages.map((p) => p.jpeg), text: `${prompt(pages)}\n\n${wording(known, lang).join('\n')}`, schema: RESULT_SCHEMA }, signal);
  return inWords(parseResult(text, pages.length), known, lang);
}

/* ------------------------------------------------- types and keywords ---- */

const LANGUAGE: Record<Lang, string> = { de: 'German', en: 'English' };

/** Types offered while the archive has none yet. */
const STARTER_TYPES: Record<Lang, string[]> = {
  de: ['Rechnung', 'Quittung', 'Brief', 'Vertrag', 'Kontoauszug', 'Lohnabrechnung', 'Versicherung', 'Steuern', 'Arztbericht', 'Bestätigung', 'Mahnung', 'Ausweis'],
  en: ['Invoice', 'Receipt', 'Letter', 'Contract', 'Bank statement', 'Payslip', 'Insurance', 'Tax', 'Medical report', 'Confirmation', 'Reminder', 'ID'],
};

/** The archive's vocabulary and the app's language (none and English where they can't be had, as in tests). */
async function knownWords(): Promise<{ known: Vocabulary; lang: Lang }> {
  const known = await import('@/paper/archive/vocabulary').then((m) => m.vocabulary()).catch(() => ({ types: [], tags: [] }));
  const lang = await import('@/core/i18n').then((m) => m.lang).catch((): Lang => 'en');
  return { known, lang };
}

/**
 * How the model names the type and keywords: in the app's language (one archive, one vocabulary, whatever language
 * each document is in), from the words the archive already uses, a new one only where none fits.
 */
export function wording(known: Vocabulary, language: Lang): string[] {
  const types = known.types.map(([n]) => n);
  const tags = known.tags.slice(0, MAX_TAGS_SENT).map(([n]) => n);
  return [
    `Write the title in the document’s own language; write the type and the keywords in ${LANGUAGE[language]}.`,
    types.length
      ? `Types already in use: ${types.join(', ')}. Use one of them if it fits; give a new type only if none does.`
      : `Types to choose from: ${STARTER_TYPES[language].join(', ')}. Give another only if none fits.`,
    tags.length ? `Keywords already in use: ${tags.join(', ')}. Use those that fit; add a new keyword only if none of them does.` : '',
    'Give at most three keywords. A keyword names a topic (a subject, an account, a person, a property), not the type, the sender or the year: those have fields of their own.',
  ].filter(Boolean);
}

/** The model's type and keywords as the archive writes them (the same word, or a typo of one, becomes that one). */
export function inWords<R extends AiDescription>(r: R, known: Vocabulary, language: Lang): R {
  const types = known.types.length ? known.types.map(([n]) => n) : STARTER_TYPES[language];
  return { ...r, type: snapName(r.type, types), keywords: snapTags(r.keywords, known.tags.map(([n]) => n)) };
}

/** What a document is, from its text alone (cheaper than images): for documents that already have text. */
export type AiDescription = Omit<AiResult, 'pages'>;
const { pages: _pages, ...describing } = RESULT_SCHEMA.properties;
export const DESCRIBE_SCHEMA = object(describing);

/** Longest text sent: the first pages say what a document is. */
const DESCRIBE_CHARS = 12_000;

export async function describeWithAi(s: AiSettings, text: string, signal?: AbortSignal): Promise<AiDescription> {
  const { known, lang } = await knownWords();
  const instructions = [
    'Below is the text of a document. Describe it: title, date, sender, type and keywords. Reply with the JSON object only.',
    ...wording(known, lang),
    '',
    text.slice(0, DESCRIBE_CHARS) || '(no text)',
  ].join('\n');
  const { pages: _ignored, ...description } = parseResult(await send(s, { images: [], text: instructions, schema: DESCRIBE_SCHEMA }, signal), 0);
  return inWords(description, known, lang);
}

/* ------------------------------------------------------------ tidying ---- */

/** A name in use as the model sees it: how general (1 one thing … 5 a broad area) and whether it names a company or person. */
export type NameRating = { name: string; generality: number; company: boolean };

const RATE_SCHEMA = object({
  names: {
    type: 'array',
    items: object({
      name: { type: 'string', description: 'A name from the list, exactly as given' },
      generality: { type: 'integer', description: 'From 1 (one specific thing: a contract, a case, a product) to 5 (a broad area of life)' },
      company: { type: 'boolean', description: 'Whether it is the name of a company, an organisation or a person' },
    }),
  },
  suggested: { ...strings, description: 'The categories suggested, each a name from the list or a new broader one' },
});

const SORT_SCHEMA = object({
  names: {
    type: 'array',
    items: object({
      name: { type: 'string', description: 'A name from the list, exactly as given' },
      category: { type: 'string', description: 'The one category it belongs under, exactly as given, or "" if none fits well' },
    }),
  },
});

const listed = (xs: [string, number][]) => xs.map(([n, c]) => `${n} (${c})`).join('\n') || '(none)';
const what = (kind: 'tag' | 'type') => (kind === 'tag' ? 'tags' : 'document types');

/** How general each name is, which are names of companies or people, and 10–15 categories for the archive (tidy.ts). */
export async function rateNames(s: AiSettings, kind: 'tag' | 'type', names: [string, number][], signal?: AbortSignal): Promise<{ ratings: NameRating[]; suggested: string[] }> {
  const { lang } = await knownWords();
  const instructions = [
    `These are the ${what(kind)} of one person’s archive of documents, each with how many documents have it.`,
    'For each, rate how general it is, from 1 (one specific thing: a contract, a case, a product) to 5 (a broad area of life, such as finances or health), and say whether it is the name of a company, an organisation or a person.',
    `Then suggest ${kind === 'tag' ? '10 to 15 categories' : '8 to 12 types'} that together cover the archive: prefer names from the list that are both general and often used; add a new, broader one only where several specific names would fit under it and none in the list does. Write new ones in ${LANGUAGE[lang]}. Never suggest a company’s or person’s name.`,
    'Give every name of the list, each once. Reply with the JSON object only.',
    '',
    listed(names),
  ].join('\n');
  const raw = replyObject(await send(s, { images: [], text: instructions, schema: RATE_SCHEMA }, signal), (v) => 'names' in v) as { names?: unknown[]; suggested?: unknown[] } | undefined;
  if (!raw) throw new Error(AI_NO_JSON);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const ratings = (Array.isArray(raw.names) ? raw.names : []).map((x) => {
    const r = x as { name?: unknown; generality?: unknown; company?: unknown };
    const g = Math.round(Number(r.generality));
    return { name: str(r.name), generality: g >= 1 && g <= 5 ? g : 3, company: r.company === true };
  });
  return { ratings: ratings.filter((r) => r.name), suggested: (Array.isArray(raw.suggested) ? raw.suggested : []).map(str).filter(Boolean) };
}

/** For each name of `rest`, the one of `categories` it belongs under ('' where none fits): the model's proposal. */
export async function sortInNames(s: AiSettings, kind: 'tag' | 'type', categories: string[], rest: [string, number][], signal?: AbortSignal): Promise<{ name: string; category: string }[]> {
  const instructions = [
    `These are the categories chosen for the ${what(kind)} of one person’s archive of documents:`,
    categories.join(', '),
    '',
    `For each of the other ${what(kind)} below (with how many documents have it), give the one category it belongs under, exactly as written above, or "" if none fits well. Give every name of the list, each once. Reply with the JSON object only.`,
    '',
    listed(rest),
  ].join('\n');
  const raw = replyObject(await send(s, { images: [], text: instructions, schema: SORT_SCHEMA }, signal), (v) => 'names' in v) as { names?: unknown[] } | undefined;
  if (!raw) throw new Error(AI_NO_JSON);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return (Array.isArray(raw.names) ? raw.names : []).map((x) => ({ name: str((x as { name?: unknown }).name), category: str((x as { category?: unknown }).category) })).filter((x) => x.name);
}

const ASSIGN_SCHEMA = object({
  documents: {
    type: 'array',
    items: object({
      id: { type: 'string', description: 'The document’s id, exactly as given' },
      categories: { ...strings, description: 'The categories that fit its content, each exactly as written in the list' },
    }),
  },
});

/** A document to sort in by its content: what it has now, and the start of its text. */
export type ContentDoc = { id: string; name: string; title: string; sender: string; type: string; tags: string[]; text: string };

/**
 * For each document, the categories its content belongs under (by id): one to three for tags, one for a type, only
 * from `categories` (a name the model writes differently is matched onto the list; one not on it is dropped; none
 * that fits: an empty list). A model held to no schema writes the ids its own way (3, "Document 3") and may answer
 * for fewer documents than asked: those it left out are asked for once more. Not in the map: no answer.
 */
export async function sortInByContent(s: AiSettings, kind: 'tag' | 'type', categories: string[], docs: ContentDoc[], signal?: AbortSignal): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let round = 0; round < 2; round++) {
    const left = docs.filter((d) => !out.has(d.id));
    if (!left.length) break;
    const got = await askByContent(s, kind, categories, left, signal);
    for (const [id, found] of got) out.set(id, found);
    log.info('ai', 'sorted in by content', { asked: left.length, answered: got.size, round });
  }
  return out;
}

async function askByContent(s: AiSettings, kind: 'tag' | 'type', categories: string[], docs: ContentDoc[], signal?: AbortSignal): Promise<Map<string, string[]>> {
  const instructions = [
    `These are the only ${what(kind)} allowed in one person’s archive of documents:`,
    categories.join(', '),
    '',
    kind === 'tag'
      ? 'For each document below, choose the one to three tags from that list that fit what it is about. Use only tags from the list, exactly as written, or none if none fits.'
      : 'For each document below, choose the one document type from that list that fits what it is. Use only a type from the list, exactly as written, or none if none fits.',
    'Go by its content. Its current details are only a hint and may be wrong.',
    `There ${docs.length === 1 ? 'is 1 document' : `are ${docs.length} documents`} (ids ${docs.map((d) => `"${d.id}"`).join(', ')}): give one entry for each of them in "documents", with its id as a string. Reply with the JSON object only.`,
    '',
    ...docs.map((d) =>
      [
        `--- Document ${d.id}`,
        `File: ${d.name}`,
        d.title && `Title: ${d.title}`,
        d.sender && `Sender: ${d.sender}`,
        d.type && `Current type: ${d.type}`,
        d.tags.length ? `Current tags: ${d.tags.join(', ')}` : '',
        `Text:\n${d.text || '(none)'}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n');
  const found = replyObjects(await send(s, { images: [], text: instructions, schema: ASSIGN_SCHEMA }, signal));
  // The entries: in "documents" as asked, or bare (an array of them, or one object each).
  const entries = found.flatMap((v) => ('documents' in v && Array.isArray(v.documents) ? (v.documents as unknown[]) : 'id' in v ? [v] : []));
  if (!found.length || (!entries.length && !found.some((v) => 'documents' in v))) throw new Error(AI_NO_JSON);
  const byKey = new Map(categories.map((c) => [nameKey(c), c]));
  const out = new Map<string, string[]>();
  for (const x of entries) {
    if (!x || typeof x !== 'object') continue;
    const { id, categories: named } = x as { id?: unknown; categories?: unknown };
    // "3", 3, "Document 3", "#3": the number is the id.
    const doc = docs.find((d) => d.id === String(id ?? '').match(/\d+/)?.[0]);
    if (!doc) continue;
    const list = Array.isArray(named) ? named : typeof named === 'string' ? named.split(',') : [];
    const names = list.flatMap((c) => (typeof c === 'string' && byKey.get(nameKey(c.trim())) ? [byKey.get(nameKey(c.trim()))!] : []));
    out.set(doc.id, [...new Set([...(out.get(doc.id) ?? []), ...names])].slice(0, kind === 'tag' ? 3 : 1));
  }
  return out;
}

/** A small request (a blank page) that checks the address, key and model, for Settings. */
export async function testAi(s: AiSettings, signal?: AbortSignal): Promise<void> {
  const canvas = new OffscreenCanvas(64, 64);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 64, 64);
  await readWithAi(s, [{ jpeg: await canvas.convertToBlob({ type: 'image/jpeg' }), lines: [] }], signal);
}

/* -------------------------------------------------------- the text layer ---- */

/**
 * The words of a page in lines (as the device read them), with the ids sent to the model. A wide gap (a gutter,
 * between a table's cells) ends a line: its corrected text is laid out within one run of words, not across the gap.
 */
export function pageLines<W extends PdfWord>(words: W[], page: number): { id: string; words: W[] }[] {
  const lines: { id: string; words: W[] }[] = [];
  for (const w of words) {
    const line = lines.at(-1);
    const prev = line?.words.at(-1);
    const overlap = prev ? Math.min(prev.y1, w.y1) - Math.max(prev.y0, w.y0) : 0;
    const near = prev ? w.x0 - prev.x1 <= 2 * Math.max(prev.y1 - prev.y0, w.y1 - w.y0) : false;
    if (line && prev && w.x0 > prev.x0 && near && overlap > 0.5 * Math.min(prev.y1 - prev.y0, w.y1 - w.y0)) line.words.push(w);
    else lines.push({ id: `${page + 1}.${lines.length + 1}`, words: [w] });
  }
  return lines;
}

/** `text` laid out across a box, word by word, in proportion to their lengths. */
export function spread(text: string, box: { x0: number; y0: number; x1: number; y1: number }): PdfWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const units = tokens.reduce((n, t) => n + [...t].length, 0) + Math.max(0, tokens.length - 1);
  const per = (box.x1 - box.x0) / Math.max(1, units);
  let x = box.x0;
  return tokens.map((t) => {
    const w = { text: t, x0: x, y0: box.y0, x1: x + [...t].length * per, y1: box.y1 };
    x = w.x1 + per;
    return w;
  });
}

/**
 * The page's words with the model's reading: each line's words replaced by its corrected text (in place, word for
 * word when the count is the same), lines it marked as not text dropped, and the text it added placed in its box.
 */
export function applyReading(words: PdfWord[], page: number, reading: AiResult['pages'][number], width: number, height: number): PdfWord[] {
  const fixed = new Map(reading.lines.map((l) => [l.id, l.text.trim()]));
  const out: PdfWord[] = [];
  for (const line of pageLines(words, page)) {
    const text = fixed.get(line.id);
    if (text === undefined) {
      out.push(...line.words);
      continue;
    }
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === line.words.length) out.push(...line.words.map((w, i) => ({ ...w, text: tokens[i] })));
    else if (tokens.length) {
      const ws = line.words;
      out.push(...spread(text, { x0: Math.min(...ws.map((w) => w.x0)), y0: Math.min(...ws.map((w) => w.y0)), x1: Math.max(...ws.map((w) => w.x1)), y1: Math.max(...ws.map((w) => w.y1)) }));
    }
  }
  for (const a of reading.added) {
    const [x0, y0, x1, y1] = a.box.map((v) => Math.min(1000, Math.max(0, v)) / 1000);
    const box = { x0: x0 * width, y0: y0 * height, x1: x1 * width, y1: y1 * height };
    if (x1 > x0 && y1 > y0 && !alreadyThere(a.text, box, out)) out.push(...spread(a.text, box));
  }
  return out;
}

const tokensOf = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}%]/gu, ''))
    .filter(Boolean);

/**
 * Text the model "adds" that the page has already, on the same row (models give a whole table row again, often in
 * the wrong place across the page): not written a second time. Text that really was missed (handwriting) isn't there.
 */
function alreadyThere(text: string, box: { y0: number; y1: number }, words: PdfWord[]): boolean {
  const tokens = tokensOf(text);
  if (!tokens.length) return true;
  const row = new Set(words.filter((w) => Math.min(w.y1, box.y1) - Math.max(w.y0, box.y0) > 0.5 * Math.min(w.y1 - w.y0, box.y1 - box.y0)).flatMap((w) => tokensOf(w.text)));
  return tokens.filter((t) => row.has(t)).length >= Math.ceil(tokens.length * 0.6);
}

/** A file name from what the model found: "2026-10-02 Musterwerke Zürich – Rechnung 40217". */
export function aiTitle(r: AiResult): string {
  const what = r.title || r.type;
  const who = r.sender && !what.toLowerCase().includes(r.sender.toLowerCase()) ? r.sender : '';
  return [r.date, [who, what].filter(Boolean).join(' – ')].filter(Boolean).join(' ').trim();
}
