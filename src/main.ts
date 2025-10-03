import './style.css';

import { initializeSQLite, type EntryInput, type EntryRecord, type SQLiteClient } from './db';
import { newWebSocketRpcSession, RpcTarget } from 'capnweb';

const appRoot = document.querySelector<HTMLDivElement>('#app');

if (!appRoot) {
  throw new Error('Missing #app container in index.html');
}

appRoot.innerHTML = `
  <main class="container">
    <header>
      <h1>SQLite WASM Demo</h1>
      <p>
        This demo initializes the <code>@sqlite.org/sqlite-wasm</code> worker using Vite.
      </p>
    </header>
    <section class="controls">
      <button id="initialize" type="button">Reinitialize Worker</button>
      <label class="field inline-field">
        <span>Worker WebSocket URL</span>
        <input id="worker-url" type="text" placeholder="ws://localhost:8787/rpc" />
      </label>
    </section>
    <section class="entry-section">
      <h2>Add Entry</h2>
      <form id="entry-form" autocomplete="off">
        <label class="field">
          <span>Title</span>
          <input name="title" type="text" required maxlength="120" placeholder="e.g. First note" />
        </label>
        <label class="field">
          <span>Content</span>
          <textarea
            name="content"
            rows="4"
            required
            placeholder="Add some details about this entry"
          ></textarea>
        </label>
        <button type="submit">Save Entry</button>
      </form>
    </section>
    <section class="entries-section">
      <div class="entries-header">
        <h2>Stored Entries</h2>
        <div class="entries-buttons">
          <span id="remote-indicator" class="remote-indicator hidden" role="status">New remote data available</span>
          <button id="sync-remote" type="button">Sync Remote</button>
          <button id="refresh" type="button">Refresh Local</button>
        </div>
      </div>
      <ul id="entries" aria-live="polite"></ul>
    </section>
    <section class="log-section">
      <h2>Log Output</h2>
      <pre id="log" aria-live="polite"></pre>
    </section>
  </main>
`;

const logOutput = appRoot.querySelector<HTMLPreElement>('#log');
const initializeButton = appRoot.querySelector<HTMLButtonElement>('#initialize');
const entryForm = appRoot.querySelector<HTMLFormElement>('#entry-form');
const refreshButton = appRoot.querySelector<HTMLButtonElement>('#refresh');
const syncRemoteButton = appRoot.querySelector<HTMLButtonElement>('#sync-remote');
const remoteIndicator = appRoot.querySelector<HTMLSpanElement>('#remote-indicator');
const entriesList = appRoot.querySelector<HTMLUListElement>('#entries');
const workerUrlInput = appRoot.querySelector<HTMLInputElement>('#worker-url');

if (
  !logOutput ||
  !initializeButton ||
  !entryForm ||
  !refreshButton ||
  !syncRemoteButton ||
  !remoteIndicator ||
  !entriesList ||
  !workerUrlInput
) {
  throw new Error('Failed to bootstrap UI components.');
}

const formatArg = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const appendLog = (level: 'info' | 'error', ...args: unknown[]) => {
  const line = `[${level.toUpperCase()}] ${args.map(formatArg).join(' ')}\n`;
  logOutput.textContent += line;
  logOutput.scrollTop = logOutput.scrollHeight;
};

const setUiEnabled = (enabled: boolean) => {
  entryForm.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
    input.disabled = !enabled;
  });
  entryForm.querySelectorAll<HTMLTextAreaElement>('textarea').forEach((textarea) => {
    textarea.disabled = !enabled;
  });
  entryForm.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = !enabled;
  });
  refreshButton.disabled = !enabled;
  syncRemoteButton.disabled = !enabled;
  entriesList.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.disabled = !enabled;
  });
};

const uiLog = (...args: unknown[]) => {
  console.log(...args);
  appendLog('info', ...args);
};

const uiError = (...args: unknown[]) => {
  console.error(...args);
  appendLog('error', ...args);
};

let sqliteClient: SQLiteClient | null = null;
let workerClient: EntriesRpcSession | null = null;
let workerUpdateTarget: ClientUpdateTarget | null = null;
let workerUnsubscribe: RemoteUnsubscribeStub | null = null;
let workerReconnectTimer: number | null = null;
let workerNextReconnectAt: number | null = null;
let customWorkerUrl: string | null = null;

const remoteUpdates = new Map<string, EntryRecord>();

