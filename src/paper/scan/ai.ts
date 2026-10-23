import { desktop } from '@/core/lib/desktop';
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

/** This device, the local network (private and link-local addresses) or a .local name. */
export function localHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
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
  date: { type: 'string', description: 'The document’s own date as YYYY-MM-DD, or "" if it has none' },
  sender: { type: 'string', description: 'Who issued it (organisation or person), or ""' },
  type: { type: 'string', description: 'What it is, in the document’s language: invoice, receipt, letter, contract, delivery note, …' },
  keywords: { ...strings, description: 'Up to five words to find it by' },
  pages: {
    type: 'array',
    items: object({
      page: { type: 'integer', description: 'The page’s number, from 1' },
      lines: { type: 'array', items: object({ id: { type: 'string' }, text: { type: 'string' } }) },
      added: { type: 'array', items: object({ text: { type: 'string' }, box: { type: 'array', items: { type: 'number' } } }) },
    }),
  },
});

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

/** The first JSON object in a reply (a model without structured output may wrap it in prose or a code fence). */
export function parseResult(text: string, pageCount: number): AiResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(AI_NO_JSON);
  let raw: Partial<AiResult>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Partial<AiResult>;
  } catch {
    throw new Error(AI_NO_JSON);
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  type Entry = Partial<AiResult['pages'][number]> & { page?: unknown };
  const entries = (Array.isArray(raw.pages) ? raw.pages : []) as Entry[];
  // Which page an entry is: its number, else the page its lines' ids name ("3.2" is on page 3), else its place
  // in the list. A model that leaves a blank page out mustn't shift the next page's handwriting onto it.
  const pageOf = (e: Entry, i: number) => {
    const n = Number(e?.page);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) return n - 1;
    const named = [...new Set((e?.lines ?? []).map((l) => Number(String(l?.id ?? '').split('.')[0])).filter(Number.isInteger))];
    if (named.length === 1 && named[0] >= 1 && named[0] <= pageCount) return named[0] - 1;
    return i;
  };
  const byPage = new Map<number, Entry>();
  entries.forEach((e, i) => {
    const at = pageOf(e, i);
    if (!byPage.has(at)) byPage.set(at, e);
  });
  return {
    title: str(raw.title),
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.date)) ? str(raw.date) : '',
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
    return fetch(url, { method: 'POST', ...init }).catch((e: unknown) => {
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

async function viaAnthropic(s: AiSettings, req: Request, signal?: AbortSignal): Promise<string> {
  const images = await Promise.all(req.images.map(async (jpeg) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await base64(jpeg) } })));
  const body = (structured: boolean, maxTokens: number) =>
    JSON.stringify({
      model: s.model.trim(),
      max_tokens: maxTokens,
      // Streamed: the reply starts at once, so a proxy on the way (Cloudflare gives up after ~100 s without a
      // byte) doesn't cut off a long reading. The whole stream is read before it is used.
      stream: true,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: req.text }] }],
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
    last = `${res.status} ${said.slice(0, 200)}`;
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
      messages: [{ role: 'user', content: [...images, { type: 'text', text: req.text }] }],
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
    last = `${res.status} ${said.slice(0, 200)}`;
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
  const text = await send(s, { images: pages.map((p) => p.jpeg), text: prompt(pages), schema: RESULT_SCHEMA }, signal);
  return parseResult(text, pages.length);
}

/** What a document is, from its text alone (cheaper than images): for documents that already have text. */
export type AiDescription = Omit<AiResult, 'pages'>;
const { pages: _pages, ...describing } = RESULT_SCHEMA.properties;
export const DESCRIBE_SCHEMA = object(describing);

/** Longest text sent: the first pages say what a document is. */
const DESCRIBE_CHARS = 12_000;

export async function describeWithAi(s: AiSettings, text: string, signal?: AbortSignal): Promise<AiDescription> {
  const instructions = [
    'Below is the text of a document. Describe it: title, date, sender, type and keywords. Reply with the JSON object only.',
    '',
    text.slice(0, DESCRIBE_CHARS) || '(no text)',
  ].join('\n');
  const { pages: _ignored, ...description } = parseResult(await send(s, { images: [], text: instructions, schema: DESCRIBE_SCHEMA }, signal), 0);
  return description;
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

/** The words of a page in lines (as the device read them), with the ids sent to the model. */
export function pageLines<W extends PdfWord>(words: W[], page: number): { id: string; words: W[] }[] {
  const lines: { id: string; words: W[] }[] = [];
  for (const w of words) {
    const line = lines.at(-1);
    const prev = line?.words.at(-1);
    const overlap = prev ? Math.min(prev.y1, w.y1) - Math.max(prev.y0, w.y0) : 0;
    if (line && prev && w.x0 > prev.x0 && overlap > 0.5 * Math.min(prev.y1 - prev.y0, w.y1 - w.y0)) line.words.push(w);
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
