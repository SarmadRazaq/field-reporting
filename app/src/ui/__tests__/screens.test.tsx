/**
 * The failure states, rendered: each screen over a real Outbox built on the
 * core's fakes (in-memory disk, scripted server), so what's on screen comes
 * from the same code paths the app runs.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { MB, fileReport, flush, settle, world, type World } from '../../core/__tests__/fakes';
import { OutboxProvider } from '../hooks/useOutbox';
import { NewReportScreen } from '../screens/NewReportScreen';
import { ReportDetailScreen } from '../screens/ReportDetailScreen';
import { ReportsScreen } from '../screens/ReportsScreen';
import { SentScreen } from '../screens/SentScreen';

// ── Native modules the screens touch ─────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-image-picker', () => ({ launchCamera: jest.fn(), launchImageLibrary: jest.fn() }));
jest.mock('react-native-permissions', () => ({
  PERMISSIONS: { ANDROID: { CAMERA: 'camera' } },
  check: jest.fn(async () => 'granted'),
  request: jest.fn(async () => 'granted'),
  requestNotifications: jest.fn(async () => ({ status: 'granted' })),
  openSettings: jest.fn(),
}));
jest.mock('react-native-svg', () => {
  const { createElement } = require('react');
  const shape = (name: string) => (props: object) => createElement(name, props);
  return { __esModule: true, default: shape('Svg'), Svg: shape('Svg'), Path: shape('Path'), Circle: shape('Circle'), Rect: shape('Rect') };
});
jest.mock('../../infra/deviceStorage', () => ({
  STORAGE: { lowBytes: 300_000_000, fullBytes: 100_000_000 },
  freeBytes: async () => null,
  isNoSpaceError: () => false,
}));
jest.mock('../../infra/serverApi', () => ({
  fetchServerReports: jest.fn(async () => {
    throw new Error('No connection');
  }),
  imageUrl: (path: string) => path,
}));

// Screens read the wall clock; tests run on the fake one.
let mockNow = 0;
jest.mock('../hooks/useNow', () => ({ useNow: () => mockNow }));

// The first render loads every screen module, which takes several seconds.
jest.setTimeout(30_000);
// The outbox publishes from its own async work; tell React this is a test so it batches those updates.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Helpers ──────────────────────────────────────────────────────────────────

const navigation = { navigate: jest.fn(), goBack: jest.fn(), replace: jest.fn() } as never;

function show(w: World, element: ReactElement) {
  mockNow = w.clock.now();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OutboxProvider outbox={w.outbox}>{element}</OutboxProvider>
    </QueryClientProvider>,
  );
}

const onlyReport = (w: World) => w.outbox.getSnapshot().reports[0]!;

// ── The states ───────────────────────────────────────────────────────────────

describe('Reports', () => {
  it('says there is no signal, and when the server was last reached', async () => {
    const w = await world();
    w.server.offline = true;
    await fileReport(w, [MB]);
    await settle(w, 2);
    await show(w, <ReportsScreen navigation={navigation} route={{ key: 'r', name: 'Reports' }} />);

    expect(screen.getByText('No signal · 1 report on this phone')).toBeTruthy();
    expect(screen.getByText('Has not reached the server yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try sending now' })).toBeTruthy();
  });

  it('turns to a warning when the server has been failing for half an hour', async () => {
    const w = await world();
    w.server.inject('any', { kind: 'status', status: 500 }, 1000);
    await fileReport(w, [MB]);
    await settle(w, 60); // about 45 s apart once backoff tops out: well past 30 minutes
    await show(w, <ReportsScreen navigation={navigation} route={{ key: 'r', name: 'Reports' }} />);

    expect(screen.getByText('Server not accepting reports · 1 report on this phone')).toBeTruthy();
  });
});

describe('Report detail', () => {
  it('shows a refusal, offers to replace the photo it names, and retries on request', async () => {
    const w = await world();
    await fileReport(w, [MB, MB]); // photo 2 is prepared by the uploader…
    w.encoder.failAboveEdge = 0; // …and can't be read
    await settle(w);
    const report = onlyReport(w);
    await show(w, <ReportDetailScreen navigation={navigation} route={{ key: 'd', name: 'ReportDetail', params: { id: report.id } }} />);

    expect(screen.getByText('The server refused this report')).toBeTruthy();
    expect(screen.getByText('Still saved on this phone. Nothing was lost.')).toBeTruthy();
    expect(screen.getByText('Replace photo 2')).toBeTruthy();

    w.encoder.failAboveEdge = Infinity;
    await act(async () => {
      fireEvent.press(screen.getByText('Try once more'));
      await flush();
      await settle(w);
    });
    expect(onlyReport(w).state).toBe('uploaded');
    expect(screen.getByText('Sent')).toBeTruthy();
  });

  it('calls a long run of server errors stuck, not just busy', async () => {
    const w = await world();
    w.server.inject('any', { kind: 'status', status: 503 }, 1000);
    await fileReport(w, [MB]);
    await settle(w, 60); // about 45 s apart once backoff tops out: well past 30 minutes
    const report = onlyReport(w);
    await show(w, <ReportDetailScreen navigation={navigation} route={{ key: 'd', name: 'ReportDetail', params: { id: report.id } }} />);

    expect(screen.getAllByText(/Server not accepting reports/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Still saved on this phone and still trying/)).toBeTruthy();
  });
});

describe('New report', () => {
  it('marks a photo that cannot be used, says why, and blocks Save', async () => {
    const w = await world();
    const draft = await w.outbox.drafts.start();
    await w.outbox.drafts.setDescription(draft.id, 'Cracked beam');
    w.files.gallery.set('content://bad', new Uint8Array(MB));
    w.encoder.failAboveEdge = 0;
    await w.outbox.drafts.addPhotos(draft.id, ['content://bad']);
    await w.outbox.drafts.idle();
    await show(w, <NewReportScreen navigation={navigation} route={{ key: 'n', name: 'NewReport' }} />);

    expect(await screen.findByText("Photo 1 can't be used")).toBeTruthy();
    expect(screen.getByLabelText("Photo 1, Can't use")).toBeTruthy();
    expect(screen.getByText("Remove the photo that can't be used")).toBeTruthy();
  });
});

describe('Sent', () => {
  it("says it can't reach the server, and that waiting reports are unaffected", async () => {
    const w = await world();
    await show(w, <SentScreen navigation={navigation} route={{ key: 's', name: 'Sent' }} />);

    expect(await screen.findByText("Can't reach the server", {}, { timeout: 5000 })).toBeTruthy(); // after its one retry
    expect(screen.getByText(/Reports waiting on this phone are not affected/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
