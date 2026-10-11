import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorText, t } from '@/i18n';
import { Button, T } from '@/components/primitives';
import { fonts, space } from '@/design/tokens';
import { goBack } from '@/lib/nav';
import { Reader } from '@/reader/Reader';
import { useDocument } from '@/reader/useDocument';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';

export default function ReadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const { loaded, load } = useLibrary();
  const doc = useLibrary((s) => s.docs.find((d) => d.id === id));
  const state = useDocument(id);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    load();
    const t = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(t);
  }, [load]);

  const missing = loaded && !doc;
  const message = useMemo(() => (missing ? t.missing : state.status === 'error' ? errorText(state.message) : null), [missing, state]);

  if (message) {
    return (
      <View style={[styles.center, { backgroundColor: p.canvas }]}>
        <T style={{ fontFamily: fonts.sansSemi, fontSize: 22, letterSpacing: -0.4, textAlign: 'center' }}>{t.cantOpen}</T>
        <T v="body" color={p.muted} style={{ textAlign: 'center', maxWidth: 420 }}>{message}</T>
        <Button label={t.backToLibrary} kind="quiet" onPress={goBack} style={{ marginTop: space.md }} />
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

  return <Reader doc={doc} handle={state.handle} cache={state.cache} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
});
