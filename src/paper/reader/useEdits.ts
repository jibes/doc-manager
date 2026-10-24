import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { DocHandle, History } from '@/core/engine/types';
import { t } from '@/core/i18n';
import { ask, OTHER } from '@/paper/state/ask';
import type { Current } from '@/core/lib/fileActions';
import { holdBrowserBack } from '@/core/lib/backGuard';
import { goBack } from '@/core/lib/nav';
import { invalidate } from '@/paper/archive/indexer';
import { changedElsewhere, writeFrom } from '@/paper/archive/versions';
import { FILE_MOVED, repo, type DocRecord } from '@/core/storage';
import { libraryActions } from '@/paper/state/library';
import { drafting, useDrafts } from './drafts';

/** A form field being typed in commits its text when it loses focus: before saving, printing or sharing. */
const NO_STEPS: History = { undo: 0, redo: 0, state: 0 };

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
export function useEdits(doc: DocRecord, handle: DocHandle, focused = true, close: () => void = goBack) {
  const [dirty, setDirty] = useState(false);
  const typed = useDrafts((s) => s.field || s.details);
  const unsaved = dirty || typed;
  const [notice, setNotice] = useState<string | null>(null);
  // Edits so far: a save only clears `dirty` when nothing was edited while it was being written.
  const edits = useRef(0);
  // `dirty` as of now, for a Back that comes before the next render (a field's blur commits it just before).
  const dirtyNow = useRef(false);
  const release = useRef<() => void>(() => {});
  // Per handle: the document opened again (its details saved, its text added) starts without steps.
  const [kept, setKept] = useState<{ handle: DocHandle; history: History }>({ handle, history: NO_STEPS });
  const history = kept.handle === handle ? kept.history : NO_STEPS;
  const steps = useRef<{ handle: DocHandle; history: History; savedAt: number }>({ handle, history: NO_STEPS, savedAt: 0 });
  const setHistory = useCallback(
    (h: History) => {
      // Steps back to the file as last saved (as opened, at first): there, nothing is unsaved.
      const savedAt = steps.current.handle === handle ? steps.current.savedAt : 0;
      steps.current = { handle, history: h, savedAt };
      setKept({ handle, history: h });
    },
    [handle],
  );

  const markDirty = useCallback(() => {
    edits.current++;
    dirtyNow.current = true;
    setDirty(true);
  }, []);
  const clearNotice = useCallback(() => setNotice(null), []);

  /** Before each change: undo comes back to here. */
  const step = useCallback(() => void handle.step().then(setHistory, () => {}), [handle, setHistory]);
  /** One change back (or forward): every page is drawn again. */
  const travel = useCallback(
    async (back: boolean) => {
      commitField();
      const h = await (back ? handle.undo() : handle.redo()).catch(() => null);
      if (!h) return false;
      setHistory(h);
      edits.current++;
      const clean = h.state === steps.current.savedAt;
      dirtyNow.current = !clean;
      setDirty(!clean);
      return true;
    },
    [handle, setHistory],
  );
  const undo = useCallback(() => travel(true), [travel]);
  const redo = useCallback(() => travel(false), [travel]);

  /** True once saved. */
  const save = useCallback(async () => {
    const fail = () => {
      setNotice(t.saveFailed);
      return false;
    };
    commitField();
    // A document only viewed is kept first (the answer is a gesture too, for the write access below).
    if (!(await libraryActions().ensureKept(doc.id))) return false;
    // Ask for write access first, while the click or key press still counts as a user gesture.
    if (!(await repo.requestAccess(doc.id, true).catch(() => false))) return fail();
    // Changed meanwhile (synced from another device, written by another app): writing over it is asked about.
    if ((await changedElsewhere(doc.id, handle)) && (await ask({ title: t.changedTitle, body: t.changedBody, confirm: t.changedOverwrite, destructive: true })) === null) return false;
    // The version written: an undo while it is being written still knows which one is on disk.
    const writing = steps.current.handle === handle ? steps.current.history.state : null;
    const bytes = await handle.save().catch(() => null);
    if (!bytes) return fail();
    // The engine works in order: every edit counted by now is in these bytes; one made while writing isn't.
    const saved = edits.current;
    const failed = await writeFrom(doc.id, handle, bytes).then(() => null, (e: unknown) => e);
    // Gone from where it was (moved, trashed, filed elsewhere): said so, and not made again there.
    if (failed) return failed instanceof Error && failed.message === FILE_MOVED ? (setNotice(`${t.saveFailed} ${t.fileGone}`), false) : fail();
    // Its size as now: browsers tell a linked document's file by its name and size.
    libraryActions().patchDoc(doc.id, { bytes: bytes.byteLength });
    invalidate(doc.id);
    if (writing !== null && steps.current.handle === handle) steps.current.savedAt = writing;
    // Unsaved still when something changed meanwhile (an edit, or an undo away from what was written).
    const clean = edits.current === saved || (writing !== null && steps.current.history.state === writing);
    if (clean) {
      dirtyNow.current = false;
      setDirty(false);
    }
    setNotice(doc.linked ? t.savedInPlace(doc.fileName) : t.savedCopy);
    return true;
  }, [doc.id, doc.linked, doc.fileName, handle]);

  /** For share / download / print: the document with its edits, saved or not (undefined: as it was opened). */
  const current: Current = useCallback(() => {
    commitField();
    // A field committed just now is with the engine already: these bytes come after it.
    return dirtyNow.current || edits.current > 0 || drafting() ? handle.bytes() : undefined;
  }, [handle]);

  const leave = useCallback(() => {
    if (!dirtyNow.current && !drafting()) return close();
    // Saving first is the usual answer; leaving without, the other one. Text still typed in the details isn't
    // in the PDF's changes: then it's only discard or stay.
    // A field being typed in is a change to the PDF too (saving commits it); typed details are not.
    const edited = dirtyNow.current || useDrafts.getState().field;
    const details = useDrafts.getState().details;
    void ask({ title: t.unsavedTitle, body: edited ? (details ? t.unsavedSaveFirstDetails : t.unsavedSaveFirst) : t.unsavedLeave, ...(edited ? { confirm: t.save, other: t.discard } : { confirm: t.discard, destructive: true }) }).then(async (answer) => {
      if (answer === null) return;
      if (edited && answer !== OTHER && !(await save())) return;
      useDrafts.setState({ field: false, details: false });
      release.current();
      close();
    });
  }, [close, save]);

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

  /** Changes not saved as of now (not only as of the last render): a field committed by this very click too. */
  const dirtyAtOnce = useCallback(() => dirtyNow.current || useDrafts.getState().field, []);

  return { dirty, dirtyAtOnce, unsaved, markDirty, step, history, undo, redo, save, current, leave, notice, clearNotice };
}
