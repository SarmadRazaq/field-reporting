import { Pressable, StyleSheet, Text, View } from 'react-native';
import { duration, megabytes, reportBytes } from '../../core/status';
import type { Activity, LocalReport } from '../../core/types';
import { useTimeLeft } from '../hooks/useTimeLeft';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';
import { Segments } from './Segments';

/** Navy card for the one report being sent right now. */
export function SendingHero({ report, activity, onPress }: { report: LocalReport; activity: Activity; onPress: () => void }) {
  const left = useTimeLeft(activity);
  const preparing = activity.stage === 'processing';
  // While photos are being made smaller no bytes move, so show which photo instead of a stuck 0%.
  const progress = preparing
    ? activity.imageIndex / activity.imageCount
    : activity.bytesTotal > 0
      ? activity.bytesSent / activity.bytesTotal
      : 0;
  const pct = Math.floor(progress * 100);
  const figure = preparing ? `${activity.imageIndex + 1}/${activity.imageCount}` : `${pct}%`;
  const caption = preparing
    ? 'Making photos smaller to send'
    : activity.stage === 'committing'
        ? 'Waiting for the server to confirm'
        : left !== null
          ? `${duration(left)} left`
          : `Photo ${activity.imageIndex + 1} of ${activity.imageCount}`;

  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      android_ripple={{ color: 'rgba(255,255,255,0.12)' }}
      accessibilityRole="button"
      accessibilityLabel={`${preparing ? 'Preparing' : 'Sending now'}: ${report.description}. ${preparing ? `Photo ${figure}` : `${pct} percent`}. ${caption}`}
    >
      <View style={styles.top}>
        <View style={styles.tag}>
          <Icon name="upload" size={15} color={color.white} />
          <Text style={[type.chip, { color: color.white }]}>{preparing ? 'Preparing' : 'Sending now'}</Text>
        </View>
        <Text style={[type.meta, { color: color.onHeroSoft }]}>
          {report.images.length} {report.images.length === 1 ? 'photo' : 'photos'} · {megabytes(reportBytes(report))}
        </Text>
      </View>
      <Text style={[type.heroTitle, styles.title]} numberOfLines={2}>
        {report.description}
      </Text>
      <Segments progress={progress} cells={preparing ? activity.imageCount : 24} height={12} fill={color.white} empty="rgba(255,255,255,0.22)" />
      <View style={styles.bottom}>
        <Text style={[type.figureSmall, { color: color.white }]}>{figure}</Text>
        <Text style={[type.small, { color: color.onHeroSoft }]}>{caption}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.brandHero, borderRadius: radius.lg, padding: 18, overflow: 'hidden' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  title: { color: color.white, marginTop: 12, marginBottom: 14 },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 },
});
