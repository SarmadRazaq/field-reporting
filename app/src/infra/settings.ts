import { database } from './db';

/**
 * The Android emulator reaches the host machine at 10.0.2.2. Traffic to it goes
 * through the emulated radio, so airplane mode really cuts it (adb reverse
 * would tunnel around airplane mode and hide the very thing we test).
 * A phone on Wi-Fi uses the host's LAN address, set in Settings.
 */
export const DEFAULT_SERVER_URL = 'http://10.0.2.2:4000';

let serverUrl: string | null = null;

export function getServerUrl(): string {
  if (serverUrl === null) {
    const { rows } = database().executeSync("SELECT value FROM settings WHERE key = 'serverUrl'");
    serverUrl = rows[0] ? String(rows[0].value) : DEFAULT_SERVER_URL;
  }
  return serverUrl;
}

export function setServerUrl(url: string) {
  serverUrl = url.trim().replace(/\/+$/, '');
  database().executeSync("INSERT OR REPLACE INTO settings (key, value) VALUES ('serverUrl', ?)", [serverUrl]);
}

export function clearSettings() {
  database().executeSync('DELETE FROM settings');
  serverUrl = null;
}
