import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { changeRules, destination, fileDocument, inboxFiles, loadRules, propose, suggest, useRules, withRules, type Proposal } from '@/archive/inbox';
import type { Details } from '@/archive/pdfInfo';
import { openDoc } from '@/archive/Results';
import type { Rule } from '@/archive/rules';
import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { aiReady } from '@/scan/ai';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 820;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const [notice, setNotice] = useState<string | null>(null);

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

  const fileOne = async (item: Proposal) => {
    if (!archive || !valid(item)) return false;
    const path = pathOf(item);
    setBusy((b) => new Set(b).add(item.entry.id));
    try {
      await fileDocument(archive, dir, item, detailsOf(item, edits[item.entry.id]), path);
      setItems((list) => (list ?? []).filter((x) => x.entry.id !== item.entry.id));
      setNotice(t.inboxFiled(path.join('/')));
      return true;
    } catch (e) {
      setNotice(t.inboxFailed(message(e)));
      return false;
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(item.entry.id);
        return next;
      });
    }
  };
  const fileAll = async () => {
    for (const item of proposals) if (!(await fileOne(item))) break;
  };
  const askAi = async (item: Proposal) => {
    setBusy((b) => new Set(b).add(item.entry.id));
    try {
      const d = await suggest({ ...item, details: detailsOf(item, edits[item.entry.id]) }, ai);
      setEdits((all) => ({ ...all, [item.entry.id]: { title: d.title, sender: d.sender, type: d.type, date: d.date, tags: d.tags.join(', ') } }));
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(item.entry.id);
        return next;
      });
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl - 4 }}>
          <ScreenHeader title={t.inboxTitle}>
            {here && proposals.length > 1 && <Button testID="inbox-file-all" kind="quiet" label={t.inboxFileAll(proposals.length)} onPress={() => void fileAll()} />}
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
              {items && proposals.length === 0 && <T color={p.muted}>{t.inboxEmpty}</T>}
              <View style={{ gap: space.lg }}>
                {proposals.map((item) => (
                  <Card
                    key={item.entry.id}
                    item={item}
                    edits={edits[item.entry.id] ?? {}}
                    onEdit={(e) => setEdits((all) => ({ ...all, [item.entry.id]: { ...all[item.entry.id], ...e } }))}
                    path={pathOf(item)}
                    valid={valid(item)}
                    busy={busy.has(item.entry.id)}
                    onFile={() => void fileOne(item)}
                    onSuggest={aiReady(ai) ? () => void askAi(item) : undefined}
                    onOpen={() => void openDoc({ key: item.entry.id, place: { kind: 'folder', root: archive, rootName: '', entry: item.entry }, name: item.entry.name, size: item.entry.size, modified: item.entry.modified, ...detailsOf(item), pages: [] }, 0, '').catch((e) => setNotice(message(e)))}
                  />
                ))}
              </View>
              <RulesEditor archive={archive} onError={(e) => setNotice(message(e))} />
            </>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} onDismiss={() => setNotice(null)} />
    </View>
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

function Field({ label, value, onChange, testID, placeholder, error }: { label: string; value: string; onChange: (v: string) => void; testID: string; placeholder?: string; error?: boolean }) {
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

function Card(props: {
  item: Proposal;
  edits: Edits;
  onEdit: (e: Edits) => void;
  path: string[];
  valid: boolean;
  busy: boolean;
  onFile: () => void;
  onSuggest?: () => void;
  onOpen: () => void;
}) {
  const { item, edits, onEdit, path, valid, busy } = props;
  const p = usePalette();
  const d = detailsOf(item, edits);
  return (
    <View testID="inbox-item" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
      <View style={styles.cardHead}>
        <Icon name="documents" size={20} color={p.muted} />
        <T numberOfLines={1} style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
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
      <T v="caption" color={p.inkSoft} testID="inbox-dest" numberOfLines={2}>
        → {path.join(' / ')}
      </T>
      <View style={styles.actions}>
        {props.onSuggest && <Button testID="inbox-ai" kind="quiet" label={t.inboxSuggest} onPress={props.onSuggest} disabled={busy} />}
        <Button testID="inbox-file" icon="check" label={t.inboxFile} onPress={props.onFile} disabled={busy || !valid} />
      </View>
    </View>
  );
}

/** The template and the rules, kept in the archive. */
function RulesEditor({ archive, onError }: { archive: string; onError: (e: unknown) => void }) {
  const p = usePalette();
  const rules = useRules();
  const [template, setTemplate] = useState<string | null>(null);
  const [draft, setDraft] = useState({ match: '', sender: '', type: '', tags: '' });
  const saveTemplate = () => {
    if (template === null || template.trim() === rules.template) return;
    changeRules(archive, (r) => ({ ...r, template: template.trim() || r.template })).then(() => setTemplate(null), onError);
  };
  const add = () => {
    if (!draft.match.trim()) return;
    const rule: Rule = { id: `r-${Date.now().toString(36)}`, match: draft.match.trim(), sender: draft.sender.trim(), type: draft.type.trim(), tags: tagsOf(draft.tags) };
    changeRules(archive, (r) => ({ ...r, rules: [...r.rules, rule] })).then(() => setDraft({ match: '', sender: '', type: '', tags: '' }), onError);
  };
  const remove = (id: string) => changeRules(archive, (r) => ({ ...r, rules: r.rules.filter((x) => x.id !== id) })).catch(onError);
  return (
    <View style={{ marginTop: space.xxl, gap: space.sm }}>
      <T v="kicker" color={p.muted}>
        {t.rulesTitle}
      </T>
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
        <Field label={t.rulesTemplate} value={template ?? rules.template} onChange={setTemplate} testID="rules-template" />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <T v="caption" color={p.muted} style={{ flex: 1 }}>
            {t.rulesTemplateNote}
          </T>
          {template !== null && template.trim() !== rules.template && <Button testID="rules-template-save" kind="quiet" label={t.save} onPress={saveTemplate} />}
        </View>
      </View>
      {rules.rules.length > 0 && (
        <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
          {rules.rules.map((r, i) => (
            <View key={r.id} testID="rule" style={[styles.ruleRow, { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontFamily: fonts.sansMedium, fontSize: 15 }}>{t.ruleSummary(r.match)}</T>
                <T v="caption" color={p.muted}>
                  → {[r.sender, r.type, ...r.tags.map((x) => `#${x}`)].filter(Boolean).join(' · ')}
                </T>
              </View>
              <IconButton testID="rule-remove" icon="trash" size={34} label={t.ruleRemove} onPress={() => void remove(r.id)} />
            </View>
          ))}
        </View>
      )}
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
        <Field label={t.ruleWhen} value={draft.match} onChange={(match) => setDraft({ ...draft, match })} testID="rule-match" placeholder="KoRo, Hanfsamen" />
        <View style={styles.fields}>
          <Field label={t.detailSender} value={draft.sender} onChange={(sender) => setDraft({ ...draft, sender })} testID="rule-sender" />
          <Field label={t.detailType} value={draft.type} onChange={(type) => setDraft({ ...draft, type })} testID="rule-type" />
        </View>
        <Field label={t.detailTags} value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} testID="rule-tags" placeholder={t.inboxTags} />
        <View style={styles.actions}>
          <Button testID="rule-add" kind="quiet" icon="plus" label={t.ruleAdd} onPress={add} disabled={!draft.match.trim()} />
        </View>
      </View>
      <T v="caption" color={p.muted}>
        {t.rulesNote}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginRight: -space.sm },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  input: { fontFamily: fonts.sans, fontSize: 15, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, outlineStyle: 'none' } as object,
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
});
