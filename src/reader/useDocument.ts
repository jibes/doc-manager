import { useEffect, useState } from 'react';

import { engine, type DocHandle } from '@/engine';
import { t } from '@/i18n';
import { openWithPassword } from '@/state/library';
import { passwordFor, rememberPassword } from '@/state/password';
import { repo } from '@/storage';
import { RasterCache } from './rasterCache';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; handle: DocHandle; cache: RasterCache };

/** Opens a stored document, asking for its password if needed (`name` is shown in the prompt). */
export function useDocument(id: string, name: string | undefined): State {
  const [result, setResult] = useState<{ id: string; state: State } | null>(null);

  useEffect(() => {
    // Wait for the library record: its file name labels the password prompt.
    if (name === undefined) return;
    let alive = true;
    let opened: { handle: DocHandle; cache: RasterCache } | null = null;
    repo
      .source(id)
      .then((src) => openWithPassword(name ?? '', (pw) => engine.open(src, pw), passwordFor(id)))
      .then((res) => {
        if (!res) throw new Error(t.passwordCancelled);
        if (res.password) rememberPassword(id, res.password);
        const handle = res.value;
        opened = { handle, cache: new RasterCache(handle) };
        if (alive) setResult({ id, state: { status: 'ready', ...opened } });
        else close();
      })
      .catch((e) => alive && setResult({ id, state: { status: 'error', message: e instanceof Error ? e.message : String(e) } }));

    function close() {
      opened?.cache.dispose();
      opened?.handle.close();
    }
    return () => {
      alive = false;
      close();
    };
  }, [id, name]);

  return result?.id === id ? result.state : { status: 'loading' };
}
