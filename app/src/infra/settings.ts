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

/** When the server last answered, kept across launches so "last reached" survives a restart. */
export const contactStore = {
  get(): number | null {
    const { rows } = database().executeSync("SELECT value FROM settings WHERE key = 'lastContactAt'");
    return rows[0] ? Number(rows[0].value) : null;
  },
  set(at: number) {
    database().executeSync("INSERT OR REPLACE INTO settings (key, value) VALUES ('lastContactAt', ?)", [String(at)]);
  },
};

/** Set before Start over begins and removed with the other settings at its end; still there at launch means it was interrupted. */
export const resetMarker = {
  isSet(): boolean {
    return database().executeSync("SELECT 1 FROM settings WHERE key = 'resetPending'").rows.length > 0;
  },
  set() {
    database().executeSync("INSERT OR REPLACE INTO settings (key, value) VALUES ('resetPending', '1')");
  },
};

/**
 * How the last Start over ended, kept until the inspector dismisses it, so a
 * reset that finished while they were away still says where things stand.
 * Written after the reset's own clearSettings(), so it survives that.
 */
export const lastResetStore = {
  get(): unknown {
    const { rows } = database().executeSync("SELECT value FROM settings WHERE key = 'lastReset'");
    try {
      return rows[0] ? JSON.parse(String(rows[0].value)) : null;
    } catch {
      return null;
    }
  },
  set(value: unknown) {
    database().executeSync("INSERT OR REPLACE INTO settings (key, value) VALUES ('lastReset', ?)", [JSON.stringify(value)]);
  },
  clear() {
    database().executeSync("DELETE FROM settings WHERE key = 'lastReset'");
  },
};

export function clearSettings() {
  database().executeSync('DELETE FROM settings');
  serverUrl = null;
}
