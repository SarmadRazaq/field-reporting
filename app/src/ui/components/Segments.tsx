import { StyleSheet, View } from 'react-native';
import { size } from '../theme';

interface Props {
  /** 0..1 */
  progress: number;
  cells?: number;
  height?: number;
  fill: string;
  empty: string;
}

/** Segmented progress: discrete cells read better than a thin bar on a glance at arm's length. */
export function Segments({ progress, cells = 20, height = size.cell, fill, empty }: Props) {
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * cells);
  return (
    <View
      style={styles.row}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
    >
      {Array.from({ length: cells }, (_, i) => (
        <View key={i} style={[styles.cell, { height, backgroundColor: i < filled ? fill : empty }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: size.cellGap },
  cell: { flex: 1, borderRadius: 3 },
});
