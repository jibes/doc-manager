import { beforeEach, describe, expect, it, vi } from 'vitest';

// A folder in memory: path → text.
const files = new Map<string, string>();
const at = (path: string[]) => path.join('/');
vi.mock('@/core/lib/folders', () => ({
  folders: {
    readText: async (_root: string, path: string[]) => files.get(at(path)) ?? null,
    writeText: async (_root: string, path: string[], text: string) => void files.set(at(path), text),
    removeText: async (_root: string, path: string[]) => void files.delete(at(path)),
    listNames: async (_root: string, path: string[]) => [...files.keys()].filter((k) => k.startsWith(`${at(path)}/`)).map((k) => k.slice(at(path).length + 1)),
  },
}));
vi.mock('@/core/i18n', () => ({ t: { settingsUnreadable: 'unreadable' } }));

import { defaultKinds, mergeKinds } from './kindList';
import { mergeViews, parseViews, serializeViews, type SavedView } from './facets';
import { mergeRules, type Rules } from './rules';
import { readSettingsMerged } from './settingsFile';

const view = (id: string, name: string) => ({ id, name, query: '', filter: {}, sort: 'date' }) as SavedView;

describe('sync conflicts in settings files', () => {
  beforeEach(() => files.clear());

  it('merges: what the newer file has stays, what only the copy has is added', () => {
    expect(mergeViews([view('a', 'Tax'), view('b', 'Car')], [view('b', 'Old car'), view('c', 'Flat')]).map((v) => v.name)).toEqual(['Tax', 'Car', 'Flat']);
    const rules = (ids: string[], template: string): Rules => ({ template, rules: ids.map((id) => ({ id, match: id, sender: '', type: '', tags: [] })) });
    expect(mergeRules(rules(['a'], 'new'), rules(['a', 'b'], 'old'))).toEqual(rules(['a', 'b'], 'new'));
    const kept = { ...defaultKinds('de'), tags: [{ name: 'Gesundheit', about: 'neu' }], onlyTags: true };
    const copy = { ...defaultKinds('de'), types: [{ name: 'Rechnung', about: 'alt' }, { name: 'Steuer', about: '' }], tags: [{ name: 'gesundheit', about: 'alt' }, { name: 'Auto', about: '' }], onlyTags: false };
    const merged = mergeKinds(kept, copy);
    expect(merged.types.at(-1)).toEqual({ name: 'Steuer', about: '' });
    expect(merged.types.find((x) => x.name === 'Rechnung')?.about).toMatch(/^Fordert/);
    expect(merged.tags).toEqual([{ name: 'Gesundheit', about: 'neu' }, { name: 'Auto', about: '' }]);
    expect(merged.onlyTags).toBe(true);
  });

  it('takes the conflict copies in, writes the result back and removes them', async () => {
    files.set('.tessel/views.json', serializeViews([view('a', 'Tax')]));
    files.set('.tessel/views.sync-conflict-20261030-101500-ABCDEF7.json', serializeViews([view('b', 'Car')]));
    files.set('.tessel/rules.sync-conflict-20261030-101500-ABCDEF7.json', '{}');
    const text = await readSettingsMerged('root', ['.tessel', 'views.json'], parseViews, mergeViews, serializeViews);
    expect(parseViews(text!).map((v) => v.name)).toEqual(['Tax', 'Car']);
    expect(parseViews(files.get('.tessel/views.json')!).map((v) => v.name)).toEqual(['Tax', 'Car']);
    // Only its own copies: another file's stays.
    expect([...files.keys()].sort()).toEqual(['.tessel/rules.sync-conflict-20261030-101500-ABCDEF7.json', '.tessel/views.json']);
  });

  it('without conflicts, reads the file as it is (and nothing is written)', async () => {
    const stored = serializeViews([view('a', 'Tax')]);
    files.set('.tessel/views.json', stored);
    expect(await readSettingsMerged('root', ['.tessel', 'views.json'], parseViews, mergeViews, serializeViews)).toBe(stored);
    expect(await readSettingsMerged('root', ['.tessel', 'kinds.json'], parseViews, mergeViews, serializeViews)).toBeNull();
  });
});
