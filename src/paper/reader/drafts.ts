import { create } from 'zustand';

import { t } from '@/core/i18n';
import { ask } from '@/paper/state/ask';

/**
 * What is typed but not in the document yet: a form field being typed in (until the engine has its text), details
 * not saved. Leaving asks about them as about unsaved edits.
 */
export const useDrafts = create<{ field: boolean; details: boolean }>(() => ({ field: false, details: false }));

export const drafting = () => {
  const d = useDrafts.getState();
  return d.field || d.details;
};

/** Whether to let the details typed in go. */
export const discardDetails = async () => (await ask({ title: t.unsavedTitle, body: t.detailsUnsaved, confirm: t.discard, destructive: true })) !== null;
