import { engine } from '@/core/engine';
import { desktop } from '@/core/lib/desktop';
import { sendToShell, shell, shellRequest } from '@/core/lib/shell';
import { repo, type DocRecord } from '@/core/storage';

export const canDownload = true;

/** Unsaved edits: the document as it is on screen, rather than as stored. */
export type Current = () => Promise<ArrayBuffer> | undefined;

async function asFile(doc: DocRecord, current?: Current): Promise<File> {
  const live = current?.();
  const src = live ? null : await repo.source(doc.id);
  const bytes = live ? await live : src!.kind === 'bytes' ? src!.bytes : await (await fetch(src!.uri)).arrayBuffer();
  return new File([bytes], doc.fileName, { type: doc.format === 'epub' ? 'application/epub+zip' : 'application/pdf' });
}

function save(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A file made here (the debug log): saved where the user says (Android app), else downloaded. */
export async function exportFile(file: File) {
  if (shell) return sendToShell(file, file.name, 'save');
  save(file);
}

export async function downloadDoc(doc: DocRecord, current?: Current) {
  const file = await asFile(doc, current);
  // Android app: the system save dialog (any folder, or a cloud drive).
  if (shell) return sendToShell(file, file.name, 'save');
  save(file);
}

/** System share sheet where the browser can share files (mostly mobile); otherwise a download. */
export async function shareDoc(doc: DocRecord, current?: Current) {
  const file = await asFile(doc, current);
  if (shell) return sendToShell(file, file.name, 'share');
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: doc.title });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') save(file);
    }
  } else {
    save(file);
  }
}

/** Several documents in one share sheet (the Android app hands over their files; browsers share them as files). */
export async function shareDocs(docs: DocRecord[]) {
  if (docs.length === 1) return shareDoc(docs[0]);
  if (shell) {
    const links = await Promise.all(docs.map((d) => repo.linkOf(d.id)));
    if (links.every(Boolean)) return shellRequest('share', { uris: links });
  }
  const files = await Promise.all(docs.map((d) => asFile(d)));
  if (shell) {
    // Copies in the app: one at a time.
    for (const f of files) await sendToShell(f, f.name, 'share');
    return;
  }
  if (navigator.canShare?.({ files })) {
    await navigator.share({ files }).catch((e: Error) => {
      if (e.name !== 'AbortError') files.forEach(save);
    });
  } else files.forEach(save);
}

/**
 * Prints the original PDF (not the app UI). Desktop browsers print it from a hidden frame;
 * where PDFs can't load in frames (mobile), it opens in the browser's own viewer instead.
 */
export async function printDoc(doc: DocRecord, current?: Current) {
  // Android app: the system print service, with the PDF itself.
  if (shell) {
    const file = await asFile(doc, current);
    return sendToShell(file, file.name, 'print');
  }
  if (desktop) return printOnDesktop(doc, await asFile(doc, current));
  const coarse = matchMedia('(pointer: coarse)').matches;
  // Open synchronously within the click so popup blockers allow it.
  const popup = coarse ? window.open('', '_blank') : null;
  const url = URL.createObjectURL(await asFile(doc, current));
  if (popup) {
    popup.location.href = url;
    return;
  }
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank');
    }
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };
  document.body.appendChild(frame);
}

/** Long side of a page drawn for printing: about 270 dpi on A4. */
const PRINT_EDGE = 2200;

/** The desktop app: the pages as drawn here, printed by the app (Electron prints no PDF of its own). */
async function printOnDesktop(doc: DocRecord, file: File) {
  const pdf = await file.arrayBuffer();
  const { passwordFor } = await import('@/paper/state/password');
  const handle = await engine.open({ kind: 'bytes', bytes: pdf.slice(0) }, passwordFor(doc.id));
  const pages: ArrayBuffer[] = [];
  try {
    for (let p = 0; p < handle.pageCount; p++) {
      const { width: w, height: h } = handle.pageSizes[p];
      const raster = await handle.renderPage(p, { width: Math.round(w >= h ? PRINT_EDGE : (PRINT_EDGE * w) / h) });
      if (raster.kind !== 'bitmap') continue;
      const canvas = new OffscreenCanvas(raster.width, raster.height);
      const ctx = canvas.getContext('2d')!;
      // Paper is white: a page without a background of its own isn't printed see-through.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, raster.width, raster.height);
      ctx.drawImage(raster.bitmap, 0, 0);
      raster.bitmap.close();
      pages.push(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
    }
  } finally {
    handle.close();
  }
  await desktop!.print({ name: file.name, pages, pdf });
}