interface RemoteUpdateNotifier {
  notifyNewData(entry: EntryRecord): Promise<void> | void;
  dup?(): RemoteUpdateNotifier;
}

class ClientUpdateTarget extends RpcTarget implements RemoteUpdateNotifier {
  constructor(private readonly onNotify: (entry: EntryRecord) => void) {
    super();
  }

  async notifyNewData(entry: EntryRecord) {
    this.onNotify(entry);
  }

  dup(): RemoteUpdateNotifier {
    return new ClientUpdateTarget(this.onNotify);
  }
}

const updateRemoteIndicator = () => {
  if (remoteUpdates.size === 0) {
    remoteIndicator.classList.add('hidden');
    remoteIndicator.textContent = 'New remote data available';
    return;
  }

  remoteIndicator.classList.remove('hidden');
  remoteIndicator.textContent = `New remote data available (${remoteUpdates.size})`;
};

type EntriesRpcSession = {
  sendEntry(entry: EntryInput): Promise<EntryRecord>;
  fetchEntries(): Promise<EntryRecord[]>;
  deleteEntry(params: { id: string }): Promise<{ deleted: string }>;
  subscribeUpdates(params: {
    listener: RemoteUpdateNotifier;
  }): Promise<{ subscribed: boolean; unsubscribe?: RemoteUnsubscribeStub }>;
};

type RemoteUnsubscribeStub = {
  unsubscribe(): Promise<void> | void;
};

const resolveWorkerRpcUrl = (): string => {
  const userPreference = customWorkerUrl ?? workerUrlInput.value.trim();
  if (userPreference) {
    return userPreference;
  }

  const explicit = import.meta.env.VITE_WORKER_WS_URL;
  if (explicit) {
    return explicit;
  }

  if (typeof window === 'undefined') {
    return 'ws://127.0.0.1:8787/rpc';
  }

  const { protocol, hostname, port } = window.location;
  const isSecure = protocol === 'https:';
  const wsProtocol = isSecure ? 'wss:' : 'ws:';

  if (import.meta.env.DEV) {
    return `${wsProtocol}//${hostname}:8787/rpc`;
  }

  const suffix = port ? `:${port}` : '';
  return `${wsProtocol}//${hostname}${suffix}/rpc`;
};

const createWorkerSession = (): EntriesRpcSession => {
  return newWebSocketRpcSession<EntriesRpcSession>(resolveWorkerRpcUrl());
};

const closeWorkerSession = async ({ preserveRemoteUpdates = false }: { preserveRemoteUpdates?: boolean } = {}): Promise<void> => {
  try {
    if (workerUnsubscribe) {
      await workerUnsubscribe.unsubscribe();
    }
  } catch (error) {
    uiError('Failed to unsubscribe from worker updates.', error);
  } finally {
    workerClient = null;
    if (workerUpdateTarget) {
      const closeFn =
        (workerUpdateTarget as unknown as { close?: () => Promise<void> | void }).close?.bind(workerUpdateTarget) ??
        (workerUpdateTarget as unknown as { dispose?: () => Promise<void> | void }).dispose?.bind(workerUpdateTarget);

      if (closeFn) {
        try {
          const result = closeFn();
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            await result;
          }
        } catch (releaseError) {
          uiError('Failed to release worker update target.', releaseError);
        }
      }
    }
    workerUpdateTarget = null;
    workerUnsubscribe = null;
    if (!preserveRemoteUpdates) {
      remoteUpdates.clear();
      updateRemoteIndicator();
    }
    clearWorkerReconnectTimer();
  }
};

const clearWorkerReconnectTimer = () => {
  if (workerReconnectTimer !== null) {
    clearTimeout(workerReconnectTimer);
    workerReconnectTimer = null;
  }
  workerNextReconnectAt = null;
};

const scheduleWorkerReconnect = () => {
  if (workerReconnectTimer !== null) {
    return;
  }

  workerReconnectTimer = window.setTimeout(() => {
    workerReconnectTimer = null;
    workerNextReconnectAt = null;
    void attemptWorkerConnection('retry');
  }, 10_000);

  workerNextReconnectAt = Date.now() + 10_000;
  uiLog('Worker RPC unavailable; will retry connection shortly.');
  logReconnectCountdown();
};

