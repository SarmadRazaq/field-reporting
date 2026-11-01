import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PENDING_STATES } from '../../core/types';
import { startOver, deleteServerReports, type ResetResult } from '../../infra/reset';
import { pingServer } from '../../infra/serverApi';
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from '../../infra/settings';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { Sheet } from '../components/Sheet';
import { useOutbox, useOutboxCommands } from '../hooks/useOutbox';
import type { TabScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok' } | { state: 'failed'; message: string };

export function SettingsScreen(_: TabScreenProps<'Settings'>) {
  const insets = useSafeAreaInsets();
  const snapshot = useOutbox();
  const box = useOutboxCommands();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(getServerUrl);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [sheet, setSheet] = useState(false);
  const [alsoServer, setAlsoServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);

  const waiting = snapshot.reports.filter(r => PENDING_STATES.includes(r.state) || r.state === 'needs_attention').length;
  const sentReceipts = snapshot.reports.filter(r => r.state === 'uploaded').length;
  const draft = snapshot.reports.some(r => r.state === 'draft');

  async function saveAndCheck() {
    setServerUrl(url);
    setCheck({ state: 'checking' });
    try {
      await pingServer();
      setCheck({ state: 'ok' });
      queryClient.invalidateQueries();
      box.retryNow('server changed');
    } catch (e) {
      setCheck({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function confirmReset() {
    setBusy(true);
    const r = await startOver({ includeServer: alsoServer });
    queryClient.clear();
    setUrl(getServerUrl());
    setBusy(false);
    setSheet(false);
    setAlsoServer(false);
    setResult(r);
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[type.h1, { color: color.ink }]} accessibilityRole="header">
          Settings
        </Text>

        <Section title="Connection">
          <Text style={[type.caption, { color: color.muted }]} nativeID="serverLabel">
            Server address
          </Text>
          <TextInput
            value={url}
            onChangeText={t => {
              setUrl(t);
              setCheck({ state: 'idle' });
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
            underlineColorAndroid="transparent"
            accessibilityLabelledBy="serverLabel"
            placeholder={DEFAULT_SERVER_URL}
            placeholderTextColor={color.muted}
          />
          <Button label={check.state === 'checking' ? 'Checking…' : 'Save and check'} variant="secondary" compact onPress={saveAndCheck} disabled={check.state === 'checking'} />
          {check.state === 'ok' ? <Text style={[type.caption, { color: color.green700 }]}>The server answered.</Text> : null}
          {check.state === 'failed' ? (
            <Text style={[type.caption, { color: color.red700 }]}>{check.message}. Reports stay on this phone until it can be reached.</Text>
          ) : null}
        </Section>

        <Section title="On this phone">
          <Row label="Not sent yet" value={String(waiting)} />
          <Row label="Sent (receipts)" value={String(sentReceipts)} />
          <Text style={[type.caption, { color: color.muted }]}>
            Photos are made smaller before sending: up to 4096 px on the long edge and always under 5 MB.
          </Text>
          {sentReceipts ? (
            <Button label="Clear sent from the list" variant="secondary" compact onPress={() => box.clearUploaded()} />
          ) : null}
        </Section>

        <Section title="Start over">
          <Text style={[type.body, { color: color.soft }]}>
            Deletes everything this app keeps on this phone. You choose whether the server's reports go too.
          </Text>
          <Button label="Start over" icon="trash" variant="danger" onPress={() => setSheet(true)} />
          {result?.server === 'failed' ? (
            <Notice
              tone="red"
              icon="warning"
              title="The phone was cleared. The server was not."
              action={<Button label="Try the server again" variant="secondary" compact onPress={async () => setResult(await deleteServerReports())} />}
            >
              {`${result.message}. Its reports are still there.`}
            </Notice>
          ) : result ? (
            <Text style={[type.caption, { color: color.muted }]} accessibilityLiveRegion="polite">
              {result.server === 'deleted' ? 'This phone and the server were cleared.' : 'This phone was cleared. The server keeps its reports.'}
            </Text>
          ) : null}
        </Section>
      </ScrollView>

      <Sheet visible={sheet} title="Start over?" onClose={() => !busy && setSheet(false)}>
        <View style={{ gap: space[2] }}>
          <Text style={[type.body, { color: color.ink }]}>This deletes from this phone:</Text>
          <Bullet>
            {waiting === 0
              ? 'No unsent reports'
              : `${waiting} ${waiting === 1 ? 'report that has' : 'reports that have'} not reached the server. They will never be sent.`}
          </Bullet>
          {draft ? <Bullet>Your unfinished report</Bullet> : null}
          <Bullet>All photos, receipts and settings</Bullet>
        </View>
        <View style={styles.toggle}>
          <Text style={[type.body, { color: color.ink, flex: 1 }]} nativeID="alsoServer">
            Also delete every report on the server
          </Text>
          <Switch
            value={alsoServer}
            onValueChange={setAlsoServer}
            accessibilityLabelledBy="alsoServer"
            trackColor={{ true: color.red700, false: color.line2 }}
            thumbColor={color.white}
          />
        </View>
        <Text style={[type.caption, { color: alsoServer ? color.red700 : color.muted }]}>
          {alsoServer ? 'Reports on the server are deleted too, for everyone.' : 'Reports already on the server stay there.'}
        </Text>
        <Button label={busy ? 'Deleting…' : 'Delete everything on this phone'} variant="destructive" onPress={confirmReset} disabled={busy} />
        <Button label="Cancel" variant="secondary" onPress={() => setSheet(false)} disabled={busy} />
      </Sheet>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[type.title, { color: color.ink }]} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={[type.body, { color: color.soft }]}>{label}</Text>
      <Text style={[type.time, { color: color.ink }]}>{value}</Text>
    </View>
  );
}

function Bullet({ children }: { children: string }) {
  return <Text style={[type.body, { color: color.soft }]}>{`•  ${children}`}</Text>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space[5], gap: space[6] },
  section: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: space[4],
    gap: space[3],
  },
  input: {
    ...type.input,
    color: color.ink,
    borderWidth: 1,
    borderColor: color.line2,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 32 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48 },
});
