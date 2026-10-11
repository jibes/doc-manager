import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { Button, T } from '@/components/primitives';
import { elevation, fonts, radius, space, type Palette } from '@/design/tokens';
import { t } from '@/i18n';

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
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      accessibilityViewIsModal
      testID="note-dialog"
      style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}
    >
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
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.ink, backgroundColor: p.hairline }]}
      />
      <View style={styles.actions}>
        <Button label={t.cancel} kind="quiet" onPress={() => request.resolve(null)} />
        <Button testID="note-save" label={t.save} onPress={() => request.resolve(value.trim())} />
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
    gap: space.md,
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
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
});
