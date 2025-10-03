import { RpcTarget, newWorkersRpcResponse } from 'capnweb';

export interface Env {
  ENTRIES: DurableObjectNamespace;
}

export interface EntryInput {
  title: string;
  content: string;
}

export interface EntryRecord extends EntryInput {
  id: number;
  createdAt: string;
}

class EntriesRpcServer extends RpcTarget {
  constructor(private readonly context: EntriesDurableObject) {
    super();
  }

  async sendEntry(params: unknown) {
    const input = validateEntryInput(params);
    return this.context.insertEntry(input);
  }

  async fetchEntries() {
    return this.context.fetchEntries();
  }

  async deleteEntry(params: unknown) {
    const id = normalizeEntryIdentifier(params);
    await this.context.deleteEntry(id);
    return { deleted: id } as const;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/rpc') {
      const id = env.ENTRIES.idFromName('singleton');
      const stub = env.ENTRIES.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

const ENTRY_PREFIX = 'entry:';
const COUNTER_KEY = 'entry.counter';

export class EntriesDurableObject {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    return newWorkersRpcResponse(request, new EntriesRpcServer(this));
  }

  async insertEntry(input: EntryInput): Promise<EntryRecord> {
    const id = await this.nextIdentifier();
    const createdAt = new Date().toISOString();

    const record: EntryRecord = { id, createdAt, ...input };
    await this.storage.put(`${ENTRY_PREFIX}${id}`, record);
    return record;
  }

  async fetchEntries(): Promise<EntryRecord[]> {
    const snapshot = await this.storage.list<EntryRecord>({ prefix: ENTRY_PREFIX });
    const entries = Array.from(snapshot.values());

    return entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async deleteEntry(id: number): Promise<void> {
    await this.storage.delete(`${ENTRY_PREFIX}${id}`);
  }

  private async nextIdentifier(): Promise<number> {
    const current = (await this.storage.get<number>(COUNTER_KEY)) ?? 0;
    const next = current + 1;
    await this.storage.put(COUNTER_KEY, next);
    return next;
  }
}

const validateEntryInput = (params: unknown): EntryInput => {
  if (!params || typeof params !== 'object') {
    throw new TypeError('Entry parameters must be an object.');
  }

  const title = sanitizeField((params as Record<string, unknown>).title, 'title');
  const content = sanitizeField((params as Record<string, unknown>).content, 'content');

  return { title, content };
};

const sanitizeField = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new TypeError(`Entry ${field} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`Entry ${field} cannot be empty.`);
  }

  if (trimmed.length > 2048) {
    throw new TypeError(`Entry ${field} exceeds the maximum length.`);
  }

  return trimmed;
};

const normalizeEntryIdentifier = (input: unknown): number => {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }

  if (typeof input === 'object' && input !== null) {
    const value = (input as Record<string, unknown>).id;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  if (typeof input === 'string' && input.trim()) {
    const parsed = Number(input);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  throw new TypeError('Entry id must be provided as a finite number.');
};
