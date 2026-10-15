import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { elevation, fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { usePasswordPrompt } from '@/state/password';
import { usePalette } from '@/state/prefs';
import { Icon } from './Icon';
import { Button, T } from './primitives';
import { useModal } from './useModal';

/** Modal answering askPassword(); mounted once in the root layout. */
export function PasswordDialog() {
  const p = usePalette();
  const request = usePasswordPrompt((s) => s.request);
  if (!request) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(160)}
     
      style={[StyleSheet.absoluteFill, styles.backdrop, { backgroundColor: p.scrim }]}
    >
      <Pressable accessibilityLabel={t.cancel} style={StyleSheet.absoluteFill} onPress={() => request.resolve(null)} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center} pointerEvents="box-none">
        {/* Keyed so a retry starts with an empty field; the backdrop stays put. */}
        <Card key={`${request.name}:${request.wrong}`} />
      </KeyboardAvoidingView>
    </Animated.View>
  );
}

function Card() {
  const p = usePalette();
  const request = usePasswordPrompt((s) => s.request)!;
  const [value, setValue] = useState('');
  const submit = () => value && request.resolve(value);
  const cancel = () => request.resolve(null);
  // Esc and Back cancel, Tab stays in it, the focus goes back where it was.
  const ref = useModal(cancel);

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      accessibilityViewIsModal
      testID="password-dialog"
      style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}
    >
      <View ref={ref} role="dialog" aria-modal aria-label={t.passwordTitle} tabIndex={-1} style={styles.inner}>
      <View style={[styles.badge, { backgroundColor: p.accentSoft }]}>
        <Icon name="lock" color={p.accent} size={22} />
      </View>
      <T v="headline" style={{ fontSize: 17 }}>
        {t.passwordTitle}
      </T>
      <T v="body" color={p.inkSoft} style={{ textAlign: 'center' }}>
        {t.passwordBody(request.name)}
      </T>
      <TextInput
        testID="password-input"
        autoFocus
        secureTextEntry
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        placeholder={t.passwordPlaceholder}
        accessibilityLabel={t.passwordPlaceholder}
        placeholderTextColor={p.muted}
        autoComplete="off"
        returnKeyType="go"
        style={[
          styles.input,
          {
            color: p.ink,
            backgroundColor: p.hairline,
            borderColor: request.wrong ? p.markRing : 'transparent',
          },
        ]}
      />
      <T v="caption" color={request.wrong ? p.markRing : p.muted} accessibilityLiveRegion="polite" style={{ textAlign: 'center' }}>
        {request.wrong ? t.passwordWrong : t.passwordNote}
      </T>
      <View style={styles.actions}>
        <Button label={t.cancel} kind="quiet" onPress={cancel} />
        <Button testID="password-submit" label={t.add} onPress={submit} />
      </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: { zIndex: 100 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    padding: space.xl,
    borderRadius: radius.lg + 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  inner: { alignItems: 'center', gap: space.md, outlineStyle: 'none' } as object,
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    alignSelf: 'stretch',
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1.5,
    paddingHorizontal: space.md,
    fontFamily: fonts.sans,
    fontSize: 16,
    outlineStyle: 'none',
  } as object,
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm, marginTop: space.xs },
});
