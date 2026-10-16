import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Platform, Pressable, Text, View, type PressableProps, type StyleProp, type TextProps, type ViewStyle } from 'react-native';

import { radius, space, type } from '@/core/design/tokens';
import { usePalette } from '@/paper/state/prefs';
import { Icon, type IconName } from './Icon';

/** A label as read out: without the soft hyphens that let long (German) words break in narrow places. */
export const spoken = (label: string) => label.replace(/\u00ad/g, '');

export function tick() {
  if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
}

type Variant = keyof typeof type;

export function T({ v = 'body', color, style, ...rest }: TextProps & { v?: Variant; color?: string }) {
  const p = usePalette();
  return <Text {...rest} style={[type[v], { color: color ?? p.ink }, style]} />;
}

type IconButtonProps = Omit<PressableProps, 'style'> & {
  icon: IconName;
  label: string;
  active?: boolean;
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({ icon, label, active, size = 40, color, style, onPress, disabled, ...rest }: IconButtonProps) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken(label)}
      disabled={disabled}
      aria-disabled={!!disabled}
      // Toggles: aria-pressed on web (aria-selected isn't valid on buttons); "selected" on native.
      accessibilityState={Platform.OS === 'web' ? undefined : { selected: active }}
      // @ts-expect-error web-only tooltip and toggle state
      title={Platform.OS === 'web' ? spoken(label) : undefined}
      aria-pressed={Platform.OS === 'web' && active !== undefined ? active : undefined}
      hitSlop={6}
      onPress={(e) => {
        tick();
        onPress?.(e);
      }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        {
          width: size,
          height: size,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: active ? p.accentSoft : hovered && !disabled ? p.hairline : 'transparent',
          opacity: disabled ? 0.35 : pressed ? 0.6 : 1,
        },
        style,
      ]}
      {...rest}
    >
      <Icon name={icon} color={color ?? (active ? p.accent : p.ink)} size={Math.round(size * 0.55)} />
    </Pressable>
  );
}

export function Button({
  label,
  icon,
  kind = 'primary',
  onPress,
  style,
  testID,
  disabled,
  a11yLabel,
}: {
  label: string;
  icon?: IconName;
  kind?: 'primary' | 'quiet';
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  disabled?: boolean;
  /** What it is read out as, where the label alone doesn't say what it acts on ("Restore letter.pdf"). */
  a11yLabel?: string;
}) {
  const p = usePalette();
  const fg = kind === 'primary' ? p.accentInk : p.ink;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={spoken(a11yLabel ?? label)}
      disabled={disabled}
      aria-disabled={!!disabled}
      onPress={() => {
        tick();
        onPress?.();
      }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          height: 44,
          paddingHorizontal: space.xl - 2,
          borderRadius: radius.pill,
          backgroundColor: kind === 'primary' ? p.ink : hovered ? p.hairline : 'transparent',
          borderWidth: kind === 'quiet' ? 1 : 0,
          borderColor: p.hairline,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
          // A long label (a folder's name, German) is cut short rather than running past the screen's edge.
          maxWidth: '100%',
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} color={kind === 'primary' ? p.canvas : fg} size={18} strokeWidth={1.9} />}
      <T v="label" numberOfLines={1} color={kind === 'primary' ? p.canvas : fg} style={{ fontFamily: type.headline.fontFamily, flexShrink: 1 }}>
        {label}
      </T>
    </Pressable>
  );
}

export function Divider() {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.hairline }} />;
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
}
