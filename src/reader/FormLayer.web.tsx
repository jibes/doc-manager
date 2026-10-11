import { memo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react';

import type { FormField, FormValue } from '@/engine/types';
import { t } from '@/i18n';

/**
 * Form fields over the page. PDFium draws every field (value, check mark, highlight); these controls are
 * invisible stand-ins that take focus, typing and clicks, and become visible only while a text field is
 * being edited. Native controls give keyboard order, IME, autofill and screen-reader roles for free.
 */
const STYLE_ID = 'tessel-form-layer';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .fl { position:absolute; inset:0; pointer-events:none; }
    .fl > * { position:absolute; box-sizing:border-box; pointer-events:auto; margin:0; border:0; border-radius:2px;
      background:transparent; color:transparent; caret-color:transparent; font-family:Helvetica, Arial, sans-serif; outline:none; }
    .fl > *:focus-visible { box-shadow:0 0 0 2px rgba(47,79,134,0.75); }
    .fl > .editing { background:#fff; color:#111; caret-color:#111; box-shadow:0 0 0 2px rgba(47,79,134,0.75); padding:0 3px; }
    .fl textarea.editing { padding:2px 3px; resize:none; }
    .fl button { cursor:pointer; }
    .fl select { opacity:0; cursor:pointer; }
  `;
  document.head.appendChild(el);
}

type Props = {
  fields: FormField[];
  width: number;
  height: number;
  /** CSS px per PDF point, for type size. */
  scale: number;
  /** The page's theme tint, so an open field matches the page. */
  filter: string;
  onChange: (index: number, value: FormValue) => Promise<void>;
};

// Taps on fields mustn't reach the page (which toggles the toolbars).
const stop = (e: SyntheticEvent) => e.stopPropagation();

export const FormLayer = memo(function FormLayer({ fields, width, height, scale, filter, onChange }: Props) {
  return (
    <div className="fl" style={{ filter }} onClick={stop} onPointerDown={stop} onTouchStart={stop} onMouseDown={stop}>
      {fields
        .filter((f) => !f.readOnly)
        .map((f) => {
          const box: CSSProperties = { left: f.rect.x * width, top: f.rect.y * height, width: f.rect.w * width, height: f.rect.h * height };
          const label = f.name || t.formField;
          switch (f.type) {
            case 'text':
              return <TextField key={f.index} field={f} style={box} label={label} scale={scale} onChange={onChange} />;
            case 'checkbox':
            case 'radio':
              return (
                <button
                  key={f.index}
                  type="button"
                  role={f.type}
                  aria-checked={!!f.checked}
                  aria-label={label}
                  data-testid={`field-${f.name}`}
                  style={box}
                  // Radios only switch on; checkboxes toggle.
                  onClick={() => void onChange(f.index, f.type === 'radio' ? true : !f.checked)}
                />
              );
            default: {
              const options = f.options ?? [];
              const selected = options.flatMap((o, i) => (o.selected ? [String(i)] : []));
              return (
                <select
                  key={f.index}
                  aria-label={label}
                  data-testid={`field-${f.name}`}
                  multiple={f.multiple}
                  style={box}
                  value={f.multiple ? selected : (selected[0] ?? '')}
                  onChange={(e) => void onChange(f.index, [...e.target.selectedOptions].map((o) => Number(o.value)))}
                >
                  {!f.multiple && selected.length === 0 && <option value="" disabled />}
                  {options.map((o, i) => (
                    <option key={i} value={String(i)}>
                      {o.label}
                    </option>
                  ))}
                </select>
              );
            }
          }
        })}
    </div>
  );
});

/** Shows its text only while focused; commits on blur or Enter, Escape reverts. */
function TextField({
  field: f,
  style,
  label,
  scale,
  onChange,
}: {
  field: FormField;
  style: CSSProperties;
  label: string;
  scale: number;
  onChange: Props['onChange'];
}) {
  const value = f.value.replace(/\r\n?/g, '\n');
  const [draft, setDraft] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const editing = draft !== null;
  const h = (style.height as number) ?? 20;
  const fontSize = f.multiline ? Math.max(11, Math.min(18, 11 * scale)) : Math.max(11, Math.min(h * 0.68, 18 * scale));
  const commit = () => {
    if (!cancelRef.current && draft !== null && draft !== value) void onChange(f.index, draft);
    cancelRef.current = false;
    setDraft(null);
  };
  const common = {
    'aria-label': label,
    'data-testid': `field-${f.name}`,
    className: editing ? 'editing' : undefined,
    style: { ...style, fontSize },
    value: draft ?? value,
    onFocus: () => setDraft(value),
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelRef.current = true;
        (e.target as HTMLElement).blur();
      } else if (e.key === 'Enter' && !f.multiline) (e.target as HTMLElement).blur();
    },
  };
  return f.multiline ? <textarea {...common} /> : <input {...common} type={f.password ? 'password' : 'text'} autoComplete="off" />;
}
