import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { DocHandle } from '@/engine/types';
import { t } from '@/i18n';
import { ask } from '@/state/ask';
import type { Current } from '@/lib/fileActions';
import { goBack } from '@/lib/nav';
import { invalidate } from '@/archive/indexer';
import { repo, type DocRecord } from '@/storage';

/**
 * Unsaved edits (form fields, annotations) to an open document. Saving writes the PDF back:
 * to the user's own file when it was opened in place, to the library copy otherwise.
 */
export function useEdits(doc: DocRecord, handle: DocHandle) {
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const markDirty = useCallback(() => setDirty(true), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  const save = useCallback(async () => {
    try {
      // Ask for write access first, while the click or key press still counts as a user gesture.
      if (!(await repo.requestAccess(doc.id, true))) throw new Error('denied');
      await repo.writeFile(doc.id, await handle.save());
      invalidate(doc.id);
      setDirty(false);
      setNotice(doc.linked ? t.savedInPlace(doc.fileName) : t.savedCopy);
    } catch {
      setNotice(t.saveFailed);
    }
  }, [doc.id, doc.linked, doc.fileName, handle]);

  /** For share / download / print: include edits that aren't saved yet. */
  const current: Current = useCallback(() => (dirty ? handle.save() : undefined), [dirty, handle]);

  const leave = useCallback(() => {
    if (!dirty) return goBack();
    void ask({ title: t.unsavedTitle, body: t.unsavedLeave, confirm: t.discard, destructive: true }).then((answer) => answer !== null && goBack());
  }, [dirty]);

  // Closing the tab with unsaved edits: the browser's own "leave site?" prompt.
  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return { dirty, markDirty, save, current, leave, notice, clearNotice };
}