const logReconnectCountdown = () => {
  if (workerNextReconnectAt === null) {
    return;
  }

  const remaining = workerNextReconnectAt - Date.now();
  if (remaining <= 0) {
    return;
  }

  uiLog(`Next worker RPC attempt in ${describeRelativeMillis(remaining)}.`);
};

const handleRemoteNotification = (entry: EntryRecord) => {
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) {
    uiError('Received invalid remote entry payload.', entry);
    return;
  }

  remoteUpdates.set(entry.id, entry);
  updateRemoteIndicator();
  appendLog('info', 'Worker reports new entry available.', entry);
};

const syncRemoteEntries = async () => {
  if (!sqliteClient) {
    uiError('Cannot sync remote entries before initialization completes.');
    return;
  }

  if (!workerClient) {
    appendLog('info', 'Worker RPC not connected; attempting to reconnect before syncing.');
    await attemptWorkerConnection('retry');

    if (!workerClient) {
      appendLog('info', 'Skipping remote sync; worker RPC still unavailable.');
      return;
    }
  }

  syncRemoteButton.disabled = true;
  appendLog('info', 'Syncing remote entries into local database...');

  try {
    const remoteEntries = await workerClient.fetchEntries();
    await sqliteClient.syncEntries(remoteEntries);
    remoteUpdates.clear();
    updateRemoteIndicator();
    appendLog('info', `Synced ${remoteEntries.length} remote entries.`);
    await renderEntries();
  } catch (err) {
    uiError('Failed to sync remote entries.', err);
  } finally {
    syncRemoteButton.disabled = false;
  }
};

const describeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const attemptWorkerConnection = async (phase: 'initial' | 'retry'): Promise<void> => {
  if (workerClient) {
    return;
  }

  try {
    let session: EntriesRpcSession;

    try {
      session = createWorkerSession();
    } catch (creationError) {
      uiLog(`Cloudflare Worker RPC unavailable (${describeErrorMessage(creationError)}).`);
      scheduleWorkerReconnect();
      return;
    }

    workerClient = session;
    workerUpdateTarget = new ClientUpdateTarget(handleRemoteNotification);

    const subscription = await workerClient.subscribeUpdates({ listener: workerUpdateTarget });
    workerUnsubscribe = subscription?.unsubscribe ?? null;

    clearWorkerReconnectTimer();
    uiLog(phase === 'retry' ? 'Reconnected to Cloudflare Worker RPC.' : 'Connected to Cloudflare Worker RPC.');

    await syncRemoteEntries();
  } catch (err) {
    await closeWorkerSession({ preserveRemoteUpdates: true });
    uiLog(`Cloudflare Worker RPC unavailable (${describeErrorMessage(err)}).`);
    scheduleWorkerReconnect();
  }
};

