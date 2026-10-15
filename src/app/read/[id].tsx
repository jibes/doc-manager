import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorText, t } from '@/i18n';
import { Button, T } from '@/components/primitives';
import { fonts, space } from '@/design/tokens';
import { canOpenInPlace, pickHandles } from '@/lib/fsa';
import { goBack } from '@/lib/nav';
import { useBook } from '@/book/useBook';
import { BookReader } from '@/reader/BookReader';
import { Reader } from '@/reader/Reader';
import { useDocument } from '@/reader/useDocument';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { FILE_ACCESS, FILE_MOVED, repo } from '@/storage';

export default function ReadScreen() {
  // `page` and `q`: opened from a search across documents, at the match, highlighted.
  const { id, page: pageParam, q } = useLocalSearchParams<{ id: string; page?: string; q?: string }>();
  // Only for the first opening: a reload (after saving details, say) continues where the reader is.
  const [reloaded, setReloaded] = useState(false);
  const at = useMemo(() => (!reloaded && pageParam != null && Number.isFinite(Number(pageParam)) ? { page: Number(pageParam), query: q } : undefined), [reloaded, pageParam, q]);
  const p = usePalette();
  const loaded = useLibrary((s) => s.loaded);
  const load = useLibrary((s) => s.load);
  const doc = useLibrary((s) => s.docs.find((d) => d.id === id));
  const relink = useLibrary((s) => s.relink);
  const [attempt, setAttempt] = useState(0);
  // Books and PDFs load differently; only the one matching the record runs.
  const isBook = doc?.format === 'epub';
  const pdf = useDocument(id, doc && !isBook ? doc.fileName : undefined, attempt);
  const book = useBook(id, attempt, isBook);
  const state = isBook ? book : pdf;
  const retry = () => setAttempt((a) => a + 1);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    load();
    const t = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(t);
  }, [load]);

  const missing = loaded && !doc;
  const failure = state.status === 'error' ? state.message : null;
  const message = useMemo(() => {
    if (missing) return t.missing;
    if (failure === FILE_ACCESS) return t.accessBody(doc?.fileName ?? '');
    if (failure === FILE_MOVED) return t.fileMoved(doc?.fileName ?? '');
    return failure ? errorText(failure) : null;
  }, [missing, failure, doc?.fileName]);

  if (message) {
    // Linked files: the browser may want the user's OK again, or the file has moved and can be found again.
    const action =
      failure === FILE_ACCESS ? (
        <Button label={t.allowAccess} testID="allow-access" onPress={() => repo.requestAccess(id).then((ok) => ok && retry())} />
      ) : failure === FILE_MOVED && canOpenInPlace() ? (
        <Button
          label={t.locateFile}
          testID="locate-file"
          onPress={async () => {
            const [h] = await pickHandles(false);
            if (h) await relink(id, h).then(retry);
          }}
        />
      ) : null;
    return (
      <View style={[styles.center, { backgroundColor: p.canvas }]}>
        <T style={{ fontFamily: fonts.sansSemi, fontSize: 22, letterSpacing: -0.4, textAlign: 'center' }}>
          {failure === FILE_ACCESS ? t.accessTitle : t.cantOpen}
        </T>
        <T v="body" color={p.muted} style={{ textAlign: 'center', maxWidth: 420 }} testID="open-error">
          {message}
        </T>
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
          {action}
          <Button label={t.backToLibrary} kind="quiet" onPress={goBack} />
        </View>
      </View>
    );
  }

  if (state.status !== 'ready' || !doc) {
    return (
      <View style={[styles.center, { backgroundColor: p.canvas }]}>
        {slow && doc && (
          <T v="label" color={p.muted}>
            {t.opening(doc.title)}
          </T>
        )}
      </View>
    );
  }

  if (state.status === 'ready' && 'book' in state) return <BookReader doc={doc} book={state.book} image={state.image} />;
  if (state.status === 'ready' && 'handle' in state)
    return (
      <Reader
        doc={doc}
        handle={state.handle}
        cache={state.cache}
        onReload={() => {
          setReloaded(true);
          retry();
        }}
        at={at}
      />
    );
  return null;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
});
