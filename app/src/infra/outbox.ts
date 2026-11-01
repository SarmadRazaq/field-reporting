import 'react-native-get-random-values';
import { v4 as uuid } from 'uuid';
import { Outbox } from '../core/outbox';
import { BlobFileStore } from './BlobFileStore';
import { database } from './db';
import { NativeHttpClient } from './NativeHttpClient';
import { ResizerEncoder } from './ResizerEncoder';
import { getServerUrl } from './settings';
import { SqliteReportRepo } from './SqliteReportRepo';

let instance: Outbox | null = null;

/**
 * The one Outbox in the process, shared by the UI and background tasks, so
 * there is only ever one uploader writing to the database.
 */
export function outbox(): Outbox {
  if (!instance) {
    instance = new Outbox({
      repo: new SqliteReportRepo(database()),
      files: new BlobFileStore(),
      encoder: new ResizerEncoder(),
      http: new NativeHttpClient(getServerUrl),
      newId: uuid,
      log: __DEV__ ? m => console.log(m) : undefined,
    });
  }
  return instance;
}
