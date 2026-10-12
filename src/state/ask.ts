import { create } from 'zustand';

/** A question for the user: a name to type (input) or a yes/no (confirm). */
export type Ask = { title: string; body?: string; input?: string; placeholder?: string; confirm: string; destructive?: boolean };
type Request = Ask & { at: number; resolve: (answer: string | null) => void };

/** One pending question at a time; the dialog in the root layout answers it. */
export const useAsk = create<{ request: Request | null }>(() => ({ request: null }));

/** Resolves with the typed text (or "" for a confirmation), or null when cancelled. */
export function ask(q: Ask): Promise<string | null> {
  return new Promise((resolve) => {
    useAsk.getState().request?.resolve(null);
    useAsk.setState({
      request: {
        ...q,
        at: Date.now(),
        resolve: (answer) => {
          useAsk.setState({ request: null });
          resolve(answer);
        },
      },
    });
  });
}
