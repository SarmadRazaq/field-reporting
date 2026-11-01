import { StyleSheet, Text, View } from 'react-native';
import type { Summary } from '../../core/status';
import { color, type } from '../theme';
import { Icon, type IconName } from './Icon';

const ICON: Record<Summary['kind'], IconName> = {
  empty: 'phone',
  'all-sent': 'cloudCheck',
  sending: 'upload',
  waiting: 'noSignal',
  attention: 'warning',
};

/** The one connection summary at the top of Reports. */
export function SignalPill({ summary }: { summary: Summary }) {
  return (
    <View style={styles.pill} accessibilityLiveRegion="polite" accessibilityLabel={summary.text}>
      <Icon name={ICON[summary.kind]} size={15} color={color.white} />
      <Text style={[type.chip, styles.text]} numberOfLines={1}>
        {summary.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.brand700,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  text: { color: color.white, flexShrink: 1 },
});
