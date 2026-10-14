import { useEffect, useRef, useState } from 'react';

import { engine, type DocHandle } from '@/engine';
import { t } from '@/i18n';
import { openWithPassword } from '@/state/library';
import { passwordFor, rememberPassword } from '@/state/password';
import { repo } from '@/storage';
import { takePreopened } from './preopened';
import { RasterCache } from './rasterCache';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; handle: DocHandle; cache: RasterCache };

/** Opens a stored document, asking for its password if needed (`name` is shown in the prompt). */
export function useDocument(id: string, name: string | undefined, attempt = 0): State {
  const [result, setResult] = useState<{ id: string; attempt: number; state: State } | null>(null);
  // The name only labels the password prompt: the document isn't opened again when it changes (moved, renamed).
  const label = useRef(name);
  useEffect(() => {
    label.current = name;
  });
  const known = name !== undefined;

  useEffect(() => {
    // Wait for the library record: its file name labels the password prompt.
    if (!known) return;
    let alive = true;
    let opened: { handle: DocHandle; cache: RasterCache } | null = null;
    const ahead = attempt === 0 ? takePreopened(id) : undefined;
    (ahead
      ? Promise.resolve({ value: ahead, password: undefined })
      : repo.source(id).then((src) => openWithPassword(label.current ?? '', (pw) => engine.open(src, pw), passwordFor(id)))
    )
      .then((res) => {
        if (!res) throw new Error(t.passwordCancelled);
        if (res.password) rememberPassword(id, res.password);
        const handle = res.value;
        opened = { handle, cache: new RasterCache(handle) };
        if (alive) setResult({ id, attempt, state: { status: 'ready', ...opened } });
        else close();
      })
      .catch((e) => alive && setResult({ id, attempt, state: { status: 'error', message: e instanceof Error ? e.message : String(e) } }));

    function close() {
      opened?.cache.dispose();
      opened?.handle.close();
    }
    return () => {
      alive = false;
      close();
    };
  }, [id, known, attempt]);

  return result?.id === id && result.attempt === attempt ? result.state : { status: 'loading' };
}
