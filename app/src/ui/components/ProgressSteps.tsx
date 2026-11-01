import { StyleSheet, Text, View } from 'react-native';
import { clockTime, photosReceived } from '../../core/status';
import type { Activity, LocalReport } from '../../core/types';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';
import { Segments } from './Segments';

type StepState = 'done' | 'now' | 'todo';

/** Saved on this phone → Sending photos → Confirmed by the server. The same three for every report. */
export function ProgressSteps({ report, activity }: { report: LocalReport; activity: Activity | null }) {
  const sent = report.state === 'uploaded';
  const sending = !sent && (activity?.reportId === report.id || report.images.some(i => i.uploadedBytes > 0));
  const received = photosReceived(report);
  const total = report.images.reduce((s, i) => s + (i.processed?.size ?? 0), 0);
  const bytes = report.images.reduce((s, i) => s + i.uploadedBytes, 0);

  const steps: { title: string; detail: string; state: StepState; progress?: number }[] = [
    {
      title: 'Saved on this phone',
      detail: `${report.createdAt ? clockTime(report.createdAt) : ''} · safe even if the app closes`,
      state: 'done',
    },
    {
      title: 'Sending photos',
      detail: sent
        ? `All ${report.images.length} received`
        : `${received} of ${report.images.length} received by the server`,
      state: sent ? 'done' : 'now',
      progress: !sent && sending && total > 0 ? bytes / total : undefined,
    },
    {
      title: 'Confirmed by the server',
      detail: sent && report.uploadedAt ? clockTime(report.uploadedAt) : 'Not yet',
      state: sent ? 'done' : 'todo',
    },
  ];

  return (
    <View style={styles.card}>
      {steps.map(step => (
        <View key={step.title} style={[styles.step, step.state === 'now' && styles.now]}>
          <Marker state={step.state} />
          <View style={styles.text}>
            <View style={styles.titleRow}>
              <Text style={[type.title, { color: color.ink }]}>{step.title}</Text>
              {step.state === 'now' ? (
                <View style={styles.nowTag}>
                  <Text style={[type.tab, { color: color.brand700 }]}>Now</Text>
                </View>
              ) : null}
            </View>
            <Text style={[type.caption, { color: color.muted }]}>{step.detail}</Text>
            {step.progress !== undefined ? (
              <Segments progress={step.progress} height={6} fill={color.amber} empty={color.line} />
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Marker({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <View style={[styles.marker, { backgroundColor: color.ink }]}>
        <Icon name="check" size={15} color={color.white} />
      </View>
    );
  if (state === 'now')
    return (
      <View style={[styles.marker, { borderWidth: 2, borderColor: color.brand }]}>
        <Icon name="upload" size={14} color={color.brand} />
      </View>
    );
  return <View style={[styles.marker, { borderWidth: 2, borderColor: color.line2 }]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  step: { flexDirection: 'row', gap: 12, paddingVertical: 14, paddingHorizontal: 6 },
  now: { borderWidth: 1.5, borderColor: color.brand, borderRadius: radius.md, marginHorizontal: -4, paddingHorizontal: 10 },
  marker: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 6 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nowTag: { backgroundColor: color.brand100, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 },
});
