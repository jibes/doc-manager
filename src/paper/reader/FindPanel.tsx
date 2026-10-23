import type { ComponentProps } from 'react';

import { t } from '@/core/i18n';
import type { Palette } from '@/core/design/tokens';
import type { SearchHit } from '@/core/engine/types';
import { ContentsBody } from './ContentsPanel';
import { Panel } from './Panel';
import { SearchField, SearchResults } from './SearchPanel';

type Props = {
  palette: Palette;
  /** Contents, pages, bookmarks, notes: shown while nothing is searched. */
  contents: ComponentProps<typeof ContentsBody>;
  query: string;
  onQuery: (q: string) => void;
  hits: SearchHit[];
  active: number;
  searching: boolean;
  /** Opened to search (⌘F, the find bar): the field takes the keyboard. */
  focus: boolean;
  onPick: (index: number) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
  /** Esc in the field (closes the panel unless given). */
  onEscape?: () => void;
};

/** Find: everything that moves you through the document, a search field over the contents. */
export function FindPanel({ palette: p, contents, query, onQuery, hits, active, searching, focus, onPick, onStep, onClose, onEscape }: Props) {
  return (
    <Panel title={t.find} onClose={onClose} testID="find-panel">
      <SearchField palette={p} query={query} onQuery={onQuery} hits={hits} searching={searching} autoFocus={focus} onStep={onStep} onClose={onEscape ?? onClose} />
      {query.trim() ? <SearchResults palette={p} query={query} hits={hits} active={active} searching={searching} onPick={onPick} /> : <ContentsBody {...contents} />}
    </Panel>
  );
}
