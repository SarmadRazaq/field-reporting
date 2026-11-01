import { useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clockTime, describeReport, duration, megabytes, reportBytes } from '../../core/status';
import { outbox } from '../../infra/outbox';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { PhotoTile } from '../components/PhotoTile';
import { ProgressSteps } from '../components/ProgressSteps';
import { Sheet } from '../components/Sheet';
import { StatusChip } from '../components/StatusChip';
import { TopBar } from '../components/TopBar';
import { useNow } from '../hooks/useNow';
import { useOutbox } from '../hooks/useOutbox';
import type { RootScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

export function ReportDetailScreen({ navigation, route }: RootScreenProps<'ReportDetail'>) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const snapshot = useOutbox();
  const now = useNow();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const report = snapshot.reports.find(r => r.id === route.params.id);

  if (!report) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <TopBar onBack={navigation.goBack} />
        <View style={styles.content}>
          <Text style={[type.h2, { color: color.ink }]}>This report is no longer on this phone</Text>
          <Text style={[type.body, { color: color.soft }]}>It was deleted, or the phone was reset.</Text>
        </View>
      </View>
    );
  }

  const status = describeReport(report, snapshot.activity, now);
  const tile = Math.floor((width - space[5] * 2 - space[2] * 2) / 3);
  // Once the server confirms, the phone deletes its copies; the photos live on the server then.
  const photos =
    report.state === 'uploaded'
      ? []
      : report.images.map(i => i.processed?.path ?? i.sourcePath).filter((p): p is string => !!p);

  async function shareDetails() {
    const lines = [
      `Report ${report!.id}`,
      `Saved on this phone at ${report!.createdAt ? clockTime(report!.createdAt) : '—'}`,
      `Photos: ${report!.images.length}`,
      `Server answer: ${report!.problem?.message ?? 'none'}${report!.problem?.status ? ` (HTTP ${report!.problem.status})` : ''}`,
      '',
      report!.description,
    ];
    await Share.share({ message: lines.join('\n') });
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <TopBar onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space[6] }]}>
        {status.kind === 'sent' ? (
          <View style={styles.sent} accessibilityLiveRegion="polite">
            <Icon name="check" size={32} color={color.white} />
            <Text style={[type.display, { color: color.white }]}>Sent</Text>
            <Text style={[type.body, { color: color.white }]}>{status.detail}</Text>
          </View>
        ) : null}

        <View style={{ gap: space[2] }}>
          <Text style={[type.h2, { color: color.ink }]} accessibilityRole="header">
            {report.description}
          </Text>
          <Text style={[type.meta, { color: color.muted }]}>
            R-{report.id.slice(0, 4).toUpperCase()} · {report.images.length} {report.images.length === 1 ? 'photo' : 'photos'} ·{' '}
            {megabytes(reportBytes(report))}
          </Text>
          {status.kind !== 'sent' ? <StatusChip status={status} /> : null}
        </View>

        {status.kind === 'refused' ? (
          <>
            <Notice tone="red" icon="warning" title="The server refused this report">
              <Text style={[type.small, { color: color.soft }]}>Still saved on this phone. Nothing was lost.</Text>
              <Text style={[type.small, { color: color.ink }]}>{report.problem?.message}</Text>
            </Notice>
            <Button label="Try once more" icon="refresh" onPress={() => outbox().retryReport(report.id)} />
            <Button label="Share details" icon="copy" variant="secondary" onPress={shareDetails} />
            <Button label="Delete this report" icon="trash" variant="danger" onPress={() => setConfirmDelete(true)} />
          </>
        ) : (
          <ProgressSteps report={report} activity={snapshot.activity} />
        )}

        {status.kind === 'waiting' ? (
          <Notice
            tone="info"
            icon="clock"
            title={status.label}
            action={<Button label="Try now" variant="secondary" compact onPress={() => outbox().retryNow('user')} />}
          >
            {`${status.detail}. Next try in ${duration(status.retryInMs ?? 0)}.`}
          </Notice>
        ) : null}

        {photos.length ? (
          <View style={styles.grid}>
            {photos.map((p, i) => (
              <PhotoTile key={p} uri={`file://${p}`} index={i} size={tile} />
            ))}
          </View>
        ) : status.kind === 'sent' ? (
          <Button label="See it on the server" variant="secondary" onPress={() => navigation.navigate('SentReport', { id: report.id })} />
        ) : null}
      </ScrollView>

      <Sheet visible={confirmDelete} title="Delete this report?" onClose={() => setConfirmDelete(false)}>
        <Text style={[type.body, { color: color.soft }]}>
          It was never received by the server. Deleting removes the text and its {report.images.length}{' '}
          {report.images.length === 1 ? 'photo' : 'photos'} from this phone for good.
        </Text>
        <Button
          label="Delete for good"
          variant="destructive"
          onPress={async () => {
            setConfirmDelete(false);
            await outbox().discardReport(report.id);
            navigation.goBack();
          }}
        />
        <Button label="Cancel" variant="secondary" onPress={() => setConfirmDelete(false)} />
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { paddingHorizontal: space[5], gap: space[4] },
  sent: { backgroundColor: color.green, borderRadius: radius.lg, padding: space[6], gap: space[2] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
});
