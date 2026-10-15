import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { DocHandle } from '@/engine/types';
import { t } from '@/i18n';
import { ask } from '@/state/ask';
import type { Current } from '@/lib/fileActions';
import { holdBrowserBack } from '@/lib/backGuard';
import { goBack } from '@/lib/nav';
import { invalidate } from '@/archive/indexer';
import { repo, type DocRecord } from '@/storage';

/** A form field being typed in commits its text when it loses focus: before saving, printing or sharing. */
function commitField() {
  if (Platform.OS !== 'web') return;
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest?.('.fl')) el.blur();
}

/**
 * Unsaved edits (form fields, annotations) to an open document. Saving writes the PDF back:
 * to the user's own file when it was opened in place, to the library copy otherwise.
 */
export function useEdits(doc: DocRecord, handle: DocHandle) {
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Edits so far: a save only clears `dirty` when nothing was edited while it was being written.
  const edits = useRef(0);
  const release = useRef<() => void>(() => {});

  const markDirty = useCallback(() => {
    edits.current++;
    setDirty(true);
  }, []);
  const clearNotice = useCallback(() => setNotice(null), []);

  const save = useCallback(async () => {
    commitField();
    try {
      // Ask for write access first, while the click or key press still counts as a user gesture.
      if (!(await repo.requestAccess(doc.id, true))) throw new Error('denied');
      const bytes = await handle.save();
      // The engine works in order: every edit counted by now is in these bytes; one made while writing isn't.
      const saved = edits.current;
      await repo.writeFile(doc.id, bytes);
      invalidate(doc.id);
      if (edits.current === saved) setDirty(false);
      setNotice(doc.linked ? t.savedInPlace(doc.fileName) : t.savedCopy);
    } catch {
      setNotice(t.saveFailed);
    }
  }, [doc.id, doc.linked, doc.fileName, handle]);

  /** For share / download / print: the document with its edits, saved or not (undefined: as it was opened). */
  const current: Current = useCallback(() => {
    commitField();
    return dirty || edits.current > 0 ? handle.bytes() : undefined;
  }, [dirty, handle]);

  const leave = useCallback(() => {
    if (!dirty) return goBack();
    void ask({ title: t.unsavedTitle, body: t.unsavedLeave, confirm: t.discard, destructive: true }).then((answer) => {
      if (answer === null) return;
      release.current();
      goBack();
    });
  }, [dirty]);

  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  }, [leave]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty) return;
    // Closing the tab: the browser's own "leave site?" prompt.
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    // The browser's Back (and the Android app's, when the page doesn't answer it first) asks too.
    const unhold = holdBrowserBack(() => leaveRef.current());
    release.current = unhold;
    return () => {
      window.removeEventListener('beforeunload', warn);
      unhold();
    };
  }, [dirty]);

  return { dirty, markDirty, save, current, leave, notice, clearNotice };
}
