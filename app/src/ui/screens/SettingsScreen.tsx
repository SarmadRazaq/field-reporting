import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PENDING_STATES } from '../../core/types';
import { describeReset } from '../../core/resetProgress';
import { dismissResetResult, retryServerDelete, startOver } from '../../infra/reset';
import { pingServer } from '../../infra/serverApi';
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from '../../infra/settings';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { Sheet } from '../components/Sheet';
import { useBatteryExemption } from '../hooks/useBatteryExemption';
import { useNow } from '../hooks/useNow';
import { useOutbox, useOutboxCommands } from '../hooks/useOutbox';
import { useReset } from '../hooks/useReset';
import type { TabScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok' } | { state: 'failed'; message: string };

export function SettingsScreen(_: TabScreenProps<'Settings'>) {
  const insets = useSafeAreaInsets();
  const snapshot = useOutbox();
  const box = useOutboxCommands();
  const queryClient = useQueryClient();
  const battery = useBatteryExemption();
  const [url, setUrl] = useState(getServerUrl);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [sheet, setSheet] = useState(false);
  const [alsoServer, setAlsoServer] = useState(false);
  const { progress, result } = useReset();
  const now = useNow();
  const busy = progress.phase !== 'idle';
  const waitingOn = describeReset(progress, now);

  const waiting = snapshot.reports.filter(r => PENDING_STATES.includes(r.state) || r.state === 'needs_attention').length;
  const sentReceipts = snapshot.reports.filter(r => r.state === 'uploaded').length;
  const draft = snapshot.reports.some(r => r.state === 'draft');
  // A commit already sent can't be called back; Start over waits for its answer.
  const confirming = snapshot.activity?.stage === 'committing';

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
    // Runs to the end even if this screen goes away; the outcome is stored and shown here when it's done.
    await startOver({ includeServer: alsoServer });
    queryClient.clear();
    setUrl(getServerUrl());
    setSheet(false);
    setAlsoServer(false);
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

        <Section title="Background sending">
          <Text style={[type.body, { color: color.soft }]}>
            Reports keep sending after you leave the app, with a "Sending reports" notification while they do.
          </Text>
          {battery.exempt === false ? (
            <>
              <Text style={[type.body, { color: color.soft }]}>
                When the phone is saving battery, Android can hold sending back for an hour or more. Nothing is lost; it is only
                late.
              </Text>
              <Button label="Let it send in battery saver" variant="secondary" compact onPress={battery.request} />
            </>
          ) : battery.exempt ? (
            <Text style={[type.caption, { color: color.muted }]}>Battery saver won't hold sending back.</Text>
          ) : null}
        </Section>

        <Section title="Start over">
          <Text style={[type.body, { color: color.soft }]}>
            Deletes everything this app keeps on this phone. You choose whether the server's reports go too.
          </Text>
          <Button label="Start over" icon="trash" variant="danger" onPress={() => setSheet(true)} disabled={busy} />
          {waitingOn ? <ResetWait text={waitingOn.text} secondsLeft={waitingOn.secondsLeft} /> : null}
          {busy ? null : result?.server === 'failed' ? (
            <Notice
              tone="red"
              icon="warning"
              title="The phone was cleared. The server was not."
              action={<Button label="Try the server again" variant="secondary" compact onPress={() => void retryServerDelete()} />}
            >
              {`${result.message}. Its reports are still there.`}
            </Notice>
          ) : result ? (
            <Text style={[type.caption, { color: color.muted }]} accessibilityLiveRegion="polite">
              {result.server === 'deleted' ? 'This phone and the server were cleared.' : 'This phone was cleared. The server keeps its reports.'}
            </Text>
          ) : null}
          {!busy && result && 'inFlight' in result && result.inFlight.reachedServer.length ? (
            <Notice tone="info" icon="cloudCheck" title="One report got there first">
              {`"${result.inFlight.reachedServer.map(r => r.description).join('", "')}" was being confirmed when you started over, and the server confirmed it. It stays on the server; you can see it in Sent.`}
            </Notice>
          ) : null}
          {!busy && result && 'inFlight' in result && result.inFlight.mayHaveReachedServer.length ? (
            <Notice tone="amber" icon="warning" title="One report may be on the server">
              {`"${result.inFlight.mayHaveReachedServer.map(r => r.description).join('", "')}" was being confirmed when you started over, and the server didn't answer in time. Check Sent to see whether it arrived.`}
            </Notice>
          ) : null}
          {!busy && result ? <Button label="Dismiss" variant="secondary" compact onPress={dismissResetResult} /> : null}
        </Section>
      </ScrollView>

      <Sheet visible={sheet} title={busy ? 'Starting over' : 'Start over?'} onClose={() => setSheet(false)}>
        {waitingOn ? (
          <>
            <ResetWait text={waitingOn.text} secondsLeft={waitingOn.secondsLeft} />
            <Text style={[type.caption, { color: color.muted }]}>
              This can't be stopped now. You can leave: it finishes on its own, and Settings shows how it ended.
            </Text>
            <Button label="Close" variant="secondary" onPress={() => setSheet(false)} />
          </>
        ) : (
          <>
        <View style={{ gap: space[2] }}>
          <Text style={[type.body, { color: color.ink }]}>This deletes from this phone:</Text>
          <Bullet>
            {waiting === 0
              ? 'No unsent reports'
              : `${waiting} ${waiting === 1 ? 'report that has' : 'reports that have'} not reached the server. They will never be sent.`}
          </Bullet>
          {confirming ? (
            <Bullet>One report is being confirmed by the server right now. If the server confirms it first, it stays there.</Bullet>
          ) : null}
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
        <Button label="Delete everything on this phone" variant="destructive" onPress={confirmReset} />
        <Button label="Cancel" variant="secondary" onPress={() => setSheet(false)} />
          </>
        )}
      </Sheet>
    </View>
  );
}

/** What a running reset is waiting on, with a countdown that ends at the wait's bound. */
function ResetWait({ text, secondsLeft }: { text: string; secondsLeft: number | null }) {
  return (
    <View style={{ gap: space[1] }} accessibilityLiveRegion="polite">
      <Text style={[type.body, { color: color.ink }]}>{text}</Text>
      {secondsLeft !== null ? (
        <Text style={[type.caption, { color: color.muted }]}>
          {secondsLeft > 0 ? `At most ${secondsLeft} s more.` : 'Finishing…'}
        </Text>
      ) : null}
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
