import { afterEach, describe, expect, it, vi } from 'vitest';

import { AI_CUT_OFF, AI_NO_JSON, aiHost, aiInsecure, aiReady, aiTitle, anthropicReply, applyReading, DEFAULT_AI, describeWithAi, openAiReply, pageLines, parseResult, prompt, spread, type AiResult } from '../ai';

const w = (text: string, x0: number, y0: number, x1: number, y1: number) => ({ text, x0, y0, x1, y1 });

describe('AI reading', () => {
  const words = [w('Zahlbar', 0, 0, 70, 20), w('bis:', 74, 1, 100, 21), w('Wahrung', 0, 40, 80, 60), w('CHF', 0, 80, 30, 100), w('20.00', 40, 80, 90, 100)];

  it('groups the words into lines with ids, as sent', () => {
    expect(pageLines(words, 1).map((l) => [l.id, l.words.map((x) => x.text).join(' ')])).toEqual([
      ['2.1', 'Zahlbar bis:'],
      ['2.2', 'Wahrung'],
      ['2.3', 'CHF 20.00'],
    ]);
    expect(prompt([{ jpeg: new Blob(), lines: [{ id: '1.1', text: 'Zahlbar bis:' }] }])).toContain('1.1\tZahlbar bis:');
  });

  it('puts the corrected text in place, drops what is not text, and places what was added', () => {
    const reading: AiResult['pages'][number] = {
      lines: [
        { id: '1.2', text: 'Währung' },
        { id: '1.3', text: '' },
      ],
      added: [{ text: 'bez zum 30.10.2026', box: [500, 900, 900, 950] }],
    };
    const out = applyReading(words, 0, reading, 1000, 1000);
    expect(out.map((x) => x.text)).toEqual(['Zahlbar', 'bis:', 'Währung', 'bez', 'zum', '30.10.2026']);
    // Same word count: the word keeps its own box.
    expect(out[2]).toMatchObject({ x0: 0, x1: 80, y0: 40 });
    // Added text spread over its box, in page pixels.
    expect(out[3].x0).toBe(500);
    expect(out[5].x1).toBeCloseTo(900);
    expect(out[3].y0).toBe(900);
  });

  it('doesn’t add a second time what the page already has on that row', () => {
    const row = [
      { text: 'Datum', x0: 100, y0: 440, x1: 140, y1: 450, page: 0 },
      { text: 'Betrag', x0: 890, y0: 440, x1: 930, y1: 450, page: 0 },
      { text: '85.45', x0: 890, y0: 460, x1: 930, y1: 470, page: 0 },
    ];
    const reading: AiResult['pages'][number] = {
      lines: [],
      added: [
        // A row given again, squeezed into the wrong place.
        { text: 'Datum Betrag', box: [100, 440, 500, 450] },
        { text: '85.45', box: [460, 460, 510, 470] },
        // Handwriting that really is missing.
        { text: '29.11.24', box: [500, 900, 600, 920] },
      ],
    };
    const out = applyReading(row, 0, reading, 1000, 1000);
    expect(out.map((w) => w.text)).toEqual(['Datum', 'Betrag', '85.45', '29.11.24']);
  });

  it('spreads a corrected line with a different word count over the line', () => {
    const out = spread('Zahlbar bis', { x0: 0, y0: 0, x1: 110, y1: 20 });
    expect(out.map((x) => [x.text, x.x0, x.x1])).toEqual([
      ['Zahlbar', 0, 70],
      ['bis', 80, 110],
    ]);
  });

  it('reads the JSON out of a wrapped reply and keeps only what is well formed', () => {
    const reply = 'Here you go:\n```json\n{"title":"Rechnung 40217","date":"02.10.2026","sender":"Musterwerke Zürich","type":"Rechnung","keywords":["Strom",3],"pages":[{"lines":[{"id":"1.1","text":"x"},{"id":2}],"added":[{"text":"bez","box":[1,2,3]}]}]}\n```';
    const r = parseResult(reply, 2);
    expect(r.title).toBe('Rechnung 40217');
    expect(r.date).toBe(''); // not YYYY-MM-DD
    expect(r.keywords).toEqual(['Strom']);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0].lines).toEqual([{ id: '1.1', text: 'x' }]);
    expect(r.pages[0].added).toEqual([]);
    expect(r.pages[1]).toEqual({ lines: [], added: [] });
    expect(() => parseResult('no json', 1)).toThrow();
  });

  it('places each page’s reading by its number, not by its place in the list', () => {
    // Page 1 left out (blank); the third entry names its page only through its lines' ids.
    const reply = JSON.stringify({
      title: 'A',
      pages: [
        { page: 2, lines: [{ id: '2.1', text: 'zwei' }], added: [] },
        { lines: [{ id: '3.1', text: 'drei' }], added: [{ text: 'bez', box: [1, 2, 3, 4] }] },
      ],
    });
    const r = parseResult(reply, 3);
    expect(r.pages[0]).toEqual({ lines: [], added: [] });
    expect(r.pages[1].lines).toEqual([{ id: '2.1', text: 'zwei' }]);
    expect(r.pages[2]).toEqual({ lines: [{ id: '3.1', text: 'drei' }], added: [{ text: 'bez', box: [1, 2, 3, 4] }] });
  });

  it('names the file by date, sender and title', () => {
    const r = { title: 'Rechnung 40217', date: '2026-10-02', sender: 'Musterwerke Zürich', type: 'Rechnung', keywords: [], pages: [] };
    expect(aiTitle(r)).toBe('2026-10-02 Musterwerke Zürich – Rechnung 40217');
    expect(aiTitle({ ...r, title: 'Musterwerke Zürich Rechnung' })).toBe('2026-10-02 Musterwerke Zürich Rechnung');
    expect(aiTitle({ ...r, date: '', sender: '', title: '' })).toBe('Rechnung');
  });
});

