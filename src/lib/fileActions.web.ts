import { repo, type DocRecord } from '@/storage';

export const canDownload = true;

async function asFile(doc: DocRecord): Promise<File> {
  const src = await repo.source(doc.id);
  const bytes = src.kind === 'bytes' ? src.bytes : await (await fetch(src.uri)).arrayBuffer();
  return new File([bytes], doc.fileName, { type: 'application/pdf' });
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

export async function downloadDoc(doc: DocRecord) {
  save(await asFile(doc));
}

/** System share sheet where the browser can share files (mostly mobile); otherwise a download. */
export async function shareDoc(doc: DocRecord) {
  const file = await asFile(doc);
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

/**
 * Prints the original PDF (not the app UI). Desktop browsers print it from a hidden frame;
 * where PDFs can't load in frames (mobile), it opens in the browser's own viewer instead.
 */
export async function printDoc(doc: DocRecord) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  // Open synchronously within the click so popup blockers allow it.
  const popup = coarse ? window.open('', '_blank') : null;
  const url = URL.createObjectURL(await asFile(doc));
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
