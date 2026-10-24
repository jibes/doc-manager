import { describe, expect, it } from 'vitest';

import { brief, setLogging, traced } from './log';

describe('brief', () => {
  it('gives sizes for bytes and hides keys and passwords', () => {
    expect(brief(new ArrayBuffer(10))).toBe('[10 B]');
    expect(brief({ url: 'https://ai.test', key: 'sk-secret', password: 'x' })).toBe('{url: "https://ai.test", key: •••, password: •••}');
  });
  it('cuts long strings and deep objects', () => {
    expect(brief('x'.repeat(200)).length).toBeLessThan(90);
    expect(brief({ a: { b: { c: 1 } } })).toBe('{a: {b: {…}}}');
  });
});

describe('traced', () => {
  it('passes calls and results through, failures too', async () => {
    setLogging(true);
    const api = traced('test', { add: async (a: number, b: number) => a + b, fail: async () => Promise.reject(new Error('no')), flag: true });
    expect(await api.add(1, 2)).toBe(3);
    await expect(api.fail()).rejects.toThrow('no');
    expect(api.flag).toBe(true);
    setLogging(false);
  });
});
