import type { FormField, TextLine } from '@/core/engine/types';

/**
 * A filled-in form's values in its text: a field's value goes after its label on the same row ("Full name: Ada"),
 * a check box's or radio button's state before the words beside it ("☑ I agree"). A field with no label beside
 * it is a line of its own where it is. Empty fields and passwords add nothing.
 */
export function withFields(lines: TextLine[], fields: FormField[]): TextLine[] {
  if (!fields.length) return lines;
  const out = lines.map((l) => ({ ...l }));
  const size = lines.length ? [...lines.map((l) => l.size)].sort((a, b) => a - b)[lines.length >> 1] : 11;
  for (const f of fields) {
    const mark = f.type === 'checkbox' ? (f.checked ? '☑' : '☐') : f.type === 'radio' ? (f.checked ? '◉' : '◯') : null;
    const value = mark ?? fieldText(f);
    if (!value) continue;
    // On the field's row: the line's middle within the field's height, or the field's middle within the line's.
    const row = (l: TextLine) => {
      const mid = l.rect.y + l.rect.h / 2;
      const fmid = f.rect.y + f.rect.h / 2;
      return (mid >= f.rect.y && mid <= f.rect.y + f.rect.h) || (fmid >= l.rect.y && fmid <= l.rect.y + l.rect.h);
    };
    const slack = 0.01;
    let best: TextLine | null = null;
    let gap = Infinity;
    for (const l of out) {
      if (l.ocr || !row(l)) continue;
      // A mark's words are right of it; a value's label left of it.
      const d = mark ? l.rect.x - (f.rect.x + f.rect.w) : f.rect.x - (l.rect.x + l.rect.w);
      if (d >= -slack && d < gap) [best, gap] = [l, d];
    }
    if (best && gap < 0.25) best.text = mark ? `${mark} ${best.text}` : `${best.text.replace(/\s*:?\s*$/, '')}: ${value}`;
    else out.push({ text: value, rect: f.rect, size, bold: false, italic: false, hyphen: false });
  }
  return out;
}

function fieldText(f: FormField): string {
  if (f.password) return '';
  if ((f.type === 'combo' || f.type === 'list') && f.options?.some((o) => o.selected))
    return f.options
      .filter((o) => o.selected)
      .map((o) => o.label)
      .join(', ');
  return f.value.replace(/\s*\n\s*/g, ' ').trim();
}
