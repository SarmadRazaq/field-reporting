# Field Reports

A React Native (bare CLI, TypeScript) app for filing photo reports from a site where 2G is normal and no signal is common. An inspector writes a short description, adds 1–5 photos, taps Save, and walks away. The app gets every report to the server exactly once, however often the link drops or the app is killed.

```
app/      React Native app (Android; iOS project present but not tested)
server/   Express + SQLite upload server with failure injection built in
sim/      Runs the app's upload core in Node against the real server, through the brief's main scenario
```

Screen recording: _link to be added_

---

## Running it

### 1. Server

Needs Node 20+.

```sh
cd server
npm install
npm start            # http://localhost:4000, admin page at http://localhost:4000/admin
```

`PORT` and `DATA_DIR` (default `./data`) can be set in the environment. Uploaded images and the SQLite file live in `DATA_DIR`; delete the folder to start the server empty.

### 2. App (Android)

Needs Node 22.11+, JDK 17 and the Android SDK, as for any React Native CLI project.

```sh
cd app
npm install
npx react-native run-android
```

**Pointing the app at the server.** The default is `http://10.0.2.2:4000`, which is the host machine as seen from the Android emulator. A physical phone on the same Wi-Fi uses the computer's LAN address. Set it in the app under **Settings → Connection** and tap **Save and check**.

Don't use `adb reverse` for testing. It tunnels over USB, so airplane mode no longer cuts the app off from the server, and that's the very thing being tested.

### 3. Tests

```sh
cd app && npm test       # 52 tests: the upload engine with fake network, disk and clock; stored-data upgrades; the failure screens
cd server && npm test    # 14 tests: the upload protocol and the failure injection
```

### 4. The main scenario, without a phone

`sim/` runs the app's real upload core (`app/src/core`) in Node, with Node adapters for disk, HTTP and image encoding:

```sh
cd sim
npm install
npm run sim              # server must be running on :4000
```

It starts in "airplane mode", composes three reports (one with five ~6000×4500 camera-style originals), force-quits, reopens on a throttled flaky link, drops the connection twice mid-upload, loses one commit reply and force-quits again. Then it checks that the server holds all three reports exactly once, with every image intact and under 5 MB. `BANDWIDTH` (bytes/s, default 150,000) sets the throttle; real 2G at ~6 KB/s works too, it just takes an hour.

---

## Making it fail

Failures are injected by the server, switchable at runtime without a restart. Use the admin page at `/admin`, or the CLI:

```sh
cd server
npm run chaos                          # show current state and the presets
npm run chaos -- preset 2g             # apply a preset
npm run chaos -- clear                 # back to normal
```

| Preset | What it does | What the app should do |
|---|---|---|
| `2g` | 600 ms latency, ~6 KB/s | Keep going, slowly, with visible progress |
| `flaky` | 2G, plus 25% of chunks dropped mid-body and 10% of requests answered 503 | Resume from the bytes the server kept; retry with backoff |
| `errors-500` | Half of all requests answer 500 | Retry |
| `hang-next-chunk` | The next chunk never gets an answer | Give up on it after 60 s, then retry |
| `drop-next-2-chunks` | The next two chunks lose their connection after 100 KB | Resume from 100 KB, not from 0 |
| `lose-next-commit` | Commits the report, then drops the reply | Retry the commit and land exactly once |
| `refuse-uploads` | Every new report is refused with 413 | Stop, do not retry; show "needs attention" |
| `forbid-uploads` | Every new report is refused with 403 | Same as above |

Finer control:

```sh
npm run chaos -- latency 1500                                     # ms
npm run chaos -- bandwidth 4000                                   # bytes/s, 0 = off
npm run chaos -- rule chunk drop --after 65536 --rate 0.5 --times 3
npm run chaos -- rule commit lose-response --times 1
npm run chaos -- rule any error --status 503 --rate 0.2
npm run chaos -- rule manifest refuse --status 413
npm run chaos -- rule chunk hang --times 1
```

Routes are `manifest`, `chunk`, `commit` or `any`. `SERVER=http://host:4000` points the CLI at another machine.

---

## Decisions, and why

### Delivery: nothing lost, nothing twice

**Save first, then say "saved".** A report and its photos are written to the phone before the UI says anything. Photos are copied into app storage the moment they're added, because picker URIs and caches don't survive a kill. Reports live in SQLite as one JSON row each (a single-row upsert is atomic) with `synchronous=FULL`, so "Saved on this phone" also survives power loss.

**A resumable upload protocol, not one big POST.** On 2G a 3 MB photo takes minutes; restarting from zero on every drop would mean it never arrives. The protocol has three steps:

