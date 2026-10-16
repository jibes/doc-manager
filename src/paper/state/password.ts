import { create } from 'zustand';

type Request = { name: string; wrong: boolean; resolve: (password: string | null) => void };

/** One pending password request at a time; the dialog in the root layout answers it. */
export const usePasswordPrompt = create<{ request: Request | null }>(() => ({ request: null }));

export function askPassword(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    usePasswordPrompt.getState().request?.resolve(null);
    usePasswordPrompt.setState({
      request: {
        name,
        wrong,
        resolve: (pw) => {
          usePasswordPrompt.setState({ request: null });
          resolve(pw);
        },
      },
    });
  });
}

/** Passwords live in memory for the session only; they are never written to storage. */
const session = new Map<string, string>();
export const rememberPassword = (id: string, password: string) => session.set(id, password);
export const passwordFor = (id: string) => session.get(id);
