import { NativeModules, Platform } from 'react-native';

interface UploadServiceNative {
  start(title: string, text: string, percent: number): Promise<boolean>;
  update(title: string, text: string, percent: number): void;
  stop(): void;
  isRunning(): Promise<boolean>;
}

const native: UploadServiceNative | undefined = Platform.OS === 'android' ? NativeModules.UploadService : undefined;

/**
 * The Android foreground service that keeps uploads running in the
 * background (android/app/src/main/java/com/fieldreports/upload). A no-op
 * where it doesn't exist. `percent` < 0 means no progress bar.
 */
export const uploadService = {
  start: (title: string, text: string, percent = -1) => native?.start(title, text, percent) ?? Promise.resolve(false),
  update: (title: string, text: string, percent = -1) => native?.update(title, text, percent),
  stop: () => native?.stop(),
};