const describeRelativeMillis = (milliseconds: number): string => {
  if (milliseconds < 1000) {
    return `${Math.max(1, Math.round(milliseconds))}ms`;
  }

  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

const renderEntries = async () => {
  if (!sqliteClient) {
    entriesList.innerHTML = '<li class="empty">Database not initialized.</li>';
    return;
  }

  entriesList.classList.add('loading');
  entriesList.innerHTML = '<li class="placeholder">Loading entries…</li>';

  try {
    const entries = await sqliteClient.fetchEntries();

    if (!entries.length) {
      entriesList.innerHTML = '<li class="empty">No entries stored yet.</li>';
      return;
    }

    const fragment = document.createDocumentFragment();

    const limitedEntries = entries.slice(0, 15);
    limitedEntries.forEach((entry) => {
      fragment.appendChild(renderEntry(entry));
    });

    entriesList.innerHTML = '';
    entriesList.append(fragment);

    if (entries.length > limitedEntries.length) {
      const footnote = document.createElement('li');
      footnote.className = 'entries-footnote';
      footnote.textContent = `Showing latest ${limitedEntries.length} of ${entries.length} entries.`;
      entriesList.append(footnote);
    }
  } catch (err) {
    entriesList.innerHTML = '<li class="empty">Failed to fetch entries.</li>';
    uiError('Fetching entries failed.', err);
  } finally {
    entriesList.classList.remove('loading');
  }
};

const renderEntry = ({ id, title, content, createdAt }: EntryRecord) => {
  const item = document.createElement('li');
  item.className = 'entry-row';
  item.dataset.entryId = String(id);

  const heading = document.createElement('h3');
  heading.textContent = title;

  const body = document.createElement('p');
  body.textContent = content;

  const timestamp = document.createElement('time');
  timestamp.dateTime = createdAt;
  const parsedDate = new Date(createdAt);
  timestamp.textContent = Number.isNaN(parsedDate.getTime())
    ? 'Unknown timestamp'
    : parsedDate.toLocaleString();

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger';
  deleteButton.dataset.action = 'delete';
  deleteButton.dataset.entryId = String(id);
  deleteButton.textContent = 'Delete';

  actions.append(deleteButton);

  item.append(heading, body, timestamp, actions);
  return item;
};

const runInitialization = async () => {
  initializeButton.disabled = true;
  appendLog('info', 'Starting SQLite initialization...');
  setUiEnabled(false);

  try {
    const storedUrl = window.localStorage.getItem('worker.ws.url');
    if (storedUrl) {
      customWorkerUrl = storedUrl;
      workerUrlInput.value = storedUrl;
    }

    sqliteClient = await initializeSQLite({ log: uiLog, error: uiError });
    setUiEnabled(true);
    appendLog('info', 'SQLite initialization completed.');
    await renderEntries();
    remoteUpdates.clear();
    updateRemoteIndicator();

    await attemptWorkerConnection('initial');
  } catch (err) {
    uiError('Initialization failed.', err);
  } finally {
    initializeButton.disabled = false;
  }
};

initializeButton.addEventListener('click', () => {
  void runInitialization();
});

workerUrlInput.addEventListener('change', () => {
  const value = workerUrlInput.value.trim();
  customWorkerUrl = value || null;
  if (customWorkerUrl) {
    window.localStorage.setItem('worker.ws.url', customWorkerUrl);
    uiLog(`Saved worker WebSocket URL: ${customWorkerUrl}`);
  } else {
    window.localStorage.removeItem('worker.ws.url');
    uiLog('Cleared custom worker WebSocket URL.');
  }

  closeWorkerSession({ preserveRemoteUpdates: true }).finally(() => {
    void attemptWorkerConnection('retry');
  });
});

entryForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!sqliteClient) {
    uiError('Cannot insert entry before initialization completes.');
    return;
  }

  const formData = new FormData(entryForm);
  const title = String(formData.get('title') ?? '').trim();
  const content = String(formData.get('content') ?? '').trim();

  if (!title || !content) {
    uiError('Please provide both a title and content.');
    return;
  }

  entryForm.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach((button) => {
    button.disabled = true;
  });

  try {
    const record = await sqliteClient.insertEntry({ title, content });
    appendLog('info', `Stored entry "${title}".`);
    entryForm.reset();
    if (workerClient) {
      try {
        await workerClient.sendEntry(record);
        appendLog('info', `Synced entry "${title}" (${record.id}) to worker.`);
      } catch (err) {
        uiError(`Failed to sync entry "${title}" to worker.`, err);
      }
    }
    await renderEntries();
  } catch (err) {
    uiError('Failed to store entry.', err);
  } finally {
    entryForm.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach((button) => {
      button.disabled = false;
    });
  }
});

refreshButton.addEventListener('click', () => {
  if (!sqliteClient) {
    uiError('Initialize the database before fetching entries.');
    return;
  }

  void renderEntries();
});

syncRemoteButton.addEventListener('click', () => {
  void syncRemoteEntries();
});

entriesList.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }

  const actionButton = target.closest<HTMLButtonElement>('button[data-action="delete"]');
  if (!actionButton) {
    return;
  }

  if (!sqliteClient) {
    uiError('Initialize the database before modifying entries.');
    return;
  }

  const id = actionButton.dataset.entryId;
  if (!id) {
    uiError('Invalid entry identifier supplied for deletion.');
    return;
  }

  actionButton.disabled = true;
  appendLog('info', `Deleting entry ${id}...`);

  try {
    await sqliteClient.deleteEntry(id);
    appendLog('info', `Deleted entry ${id}.`);
    remoteUpdates.delete(id);
    updateRemoteIndicator();
    if (workerClient) {
      try {
        await workerClient.deleteEntry({ id });
        appendLog('info', `Synced deletion for entry ${id} to worker.`);
      } catch (err) {
        uiError(`Failed to sync deletion for entry ${id}.`, err);
      }
    }
    await renderEntries();
  } catch (err) {
    uiError(`Failed to delete entry ${id}.`, err);
  }
});

setUiEnabled(false);

void runInitialization();
