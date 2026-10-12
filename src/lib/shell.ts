/**
 * The Android app (shell/android) runs this web app in a WebView and exposes window.TesselShell for what
 * a WebView can't do alone: receive files from other apps, share, save and print, and colour the system bars.
 * Absent everywhere else, so every caller falls back to the plain web behaviour.
 */
type ShellApi = {
  pending(): string;
  begin(name: string, mime: string): string;
  append(token: string, base64: string): void;
  finish(token: string, action: 'share' | 'save' | 'print'): void;
  theme(background: string, dark: boolean): void;
};

export const shell: ShellApi | undefined = typeof window !== 'undefined' ? (window as unknown as { TesselShell?: ShellApi }).TesselShell : undefined;

/** Fired by the shell when files arrive from "Open with" or "Share". */
export const SHELL_OPEN_EVENT = 'tessel-shell-open';

/** Files handed over by the shell since the last call. */
export async function takeShellFiles(): Promise<File[]> {
  if (!shell) return [];
  const list = JSON.parse(shell.pending()) as { url: string; name: string; type: string }[];
  const files = await Promise.all(
    list.map(async (f) => {
      const blob = await (await fetch(f.url)).blob();
      return new File([blob], f.name, { type: f.type || blob.type });
    }),
  );
  return files;
}

/** ~384 KB of bytes per bridge call: a multiple of 3, so each chunk base64-encodes on its own. */
const CHUNK = 3 * 128 * 1024;

/** Hands a file to the shell for the system share sheet, save dialog or print service. */
export async function sendToShell(file: Blob, name: string, action: 'share' | 'save' | 'print') {
  if (!shell) throw new Error('No shell');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const token = shell.begin(name, file.type || 'application/octet-stream');
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, i + CHUNK);
    let bin = '';
    for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode(...part.subarray(j, j + 0x8000));
    shell.append(token, btoa(bin));
  }
  shell.finish(token, action);
}
