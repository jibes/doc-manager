import { router } from 'expo-router';
import { create } from 'zustand';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { destination, fileDocument, inboxFiles, loadRules, propose, refreshInboxCount, suggest, useRules, useRulesUnreadable, withRules, type Proposal } from '@/paper/archive/inbox';
import { typedDate } from '@/paper/archive/rules';
import type { Details } from '@/paper/archive/pdfInfo';
import { openDoc } from '@/paper/archive/Results';
import { discard, restore } from '@/paper/archive/trash';
import { goTab, SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { Thumbnail } from '@/paper/components/DocItems';
import { Field } from '@/paper/components/Field';
import { Icon } from '@/paper/components/Icon';
import { Button, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { fonts, radius, space } from '@/core/design/tokens';
import { aiMessage, opError, t } from '@/core/i18n';
import { aiReady } from '@/paper/scan/ai';
import { libraryActions } from '@/paper/state/library';
import { usePalette, usePrefs } from '@/paper/state/prefs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** How long the model may take to suggest details. */
const AI_WAIT_MS = 120_000;

type Edits = Partial<Omit<Details, 'tags'>> & { tags?: string };
/** What went wrong, in words: the codes storage throws ("denied") as the other screens put them. */
const message = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const changed = /^changed:([^\n]*)\n(.*)$/s.exec(m);
  if (changed) return t.inboxChangedMeanwhile(changed[1], changed[2]);
  const known = opError(e);
  return known !== t.opFailed ? known : m || known;
};
const tagsOf = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** A proposal's details with what the user typed over them. */
const detailsOf = (p: Proposal, e: Edits = {}): Details => ({
  title: e.title ?? p.details.title,
  sender: e.sender ?? p.details.sender,
  type: e.type ?? p.details.type,
  // Typed as on paper ("2.10.2026") it files as YYYY-MM-DD; one that isn't a date stays as typed (and holds it back).
  date: e.date !== undefined ? (typedDate(e.date) ?? e.date) : p.details.date,
  tags: e.tags !== undefined ? tagsOf(e.tags) : p.details.tags,
});

/** The inbox: each new document with its proposed details and destination, to check and file. */
/** What was typed into the inbox's cards, by file (until filed or the app closes). */
const useInboxEdits = create<{ edits: Record<string, Edits> }>(() => ({ edits: {} }));
/** What a document's typed details are kept under: a later file of the same name (a scanner's next Scan.pdf) is another. */
const editKey = (item: Proposal) => `${item.entry.id}|${item.entry.size}|${item.entry.modified}`;

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
  // Kept while the app runs: leaving the inbox (Back, a document opened) doesn't lose what was typed.
  const edits = useInboxEdits((st) => st.edits);
  const setEdits = (change: (all: Record<string, Edits>) => Record<string, Edits>) => useInboxEdits.setState((st) => ({ edits: change(st.edits) }));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // Being filed now (a second tap, or File all, leaves them be).
  const filing = useRef(new Set<string>());
  const [filingAll, setFilingAll] = useState(false);
  // Filing with rules that couldn't be read would file by others (the default ones): it waits for them.
  const rulesUnreadable = useRulesUnreadable((s) => s.unreadable);
  const [notice, setNoticeText] = useState<string | null>(null);
  // Each notice its own, so a second like the first (two discards) gets its own time and Undo.
  const [noticeId, setNoticeId] = useState(0);
  const setNotice = (text: string | null) => {
    setNoticeText(text);
    if (text) setNoticeId((n) => n + 1);
  };
  // Undo for the last removed: put back from the trash, and the inbox read again.
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [reread, setReread] = useState(0);
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
  }, [archive, here, reread]);

  const proposals = (items ?? []).map((item) => withRules(item, rules));
  const pathOf = (item: Proposal) => destination(detailsOf(item, edits[editKey(item)]), item.entry, rules, t.inboxUnknownSender);
  const valid = (item: Proposal) => {
    const d = detailsOf(item, edits[editKey(item)]);
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
      detailsOf(item, edits[editKey(item)]),
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
        setNotice(e instanceof Error && e.message.startsWith('changed:') ? message(e) : t.inboxFailed(message(e)));
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
      (trashed) => {
        gone(item);
        setNotice(t.trashedN(1));
        setUndo(() =>
          trashed?.length
            ? () =>
                void restore(archive, trashed).then(
                  () => (setReread((n) => n + 1), void refreshInboxCount()),
                  (e: unknown) => setNotice(message(e)),
                )
            : null,
        );
      },
      (e: unknown) => setNotice(message(e)),
    );
  };
  // The model fills in the details; what the user types meanwhile stays. It gets two minutes.
  const askAi = async (item: Proposal) => {
    const id = item.entry.id;
    const before = edits[editKey(item)] ?? {};
    setBusy((b) => new Set(b).add(id));
    await suggest({ ...item, details: detailsOf(item, before) }, ai, AbortSignal.timeout(AI_WAIT_MS)).then(
      (d) => {
        const got: Edits = { title: d.title, sender: d.sender, type: d.type, date: d.date, tags: d.tags.join(', ') };
        setEdits((all) => {
          const now = all[editKey(item)] ?? {};
          const kept = Object.fromEntries((Object.keys(got) as (keyof Edits)[]).filter((k) => now[k] !== before[k]).map((k) => [k, now[k]]));
          return { ...all, [editKey(item)]: { ...now, ...got, ...kept } };
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
            {archive && here && <Button testID="inbox-rules" kind="quiet" label={rules.rules.length ? `${t.rulesTitle} · ${rules.rules.length}` : t.rulesTitle} onPress={() => router.push({ pathname: '/rules', params: { from: 'inbox' } })} />}
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
                    edits={edits[editKey(item)] ?? {}}
                    onEdit={(e) => setEdits((all) => ({ ...all, [editKey(item)]: { ...all[editKey(item)], ...e } }))}
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
      <Toast message={notice} id={noticeId} onDismiss={() => (setNotice(null), setUndo(null))} action={undo && notice === t.trashedN(1) ? { label: t.undo, onPress: undo } : undefined} />
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
      {/* The whole head opens it: its first page, its name and the arrow. */}
      <Pressable
        testID="inbox-preview"
        accessibilityRole="button"
        accessibilityLabel={`${t.inboxOpen}: ${item.entry.name}`}
        onPress={props.onOpen}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.cardHead, styles.headPress, hovered && { backgroundColor: p.hairline }]}
      >
        <Thumbnail picture={{ kind: 'file', root: props.archive, entry: item.entry }} width={56} />
        <T numberOfLines={2} style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
          {item.entry.name}
        </T>
        <Icon name="chevronRight" size={22} color={p.muted} />
      </Pressable>
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
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // Pressable to its edges, its content where it was.
  headPress: { margin: -space.sm, padding: space.sm, borderRadius: radius.md },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  duplicate: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
});
