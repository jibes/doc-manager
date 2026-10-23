/**
 * The desktop app (shell/desktop, Electron on macOS, Windows and Linux) runs this web app in its own window and
 * exposes window.TesselDesktop for the little a browser tab can't do: AI requests without the browser's
 * cross-origin rules, and PDFs opened with Tessel from the Finder or Explorer. Folders, storage and the PDF engine
 * work as in Chromium, so everything else is the website's own code.
 */
type DesktopApi = {
  http(request: { url: string; method: string; headers: Record<string, string>; body: string }, onAbort?: (abort: () => void) => void): Promise<{ status: number; body: string }>;
  onOpen(cb: (files: { name: string; bytes: Uint8Array }[]) => void): void;
  /** Each returns what stops listening. */
  onMenu(cb: (name: string) => void): () => void;
  onUpdate(cb: (info: { version: string | null; url: string | null; failed?: boolean }) => void): () => void;
};

export const desktop: DesktopApi | undefined = typeof window !== 'undefined' ? (window as unknown as { TesselDesktop?: DesktopApi }).TesselDesktop : undefined;
