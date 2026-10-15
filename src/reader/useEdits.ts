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
import { useLibrary } from '@/state/library';
import { drafting, useDrafts } from './drafts';

/** A form field being typed in commits its text when it loses focus: before saving, printing or sharing. */
function commitField() {
  if (Platform.OS !== 'web') return;
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest?.('.fl')) el.blur();
}

/**
 * Unsaved edits (form fields, annotations) to an open document. Saving writes the PDF back:
 * to the user's own file when it was opened in place, to the library copy otherwise. `unsaved`: those, or text
 * still being typed (a field, the details), which leaving asks about too.
 */
export function useEdits(doc: DocRecord, handle: DocHandle, focused = true) {
  const [dirty, setDirty] = useState(false);
  const typed = useDrafts((s) => s.field || s.details);
  const unsaved = dirty || typed;
  const [notice, setNotice] = useState<string | null>(null);
  // Edits so far: a save only clears `dirty` when nothing was edited while it was being written.
  const edits = useRef(0);
  // `dirty` as of now, for a Back that comes before the next render (a field's blur commits it just before).
  const dirtyNow = useRef(false);
  const release = useRef<() => void>(() => {});

  const markDirty = useCallback(() => {
    edits.current++;
    dirtyNow.current = true;
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
      // Its size as now: browsers tell a linked document's file by its name and size.
      useLibrary.getState().patchDoc(doc.id, { bytes: bytes.byteLength });
      invalidate(doc.id);
      if (edits.current === saved) {
        dirtyNow.current = false;
        setDirty(false);
      }
      setNotice(doc.linked ? t.savedInPlace(doc.fileName) : t.savedCopy);
    } catch {
      setNotice(t.saveFailed);
    }
  }, [doc.id, doc.linked, doc.fileName, handle]);

  /** For share / download / print: the document with its edits, saved or not (undefined: as it was opened). */
  const current: Current = useCallback(() => {
    commitField();
    // A field committed just now is with the engine already: these bytes come after it.
    return dirtyNow.current || edits.current > 0 || drafting() ? handle.bytes() : undefined;
  }, [handle]);

  const leave = useCallback(() => {
    if (!dirtyNow.current && !drafting()) return goBack();
    void ask({ title: t.unsavedTitle, body: t.unsavedLeave, confirm: t.discard, destructive: true }).then((answer) => {
      if (answer === null) return;
      useDrafts.setState({ field: false, details: false });
      release.current();
      goBack();
    });
  }, []);

  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  }, [leave]);

  // Typed text belongs to this document only.
  useEffect(() => () => useDrafts.setState({ field: false, details: false }), []);

  // Closing the tab: the browser's own "leave site?" prompt (also for a document another one was opened over).
  useEffect(() => {
    if (Platform.OS !== 'web' || !unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  // The browser's Back (and the Android app's, when the page doesn't answer it first) asks too: only the document
  // in front holds it (another opened over it holds its own).
  useEffect(() => {
    if (Platform.OS !== 'web' || !unsaved || !focused) return;
    const unhold = holdBrowserBack(() => leaveRef.current());
    release.current = unhold;
    return () => unhold();
  }, [unsaved, focused]);

  return { dirty, unsaved, markDirty, save, current, leave, notice, clearNotice };
}
