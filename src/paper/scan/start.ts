import { router } from 'expo-router';

import { t } from '@/core/i18n';
import { ask, OTHER } from '@/paper/state/ask';
import { preparingAgain } from './again';
import { useScan } from './session';

/**
 * Opens the scanner for a new scan. Pages of a document being cleaned up (left without saving) are asked about
 * first: they would otherwise replace that document's pages when this scan is saved.
 */
export async function startScan() {
  // A document's pages still coming in to be cleaned up: once they are, they are asked about as below.
  await preparingAgain()?.catch(() => {});
  await useScan.getState().restore();
  const { replaces, clear } = useScan.getState();
  if (replaces) {
    const answer = await ask({ title: t.againOpenTitle, body: t.againOpen(replaces.title), confirm: t.againContinue, other: t.againStartNew });
    if (answer === null) return;
    if (answer === OTHER) clear();
  }
  router.push('/scan');
}
