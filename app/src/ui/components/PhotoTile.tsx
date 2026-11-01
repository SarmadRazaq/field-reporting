import { Image, Pressable, StyleSheet, View } from 'react-native';
import { color, radius } from '../theme';
import { Icon } from './Icon';

interface Props {
  uri: string;
  index: number;
  onRemove?: () => void;
  size: number;
}

/**
 * A square thumbnail. resizeMethod="resize" makes Android decode a small
 * bitmap instead of a 48 MP one, so five originals don't exhaust memory.
 */
export function PhotoTile({ uri, index, onRemove, size }: Props) {
  return (
    <View style={[styles.tile, { width: size, height: size }]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        resizeMethod="resize"
        accessibilityIgnoresInvertColors
        accessibilityLabel={`Photo ${index + 1}`}
      />
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
