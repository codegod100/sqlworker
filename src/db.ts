import { sqlite3Worker1Promiser } from '@sqlite.org/sqlite-wasm';

type Logger = (...args: unknown[]) => void;

type SQLitePromiser = ReturnType<typeof sqlite3Worker1Promiser>;
type DatabaseIdentifier = number | string;

export interface SQLiteInitOptions {
  log?: Logger;
  error?: Logger;
}

export interface EntryInput {
  id?: string;
  title: string;
  content: string;
  createdAt?: string;
}

export interface EntryRecord extends EntryInput {
  id: string;
  createdAt: string;
}

export interface SQLiteClient {
  insertEntry(entry: EntryInput): Promise<EntryRecord>;
  fetchEntries(): Promise<EntryRecord[]>;
  deleteEntry(id: string): Promise<void>;
  syncEntries(entries: EntryRecord[]): Promise<void>;
}

let clientPromise: Promise<SQLiteClient> | null = null;

export const initializeSQLite = async (options: SQLiteInitOptions = {}): Promise<SQLiteClient> => {
  if (!clientPromise) {
    clientPromise = createClient(options);
  }
  return clientPromise;
};

const createClient = async ({
  log = console.log,
  error = console.error,
}: SQLiteInitOptions): Promise<SQLiteClient> => {
  try {
    log('Loading and initializing SQLite3 module...');

    const promiser = await createPromiser();

    log('SQLite worker ready. Fetching configuration...');

    const configResponse = await promiser('config-get', {});
    const libVersion: string | undefined = (configResponse as any)?.result?.version?.libVersion;
    log('Running SQLite3 version', libVersion ?? 'unknown');

    const filename = 'file:mydb.sqlite3?vfs=opfs';
    const openResponse = await promiser('open', { filename });

    const dbId = extractDbId(openResponse);

    if (!isValidDbId(dbId)) {
      log('Received unexpected open response payload:', openResponse);
      throw new Error('SQLite worker did not return a database identifier.');
    }

    const persistentPath = ((openResponse as any)?.result?.filename as string | undefined)?.replace(
      /^file:(.*?)\?vfs=opfs$/,
      '$1',
    );

    if (persistentPath) {
      log('OPFS is available, database stored at', persistentPath);
    }

    await ensureSchema(promiser, dbId, log);

    const insertEntry = async ({ id, title, content, createdAt }: EntryInput): Promise<EntryRecord> => {
      const finalId = id ?? generateUlid();
      const finalCreatedAt = createdAt ?? new Date().toISOString();

      const insertResponse = await promiser('exec', {
        dbId,
        sql: `INSERT INTO entries (id, title, content, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 content = excluded.content,
                 created_at = excluded.created_at;`,
        bind: [finalId, title, content, finalCreatedAt],
      });

      log('Stored entry', finalId, insertResponse);

      return { id: finalId, title, content, createdAt: finalCreatedAt };
    };

    const fetchEntries = async (): Promise<EntryRecord[]> => {
      const response = await promiser('exec', {
        dbId,
        sql: `SELECT id, title, content, created_at FROM entries ORDER BY created_at DESC;`,
        rowMode: 'object',
        returnValue: 'resultRows',
      });

      log('Fetch response payload:', response);

      const rows = normalizeRows(response);
      log(`Fetched ${rows.length} entries from the database.`);

      return rows
        .map((row) => ({
          id: String(row.id ?? ''),
          title: String(row.title ?? ''),
          content: String(row.content ?? ''),
          createdAt: String(row.created_at ?? row.createdAt ?? ''),
        }))
        .filter((entry) => entry.id.length > 0);
    };

    return {
      insertEntry,
      fetchEntries,
      deleteEntry: async (id: string) => {
        if (!id) {
          throw new Error('Entry id must be provided.');
        }

        const deleteResponse = await promiser('exec', {
          dbId,
          sql: 'DELETE FROM entries WHERE id = ?;',
          bind: [id],
        });

        log('Deleted entry', id, deleteResponse);
      },
      syncEntries: async (entries: EntryRecord[]) => {
        if (!entries.length) {
          return;
        }

        log(`Synchronizing ${entries.length} entries from remote source.`);

        try {
          await promiser('exec', {
            dbId,
            sql: 'BEGIN TRANSACTION;',
          });

          for (const entry of entries) {
            if (!entry.id) {
              continue;
            }
            await promiser('exec', {
              dbId,
              sql: `INSERT INTO entries (id, title, content, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      title = excluded.title,
                      content = excluded.content,
                      created_at = excluded.created_at;`,
              bind: [entry.id, entry.title, entry.content, entry.createdAt],
            });
          }

          await promiser('exec', {
            dbId,
            sql: 'COMMIT;',
          });

          log('Remote entries synchronized into local database.');
        } catch (error) {
          await promiser('exec', {
            dbId,
            sql: 'ROLLBACK;',
          }).catch(() => {
            /* ignore rollback failure */
          });

          throw normalizeError(error);
        }
      },
    };
  } catch (err) {
    const normalized = normalizeError(err);
    error(normalized.name, normalized.message);
    throw normalized;
  }
};

const createPromiser = () =>
  new Promise<SQLitePromiser>((resolve) => {
    const promiser = sqlite3Worker1Promiser({
      onready: () => resolve(promiser),
    });
  });

