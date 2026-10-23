import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { elevation, fonts, radius, space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { OTHER, useAsk } from '@/paper/state/ask';
import { usePalette } from '@/paper/state/prefs';
import { Button, T } from './primitives';
import { useModal } from './useModal';

let backdropPressed = false;

/** Modal answering ask(); mounted once in the root layout. */
export function AskDialog() {
  const p = usePalette();
  const request = useAsk((s) => s.request);
  if (!request) return null;
  return (
    <Animated.View entering={FadeIn.duration(160)} style={[StyleSheet.absoluteFill, styles.backdrop, { backgroundColor: p.scrim }]}>
      {/*
        On touch screens the click from the tap that opened the dialog can arrive after it has appeared, on the
        backdrop. Only a press that starts on the backdrop closes it.
      */}
      <Pressable
        accessibilityLabel={t.cancel}
        style={StyleSheet.absoluteFill}
        onPressIn={() => (backdropPressed = true)}
        onPress={() => {
          if (backdropPressed) request.resolve(null);
          backdropPressed = false;
        }}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center} pointerEvents="box-none">
        <Card key={request.title} />
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

function Card() {
  const p = usePalette();
  const request = useAsk((s) => s.request)!;
  const [value, setValue] = useState(request.input ?? '');
  const hasInput = request.input !== undefined;
  const ok = !hasInput || value.trim().length > 0;
  const submit = () => ok && request.resolve(hasInput ? value.trim() : '');
  const ref = useModal(() => request.resolve(null));

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      accessibilityViewIsModal
      testID="ask-dialog"
      style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}
    >
      <View ref={ref} role="dialog" aria-modal aria-label={request.title} tabIndex={-1} style={styles.inner}>
        <T v="headline" accessibilityRole="header" style={{ fontSize: 17 }}>
          {request.title}
        </T>
        {request.body ? (
          <T v="body" color={p.inkSoft}>
            {request.body}
          </T>
        ) : null}
        {hasInput && (
          <TextInput
            testID="ask-input"
            autoFocus
            value={value}
            onChangeText={setValue}
            onSubmitEditing={submit}
            placeholder={request.placeholder}
            placeholderTextColor={p.muted}
            accessibilityLabel={request.placeholder ?? request.title}
            autoComplete="off"
            autoCorrect={false}
            selectTextOnFocus
            returnKeyType="done"
            style={[styles.input, { color: p.ink, backgroundColor: p.hairline }]}
          />
        )}
        <View style={styles.actions}>
          <Button testID="ask-cancel" label={t.cancel} kind="quiet" onPress={() => request.resolve(null)} />
          {request.other && <Button testID="ask-other" label={request.other} kind="quiet" onPress={() => request.resolve(OTHER)} />}
          <Button testID="ask-confirm" label={request.confirm} onPress={submit} style={request.destructive ? { backgroundColor: p.markRing } : undefined} />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { zIndex: 100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  card: { width: '100%', maxWidth: 400, padding: space.xl, borderRadius: radius.lg + 2, borderWidth: StyleSheet.hairlineWidth },
  inner: { gap: space.md, outlineStyle: 'none' } as object,
  input: { height: 44, borderRadius: radius.md, paddingHorizontal: space.md, fontFamily: fonts.sans, fontSize: 16, outlineStyle: 'none' } as object,
  // A long confirm label (German, a phone) goes under Cancel rather than past the card's edge.
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.sm, marginTop: space.xs },
});
