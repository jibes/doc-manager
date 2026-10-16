import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { destination, fileDocument, inboxFiles, loadRules, propose, refreshInboxCount, suggest, useRules, useRulesUnreadable, withRules, type Proposal } from '@/paper/archive/inbox';
import type { Details } from '@/paper/archive/pdfInfo';
import { openDoc } from '@/paper/archive/Results';
import { discard } from '@/paper/archive/trash';
import { goTab, SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { Thumbnail } from '@/paper/components/DocItems';
import { Field } from '@/paper/components/Field';
import { Button, IconButton, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { fonts, radius, space } from '@/core/design/tokens';
import { aiMessage, t } from '@/core/i18n';
import { aiReady } from '@/paper/scan/ai';
import { libraryActions } from '@/paper/state/library';
import { usePalette, usePrefs } from '@/paper/state/prefs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How long the model may take to suggest details. */
const AI_WAIT_MS = 120_000;

type Edits = Partial<Omit<Details, 'tags'>> & { tags?: string };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tagsOf = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** A proposal's details with what the user typed over them. */
const detailsOf = (p: Proposal, e: Edits = {}): Details => ({
  title: e.title ?? p.details.title,
  sender: e.sender ?? p.details.sender,
  type: e.type ?? p.details.type,
  date: e.date ?? p.details.date,
  tags: e.tags !== undefined ? tagsOf(e.tags) : p.details.tags,
});

/** The inbox: each new document with its proposed details and destination, to check and file. */
export default function Inbox() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const here = usePrefs((s) => s.inboxHere);
  const ai = usePrefs((s) => s.ai);
  const setPrefs = usePrefs((s) => s.set);
  const rules = useRules();
  const [dir, setDir] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Being filed now (a second tap, or File all, leaves them be).
  const filing = useRef(new Set<string>());
  const [filingAll, setFilingAll] = useState(false);
  // Filing with rules that couldn't be read would file by others (the default ones): it waits for them.
  const rulesUnreadable = useRulesUnreadable((s) => s.unreadable);
  const [notice, setNotice] = useState<string | null>(null);
  // While filing makes a document searchable: how far reading its text has come.
  const [progress, setProgress] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!archive || !here) return;
    let alive = true;
    readInbox(archive, (r) => alive && setReading(r)).then(
      (read) => {
        if (!alive) return;
        setDir(read.dir);
        setItems(read.items);
        setReading(null);
      },
      (e) => {
        if (!alive) return;
        setItems([]);
        setReading(null);
        setNotice(message(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [archive, here]);

  const proposals = (items ?? []).map((item) => withRules(item, rules));
  const pathOf = (item: Proposal) => destination(detailsOf(item, edits[item.entry.id]), item.entry, rules, t.inboxUnknownSender);
  const valid = (item: Proposal) => {
    const d = detailsOf(item, edits[item.entry.id]);
    return !d.date || DATE.test(d.date);
  };

  const gone = (item: Proposal) => {
    setItems((list) => (list ?? []).filter((x) => x.entry.id !== item.entry.id));
    void refreshInboxCount();
  };
  /** Files one; false when it failed (it says why). */
  const fileOne = async (item: Proposal) => {
    const id = item.entry.id;
    if (!archive || !valid(item) || filing.current.has(id)) return true;
    filing.current.add(id);
    const path = pathOf(item);
    setBusy((b) => new Set(b).add(id));
    const filed = await fileDocument(
      archive,
      dir,
      item,
      detailsOf(item, edits[id]),
      path,
      (done, total) => setProgress((all) => ({ ...all, [id]: t.searchableProgress(done, total) })),
      libraryActions().followEntry,
    ).then(
      () => {
        gone(item);
        setNotice(t.inboxFiled(path.join('/')));
        return true;
      },
      (e: unknown) => {
        setNotice(t.inboxFailed(message(e)));
        return false;
      },
    );
    filing.current.delete(id);
    setBusy((b) => {
      const next = new Set(b);
      next.delete(id);
      return next;
    });
    setProgress((all) => {
      const rest = { ...all };
      delete rest[id];
      return rest;
    });
    return filed;
  };
  // One after the other; those whose date isn't valid stay (and it says so), a failure stops it.
  const fileAll = async () => {
    setFilingAll(true);
    const skipped = proposals.filter((item) => !valid(item)).length;
    let stopped = false;
    for (const item of proposals.filter(valid)) {
      if (await fileOne(item)) continue;
      stopped = true;
      break;
    }
    if (skipped && !stopped) setNotice(t.inboxSkipped(skipped));
    setFilingAll(false);
  };
  // A copy that is already filed: the library's documents of it become the filed one, then it goes.
  const discardOne = async (item: Proposal) => {
    if (!archive) return;
    const filed = item.duplicateOf?.place;
    if (filed?.kind === 'folder') await libraryActions().followEntry(item.entry, filed.entry).catch(() => {});
    await discard(archive, dir, [item.entry]).then(
      () => gone(item),
      (e: unknown) => setNotice(message(e)),
    );
  };
  // The model fills in the details; what the user types meanwhile stays. It gets two minutes.
  const askAi = async (item: Proposal) => {
    const id = item.entry.id;
    const before = edits[id] ?? {};
    setBusy((b) => new Set(b).add(id));
    await suggest({ ...item, details: detailsOf(item, before) }, ai, AbortSignal.timeout(AI_WAIT_MS)).then(
      (d) => {
        const got: Edits = { title: d.title, sender: d.sender, type: d.type, date: d.date, tags: d.tags.join(', ') };
        setEdits((all) => {
          const now = all[id] ?? {};
          const kept = Object.fromEntries((Object.keys(got) as (keyof Edits)[]).filter((k) => now[k] !== before[k]).map((k) => [k, now[k]]));
          return { ...all, [id]: { ...now, ...got, ...kept } };
        });
      },
      (e: unknown) => setNotice(aiMessage(e)),
    );
    setBusy((b) => {
      const next = new Set(b);
      next.delete(item.entry.id);
      return next;
    });
  };

  return (
    <SubFrame sub="inbox">
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column }}>
          <ScreenHeader title={t.inboxTitle} up={() => goTab('documents')}>
            {archive && here && <Button testID="inbox-rules" kind="quiet" label={rules.rules.length ? `${t.rulesTitle} · ${rules.rules.length}` : t.rulesTitle} onPress={() => router.push('/rules')} />}
            {here && proposals.length > 1 && <Button testID="inbox-file-all" kind="quiet" label={t.inboxFileAll(proposals.length)} disabled={filingAll || rulesUnreadable} onPress={() => void fileAll()} />}
          </ScreenHeader>

          {!archive ? (
            <View style={{ gap: space.md, alignItems: 'flex-start' }}>
              <T color={p.muted}>{t.inboxNoArchive}</T>
              <Button kind="quiet" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />
            </View>
          ) : !here ? (
            <View style={{ gap: space.md, alignItems: 'flex-start' }}>
              <T color={p.muted}>{t.inboxOtherDevice}</T>
              <Button testID="inbox-here" kind="quiet" icon="inbox" label={t.inboxHere} onPress={() => setPrefs({ inboxHere: true })} />
            </View>
          ) : (
            <>
              {reading && (
                <T v="caption" color={p.muted} testID="inbox-reading">
                  {t.inboxReading(reading.done, reading.total)}
                </T>
              )}
              {rulesUnreadable && (
                <T v="caption" color={p.markRing} testID="inbox-rules-unreadable">
                  {t.inboxRulesUnreadable}
                </T>
              )}
              {items && proposals.length === 0 && <T color={p.muted}>{t.inboxEmpty}</T>}
              <View style={{ gap: space.lg }}>
                {proposals.map((item) => (
                  <Card
                    key={item.entry.id}
                    item={item}
                    archive={archive}
                    edits={edits[item.entry.id] ?? {}}
                    onEdit={(e) => setEdits((all) => ({ ...all, [item.entry.id]: { ...all[item.entry.id], ...e } }))}
                    path={pathOf(item)}
                    valid={valid(item) && !rulesUnreadable}
                    busy={busy.has(item.entry.id)}
                    progress={progress[item.entry.id]}
                    onFile={() => void fileOne(item)}
                    onDiscard={() => void discardOne(item)}
                    onSuggest={aiReady(ai) ? () => void askAi(item) : undefined}
                    onOpen={() => void openDoc({ key: item.entry.id, place: { kind: 'folder', root: archive, rootName: '', entry: item.entry }, name: item.entry.name, size: item.entry.size, modified: item.entry.modified, ...detailsOf(item) }, undefined, '').catch((e) => setNotice(message(e)))}
                  />
                ))}
              </View>
            </>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} onDismiss={() => setNotice(null)} />
    </SubFrame>
  );
}

/** The inbox's documents, read one by one (reporting progress), with the rules as stored now. */
async function readInbox(archive: string, onProgress: (r: { done: number; total: number }) => void) {
  const current = await loadRules(archive);
  const { dir, files } = await inboxFiles(archive);
  const items: Proposal[] = [];
  onProgress({ done: 0, total: files.length });
  for (const [i, entry] of files.entries()) {
    items.push(await propose(archive, entry, current).catch(() => ({ entry, text: '', own: blank(entry.name), details: blank(entry.name) })));
    onProgress({ done: i + 1, total: files.length });
  }
  return { dir, items };
}

const blank = (name: string): Details => ({ title: name.replace(/\.pdf$/i, ''), sender: '', type: '', tags: [], date: '' });

function Card(props: {
  item: Proposal;
  archive: string;
  edits: Edits;
  onEdit: (e: Edits) => void;
  path: string[];
  valid: boolean;
  busy: boolean;
  progress?: string;
  onFile: () => void;
  onDiscard: () => void;
  onSuggest?: () => void;
  onOpen: () => void;
}) {
  const { item, edits, onEdit, path, valid, busy } = props;
  const p = usePalette();
  const d = detailsOf(item, edits);
  return (
    <View testID="inbox-item" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
      <View style={styles.cardHead}>
        <Pressable testID="inbox-preview" accessibilityRole="button" accessibilityLabel={`${t.inboxOpen}: ${item.entry.name}`} onPress={props.onOpen}>
          <Thumbnail picture={{ kind: 'file', root: props.archive, entry: item.entry }} width={56} />
        </Pressable>
        <T numberOfLines={2} style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
          {item.entry.name}
        </T>
        <IconButton icon="chevronRight" size={34} label={t.inboxOpen} onPress={props.onOpen} />
      </View>
      <View style={styles.fields}>
        <Field label={t.detailTitle} value={d.title} onChange={(title) => onEdit({ title })} testID="inbox-title" />
        <Field label={t.detailSender} value={d.sender} onChange={(sender) => onEdit({ sender })} testID="inbox-sender" />
      </View>
      <View style={styles.fields}>
        <Field label={t.detailType} value={d.type} onChange={(type) => onEdit({ type })} testID="inbox-type" placeholder={t.detailTypeHint} />
        <Field label={t.detailDate} value={d.date} onChange={(date) => onEdit({ date })} testID="inbox-date" placeholder={t.detailDateHint} error={!valid} />
      </View>
      <Field label={t.detailTags} value={edits.tags ?? d.tags.join(', ')} onChange={(tags) => onEdit({ tags })} testID="inbox-tags" placeholder={t.inboxTags} />
      {item.duplicateOf && (
        <View style={styles.duplicate}>
          <T v="caption" color={p.markRing} style={{ flex: 1 }} testID="inbox-duplicate">
            {t.inboxDuplicate(item.duplicateOf.name)}
          </T>
          <Button testID="inbox-discard" kind="quiet" icon="trash" label={t.inboxDiscard} a11yLabel={`${t.inboxDiscard}: ${item.entry.name}`} onPress={props.onDiscard} />
        </View>
      )}
      {item.read && (
        <T v="caption" color={p.muted} testID="inbox-no-text">
          {props.progress ?? t.inboxNoText}
        </T>
      )}
      <T v="caption" color={p.inkSoft} testID="inbox-dest" numberOfLines={2}>
        → {path.join(' / ')}
      </T>
      <View style={styles.actions}>
        {props.onSuggest && <Button testID="inbox-ai" kind="quiet" label={t.inboxSuggest} onPress={props.onSuggest} disabled={busy} />}
        <Button testID="inbox-file" icon="check" label={t.inboxFile} a11yLabel={`${t.inboxFile}: ${item.entry.name}`} onPress={props.onFile} disabled={busy || !valid} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginRight: -space.sm },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  duplicate: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
});
