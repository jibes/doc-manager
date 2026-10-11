import { requireNativeModule } from 'expo-modules-core';

import type { OutlineItem, SearchHit, Size } from '@/engine/types';

type OpenResult = { handle: string; pageCount: number; pageSizes: Size[]; title?: string; author?: string };

type PdfEngineNative = {
  open(uri: string, password: string | null): Promise<OpenResult>;
  render(handle: string, page: number, width: number): Promise<{ uri: string; width: number; height: number }>;
  outline(handle: string): Promise<OutlineItem[]>;
  search(handle: string, query: string): Promise<SearchHit[]>;
  close(handle: string): void;
};

export default requireNativeModule<PdfEngineNative>('PdfEngine');