```
PUT   /v1/reports/:id                 manifest (description, sha256 and size per photo); safe to repeat; answers with how many bytes the server holds per photo
PATCH /v1/reports/:id/images/:image   raw bytes at Upload-Offset
POST  /v1/reports/:id/commit          server checks every sha256, then publishes; safe to repeat
```

Report and image ids are UUIDs made on the phone, so a retry of any step is the same request, not a new report. The server's byte count is always the truth: a dropped connection leaves a valid prefix on disk, and the app resumes from whatever the server says it has. A report becomes visible only at commit, so the server never lists a half-uploaded one.

**Exactly once after a lost reply.** If the commit succeeds but the reply is lost, the app retries the commit; the server answers "already committed" and nothing is duplicated. If the server has forgotten a report entirely (it was reset, or an unfinished upload was cleaned up after 24 h), a 404 makes the app start that report over from the manifest.

**Intact.** The server hashes each photo at commit. A mismatch discards that photo and asks for it again from byte 0; after repeated mismatches the report stops with "needs attention" instead of looping.

**A kill at any point.** Each step is saved before the next begins, so `deliver()` picks up wherever the last run stopped. Photo processing writes to a temp file and moves it into place only when finished. A photo that crashes the encoder is given up after three tries, so it can't crash-loop the app. Files left behind by a kill are removed at the next launch.

**Chunk size adapts.** It starts at 64 KB, doubles after fast chunks (up to 1 MB) and halves after a drop or timeout (down to 16 KB). A drop on 2G loses little; a good link isn't slowed by tiny requests.

**One report at a time, oldest first.** On 2G, parallel uploads just make every report slower. The inspector can move a report to the front ("Send this one first"); the current chunk is abandoned, but bytes already on the server are kept. A refused report steps aside, so one bad report can't block the queue.

### Retry policy

Every failure is sorted into one of three kinds (`app/src/core/retry.ts`):

| Kind | Cases | What happens |
|---|---|---|
| Retry on our own | no connection, timeouts, 408, 423/425, 429, 5xx | Exponential backoff with jitter: 2 s, 4 s, 8 s … up to 60 s. Up to 5 min while the phone says it's offline. `Retry-After` is honoured. |
| Stop and ask | 400, 401/403, 409, 413, 422, a photo that can't be read or shrunk | "Needs attention" with the reason, and Retry / Discard buttons. When the refusal names one photo, a **Replace photo** button swaps just that one and keeps the rest. Retrying the same bytes would get the same answer. |
| Start over | 404 | The server no longer knows the report; send the manifest again. |

The phone's "offline" signal never stops an attempt, because on 2G it's wrong in both directions. "Back online" is used only as a reason to stop waiting out a backoff. Every request has a timeout (30 s for control requests, 60 s per chunk), so a server that never answers can't hang the queue.

### Images

The ceiling is **5,000,000 bytes**, reading "5 MB" the strict decimal way, which is also below 5 MiB. The app aims for 4.8 MB to leave headroom. The server enforces the same limit as a backstop, but the app doesn't rely on it: a final check before any byte goes out refuses anything over the ceiling.

Photos are re-encoded as JPEG by the app's own Kotlin module (`android/app/src/main/java/com/fieldreports/photos`), on a background thread. The JS core owns the policy and sends it these steps, tried in order until one fits:

```
4096 px long edge @ q85 → 4096 @ q75 → 3072 @ q80 → 2560 @ q75 → 2048 @ q70 → 1600 @ q70
```

The module **decodes each photo once**, subsampled to the first step's size, and scales every later step down from that same bitmap. A detailed photo that needs four tries is still read and decoded only once. If decoding runs out of memory, it retries at the next smaller step's size. Only one photo is encoded at a time, so five queued originals never sit in memory together. Pixels never reach JS.

An 18 MB camera original usually fits on the first step, at 2–4 MB, which is plenty to read a serial plate or a crack width. Later steps only kick in for unusually detailed scenes.

**Formats.** On Android 9+ decoding uses `ImageDecoder`, which reads HEIC/HEIF, JPEG, PNG and WebP and applies EXIF orientation. On Android 7–8.1 it uses `BitmapFactory` and rotates by the EXIF tag itself; those versions can't decode HEIC, and such a photo is marked "can't be used" at once. Output is always JPEG.

**Metadata, including GPS, is stripped.** The server gets pixels only.

**Photos are prepared as soon as they're added**, one at a time, while the inspector is still writing. A photo that can't be read or shrunk is marked on its thumbnail straight away ("Can't use", with the reason), so it can be retaken on site, and Save is blocked until it's removed. By the time Save is tapped the photos are usually ready, so the report can start sending at once. Save waits at most for the one photo being prepared right then; the uploader prepares any others.

