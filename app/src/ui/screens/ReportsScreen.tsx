import { useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeReport, summarize } from '../../core/status';
import type { LocalReport } from '../../core/types';
import { PENDING_STATES } from '../../core/types';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { ReportRow } from '../components/ReportRow';
import { SendingHero } from '../components/SendingHero';
import { SignalPill } from '../components/SignalPill';
import { useNow } from '../hooks/useNow';
import { useOutbox } from '../hooks/useOutbox';
import type { TabScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

/** Order that answers "what needs me, what is moving, what is done". */
const rank = (r: LocalReport) => (r.state === 'needs_attention' ? 0 : PENDING_STATES.includes(r.state) ? 1 : 2);

export function ReportsScreen({ navigation }: TabScreenProps<'Reports'>) {
  const insets = useSafeAreaInsets();
  const snapshot = useOutbox();
  const now = useNow();
  const summary = summarize(snapshot, now);

  const draft = snapshot.reports.find(r => r.state === 'draft');
  const active = snapshot.activity;
  const hero = active ? snapshot.reports.find(r => r.id === active.reportId && PENDING_STATES.includes(r.state)) : undefined;

  const rows = useMemo(
    () =>
      snapshot.reports
        .filter(r => r.state !== 'draft' && r.id !== hero?.id)
        .sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (a.createdAt ?? '').localeCompare(b.createdAt ?? '') : 0)),
    [snapshot.reports, hero?.id],
  );

  const open = useCallback((id: string) => navigation.navigate('ReportDetail', { id }), [navigation]);

  const header = (
    <View style={styles.header}>
      <Text style={[type.h1, { color: color.ink }]} accessibilityRole="header">
        Reports
      </Text>
      <SignalPill summary={summary} />
      {draft ? (
        <Pressable
          style={styles.draft}
          onPress={() => navigation.navigate('NewReport')}
          android_ripple={{ color: color.bg2 }}
          accessibilityRole="button"
          accessibilityLabel="Continue your unfinished report"
        >
          <View style={{ flex: 1 }}>
            <Text style={[type.title, { color: color.ink }]}>Unfinished report</Text>
            <Text style={[type.caption, { color: color.muted }]} numberOfLines={1}>
              {draft.description.trim() || 'No description yet'} · {draft.images.length} of 5 photos
            </Text>
          </View>
          <Text style={[type.bodyStrong, { color: color.brand }]}>Continue</Text>
        </Pressable>
      ) : null}
      {hero && active ? <SendingHero report={hero} activity={active} onPress={() => open(hero.id)} /> : null}
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlatList
        data={rows}
        keyExtractor={r => r.id}
        renderItem={({ item }) => <ReportRow report={item} status={describeReport(item, active, now)} onPress={open} />}
        ListHeaderComponent={header}
        ListEmptyComponent={hero ? undefined : <Empty />}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={Gap}
      />
      <View style={styles.footer}>
        <Button label="New report" icon="plus" onPress={() => navigation.navigate('NewReport')} />
      </View>
    </View>
  );
}

const Gap = () => <View style={{ height: space[3] }} />;

function Empty() {
  return (
    <View style={styles.empty}>
      <Icon name="phone" size={28} color={color.muted} />
      <Text style={[type.title, { color: color.ink }]}>No reports on this phone</Text>
      <Text style={[type.body, { color: color.soft, textAlign: 'center' }]}>
        A new report is kept on this phone first, then sends by itself whenever there is signal.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: { gap: space[4], paddingBottom: space[4] },
  list: { padding: space[5], paddingBottom: space[6] },
  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: 14,
    minHeight: 56,
    backgroundColor: color.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.line2,
    borderStyle: 'dashed',
    overflow: 'hidden',
  },
  empty: { alignItems: 'center', gap: space[2], paddingVertical: space[6] * 2, paddingHorizontal: space[4] },
  footer: { paddingHorizontal: space[5], paddingBottom: space[2], backgroundColor: color.bg },
});
