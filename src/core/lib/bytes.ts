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

/**
 * A short mark of a file's content, to tell whether it changed: its length and a hash of its start, its end and
 * every 61st byte between (an edit moves or changes those: a PDF's later revision is appended, a full save rewrites it).
 */
export function fingerprint(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  const edge = Math.min(b.length, 65536);
  let h = 0x811c9dc5;
  const mix = (i: number) => (h = Math.imul(h ^ b[i], 0x01000193));
  for (let i = 0; i < edge; i++) mix(i);
  for (let i = edge; i < b.length - edge; i += 61) mix(i);
  for (let i = Math.max(edge, b.length - edge); i < b.length; i++) mix(i);
  return `${b.length}:${(h >>> 0).toString(36)}`;
}
