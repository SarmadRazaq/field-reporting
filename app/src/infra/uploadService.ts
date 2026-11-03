import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { HandoffReport } from '../core/handoff';

interface UploadServiceNative {
  start(title: string, text: string, percent: number): Promise<boolean>;
  update(title: string, text: string, percent: number): void;
  stop(): void;
  isRunning(): Promise<boolean>;
  handOff(reportsJson: string, baseUrl: string): Promise<boolean>;
  takeBack(): Promise<string | null>;
  isSending(): Promise<boolean>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

const native: UploadServiceNative | undefined = Platform.OS === 'android' ? NativeModules.UploadService : undefined;
const events = native ? new NativeEventEmitter(native) : null;

/**
 * The Android foreground service that keeps uploads running in the
 * background (android/app/src/main/java/com/fieldreports/upload). A no-op
 * where it doesn't exist. `percent` < 0 means no progress bar.
 */
export const uploadService = {
  start: (title: string, text: string, percent = -1) => native?.start(title, text, percent) ?? Promise.resolve(false),
  update: (title: string, text: string, percent = -1) => native?.update(title, text, percent),
  stop: () => native?.stop(),
  /** Let native code send these while the app is in the background. False if it can't (service not running). */
  handOff: (reports: HandoffReport[], baseUrl: string) =>
    native?.handOff(JSON.stringify(reports), baseUrl) ?? Promise.resolve(false),
  /** Stop native sending; returns what it did (JSON for parseHandoffResults), or null. */
  takeBack: () => native?.takeBack() ?? Promise.resolve(null),
  isSending: () => native?.isSending() ?? Promise.resolve(false),
  /** Called when the service stops without the app asking: 'done' (native sender finished) or 'timeout' (Android 15+ daily cap). */
  onStoppedByAndroid(listener: (reason: string) => void): () => void {
    const sub = events?.addListener('UploadServiceStopped', (reason: unknown) => listener(String(reason)));
    return () => sub?.remove();
  },
};

/** Doze / app standby: while it applies, background wake-ups can be held back for an hour or more. */
export const batteryOptimisation = {
  /** True when the app is exempt; also true where the question doesn't apply. */
  isExempt: () => native?.isIgnoringBatteryOptimizations() ?? Promise.resolve(true),
  /** Opens the system dialog that lets the inspector exempt the app. */
  requestExemption: () => native?.requestIgnoreBatteryOptimizations(),
};
