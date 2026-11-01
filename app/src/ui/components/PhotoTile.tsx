import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';

interface Props {
  uri: string;
  index: number;
  onRemove?: () => void;
  size: number;
  /** While composing: being made ready to send, ready, or unusable. */
  state?: 'preparing' | 'ready' | 'problem';
}

const LABEL = { preparing: 'Preparing…', problem: "Can't use" } as const;

/**
 * A square thumbnail. resizeMethod="resize" makes Android decode a small
 * bitmap instead of a 48 MP one, so five originals don't exhaust memory.
 */
export function PhotoTile({ uri, index, onRemove, size, state = 'ready' }: Props) {
  const label = state === 'ready' ? null : LABEL[state];
  return (
    <View style={[styles.tile, { width: size, height: size }, state === 'problem' && styles.problem]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        resizeMethod="resize"
        accessibilityIgnoresInvertColors
        accessibilityLabel={label ? `Photo ${index + 1}, ${label}` : `Photo ${index + 1}`}
      />
      {label ? (
        <View style={[styles.band, state === 'problem' && styles.bandProblem]}>
          {state === 'problem' ? <Icon name="warning" size={14} color={color.white} /> : null}
          <Text style={[type.meta, styles.bandText]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={styles.remove}
          accessibilityRole="button"
          accessibilityLabel={`Remove photo ${index + 1}`}
        >
          <Icon name="close" size={16} color={color.white} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.bg2 },
  problem: { borderWidth: 2, borderColor: color.red700 },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 4,
    backgroundColor: 'rgba(17,24,39,0.72)',
  },
  bandProblem: { backgroundColor: color.red700 },
  bandText: { color: color.white },
  remove: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(17,24,39,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
