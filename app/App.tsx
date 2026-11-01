import { useEffect } from 'react';
import { Button, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { describeReport, summarize } from './src/core/status';
import { startOutboxLifecycle } from './src/infra/lifecycle';
import { outbox } from './src/infra/outbox';
import { getServerUrl } from './src/infra/settings';
import { useOutbox } from './src/ui/hooks/useOutbox';

/** Temporary shell to exercise the uploader on a device; replaced by the real screens. */
export default function App() {
  useEffect(() => startOutboxLifecycle(), []);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.root}>
        <Shell />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Shell() {
  const snapshot = useOutbox();
  const now = Date.now();
  const summary = summarize(snapshot, now);

  async function fileTestReport() {
    const picked = await launchImageLibrary({ mediaType: 'photo', selectionLimit: 5, quality: 1 });
    const uris = (picked.assets ?? []).map(a => a.uri).filter((u): u is string => !!u);
    if (!uris.length) return;
    const draft = await outbox().startDraft();
    await outbox().setDescription(draft.id, `Device test ${new Date().toLocaleTimeString()}`);
    await outbox().addPhotos(draft.id, uris);
    await outbox().submit(draft.id);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{summary.title}</Text>
      {summary.detail ? <Text>{summary.detail}</Text> : null}
      <Text style={styles.muted}>Server: {getServerUrl()}</Text>
      <View style={styles.gap} />
      <Button title="Pick photos and file a test report" onPress={fileTestReport} disabled={!snapshot.ready} />
      <View style={styles.gap} />
      {snapshot.reports.map(r => {
        const line = describeReport(r, snapshot.activity, now);
        return (
          <View key={r.id} style={styles.row}>
            <Text style={styles.bold}>{r.description || '(draft)'}</Text>
            <Text>
              {line.title}
              {line.detail ? ` · ${line.detail}` : ''}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F1F4F3' },
  content: { padding: 16 },
  title: { fontSize: 20, fontWeight: '600', color: '#16212C' },
  muted: { color: '#7A8894', marginTop: 4 },
  bold: { fontWeight: '600' },
  gap: { height: 16 },
  row: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#D3DBD8' },
});
