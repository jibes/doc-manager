import { create } from 'zustand';

import { t } from '@/core/i18n';
import { useIntake } from '@/paper/archive/intake';
import { drafting, useDrafts } from '@/paper/reader/drafts';
import { ask, OTHER } from './ask';

/** A document in the pane: its library id, where to open it (a search match), and its row in the list. */
export type PaneDoc = { id: string; page?: string; q?: string; key?: string };

/**
 * A wide desktop window shows the list of documents and, beside it, the one opened from it (`split`: the list is
 * showing, with room for the pane). `cursor`: the row the keyboard is on.
 */
/** The reader in the pane: whether its PDF has changes not saved, and saving them (true once saved). */
export type PaneReader = { dirty: () => boolean; save: () => Promise<boolean> };

export const usePane = create<{ split: boolean; doc: PaneDoc | null; cursor: string | null; reader: PaneReader | null }>(() => ({ split: false, doc: null, cursor: null, reader: null }));

/** Whether the document in the pane may go: asked when it has unsaved changes (saved first, or left without). */
async function mayLeave(): Promise<boolean> {
  const { doc: now, reader } = usePane.getState();
  if (!now || !(useIntake.getState().editing.includes(now.id) || drafting())) return true;
  // Changes to the PDF can be saved; typed details alone can only go.
  const edited = !!reader?.dirty();
  const details = useDrafts.getState().details;
  const answer = await ask(
    edited
      ? { title: t.unsavedTitle, body: details ? t.unsavedSaveFirstDetails : t.unsavedSaveFirst, confirm: t.save, other: t.discard }
      : { title: t.unsavedTitle, body: details && !useDrafts.getState().field ? t.unsavedLeaveDetails : t.unsavedLeave, confirm: t.discard, destructive: true },
  );
  if (answer === null) return false;
  if (edited && answer !== OTHER && !(await reader!.save())) return false;
  useDrafts.setState({ field: false, details: false });
  return true;
}

/** Opens a document in the pane, if there is one (false: open it as a screen). */
export async function showInPane(doc: PaneDoc): Promise<boolean> {
  if (!usePane.getState().split) return false;
  if (usePane.getState().doc?.id === doc.id && !doc.page) return true;
  if (await mayLeave()) usePane.setState({ doc, ...(doc.key ? { cursor: doc.key } : {}) });
  // Kept: the cursor goes back to it.
  else usePane.setState((s) => ({ cursor: s.doc?.key ?? s.cursor }));
  return true;
}

export const closePane = () => usePane.setState({ doc: null });
