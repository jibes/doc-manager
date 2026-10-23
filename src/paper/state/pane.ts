import { create } from 'zustand';

import { t } from '@/core/i18n';
import { useIntake } from '@/paper/archive/intake';
import { drafting, useDrafts } from '@/paper/reader/drafts';
import { ask } from './ask';

/** A document in the pane: its library id, where to open it (a search match), and its row in the list. */
export type PaneDoc = { id: string; page?: string; q?: string; key?: string };

/**
 * A wide desktop window shows the list of documents and, beside it, the one opened from it (`split`: the list is
 * showing, with room for the pane). `cursor`: the row the keyboard is on.
 */
export const usePane = create<{ split: boolean; doc: PaneDoc | null; cursor: string | null }>(() => ({ split: false, doc: null, cursor: null }));

/** Whether the document in the pane may go: asked when it has unsaved changes. */
async function mayLeave(): Promise<boolean> {
  const now = usePane.getState().doc;
  if (!now || !(useIntake.getState().editing.includes(now.id) || drafting())) return true;
  if ((await ask({ title: t.unsavedTitle, body: t.unsavedLeave, confirm: t.discard, destructive: true })) === null) return false;
  useDrafts.setState({ field: false, details: false });
  return true;
}

/** Opens a document in the pane, if there is one (false: open it as a screen). */
export async function showInPane(doc: PaneDoc): Promise<boolean> {
  if (!usePane.getState().split) return false;
  if (usePane.getState().doc?.id === doc.id && !doc.page) return true;
  if (await mayLeave()) usePane.setState({ doc, ...(doc.key ? { cursor: doc.key } : {}) });
  return true;
}

export const closePane = () => usePane.setState({ doc: null });
