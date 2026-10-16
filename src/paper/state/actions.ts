import { create } from 'zustand';

import type { IconName } from '@/paper/components/Icon';

export type Action = { key: string; icon: IconName; label: string; destructive?: boolean; onPress: () => void };
type Sheet = { title: string; actions: Action[] };

/** One action sheet at a time; the sheet in the root layout shows it. */
export const useActions = create<{ sheet: Sheet | null }>(() => ({ sheet: null }));

/** What can be done with something (a long press, or its ⋯ button). */
export const showActions = (title: string, actions: Action[]) => useActions.setState({ sheet: { title, actions } });
export const closeActions = () => useActions.setState({ sheet: null });
