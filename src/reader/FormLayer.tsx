import type { FormField, FormValue } from '@/engine/types';

/** Native: form filling needs PDFium in the app (deferred); fields show as printed. */
export function FormLayer(_: {
  fields: FormField[];
  width: number;
  height: number;
  scale: number;
  filter: string;
  onChange: (index: number, value: FormValue) => Promise<void>;
}) {
  return null;
}
