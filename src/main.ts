import './style.css';

import { initializeSQLite, type EntryRecord, type SQLiteClient } from './db';
import { newWebSocketRpcSession } from 'capnweb';

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
          <button id="refresh" type="button">Refresh Local</button>
          <button id="fetch-remote" type="button">Fetch Remote</button>
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
const fetchRemoteButton = appRoot.querySelector<HTMLButtonElement>('#fetch-remote');
const entriesList = appRoot.querySelector<HTMLUListElement>('#entries');

if (!logOutput || !initializeButton || !entryForm || !refreshButton || !fetchRemoteButton || !entriesList) {
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
  fetchRemoteButton.disabled = !enabled;
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

type EntriesRpcSession = {
  sendEntry(entry: { title: string; content: string }): Promise<EntryRecord>;
  fetchEntries(): Promise<EntryRecord[]>;
  deleteEntry(params: { id: number }): Promise<{ deleted: number }>;
};

const resolveWorkerRpcUrl = (): string => {
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

const closeWorkerSession = async (): Promise<void> => {
  workerClient = null;
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

    entries.forEach((entry) => {
      fragment.appendChild(renderEntry(entry));
    });

    entriesList.innerHTML = '';
    entriesList.append(fragment);
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
    sqliteClient = await initializeSQLite({ log: uiLog, error: uiError });
    setUiEnabled(true);
    appendLog('info', 'SQLite initialization completed.');
    await renderEntries();

    try {
      await closeWorkerSession();
      workerClient = createWorkerSession();
      await workerClient.fetchEntries();
      appendLog('info', 'Connected to Cloudflare Worker RPC.');
    } catch (err) {
      await closeWorkerSession();
      uiError('Failed to connect to Cloudflare Worker RPC.', err);
    }
  } catch (err) {
    uiError('Initialization failed.', err);
  } finally {
    initializeButton.disabled = false;
  }
};

initializeButton.addEventListener('click', () => {
  void runInitialization();
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
    await sqliteClient.insertEntry({ title, content });
    appendLog('info', `Stored entry "${title}".`);
    entryForm.reset();
    if (workerClient) {
      try {
        await workerClient.sendEntry({ title, content });
        appendLog('info', `Synced entry "${title}" to worker.`);
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

fetchRemoteButton.addEventListener('click', async () => {
  if (!workerClient) {
    uiError('Connect to the Cloudflare Worker before fetching remote entries.');
    return;
  }

  fetchRemoteButton.disabled = true;
  appendLog('info', 'Fetching entries from Cloudflare Worker...');

  try {
    const remoteEntries = await workerClient.fetchEntries();
    appendLog('info', 'Remote entries', remoteEntries);
  } catch (err) {
    uiError('Failed to fetch entries from Cloudflare Worker.', err);
  } finally {
    fetchRemoteButton.disabled = false;
  }
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

  const id = Number(actionButton.dataset.entryId);
  if (!Number.isFinite(id)) {
    uiError('Invalid entry identifier supplied for deletion.');
    return;
  }

  actionButton.disabled = true;
  appendLog('info', `Deleting entry #${id}...`);

  try {
    await sqliteClient.deleteEntry(id);
    appendLog('info', `Deleted entry #${id}.`);
    if (workerClient) {
      try {
        await workerClient.deleteEntry({ id });
        appendLog('info', `Synced deletion for entry #${id} to worker.`);
      } catch (err) {
        uiError(`Failed to sync deletion for entry #${id}.`, err);
      }
    }
    await renderEntries();
  } catch (err) {
    uiError(`Failed to delete entry #${id}.`, err);
  }
});

setUiEnabled(false);

void runInitialization();
