import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, size, space, type } from '../theme';
import { Icon, type IconName } from './Icon';

interface Props {
  title?: string;
  onBack: () => void;
  backIcon?: IconName;
  backLabel?: string;
  right?: ReactNode;
}

/** A 48dp back target, an optional title, and an optional trailing slot. */
export function TopBar({ title, onBack, backIcon = 'chevronLeft', backLabel = 'Back', right }: Props) {
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onBack}
        style={styles.back}
        android_ripple={{ color: color.bg2, borderless: true }}
        accessibilityRole="button"
        accessibilityLabel={backLabel}
      >
        <Icon name={backIcon} size={24} color={color.ink} />
      </Pressable>
      {title ? (
        <Text style={[type.title, styles.title]} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
      ) : (
        <View style={styles.title} />
      )}
      {right ?? <View style={styles.back} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[2], minHeight: 56 },
  back: { width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', color: color.ink },
});
