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
  /** Read new scans with it (the switch on the scan). */
  read: boolean;
};

export const DEFAULT_AI: AiSettings = { api: 'anthropic', url: '', key: '', model: '', read: false };

export const aiReady = (s: AiSettings) => !!(s.url.trim() && s.model.trim());

/** The host pages are sent to, for the note on the switch. */
export function aiHost(s: AiSettings): string {
  try {
    return new URL(s.url.trim()).host;
  } catch {
    return s.url.trim();
  }
}

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
    '1. For every line, give its text exactly as it appears on the page: fix misread letters, umlauts and accents, missing or extra spaces. Keep the line’s id. Give "" for a line that is not text (a logo, a stamp, noise).',
    '2. Under "added", give text the recogniser missed, such as handwriting, one entry per line of text, with its box as [x0, y0, x1, y1] in thousandths of the page’s width and height (0,0 is the top left).',
    '3. Describe the document: title, date, sender, type and keywords.',
    'Give one entry in "pages" per page, in order. Reply with the JSON object only.',
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
  if (start < 0 || end < start) throw new Error('The reply has no JSON in it.');
  const raw = JSON.parse(text.slice(start, end + 1)) as Partial<AiResult>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  return {
    title: str(raw.title),
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.date)) ? str(raw.date) : '',
    sender: str(raw.sender),
    type: str(raw.type),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map(str).filter(Boolean).slice(0, 5) : [],
    pages: Array.from({ length: pageCount }, (_, i) => ({
      lines: (pages[i]?.lines ?? []).filter((l) => typeof l?.id === 'string' && typeof l?.text === 'string'),
      added: (pages[i]?.added ?? []).filter((a) => str(a?.text) && Array.isArray(a?.box) && a.box.length === 4 && a.box.every(Number.isFinite)),
    })),
  };
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * Anthropic's Messages API over fetch. (The official SDK can't initialise in this app's web bundle: Metro trips
 * over a circular import in it.) Browsers may call it directly with the header below; the key is the user's own.
 */
/** A request: images (JPEG), the instructions, and the JSON schema the reply should follow. */
type Request = { images: Blob[]; text: string; schema: object };

async function viaAnthropic(s: AiSettings, req: Request, signal?: AbortSignal): Promise<string> {
  const images = await Promise.all(req.images.map(async (jpeg) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await base64(jpeg) } })));
  const body = (structured: boolean) =>
    JSON.stringify({
      model: s.model.trim(),
      max_tokens: 16000,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: req.text }] }],
      ...(structured ? { output_config: { format: { type: 'json_schema', schema: req.schema } } } : {}),
    });
  let last = '';
  // A model or server without structured output gets the request again without it: the prompt asks for JSON anyway.
  for (const structured of [true, false]) {
    // With or without the /v1 that OpenAI-style addresses carry.
    const res = await fetch(`${trimSlash(s.url).replace(/\/v1$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(s.key ? { 'x-api-key': s.key } : {}),
      },
      body: body(structured),
      signal,
    });
    if (res.ok) {
      const message = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
      if (message.stop_reason === 'refusal') throw new Error('The model declined to read this document.');
      return (message.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
    }
    last = `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
    if (res.status !== 400) break;
  }
  throw new Error(`The server answered ${last}`);
}

async function viaOpenAi(s: AiSettings, req: Request, signal?: AbortSignal): Promise<string> {
  const images = await Promise.all(req.images.map(async (jpeg) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await base64(jpeg)}` } })));
  const body = (format: unknown) =>
    JSON.stringify({
      model: s.model.trim(),
      messages: [{ role: 'user', content: [...images, { type: 'text', text: req.text }] }],
      ...(format ? { response_format: format } : {}),
    });
  const formats = [{ type: 'json_schema', json_schema: { name: 'document', strict: true, schema: req.schema } }, { type: 'json_object' }, null];
  let last = '';
  for (const format of formats) {
    const res = await fetch(`${trimSlash(s.url)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s.key ? { authorization: `Bearer ${s.key}` } : {}) },
      body: body(format),
      signal,
    });
    if (res.ok) {
      const json = (await res.json()) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
      const msg = json.choices?.[0]?.message;
      if (msg?.refusal) throw new Error('The model declined to read this document.');
      return msg?.content ?? '';
    }
    last = `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`;
    // Only a rejected request format is worth another try.
    if (res.status !== 400 && res.status !== 422) break;
  }
  throw new Error(`The server answered ${last}`);
}

/** Sends the pages and returns what the model read. Throws with a message for the user on any failure. */
const send = (s: AiSettings, req: Request, signal?: AbortSignal) => (s.api === 'anthropic' ? viaAnthropic(s, req, signal) : viaOpenAi(s, req, signal));

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
export async function testAi(s: AiSettings): Promise<void> {
  const canvas = new OffscreenCanvas(64, 64);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 64, 64);
  await readWithAi(s, [{ jpeg: await canvas.convertToBlob({ type: 'image/jpeg' }), lines: [] }]);
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
    if (x1 > x0 && y1 > y0) out.push(...spread(a.text, { x0: x0 * width, y0: y0 * height, x1: x1 * width, y1: y1 * height }));
  }
  return out;
}

/** A file name from what the model found: "2026-10-02 Musterwerke Zürich – Rechnung 40217". */
export function aiTitle(r: AiResult): string {
  const what = r.title || r.type;
  const who = r.sender && !what.toLowerCase().includes(r.sender.toLowerCase()) ? r.sender : '';
  return [r.date, [who, what].filter(Boolean).join(' – ')].filter(Boolean).join(' ').trim();
}
