import { memo } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';

import type { PageLink } from '@/engine/types';
import { t } from '@/i18n';

/** Transparent hit areas over link annotations and detected URLs. */
export const LinkLayer = memo(function LinkLayer({
  links,
  width,
  height,
  onLink,
}: {
  links: PageLink[];
  width: number;
  height: number;
  onLink: (l: PageLink) => void;
}) {
  return (
    <>
      {links.map((l, i) => (
        <Pressable
          key={i}
          testID={`link-${l.kind}`}
          accessibilityRole="link"
          accessibilityLabel={l.kind === 'url' ? t.openLink(l.url) : t.goToPageN(l.page + 1)}
          // @ts-expect-error web-only tooltip
          title={Platform.OS === 'web' ? (l.kind === 'url' ? l.url : t.goToPageN(l.page + 1)) : undefined}
          onPress={() => onLink(l)}
          style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.link,
            { left: l.rect.x * width - 2, top: l.rect.y * height - 2, width: l.rect.w * width + 4, height: l.rect.h * height + 4 },
            hovered && styles.hover,
          ]}
        />
      ))}
    </>
  );
});

const styles = StyleSheet.create({
  link: { position: 'absolute', borderRadius: 3, cursor: 'pointer' } as object,
  hover: { backgroundColor: 'rgba(47,79,134,0.12)' },
});
