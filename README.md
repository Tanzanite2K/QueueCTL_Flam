# QueueCTL - CLI-based background job queue system


>A small, self-hosted job queue and worker system with a CLI and a lightweight web dashboard.

[![CI](https://img.shields.io/github/actions/workflow/status/Tanzanite2K/flam-queuectl/ci.yml?branch=main)](./.github/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022-339933)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)


## 🎥 Video Demonstration

Watch the complete project demo here: https://drive.google.com/...


## Table of Contents
- [Setup Instructions](#setup-instructions---run-locally)
- [Web Dashboard](#web-dashboard-for-monitoring)
- [Usage examples (CLI)](#usage-examples-cli)
- [Architecture overview](#architecture-overview)
- [System Design of QueueCTL](#queuectl-architecture)
- [Assumptions & trade-offs](#assumptions--trade-offs)
- [Testing instructions](#testing-instructions)

## Setup instructions - Run locally

Prerequisites

- Node.js v18 / v20 / v22 (LTS recommended)
- npm

Quick install

```bash
# from the repository root
npm install
```

Run the CLI without installing globally

```bash
# run any command via node
node ./bin/queuectl.js --help
```

Optional: make `queuectl` available system-wide (developer convenience)

```bash
npm link    # creates a global shim that points to this repo
# or to install globally (not required for development):
npm install -g .
```

Notes for Windows

- Global shims on Windows may appear as `queuectl.cmd`. If you use `npm link`, re-run it after editing the CLI so the shim points to the current code.

---

## Web dashboard for monitoring

QueueCTL also features a powerful dashboard for monitoring the job-queue more visually.

```bash
# use node
node ./web/server.js
# or via CLI (after running `npm link`):
queuectl web start
```

![](./assets/web.png)

---

## Usage examples (CLI)

Cheat sheet

| Task | Command |
|------|---------|
| Dashboard     | `queuectl web start` or `queuectl web start --daemon` |
| Initialize DB | `queuectl init` |
| Enqueue job   | `queuectl --% enqueue "{\"id\":\"job-1\",\"command\":\"echo hello\"}"` |
| Start workers | `queuectl worker start --count 2` |
| Stop workers  | `queuectl worker stop` |
| List DLQ      | `queuectl dlq list` |
| Retry DLQ     | `queuectl dlq retry <id>` |
| Set config    | `queuectl config set default_max_tries 5` |

Examples

```bash
queuectl init
# op: 
[+] Database initialization complete.

# push a job for execution
queuectl --% enqueue "{\"id\":\"job-1\",\"command\":\"echo hello\"}"
# op: 
[+] Successfully enqueued job 'job-1'.

# starts two workers concurrently
queuectl worker start --count 2

# checking active workers and job state
queuectl status
# op:
[*] Active Workers: 4

┌───────────┬────────┐
│ (index)   │ Values │
├───────────┼────────┤
│ completed │ 2      │
│ dead      │ 2      │
└───────────┴────────┘

# check active worker list
queuectl worker list
# op:
┌─────────┬───────┬───────────┬───────────────────────┬───────────────────────┐
│ (index) │ pid   │ hostname  │ started_at            │ last_heartbeat        │
├─────────┼───────┼───────────┼───────────────────────┼───────────────────────┤
│ 0       │ 25680 │ 'Prabhas' │ '2026-07-27 15:49:51' │ '2026-07-27 15:51:22' │
│ 1       │ 26080 │ 'Prabhas' │ '2026-07-27 15:49:51' │ '2026-07-27 15:51:22' │
│ 2       │ 26096 │ 'Prabhas' │ '2026-07-27 15:49:51' │ '2026-07-27 15:51:22' │
│ 3       │ 31624 │ 'Prabhas' │ '2026-07-27 15:51:21' │ '2026-07-27 15:51:21' │
└─────────┴───────┴───────────┴───────────────────────┴───────────────────────┘
```

---

## Architecture overview

High level components
- CLI (`bin/queuectl.js`) — single entrypoint built with `commander` that performs DB initialization and exposes management commands (init, enqueue, worker start/stop, web start/stop, dlq, config, status).
- Worker (`worker.js`) — simple Node process that registers a heartbeat in `workers` table and polls the `jobs` table for ready work.
- Persistence (`job-queue.db`) — SQLite database (managed through `dbHandler.js`) that stores `jobs`, `workers`, and `config` tables.
- Dashboard (`web/server.js`) — Express app that serves a static `dashboard.html` and exposes `/api/summary` for the UI.

### Job lifecycle (simplified)
1. Enqueue: job inserted with state `pending`, `next_run_at` defaults to now and `max_attempts` configured.
2. Worker picks job: worker atomically marks a job `processing` (poll/update), increments `attempts`.
3. Execution: worker spawns the job command; on success job -> `completed` and `updated_at` changed.
4. Failure & retry: on failure worker schedules the next attempt (backoff), job remains `pending`/`failed` until attempts exceed `max_attempts`.
5. Dead-letter (DLQ): when attempts >= max, job is moved to `dead` for inspection/retry via `dlq retry`.

### Concurrency & resilience
- Workers are independent Node processes; concurrency is achieved by running multiple workers. DB state transitions avoid double-processing.
- SQLite keeps deployment simple; great for single-node/dev use, not intended for large multi-node clustered throughput.

### Data model (high level)

| Table   | Key columns                                                                                  |
|---------|-----------------------------------------------------------------------------------------------|
| jobs    | id, command, state, attempts, max_attempts, next_run_at, created_at, updated_at, last_error |
| workers | pid, hostname, last_heartbeat, registered_at                                                 |
| config  | key, value (defaults include `default_max_tries`, `backoff_base`, etc.)                      |

---

## Features
- Atomic job claiming using SQLite transactions
- Configurable retry mechanism with exponential backoff
- Dead Letter Queue (DLQ)
- Worker heartbeat monitoring
- Automatic stale worker recovery
- Concurrent worker execution
- Graceful shutdown support
- Persistent job storage
- Web dashboard for monitoring


## QueueCTL Architecture

See the full design write-up in [`DESIGN.md`](./DESIGN.md).

---

## Assumptions & trade-offs
- Simplicity over distributed scale: SQLite is intentionally chosen for ease-of-use.
- Polling workers: easy to reason about, but adds periodic DB load vs. push-based consumers.
- No auth on dashboard/api by default: intended for localhost-only usage. Add a proxy or auth in front for production.
- Retry/backoff: configurable base; extend for exponential with jitter if needed.
- Tests are integration-style (spawn real processes) for higher confidence.

---

## Testing instructions

Short checklist

```bash
npm install
npm test
```

If you see "Cannot find module" errors in spawned child processes, tests assume `node_modules` are at the repo root. On some shells you may need to set `NODE_PATH` before running tests:

```bash
# Bash (Linux/macOS/WSL/git-bash):
export NODE_PATH=$(pwd)/node_modules
npm test

# PowerShell (Windows):
$env:NODE_PATH = (Resolve-Path .\node_modules).Path
npm test
```

Smoke test

```bash
queuectl init
queuectl worker start --count 1
queuectl enqueue '{"id":"smoke-1","command":"node -e \"console.log(\\'smoke\\')\""}'
queuectl status
```

More docs
- Full testing instructions and troubleshooting are in `TESTING.md`.
- Detailed design notes and diagrams are in `DESIGN.md`.
---


## Author

Karri Pavan Prabhas | [Portfolio](https://personal-portfolio-kfhz-fawn.vercel.app/)

B.Tech CSE, SRM University AP

GitHub: https://github.com/Tanzanite2K


## License
This project is licensed under GPL-3.0. For more details check the [License](./LICENSE) file.
#   Q u e u e C T L _ F l a m  
 