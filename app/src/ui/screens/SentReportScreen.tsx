import { Image, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clockTime, megabytes } from '../../core/status';
import { imageUrl } from '../../infra/serverApi';
import { Icon } from '../components/Icon';
import { TopBar } from '../components/TopBar';
import { useServerReports } from '../hooks/useServerReports';
import type { RootScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

/** One report as the server holds it: every photo, with the size and dimensions the server measured. */
export function SentReportScreen({ navigation, route }: RootScreenProps<'SentReport'>) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { data } = useServerReports();
  const report = data?.find(r => r.id === route.params.id);
  const photoWidth = width - space[5] * 2;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <TopBar onBack={navigation.goBack} />
      {!report ? (
        <View style={styles.content}>
          <Text style={[type.h2, { color: color.ink }]}>Not on the server list</Text>
          <Text style={[type.body, { color: color.soft }]}>Pull down on Sent to check again.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space[6] }]}>
          <View style={styles.chip}>
            <Icon name="check" size={15} color={color.green700} />
            <Text style={[type.chip, { color: color.green700 }]}>Sent · confirmed at {clockTime(report.committedAt)}</Text>
          </View>
          <Text style={[type.h2, { color: color.ink }]} accessibilityRole="header">
            {report.description}
          </Text>
          {report.images.map((img, i) => {
            const ratio = img.width && img.height ? img.height / img.width : 0.75;
            return (
              <View key={img.id} style={{ gap: 6 }}>
                <Image
                  source={{ uri: imageUrl(img.url) }}
                  style={[styles.photo, { width: photoWidth, height: photoWidth * ratio }]}
                  resizeMode="cover"
                  resizeMethod="resize"
                  accessibilityLabel={`Photo ${i + 1} as stored on the server`}
                />
                <Text style={[type.meta, { color: color.muted }]}>
                  Photo {i + 1} · {megabytes(img.size)} · {img.width}×{img.height}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { paddingHorizontal: space[5], gap: space[4] },
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.green100,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  photo: { borderRadius: radius.md, backgroundColor: color.bg2 },
});
