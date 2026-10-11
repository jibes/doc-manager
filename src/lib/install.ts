/** Native apps are installed from the store; nothing to offer. */
export function useInstall(): { kind: 'prompt' | 'ios' | null; install: () => Promise<boolean> } {
  return { kind: null, install: async () => false };
}
