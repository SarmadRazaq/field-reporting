import { StyleSheet, Text, View } from 'react-native';
import { duration, type ReportStatus, type StatusKind } from '../../core/status';
import { color, radius, size, type } from '../theme';
import { Icon, type IconName } from './Icon';

const LOOK: Record<StatusKind, { bg: string; fg: string; icon: IconName }> = {
  draft: { bg: color.bg2, fg: color.ink7, icon: 'phone' },
  saved: { bg: color.bg2, fg: color.ink7, icon: 'phone' },
  waiting: { bg: color.bg2, fg: color.ink7, icon: 'clock' },
  stuck: { bg: color.amber100, fg: color.amber700, icon: 'warning' },
  sending: { bg: color.amber100, fg: color.amber700, icon: 'upload' },
  sent: { bg: color.green100, fg: color.green700, icon: 'check' },
  refused: { bg: color.red100, fg: color.red700, icon: 'warning' },
};

/** Exactly one per report. Icon plus words, never colour alone. */
export function StatusChip({ status, suffix }: { status: ReportStatus; suffix?: string }) {
  const look = LOOK[status.kind];
  const countdown =
    (status.kind === 'waiting' || status.kind === 'stuck') && status.retryInMs !== undefined ? duration(status.retryInMs) : null;
  return (
    <View style={[styles.chip, { backgroundColor: look.bg }]} accessibilityRole="text">
      <Icon name={look.icon} size={15} color={look.fg} />
      <Text style={[type.chip, { color: look.fg }]} numberOfLines={1}>
        {status.label}
        {countdown ? ' · tries in ' : ''}
        {countdown ? <Text style={type.meta}>{countdown}</Text> : null}
        {suffix ? ` · ${suffix}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: size.chip,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.sm,
    maxWidth: '100%',
  },
});