const normalizeRows = (response: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(response)) {
    return response as Array<Record<string, unknown>>;
  }

  const candidates = [
    (response as any)?.result?.resultRows,
    (response as any)?.result?.rows,
    (response as any)?.resultRows,
    (response as any)?.rows,
    (response as any)?.result,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate as Array<Record<string, unknown>>;
    }
  }

  return [];
};

const normalizeError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }

  const fallback = (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value ?? 'Unknown value');
    }
  })();

  const message =
    (value as any)?.result?.message ??
    (value as any)?.message ??
    (value as string | undefined) ??
    fallback ??
    'Unknown SQLite error';

  return new Error(message);
};

const ensureSchema = async (promiser: SQLitePromiser, dbId: DatabaseIdentifier, log: Logger) => {
  const existingColumnsResponse = await promiser('exec', {
    dbId,
    sql: `PRAGMA table_info('entries');`,
    rowMode: 'object',
    returnValue: 'resultRows',
  });

  const columns = normalizeRows(existingColumnsResponse);

  if (!columns.length) {
    await createEntriesTable(promiser, dbId, log);
    return;
  }

  const idColumn = columns.find((column) => String(column.name) === 'id');
  const idType = String(idColumn?.type ?? '').toUpperCase();

  if (idType === 'TEXT') {
    log('Schema ready.');
    return;
  }

  log('Migrating entries table to ULID-based schema...');

  await promiser('exec', { dbId, sql: 'BEGIN TRANSACTION;' });
  try {
    await promiser('exec', { dbId, sql: 'ALTER TABLE entries RENAME TO entries_legacy;' });
    await createEntriesTable(promiser, dbId, log);

    const legacyRowsResponse = await promiser('exec', {
      dbId,
      sql: `SELECT id, title, content, created_at FROM entries_legacy ORDER BY created_at ASC;`,
      rowMode: 'object',
      returnValue: 'resultRows',
    });

    const legacyRows = normalizeRows(legacyRowsResponse);

    for (const row of legacyRows) {
      const rawId = row.id;
      const migratedId = typeof rawId === 'string' && rawId.trim().length
        ? rawId.trim()
        : typeof rawId === 'number' && Number.isFinite(rawId)
        ? String(rawId)
        : generateUlid();
      await promiser('exec', {
        dbId,
        sql: `INSERT INTO entries (id, title, content, created_at)
               VALUES (?, ?, ?, ?);`,
        bind: [migratedId, String(row.title ?? ''), String(row.content ?? ''), String(row.created_at ?? row.createdAt ?? new Date().toISOString())],
      });
    }

    await promiser('exec', { dbId, sql: 'DROP TABLE entries_legacy;' });
    await promiser('exec', { dbId, sql: 'COMMIT;' });
    log('Schema migration complete.');
  } catch (migrationError) {
    await promiser('exec', { dbId, sql: 'ROLLBACK;' }).catch(() => {});
    throw migrationError;
  }
};

const createEntriesTable = async (promiser: SQLitePromiser, dbId: DatabaseIdentifier, log: Logger) => {
  await promiser('exec', {
    dbId,
    sql: `CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`,
  });
  log('Entries table ready.');
};

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIMESTAMP_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;

const generateUlid = (): string => {
  const time = Date.now();
  const timeEncoded = encodeTime(time, ULID_TIMESTAMP_LENGTH);
  const randomEncoded = encodeRandom(ULID_RANDOM_LENGTH);
  return timeEncoded + randomEncoded;
};

const encodeTime = (time: number, length: number): string => {
  let value = time;
  const encoded = Array<string>(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    encoded[i] = ULID_ALPHABET.charAt(value % ULID_ALPHABET.length);
    value = Math.floor(value / ULID_ALPHABET.length);
  }
  return encoded.join('');
};

const encodeRandom = (length: number): string => {
  const randomBytes = new Uint8Array(length);
  getCrypto().getRandomValues(randomBytes);

  const encoded = Array<string>(length);
  randomBytes.forEach((byte, index) => {
    encoded[index] = ULID_ALPHABET.charAt(byte % ULID_ALPHABET.length);
  });

  return encoded.join('');
};

const getCrypto = (): Crypto => {
  if (typeof globalThis === 'object' && globalThis.crypto && 'getRandomValues' in globalThis.crypto) {
    return globalThis.crypto;
  }

  throw new Error('Secure random number generation is not supported in this environment.');
};

const extractDbId = (payload: unknown): DatabaseIdentifier | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const direct = (payload as any).dbId;
  const resolvedDirect = coerceDbId(direct);
  if (resolvedDirect !== undefined) {
    return resolvedDirect;
  }

  const nestedResult = (payload as any).result;
  if (nestedResult && typeof nestedResult === 'object') {
    const nestedDbId = coerceDbId((nestedResult as any).dbId);
    if (nestedDbId !== undefined) {
      return nestedDbId;
    }
  }

  const alternative = coerceDbId(
    (payload as any).id ?? (payload as any).db_id ?? nestedResult?.id ?? nestedResult?.db_id,
  );

  return alternative;
};

const coerceDbId = (value: unknown): DatabaseIdentifier | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length) {
    return value;
  }

  return undefined;
};

const isValidDbId = (value: unknown): value is DatabaseIdentifier => {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  return typeof value === 'string' && value.length > 0;
};
