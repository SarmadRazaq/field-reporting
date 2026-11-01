import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, radius, type } from '../theme';
import { Icon, type IconName } from './Icon';

interface Props {
  tone: 'amber' | 'red' | 'info';
  icon: IconName;
  title: string;
  children?: ReactNode;
  /** One action, or a plain next step. */
  action?: ReactNode;
}

const TONES = {
  amber: { bg: color.amber100, border: color.amberLine, fg: color.amber700, r: radius.md },
  red: { bg: color.red100, border: color.redLine, fg: color.red700, r: radius.lg },
  info: { bg: color.bg2, border: color.line, fg: color.ink7, r: radius.md },
} as const;

/** Something the inspector should know or can fix (amber), or a server refusal (red). */
export function Notice({ tone, icon, title, children, action }: Props) {
  const t = TONES[tone];
  return (
    <View
      style={[styles.box, { backgroundColor: t.bg, borderColor: t.border, borderRadius: t.r }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.head}>
        <Icon name={icon} size={20} color={t.fg} />
        <Text style={[type.bodyStrong, styles.title, { color: t.fg }]}>{title}</Text>
      </View>
      {typeof children === 'string' ? <Text style={styles.text}>{children}</Text> : children}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, padding: 14, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { flex: 1 },
  // The design's preview sets this to brand-100, which is unreadable on amber/red; soft passes 4.5:1 on both.
  text: { ...type.small, color: color.soft },
});
