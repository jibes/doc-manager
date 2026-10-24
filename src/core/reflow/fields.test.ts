import { describe, expect, it } from 'vitest';

import type { FormField, TextLine } from '@/core/engine/types';
import { withFields } from './fields';

const line = (text: string, x: number, y: number, w = 0.15): TextLine => ({ text, rect: { x, y, w, h: 0.015 }, size: 11, bold: false, italic: false, hyphen: false });
const field = (f: Partial<FormField> & Pick<FormField, 'type' | 'rect'>): FormField => ({ index: 0, name: 'f', value: '', readOnly: false, multiline: false, password: false, multiple: false, ...f });

describe('withFields', () => {
  it('puts a value after its label, a mark before its words', () => {
    const lines = [line('Full name', 0.1, 0.2), line('Medium', 0.4, 0.4, 0.08), line('I agree to keep the notes in order', 0.34, 0.5, 0.4)];
    const out = withFields(lines, [
      field({ type: 'text', rect: { x: 0.3, y: 0.195, w: 0.5, h: 0.03 }, value: 'Ada Lövelace' }),
      field({ type: 'radio', rect: { x: 0.37, y: 0.398, w: 0.025, h: 0.02 }, checked: true }),
      field({ type: 'checkbox', rect: { x: 0.31, y: 0.498, w: 0.025, h: 0.02 }, checked: false }),
    ]);
    expect(out.map((l) => l.text)).toEqual(['Full name: Ada Lövelace', '◉ Medium', '☐ I agree to keep the notes in order']);
  });

  it('shows the chosen option, keeps one line for a multi-line value, and skips empty fields and passwords', () => {
    const lines = [line('Site:', 0.1, 0.3), line('Notes', 0.1, 0.6), line('PIN', 0.1, 0.7)];
    const out = withFields(lines, [
      field({ type: 'combo', rect: { x: 0.3, y: 0.295, w: 0.3, h: 0.03 }, value: 'harbour', options: [{ label: 'Harbour', selected: true }, { label: 'Mill', selected: false }] }),
      field({ type: 'text', rect: { x: 0.3, y: 0.58, w: 0.5, h: 0.08 }, value: 'one\n two', multiline: true }),
      field({ type: 'text', rect: { x: 0.3, y: 0.695, w: 0.3, h: 0.03 }, value: '1234', password: true }),
      field({ type: 'text', rect: { x: 0.3, y: 0.9, w: 0.3, h: 0.03 }, value: '' }),
    ]);
    expect(out.map((l) => l.text)).toEqual(['Site: Harbour', 'Notes: one two', 'PIN']);
  });

  it('puts a second field after one label on with a comma', () => {
    const out = withFields([line('Name', 0.1, 0.2, 0.08)], [
      field({ type: 'text', rect: { x: 0.25, y: 0.195, w: 0.2, h: 0.03 }, value: 'Ada' }),
      field({ type: 'text', rect: { x: 0.5, y: 0.195, w: 0.2, h: 0.03 }, value: 'Lovelace' }),
    ]);
    expect(out[0].text).toBe('Name: Ada, Lovelace');
  });

  it('gives a value without a label a line of its own', () => {
    const out = withFields([line('Title', 0.1, 0.1)], [field({ type: 'text', rect: { x: 0.3, y: 0.5, w: 0.3, h: 0.03 }, value: 'alone' })]);
    expect(out.at(-1)).toMatchObject({ text: 'alone', rect: { x: 0.3, y: 0.5 } });
  });
});