### Interface

Three tabs: **Reports** (what's on the phone and where each stands), **Sent** (what the server holds) and **Settings**.

- **One glance, one answer.** The top of Reports says whether work is safe, moving or stuck: how many are waiting, what's being sent, when the server last answered, and when the next try is.
- **It never lies.** "Saved on this phone" and "Sent" are different facts and never share a sentence; there's a test for that. A report shows as sent only after the server confirms the commit.
- **Sent is fetched from the server**, not read from local state, with pull-to-refresh and designed loading, empty and failed states. While reports are still waiting, it doesn't poll, so it doesn't compete with uploads for the link.
- **Failure is designed.** Each state has its own message and next step: offline, retrying (with the next try time), refused (reason plus Retry / Replace photo / Discard), a photo that can't be used (marked on its thumbnail while composing), low storage when saving, camera permission blocked (with Open Settings), and validation errors. Photo errors stay on screen as notices until dismissed or fixed, rather than toasts that vanish. An error boundary replaces a white screen.
- **Slow is not stuck, and stuck is not slow.** While a report is moving, Reports shows its progress and an estimate of the time left. When the server has failed on its own side for 30 minutes in a row, the status turns amber: "Server not accepting reports", failing since when, still saved on this phone and still trying. Retrying never stops, because on 2G giving up would be wrong, but a person can now tell this needs someone to look at the server.
- **Light theme only, on purpose.** High contrast in daylight on site matters more here than following the phone's dark mode, and Android is told not to auto-darken the app.
- **Permissions.** Camera permission is checked again whenever the app comes back to the foreground, so a grant made in Settings works without a restart. The gallery uses the system photo picker (the document picker on older Android), so the app holds no photo or storage permission and there's nothing to refuse there. The storage permissions `react-native-blob-util` declares are stripped from the manifest.

### Background sending (Android)

While reports are waiting, the app runs a foreground service with a quiet "Sending reports" notification showing progress. That keeps the process alive after the inspector leaves the app. Android only allows starting it while the app is visible, so it starts as soon as there's work, and stops when the queue is empty.

**In the background, native code sends.** Keeping the process alive isn't enough on its own: React Native stops firing JS timers once the app is in the background, and `fetch()` hands back its result through a timer, as do retries and timeouts. On the emulator, photo bytes kept flowing but the commit's reply was never processed, so a report sat at "99%" until the app was opened again. So when the app leaves the screen, the outbox pauses and hands the reports whose photos are ready to a native sender (`BackgroundSender.kt`), which speaks the same protocol with the same rules: chunks sized to the link, the same retry table, backoff, and the 5 MB check before anything goes out. When the app comes back, the outbox takes the reports back and applies what was sent.

The native sender never writes the reports database (the database library bundles its own SQLite, and two copies of SQLite on one file in one process can corrupt it). It writes a small results file instead, which the app applies when it takes over, at launch too if the process died in between. The server stays the truth either way: if a result is lost, the next manifest the app sends is answered "committed", so nothing is sent twice. A report whose photos aren't prepared yet stays with the app until it's next opened or woken.

If Android kills the process anyway, or the service stops, WorkManager (through `react-native-background-fetch`) wakes a headless task about every 15 minutes when there's a network. Each wake-up sends until Android signals that its time is up (about 10 minutes), then stops the uploader cleanly, so no request is cut off mid-write; the next wake-up carries on from the server's byte count.

The notification is local and ongoing, not a push notification; Android requires it for a foreground service. Notification permission is asked after the first save, when it means something. Android 15+ caps this kind of service at about six hours a day. When Android stops it, the native sender stops (keeping what it sent for the app), the service tells the app, and the wake-ups carry on until the app is next opened and starts the service again.

**Battery saver (Doze).** When the phone sits still with the screen off, Android batches WorkManager wake-ups into maintenance windows that can be an hour or more apart, and battery saver can stop them entirely. The foreground service isn't affected while it runs. **Settings → Background sending** says whether this applies to the app and offers **Let it send in battery saver**, which opens Android's own dialog to exempt it. That's the inspector's choice, not something the app does on its own. Without the exemption the worst case for a report left on a phone in a drawer is "sends in the next window, or when the app is opened", never "lost".

### Start over

Settings → **Start over** deletes, from this phone: unsent reports, the unfinished draft, all photos, sent receipts, cached server data and settings (including the server address). It also cancels uploads in flight and background jobs. The confirmation sheet lists exactly that.

**The server is kept by default.** A switch on the same sheet deletes the server's reports too, "for everyone", in red. If the phone is cleared but the server can't be reached, the app says so and offers to try the server again.

A reply that arrives after the reset can't write a report back. If the app is killed halfway through a reset, it finishes the reset at the next launch, or at the next background wake-up if that comes first, before anything is sent.

**A report already being confirmed.** One request can't be called back: a commit the server may be processing right now. Instead of aborting it and leaving the report's fate unknown, Start over lets that one request finish (for at most about 30 seconds; nothing new starts meanwhile) and then says where the report ended up. If the server confirmed it: "One report got there first… it stays on the server". If the server didn't answer in time: "One report may be on the server… check Sent". The sheet warns about this before you confirm. Any other upload in flight is cancelled at once and never reaches the server.

### Architecture

```
app/src/core    the domain. Plain TypeScript, no React, no native modules.
  store.ts        the reports on the phone, written through to disk; refuses writes after a reset
  drafts.ts       composing: copy photos in, prepare them as they're added, validate, submit
  outbox.ts       after Save: the upload queue, retries, send-first, replace photo, reset, hand-off
  handoff.ts      what the native background sender gets, and what it reports back
  deliver.ts      one report from wherever it stands to "uploaded"
  schema.ts       versioned storage: every saved report carries its schema and is upgraded on load
app/src/infra   adapters: SQLite, files, HTTP, the native photo encoder, settings, background work
app/src/ui      screens, components and thin hooks
android/…/photos  the Kotlin photo encoder
android/…/upload  the foreground service and the native background sender (same protocol, in Kotlin)
```

`Drafts` and the `Outbox` share one `ReportStore`, so each sees the other's writes, and a reset that bumps the store's epoch stops both. Their dependencies (storage, files, HTTP, encoder, clock, randomness) are interfaces (`core/ports.ts`), which is why the tests and `sim/` drive the real logic with fakes or Node adapters.

The screens get the outbox from an `OutboxProvider` (`ui/hooks/useOutbox.ts`), not from a global. The app passes the real one; the UI tests pass one built over the core's fakes, so the failure screens are tested against the same code paths the app runs. A few screens still call small infra helpers directly (the server list, settings, free space); those are thin read-side services with no state of their own.

**App updates.** A report saved by one version may only be sent after an update. Each stored report carries a schema number, and loading upgrades older ones step by step (`core/schema.ts`, with a test that loads a first-release report).

### Libraries

| Library | Why |
|---|---|
| `op-sqlite` | Fast, synchronous-capable SQLite with WAL; atomic single-row writes for the queue. |
| `react-native-blob-util` | Streams a file from disk as a raw request body: no base64, no photo bytes in JS memory. Also used for file copies, slicing and hashing. |
| OkHttp (already in React Native) | The native background sender's HTTP client; no new dependency. |
| Own Kotlin encoder (no library) | One decode per photo for every quality step, HEIC on Android 9+, one photo in memory at a time. A resizer library takes one size per call, which means a fresh full decode for each step. |
| `react-native-image-picker` | Camera and system photo picker. |
| `react-native-permissions` | Camera and notification permission checks that can be re-run on foreground. |
| `@react-native-community/netinfo` | Connectivity hints (used only to stop waiting, never to skip work). |
| `react-native-background-fetch` | WorkManager wake-ups after the process is killed. |
| `@tanstack/react-query` | Fetching and caching the server's list for the Sent tab only. Local state comes from the outbox. |
| React Navigation | Standard native stack and tabs. |
| Server: Express, better-sqlite3, sharp | Simple to run anywhere; sharp makes thumbnails and checks each committed photo is a real JPEG. |
| Tests: Jest, React Native Testing Library | The engine's tests need nothing but fakes; the screen tests render real screens over a real outbox. |

---

## What I'd do with another day

- An end-to-end test on a real device that scripts airplane mode and force-quits (e.g. Maestro).
- Show thumbnails in the Sent tab progressively on 2G, with an offline image cache.

## What I knowingly left out

- **iOS.** The project is there, but I haven't built or run it. The photo encoder and background sending are Android only, so it would not work there as it stands.
- **No automated tests for the native code.** The photo encoder and the background sender were tested on the emulator; the logic around them (hand-off, applying results) is covered by the Jest tests, but the Kotlin itself is not.
- **The background sender is a second copy of the protocol.** Kotlin mirrors `core/deliver.ts`; a protocol change has to be made in both.
- **Dark mode.** The app is light-only by design (see Interface).
- **The server is a test backend.** No authentication (out of scope by the brief) and no horizontal scaling.
- **Editing a report after it's sent**, login, push notifications, maps and video are out of scope by the brief.
