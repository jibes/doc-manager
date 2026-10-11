import { useEffect, useState } from 'react';

import { engine, type DocHandle } from '@/engine';
import { repo } from '@/storage';
import { RasterCache } from './rasterCache';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; handle: DocHandle; cache: RasterCache };

export function useDocument(id: string): State {
  const [result, setResult] = useState<{ id: string; state: State } | null>(null);

  useEffect(() => {
    let alive = true;
    let opened: { handle: DocHandle; cache: RasterCache } | null = null;
    repo
      .source(id)
      .then((src) => engine.open(src))
      .then((handle) => {
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
  }, [id]);

  return result?.id === id ? result.state : { status: 'loading' };
}
