import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { Button, T } from '@/paper/components/primitives';
import { useModal } from '@/paper/components/useModal';
import { elevation, fonts, radius, space, type Palette } from '@/core/design/tokens';
import { t } from '@/core/i18n';

export type NoteRequest = { initial: string; quote: string; resolve: (text: string | null) => void };

/** Writes or edits the comment on a highlight. */
export function NoteDialog({ request, palette: p }: { request: NoteRequest | null; palette: Palette }) {
  if (!request) return null;
  return (
    <Animated.View entering={FadeIn.duration(160)} style={[StyleSheet.absoluteFill, styles.backdrop, { backgroundColor: p.scrim }]}>
      <Pressable accessibilityLabel={t.cancel} style={StyleSheet.absoluteFill} onPress={() => request.resolve(null)} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center} pointerEvents="box-none">
        <Card request={request} palette={p} />
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

function Card({ request, palette: p }: { request: NoteRequest; palette: Palette }) {
  const [value, setValue] = useState(request.initial);
  // Esc and Back cancel (before the reader under it reacts), Tab stays in it, the focus goes back where it was.
  const ref = useModal(() => request.resolve(null));
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      accessibilityViewIsModal
      testID="note-dialog"
      style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}
    >
      <View ref={ref} role="dialog" aria-modal aria-label={t.noteTitle} tabIndex={-1} style={styles.inner}>
      <T v="headline" style={{ fontSize: 17 }}>
        {t.noteTitle}
      </T>
      {!!request.quote && (
        <T v="caption" color={p.muted} numberOfLines={3} style={[styles.quote, { borderColor: p.hairline }]}>
          {request.quote}
        </T>
      )}
      <TextInput
        testID="note-input"
        autoFocus
        multiline
        value={value}
        onChangeText={setValue}
        placeholder={t.notePlaceholder}
        accessibilityLabel={t.noteTitle}
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.ink, backgroundColor: p.hairline }]}
      />
      <View style={styles.actions}>
        <Button label={t.cancel} kind="quiet" onPress={() => request.resolve(null)} />
        <Button testID="note-save" label={t.save} onPress={() => request.resolve(value.trim())} />
      </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { zIndex: 100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  card: {
    width: '100%',
    maxWidth: 420,
    padding: space.xl,
    borderRadius: radius.lg + 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  quote: { borderLeftWidth: 2, paddingLeft: space.md, fontStyle: 'italic' },
  input: {
    minHeight: 110,
    borderRadius: radius.md,
    padding: space.md,
    fontFamily: fonts.sans,
    fontSize: 16,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as object,
  inner: { gap: space.md, outlineStyle: 'none' } as object,
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.sm },
});
