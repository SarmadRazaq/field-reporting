import { useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clockTime, duration } from '../../core/status';
import { imageUrl, type ServerReport } from '../../infra/serverApi';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { useNow } from '../hooks/useNow';
import { useServerReports, useUploadsWaiting } from '../hooks/useServerReports';
import type { TabScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

/** What the server holds, fetched from it. Never read from local state. */
export function SentScreen({ navigation }: TabScreenProps<'Sent'>) {
  const insets = useSafeAreaInsets();
  const now = useNow(15_000);
  const query = useServerReports();
  const waiting = useUploadsWaiting();
  const [photosAnyway, setPhotosAnyway] = useState(false);
  const showThumbs = !waiting || photosAnyway;
  const reports = query.data ?? [];
  const checkedAt = query.dataUpdatedAt;

  const header = (
    <View style={styles.header}>
      <Text style={[type.h1, { color: color.ink }]} accessibilityRole="header">
        Sent
      </Text>
      <Text style={[type.body, { color: color.soft }]}>
        What the server holds.{' '}
        {checkedAt ? (
          <Text>
            Checked <Text style={type.meta}>{now - checkedAt < 60_000 ? 'just now' : `${duration(now - checkedAt)} ago`}</Text>.
          </Text>
        ) : null}
      </Text>
      {waiting && !photosAnyway ? (
        <Notice
          tone="info"
          icon="upload"
          title="Your reports are using the connection"
          action={<Button label="Load photos anyway" variant="secondary" compact onPress={() => setPhotosAnyway(true)} />}
        >
          Until they are sent, this list only refreshes when you pull down, and photos load when you ask.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice
          tone="amber"
          icon="noSignal"
          title={query.data ? `Showing the list from ${clockTime(new Date(checkedAt).toISOString())}` : "Can't reach the server"}
          action={<Button label="Try again" variant="navy" compact onPress={() => query.refetch()} />}
        >
          {`${query.error.message}. Reports waiting on this phone are not affected.`}
        </Notice>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <FlatList
        data={reports}
        keyExtractor={r => r.id}
        renderItem={({ item }) => (
          <SentCard report={item} showThumbs={showThumbs} onPress={() => navigation.navigate('SentReport', { id: item.id })} />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={query.isPending ? <Loading /> : query.isError ? undefined : <Empty />}
        ItemSeparatorComponent={() => <View style={{ height: space[3] }} />}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={query.isFetching && !query.isPending} onRefresh={() => void query.refetch()} colors={[color.brand]} />
        }
      />
    </View>
  );
}

function SentCard({ report, showThumbs, onPress }: { report: ServerReport; showThumbs: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.card}
      android_ripple={{ color: color.bg2 }}
      accessibilityRole="button"
      accessibilityLabel={`${report.description}. Sent. ${report.images.length} photos`}
    >
      <View style={styles.cardTop}>
        <Text style={[type.time, { color: color.ink, width: 44 }]}>{clockTime(report.committedAt)}</Text>
        <View style={{ flex: 1, gap: 8 }}>
          <Text style={[type.title, { color: color.ink }]} numberOfLines={2}>
            {report.description}
          </Text>
          <View style={styles.sentChip}>
            <Icon name="check" size={15} color={color.green700} />
            <Text style={[type.chip, { color: color.green700 }]}>Sent</Text>
          </View>
        </View>
      </View>
      <View style={styles.thumbs}>
        {report.images.map(img =>
          showThumbs ? (
            <Image key={img.id} source={{ uri: imageUrl(img.thumbUrl) }} style={styles.thumb} resizeMethod="resize" />
          ) : (
            <View key={img.id} style={styles.thumb} />
          ),
        )}
      </View>
    </Pressable>
  );
}

function Loading() {
  return (
    <View style={{ gap: space[3] }} accessibilityLabel="Loading reports from the server">
      {[0, 1, 2].map(i => (
        <View key={i} style={[styles.card, styles.skeleton]} />
      ))}
    </View>
  );
}

function Empty() {
  return (
    <View style={styles.empty}>
      <Icon name="server" size={28} color={color.muted} />
      <Text style={[type.title, { color: color.ink }]}>The server has no reports yet</Text>
      <Text style={[type.body, { color: color.soft, textAlign: 'center' }]}>
        Reports show up here once the server confirms it has every photo.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  list: { padding: space[5] },
  header: { gap: space[3], paddingBottom: space[4] },
  card: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: 14,
    gap: space[3],
    overflow: 'hidden',
  },
  cardTop: { flexDirection: 'row', gap: 14 },
  sentChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.green100,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  thumbs: { flexDirection: 'row', gap: 6, paddingLeft: 58 },
  thumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: color.bg2 },
  skeleton: { height: 132, backgroundColor: color.bg2, borderColor: color.bg2 },
  empty: { alignItems: 'center', gap: space[2], paddingVertical: space[6] * 2 },
});
