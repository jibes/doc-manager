/** The same document on every device: its bytes up to the end of the first "%%EOF" (what later edits append to keep), at most 64 KiB. */
export async function docKey(bytes: ArrayBuffer): Promise<string> {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65536));
  let end = head.length;
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x25 && head[i + 2] === 0x45 && head[i + 3] === 0x4f && head[i + 4] === 0x46) {
      end = i + 5;
      break;
    }
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', head.slice(0, end)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