describe('replies', () => {
  const sse = (events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');

  it('read an Anthropic stream, or a whole message', () => {
    const stream = sse([
      { type: 'message_start' },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"title":' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '"A"}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
    expect(anthropicReply(stream)).toBe('{"title":"A"}');
    expect(anthropicReply(JSON.stringify({ content: [{ type: 'text', text: 'whole' }] }))).toBe('whole');
    expect(() => anthropicReply(sse([{ type: 'error', error: { message: 'Overloaded' } }]))).toThrow('Overloaded');
    expect(() => anthropicReply(sse([{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]))).toThrow(/declined/);
    // Cut off at the length limit: said so, not a broken JSON error later.
    expect(() => anthropicReply(sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ti' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]))).toThrow(AI_CUT_OFF);
    expect(() => anthropicReply(JSON.stringify({ content: [{ type: 'text', text: '{"ti' }], stop_reason: 'max_tokens' }))).toThrow(AI_CUT_OFF);
  });

  it('read a Chat Completions stream, or a whole reply', () => {
    const stream = `${sse([{ choices: [{ delta: { content: 'he' } }] }, { choices: [{ delta: { content: 'llo' } }] }])}data: [DONE]\n\n`;
    expect(openAiReply(stream)).toBe('hello');
    expect(openAiReply(JSON.stringify({ choices: [{ message: { content: 'whole' } }] }))).toBe('whole');
    expect(() => openAiReply(sse([{ choices: [{ delta: { refusal: 'no' } }] }]))).toThrow(/declined/);
    expect(() => openAiReply(sse([{ choices: [{ delta: { content: '{"ti' }, finish_reason: 'length' }] }]))).toThrow(AI_CUT_OFF);
    expect(() => openAiReply(JSON.stringify({ choices: [{ message: { content: '{"ti' }, finish_reason: 'length' }] }))).toThrow(AI_CUT_OFF);
  });

  it('take only a whole web address, and say when a reply is no JSON', () => {
    const s = { ...DEFAULT_AI, model: 'm' };
    expect(aiReady({ ...s, url: 'https://api.anthropic.com' })).toBe(true);
    expect(aiReady({ ...s, url: 'http://localhost:11434/v1' })).toBe(true);
    // Without a scheme it would be a path on the app's own site.
    expect(aiReady({ ...s, url: 'api.anthropic.com' })).toBe(false);
    expect(aiReady({ ...s, url: 'ftp://example.com' })).toBe(false);
    expect(aiHost({ ...s, url: ' https://api.anthropic.com/v1 ' })).toBe('api.anthropic.com');
    // Over plain http only within this device or network: elsewhere the key would travel unencrypted.
    expect(aiInsecure({ ...s, url: 'http://example.com/v1' })).toBe(true);
    expect(aiReady({ ...s, url: 'http://example.com/v1' })).toBe(false);
    expect(aiReady({ ...s, url: 'http://172.32.0.1/v1' })).toBe(false);
    for (const url of ['http://192.168.1.20:11434/v1', 'http://10.0.0.5', 'http://172.20.1.1', 'http://ollama.local:11434', 'http://[::1]:8080', 'http://100.101.1.2'])
      expect(aiReady({ ...s, url }), url).toBe(true);
    expect(aiInsecure({ ...s, url: 'https://example.com' })).toBe(false);
    expect(() => parseResult('no json here', 1)).toThrow(AI_NO_JSON);
    expect(() => parseResult('{"title": "A", "pages": [', 1)).toThrow(AI_NO_JSON);
  });
});

describe('output formats', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = JSON.stringify({ title: 'Rechnung 40217', date: '', sender: 'Musterwerke Zürich', type: '', keywords: [] });
  const sse = (e: object) => `data: ${JSON.stringify(e)}\n\ndata: [DONE]\n\n`;
  // A server that starts the reply, then says in the stream that the model can't follow a JSON schema.
  const server = () => {
    const sent: { response_format?: { type: string } }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { response_format?: { type: string } };
      sent.push(body);
      if (body.response_format?.type === 'json_schema')
        return new Response(sse({ error: { message: "The model 'deepseek-v4.1-flash' does not support JSON schema mode. Use 'json_object' mode instead, or choose a model that supports structured outputs." } }));
      return new Response(sse({ choices: [{ delta: { content: answer } }] }));
    });
    return sent;
  };

  it('fall back to plain JSON when the model rejects the schema inside the reply, and start there next time', async () => {
    const sent = server();
    const s = { api: 'openai' as const, url: 'https://ai.test/v1', key: 'k', model: 'deepseek-v4.1-flash' };
    expect((await describeWithAi(s, 'text')).sender).toBe('Musterwerke Zürich');
    expect(sent.map((b) => b.response_format?.type)).toEqual(['json_schema', 'json_object']);
    await describeWithAi(s, 'text');
    expect(sent.map((b) => b.response_format?.type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('ask not to think in every known way, and drop each one a server rejects by name (and not again)', async () => {
    const sent: Record<string, unknown>[] = [];
    // A strict server: knows reasoning_effort (but not "none"), rejects any other field it doesn't know.
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push(body);
      if (body.reasoning_effort === 'none') return new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model." } }), { status: 400 });
      const unknown = ['thinking', 'chat_template_kwargs', 'enable_thinking'].find((k) => k in body);
      if (unknown) return new Response(JSON.stringify({ error: { message: `Unrecognized request argument supplied: ${unknown}` } }), { status: 400 });
      return new Response(sse({ choices: [{ delta: { content: answer } }] }));
    });
    const s = { api: 'openai' as const, url: 'https://strict.test/v1', key: 'k', model: 'gpt-test' };
    expect((await describeWithAi(s, 'text')).sender).toBe('Musterwerke Zürich');
    const last = sent.at(-1)!;
    expect(last.reasoning_effort).toBe('minimal');
    expect(['thinking', 'chat_template_kwargs', 'enable_thinking'].some((k) => k in last)).toBe(false);
    const asked = sent.length;
    await describeWithAi(s, 'text');
    expect(sent.length).toBe(asked + 1);
    expect(sent.at(-1)).toMatchObject({ reasoning_effort: 'minimal' });
  });

  it('send no thinking hints when thinking is on (the model’s default), and Anthropic’s adaptive thinking', async () => {
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(sse({ choices: [{ delta: { content: answer } }] }));
    });
    await describeWithAi({ api: 'openai', url: 'https://on.test/v1', key: 'k', model: 'm', thinking: true }, 'text');
    expect(['reasoning_effort', 'thinking', 'chat_template_kwargs', 'enable_thinking'].some((k) => k in sent[0])).toBe(false);
    await describeWithAi({ api: 'anthropic', url: 'https://on.test', key: 'k', model: 'm', thinking: true }, 'text').catch(() => {});
    expect(sent[1].thinking).toEqual({ type: 'adaptive' });
    await describeWithAi({ api: 'anthropic', url: 'https://off.test', key: 'k', model: 'm' }, 'text').catch(() => {});
    expect(sent[2].thinking).toEqual({ type: 'disabled' });
  });

  it('read an error sent with a 200 as the error', () => {
    expect(() => openAiReply(JSON.stringify({ error: { message: 'Model not found' } }))).toThrow('Model not found');
  });
});
