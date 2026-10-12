import { useEffect, useState } from 'react';

import { repo } from '@/storage';
import { openBook, type Book } from './index';
import { imageUri, readBytes, releaseImageUri } from './platform';

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; book: Book; image: (path: string) => string | undefined };

/** Opens a stored book. Images get URIs on first use and are released when the book closes. */
export function useBook(id: string, attempt = 0, enabled = true): State {
  const [result, setResult] = useState<{ id: string; attempt: number; state: State } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const uris = new Map<string, string>();
    repo
      .source(id)
      .then(readBytes)
      .then((bytes) => {
        const book = openBook(bytes);
        const image = (path: string) => {
          let uri = uris.get(path);
          const img = book.images[path];
          if (!uri && img) {
            uri = imageUri(img.bytes, img.type);
            uris.set(path, uri);
          }
          return uri;
        };
        if (alive) setResult({ id, attempt, state: { status: 'ready', book, image } });
      })
      .catch((e) => alive && setResult({ id, attempt, state: { status: 'error', message: e instanceof Error ? e.message : String(e) } }));
    return () => {
      alive = false;
      uris.forEach(releaseImageUri);
    };
  }, [id, attempt, enabled]);
  return result?.id === id && result.attempt === attempt ? result.state : { status: 'loading' };
}
