import { create } from 'zustand';

import { useLibrary } from '@/state/library';
import { Toast } from './Toast';

/** What the app as a whole says, on whichever screen is in front (files from another app, say). */
const useRootNotice = create<{ text: string | null; id: number }>(() => ({ text: null, id: 0 }));
export const sayRoot = (text: string) => useRootNotice.setState((s) => ({ text, id: s.id + 1 }));

/**
 * At the top of every screen: what couldn't be added to the library (files dropped or opened anywhere, not only
 * on the screens that list them), and what the app says as a whole. Mounted once in the root layout.
 */
export function RootToast() {
  const error = useLibrary((s) => s.error);
  const clearError = useLibrary((s) => s.clearError);
  const { text, id } = useRootNotice();
  return <Toast top message={error ?? text} id={error ? undefined : id} onDismiss={() => (error ? clearError() : useRootNotice.setState({ text: null }))} />;
}
