import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { clockTime, describeReport, megabytes, reportBytes } from '../../core/status';
import type { Activity, LocalReport } from '../../core/types';
import { useNow } from '../hooks/useNow';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';
import { StatusChip } from './StatusChip';

interface Props {
  report: LocalReport;
  /** Only the activity for this report, so other rows don't re-render on every chunk. */
  activity: Activity | null;
  onPress: (id: string) => void;
}

/** White card: time, title, photo count and size, one chip. A refused report gets a red border and a chevron. */
export const ReportRow = memo(function ReportRow({ report, activity, onPress }: Props) {
  // Only a row with a countdown needs to tick every second.
  const now = useNow(report.nextAttemptAt !== null ? 1000 : 60_000);
  const status = describeReport(report, activity, now);
  const refused = status.kind === 'refused';
  const photos = `${report.images.length} ${report.images.length === 1 ? 'photo' : 'photos'}`;
  return (
    <Pressable
      onPress={() => onPress(report.id)}
      android_ripple={{ color: color.bg2 }}
      style={[styles.card, refused && styles.refused]}
      accessibilityRole="button"
      accessibilityLabel={`${report.description}. ${photos}. ${status.label}`}
      accessibilityHint={refused ? 'Opens what went wrong and what you can do' : 'Opens the report'}
    >
      <Text style={[type.time, styles.time]}>{report.createdAt ? clockTime(report.createdAt) : '—'}</Text>
      <View style={styles.body}>
        <View>
          <Text style={[type.title, { color: color.ink }]} numberOfLines={2}>
            {report.description}
          </Text>
          <Text style={[type.meta, { color: color.muted }]}>
            {photos} · {megabytes(reportBytes(report))}
          </Text>
        </View>
        <StatusChip status={status} suffix={refused ? 'tap to fix' : undefined} />
      </View>
      {refused ? <Icon name="chevronRight" size={20} color={color.red700} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  refused: { borderColor: color.redLine },
  time: { color: color.ink, width: 44, alignSelf: 'flex-start' },
  body: { flex: 1, gap: 8 },
});
