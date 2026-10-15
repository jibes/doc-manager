/** Whether `whole` begins with all of `head`: the same file, or `head` with something appended to it (a PDF's later revisions). */
export function startsWith(whole: ArrayBuffer, head: ArrayBuffer): boolean {
  if (whole.byteLength < head.byteLength) return false;
  const a = new Uint8Array(whole, 0, head.byteLength);
  const b = new Uint8Array(head);
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The same bytes. */
export const sameBytes = (a: ArrayBuffer, b: ArrayBuffer) => a.byteLength === b.byteLength && startsWith(a, b);
