import { StyleSheet, TextInput, View } from 'react-native';

import { fonts, radius, space } from '@/design/tokens';
import { usePalette } from '@/state/prefs';
import { T } from './primitives';

/** A labelled one-line text field. */
export function Field({ label, value, onChange, testID, placeholder, error }: { label: string; value: string; onChange: (v: string) => void; testID: string; placeholder?: string; error?: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flex: 1, minWidth: 140, gap: 2 }}>
      <T v="caption" color={error ? p.markRing : p.muted}>
        {label}
      </T>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.ink, borderColor: error ? p.markRing : p.hairline }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  input: { fontFamily: fonts.sans, fontSize: 15, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, outlineStyle: 'none' } as object,
});
