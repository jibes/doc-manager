import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { changeRules, loadRules, useRules } from '@/paper/archive/inbox';
import type { Rule } from '@/paper/archive/rules';
import { Field } from '@/paper/components/Field';
import { Button, IconButton, T } from '@/paper/components/primitives';
import { SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { ask } from '@/paper/state/ask';
import { Toast } from '@/paper/components/Toast';
import { fonts, radius, space } from '@/core/design/tokens';
import { opError, t } from '@/core/i18n';
import { usePalette, usePrefs } from '@/paper/state/prefs';

const tagsOf = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The inbox's rules and file name template, on their own screen. */
export default function Rules() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  // Reached from the inbox, or from Documents.
  const fromInbox = useLocalSearchParams<{ from?: string }>().from === 'inbox';
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SubFrame sub="rules">
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column }}>
          <ScreenHeader over={fromInbox ? t.inboxTitle : t.documentsTitle} title={t.rulesTitle} up={() => (router.canGoBack() ? router.back() : router.replace(fromInbox ? '/inbox' : '/'))} />
          {archive ? (
            <RulesEditor archive={archive} onError={(e) => setNotice(opError(e))} />
          ) : (
            <View style={{ gap: space.md, alignItems: 'flex-start' }}>
              <T color={p.muted}>{t.rulesNoArchive}</T>
              <Button kind="quiet" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />
            </View>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} onDismiss={() => setNotice(null)} />
    </SubFrame>
  );
}

/** The template and the rules, kept in the archive. */
function RulesEditor({ archive, onError }: { archive: string; onError: (e: unknown) => void }) {
  const p = usePalette();
  const rules = useRules();
  // As stored now (another device may have changed them; opened directly, nothing has read them yet).
  useEffect(() => void loadRules(archive), [archive]);
  const [template, setTemplate] = useState<string | null>(null);
  const [draft, setDraft] = useState({ match: '', sender: '', type: '', tags: '' });
  // No folders in the Tessel folder: a template names the file only.
  const slash = !!template?.includes('/');
  // Once: leaving the field saves, and the Save button's press comes right after.
  const savingTemplate = useRef(false);
  const saveTemplate = () => {
    if (template === null || slash || template.trim() === rules.template || savingTemplate.current) return;
    savingTemplate.current = true;
    changeRules(archive, (r) => ({ ...r, template: template.trim() || r.template }))
      .then(() => setTemplate(null), onError)
      .finally(() => {
        savingTemplate.current = false;
      });
  };
  // A rule fills in something: words to match alone would do nothing.
  const complete = !!draft.match.trim() && !!(draft.sender.trim() || draft.type.trim() || draft.tags.trim());
  const add = () => {
    if (!complete) return;
    const rule: Rule = { id: `r-${Date.now().toString(36)}`, match: draft.match.trim(), sender: draft.sender.trim(), type: draft.type.trim(), tags: tagsOf(draft.tags) };
    changeRules(archive, (r) => ({ ...r, rules: [...r.rules, rule] })).then(() => setDraft({ match: '', sender: '', type: '', tags: '' }), onError);
  };
  // Asked first: a rule gone is typed again by hand.
  const remove = async (id: string, match: string) => {
    if ((await ask({ title: t.ruleRemove, body: t.ruleSummary(match), confirm: t.remove, destructive: true })) === null) return;
    await changeRules(archive, (r) => ({ ...r, rules: r.rules.filter((x) => x.id !== id) })).catch(onError);
  };
  return (
    <View style={{ gap: space.sm }}>
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
        <Field label={t.rulesTemplate} value={template ?? rules.template} onChange={setTemplate} onDone={saveTemplate} testID="rules-template" />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <T v="caption" color={slash ? p.markRing : p.muted} style={{ flex: 1 }} testID="rules-template-note">
            {slash ? t.rulesTemplateNoSlash : t.rulesTemplateNote}
          </T>
          {template !== null && !slash && template.trim() !== rules.template && <Button testID="rules-template-save" kind="quiet" label={t.save} onPress={saveTemplate} />}
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
              <IconButton testID="rule-remove" icon="trash" size={34} label={t.ruleRemove} onPress={() => void remove(r.id, r.match)} />
            </View>
          ))}
        </View>
      )}
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
        <Field label={t.ruleWhen} value={draft.match} onChange={(match) => setDraft({ ...draft, match })} testID="rule-match" placeholder={t.ruleWhenHint} />
        <View style={styles.fields}>
          <Field label={t.detailSender} value={draft.sender} onChange={(sender) => setDraft({ ...draft, sender })} testID="rule-sender" />
          <Field label={t.detailType} value={draft.type} onChange={(type) => setDraft({ ...draft, type })} testID="rule-type" />
        </View>
        <Field label={t.detailTags} value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} testID="rule-tags" placeholder={t.inboxTags} />
        <View style={styles.actions}>
          {/* Words to match alone: what is missing, rather than a button greyed out for no reason given. */}
          {!!draft.match.trim() && !complete && (
            <T v="caption" color={p.muted} style={{ flex: 1 }} testID="rule-incomplete">
              {t.ruleNeedsTarget}
            </T>
          )}
          <Button testID="rule-add" kind="quiet" icon="plus" label={t.ruleAdd} onPress={add} disabled={!complete} />
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
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.sm },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
});
