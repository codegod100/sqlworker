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

type UpdateListener = {
  notifyNewData(entry: EntryRecord): Promise<void> | void;
  dup?: () => UpdateListener;
  close?: () => Promise<void> | void;
  dispose?: () => Promise<void> | void;
};

interface ListenerEntry {
  retained: UpdateListener;
  release?: () => Promise<void> | void;
}

const RANDOM_ENTRY_INTERVAL_MS = 15_000;

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

  async subscribeUpdates(params: unknown) {
    const listenerCandidate =
      params && typeof params === 'object' && 'listener' in (params as Record<string, unknown>)
        ? (params as Record<string, unknown>).listener
        : params;

    const candidateType = typeof listenerCandidate;
    if (!listenerCandidate || (candidateType !== 'object' && candidateType !== 'function')) {
      console.error('EntriesDurableObject: subscribeUpdates received invalid listener payload', {
        params,
        listenerCandidate,
        candidateType,
      });
      throw new TypeError('subscribeUpdates requires a listener object payload.');
    }

    const listener = listenerCandidate as UpdateListener;
    if (typeof (listener as any).notifyNewData !== 'function') {
      console.error('EntriesDurableObject: listener missing notifyNewData method', listener);
      throw new TypeError('subscribeUpdates requires listener with notifyNewData method.');
    }

    const unsubscribe = this.context.registerListener(listener);
    return { subscribed: true, unsubscribe } as const;
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
  private readonly updateListeners = new Set<ListenerEntry>();

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    state.blockConcurrencyWhile(async () => {
      await this.ensureRandomAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    return newWorkersRpcResponse(request, new EntriesRpcServer(this));
  }

  async insertEntry(input: EntryInput): Promise<EntryRecord> {
    const id = await this.nextIdentifier();
    const createdAt = new Date().toISOString();

    const record: EntryRecord = { id, createdAt, ...input };
    await this.storage.put(`${ENTRY_PREFIX}${id}`, record);
    console.log('EntriesDurableObject: stored entry', record);
    await this.notifyListeners(record);
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

  registerListener(listener: UpdateListener): UnsubscribeTarget {
    if (!listener || typeof listener.notifyNewData !== 'function') {
      throw new TypeError('Listener must expose a notifyNewData method.');
    }
    const retained = typeof (listener as any).dup === 'function' ? (listener as any).dup() : listener;
    const release = (() => {
      const target = retained as { close?: () => unknown; dispose?: () => unknown };
      if (typeof target.close === 'function') {
        return target.close.bind(target);
      }
      if (typeof target.dispose === 'function') {
        return target.dispose.bind(target);
      }
      return undefined;
    })();

    const entry: ListenerEntry = { retained, release };
    this.updateListeners.add(entry);
    console.log('EntriesDurableObject: registered listener. Total listeners:', this.updateListeners.size);
    return new UnsubscribeTarget(this, entry);
  }

  private async notifyListeners(record: EntryRecord): Promise<void> {
    const failures: ListenerEntry[] = [];
    const entries = Array.from(this.updateListeners);

    await Promise.all(
      entries.map(async (entry) => {
        const { retained } = entry;
        try {
          console.log('EntriesDurableObject: notifying listener about entry', record.id);
          await retained.notifyNewData(record);
          console.log('EntriesDurableObject: listener notified successfully for entry', record.id);
        } catch (error) {
          console.warn('Failed to notify listener of new entry.', error);
          failures.push(entry);
        }
      }),
    );

    failures.forEach((entry) => this.unsubscribeListener(entry));
  }

  unsubscribeListener(entry: ListenerEntry): void {
    if (entry.release) {
      const releaseFn = entry.release;
      entry.release = undefined;
      try {
        void releaseFn();
      } catch (error) {
        console.warn('EntriesDurableObject: error while releasing listener', error);
      }
    }
    this.updateListeners.delete(entry);
    console.log('EntriesDurableObject: listener unsubscribed. Total listeners:', this.updateListeners.size);
  }

  private async nextIdentifier(): Promise<number> {
    const current = (await this.storage.get<number>(COUNTER_KEY)) ?? 0;
    const next = current + 1;
    await this.storage.put(COUNTER_KEY, next);
    return next;
  }

  private async ensureRandomAlarm(): Promise<void> {
    const existing = await this.storage.getAlarm();
    const now = Date.now();

    if (existing) {
      if (existing > now + 1000) {
        console.log(
          'EntriesDurableObject: alarm already scheduled for',
          new Date(existing).toISOString(),
          `(${describeRelativeTime(existing - now)})`,
        );
        return;
      }

      console.log(
        'EntriesDurableObject: detected overdue alarm, generating catch-up entry (scheduled for',
        new Date(existing).toISOString(),
        ')',
      );
      await this.insertEntry(this.buildRandomEntryInput());
      await this.scheduleNextRandomEntry();
      return;
    }

    console.log('EntriesDurableObject: no alarm scheduled, creating initial random entry and scheduling next');
    await this.insertEntry(this.buildRandomEntryInput());
    await this.scheduleNextRandomEntry();
  }

  private async scheduleNextRandomEntry(delayMs = RANDOM_ENTRY_INTERVAL_MS): Promise<void> {
    const when = Date.now() + delayMs;
    await this.storage.setAlarm(when);
    console.log(
      'EntriesDurableObject: scheduled next random entry for',
      new Date(when).toISOString(),
      `(${describeRelativeTime(delayMs)})`,
    );
  }

  async alarm(): Promise<void> {
    console.log('EntriesDurableObject: alarm triggered, creating random entry');
    await this.insertEntry(this.buildRandomEntryInput());
    await this.scheduleNextRandomEntry();
  }

  private buildRandomEntryInput(): EntryInput {
    const adjectives = ['Vibrant', 'Luminous', 'Curious', 'Breezy', 'Twilight', 'Nebula', 'Aurora'];
    const nouns = ['Aurora', 'Echo', 'Cascade', 'Harbor', 'Cosmos', 'Vista', 'Grove'];
    const topics = ['observations', 'insights', 'notes', 'discoveries', 'ideas'];

    const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
    const title = `${pick(adjectives)} ${pick(nouns)}`;
    const content = `Auto-generated ${pick(topics)} at ${new Date().toLocaleTimeString()}.`;

    return { title, content };
  }
}

const describeRelativeTime = (milliseconds: number): string => {
  const sign = milliseconds >= 0 ? 1 : -1;
  const remaining = Math.abs(milliseconds);
  const seconds = Math.round(remaining / 1000);

  const format = (unit: string, value: number) =>
    sign >= 0 ? `in ${value}${unit}` : `${value}${unit} ago`;

  if (seconds < 60) {
    return format('s', seconds);
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return format('m', minutes);
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return format('h', hours);
  }

  const days = Math.round(hours / 24);
  return format('d', days);
};

class UnsubscribeTarget extends RpcTarget {
  constructor(private readonly context: EntriesDurableObject, private readonly entry: ListenerEntry) {
    super();
  }

  async unsubscribe() {
    this.context.unsubscribeListener(this.entry);
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
