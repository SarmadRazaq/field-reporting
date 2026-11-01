import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { color, radius, size, type } from '../theme';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'navy' | 'secondary' | 'danger' | 'destructive';

const VARIANTS: Record<ButtonVariant, { bg: string; fg: string; border: string; ripple: string }> = {
  primary: { bg: color.brand, fg: color.white, border: color.brand, ripple: 'rgba(255,255,255,0.22)' },
  navy: { bg: color.brand700, fg: color.white, border: color.brand700, ripple: 'rgba(255,255,255,0.22)' },
  secondary: { bg: color.white, fg: color.ink, border: color.line2, ripple: color.bg2 },
  danger: { bg: color.white, fg: color.red700, border: color.redLine, ripple: color.red100 },
  destructive: { bg: color.red700, fg: color.white, border: color.red700, ripple: 'rgba(255,255,255,0.22)' },
};

interface Props {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  /** Shown under a disabled button: what is missing. */
  disabledReason?: string;
  compact?: boolean;
  style?: ViewStyle;
  accessibilityHint?: string;
}

/** 56dp, 14 radius, sentence-case label. One primary per screen. */
export function Button({ label, onPress, variant = 'primary', icon, disabled, disabledReason, compact, style, accessibilityHint }: Props) {
  const v = VARIANTS[variant];
  const fg = disabled ? color.muted : v.fg;
  return (
    <View style={style}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        android_ripple={{ color: v.ripple }}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={disabled ? disabledReason : accessibilityHint}
        accessibilityState={{ disabled: !!disabled }}
        style={[
          styles.base,
          compact && styles.compact,
          disabled ? styles.disabled : { backgroundColor: v.bg, borderColor: v.border },
        ]}
      >
        {icon ? <Icon name={icon} size={compact ? 18 : 20} color={fg} /> : null}
        <Text style={[compact ? type.buttonSmall : type.button, { color: fg }]}>{label}</Text>
      </Pressable>
      {disabled && disabledReason ? <Text style={styles.reason}>{disabledReason}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: size.button,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    overflow: 'hidden',
  },
  compact: { minHeight: size.touch },
  disabled: { backgroundColor: color.bg2, borderColor: color.bg2 },
  reason: { ...type.caption, color: color.muted, textAlign: 'center', marginTop: 6 },
});
