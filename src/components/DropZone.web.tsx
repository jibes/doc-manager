import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { t } from '@/i18n';
import { fonts, radius } from '@/design/tokens';
import { isFileHandle, type FileHandle } from '@/lib/fsa';
import { itemsFromFiles, itemsFromHandles } from '@/lib/pick';
import type { ImportItem } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { T } from './primitives';

type LaunchQueue = { setConsumer(fn: (p: { files: FileHandle[] }) => void): void };
type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> };

/** Window-wide PDF drop target, plus OS "Open with" via the File Handling API. */
export function DropZone({ children, onFiles }: { children: ReactNode; onFiles: (items: ImportItem[]) => void }) {
  const p = usePalette();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles);
  useEffect(() => {
    cb.current = onFiles;
  });

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const overFn = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      // Handles must be requested synchronously, inside the drop event; they let the file open in place.
      const dt = e.dataTransfer;
      const files = [...(dt?.files ?? [])];
      const handles = [...(dt?.items ?? [])].filter((i) => i.kind === 'file').map((i) => (i as HandleItem).getAsFileSystemHandle?.().catch(() => null) ?? null);
      Promise.all(handles).then((hs) => {
        const items = itemsFromFiles(files, hs.map((h) => (isFileHandle(h) ? h : null)));
        if (items.length) cb.current(items);
      });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    (window as unknown as { launchQueue?: LaunchQueue }).launchQueue?.setConsumer(async ({ files }) => {
      const items = await itemsFromHandles(files);
      if (items.length) cb.current(items);
    });
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <View style={{ flex: 1 }}>
      {children}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.overlay,
          { backgroundColor: p.glass, opacity: over ? 1 : 0, transform: [{ scale: over ? 1 : 1.015 }] },
        ]}
      >
        <View style={[styles.frame, { borderColor: p.accent }]}>
          <T style={{ fontFamily: fonts.sansSemi, fontSize: 28, letterSpacing: -0.6 }}>{t.dropTitle}</T>
          <T v="label" color={p.muted}>{t.dropBody}</T>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    padding: 20,
    backdropFilter: 'blur(14px)',
    transitionDuration: '200ms',
    transitionProperty: 'opacity, transform',
  } as object,
  frame: {
    flex: 1,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
});
