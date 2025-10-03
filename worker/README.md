# Cloudflare Worker

This directory contains a Cloudflare Worker that exposes a simple RPC endpoint, backed by a Durable Object for persistence. The Worker uses the official [`capnweb`](https://github.com/cloudflare/capnweb) package (via `RpcTarget` and `newWorkersRpcResponse`) to serve the API over HTTP and WebSocket transports.

## Capabilities

- `POST /rpc` with `{ "method": "sendEntry", "params": { "title": "...", "content": "..." } }` creates a new entry.
- `POST /rpc` with `{ "method": "fetchEntries" }` returns all entries ordered by `createdAt` (descending).
- `POST /rpc` with `{ "method": "deleteEntry", "params": { "id": 123 } }` removes an entry by identifier.
- `POST /rpc` with `{ "method": "subscribeUpdates", "params": listener }` registers a callback capability; the worker invokes `listener.notifyNewData(entry)` whenever a new entry is created (either by clients or by the scheduled generator). The worker retains the capability by calling `.dup()` internally and will call `unsubscribe()` on the returned handle when a client disconnects.
- `GET /health` returns a minimal status payload for smoke checks.
- `GET /rpc` that upgrades to WebSocket establishes a bidirectional RPC session handled by `capnweb`. Send JSON messages such as `{ "id": 1, "method": "fetchEntries" }` and receive matching responses on the same socket.
- A periodic alarm generates random entries every ~15 seconds; all subscribed clients are notified through their registered callbacks so they can react to new data.

All RPC responses are JSON and include permissive CORS headers so that the Vite front-end can call the Worker directly. WebSocket sessions deliver the same RPC responses on the open connection.

## Development

1. Install dependencies inside this directory: `pnpm install` (or `npm install`).
2. Start a local dev session: `pnpm dev` (runs `wrangler dev`).
3. Deploy with `pnpm deploy` once your Cloudflare account is configured.

The Durable Object binding is defined in `wrangler.toml` (`ENTRIES`). Migrations are set up with an initial tag `v1` that registers the Durable Object class.
