## Testing Guide for QueueCTL
> includes both manual and automated testing

This document describes how to manually test the CLI and worker system, how the automated test-suite is organized, and how to add/extend tests. It also documents CI and troubleshooting tips so you can validate behavior consistently.

## Quick start - Use queuectl directly

- Install a dev shim for convenience:

```bash
npm install
npm link    # creates a global link so you can run `queuectl` directly
# or install globally (not required for development):
npm install -g .
```

- now you can start using the tool by its shim:
```bash
queuectl init
```
- or, you can just use traditional approach
```bash
node ./bin/queuectl.js init
```

Notes:
- On Windows the global shim may be `queuectl.cmd` depending on your shell. When using `npm link` re-run it after editing `bin/queuectl.js` so the linked shim points to the current code.
- Tests and CI run the CLI via `node ./bin/queuectl.js` in isolated temporary directories.
> linking is purely for developer convenience & tooling.

## Table of contents
- [Manual testing](#manual-testing)
  - [Running the dashboard](#running-the-dashboard)
  - [CLI manual checks](#cli-manual-checks)
  - [Worker manual checks](#worker-manual-checks)
- [Automated tests](#automated-tests)
  - [Running the full suite locally](#running-the-full-suite-locally)
  - [Test file mapping (what each test covers)](#test-file-mapping)
  - [How tests are structured (temp workspace pattern)](#how-tests-are-structured)
- [CI](#ci)
  - [GitHub Actions workflow (what it runs)](#github-actions-workflow)
- [Troubleshooting](#troubleshooting)
  - [Common failures and fixes](#common-failures-and-fixes)
---

## Manual testing

These steps help you manually validate the system when debugging a change or before creating a PR.

Prerequisites
- Node.js (18, 20, or 22 recommended)
- npm
- Run `npm install` in the project root to install dependencies.

Running the dashboard (HTTP UI)
1. Start the server from the project root:

```bash
node ./web/server.js
```

2. Open `http://localhost:3000` in a browser.
3. Check the network tab for `/favicon.ico` and `/api/summary` to validate static asset serving and API responses.

### Quick demo (end-to-end)

These steps give a very small end-to-end demonstration you can run in a single terminal. They assume you are in the project root.

```bash
# 1) Initialize the DB in the current directory
node ./bin/queuectl.js init

# 2) Start one worker in background (or open a second terminal and run in foreground to see logs)
node ./bin/queuectl.js worker start --count 1

# 3) Enqueue a simple job
node ./bin/queuectl.js --% enqueue "{\"id\":\"job-1\",\"command\":\"echo hello\"}"

# 4) Watch status (poll until job finishes)
node ./bin/queuectl.js status

# 5) Open the dashboard (optional)
# node ./web/server.js  # or: node ./bin/queuectl.js web start
```

If you start the worker in foreground (`node worker.js`) you will see the job output in that terminal.


Manual CLI checks
- Show help/version:

```bash
node ./bin/queuectl.js --help
node ./bin/queuectl.js --version
```

- Initialize DB (creates `job-queue.db` in current working dir):

```bash
node ./bin/queuectl.js init
```

- Enqueue a job:

```bash
node ./bin/queuectl.js --% enqueue "{\"id\":\"job-1\",\"command\":\"echo hello\"}"
```

- List pending jobs:

```bash
node ./bin/queuectl.js list --state pending
```

Worker manual check
- Start a worker in foreground (for debugging):

```bash
node worker.js
```

- Start background worker(s) via CLI:

```bash
node ./bin/queuectl.js worker start --count 2
```

- Signal workers to stop gracefully:

```bash
node ./bin/queuectl.js worker stop
```

---

## Automated tests

Our tests use Mocha + Chai and are located in the `test/` directory. They run the real CLI binary (`bin/queuectl.js`) and spawn worker processes in isolated temporary directories to avoid interfering with the dev environment.

Run the full test suite:

```bash
npm install
npm test
```

### Running tests locally (tips)

- Tests spawn worker child processes and run the CLI directly from the repository. In some shells (or when spawning child processes) you may need to ensure `node_modules` is resolvable by child processes. Two common options:

  1. Run tests from the project root after `npm install` (recommended):

```bash
npm install
npm test
```

  2. If you encounter "Cannot find module" errors in child-workers, set `NODE_PATH` so spawned processes can resolve dependencies from the repository `node_modules` (useful for Windows or when tests spawn separate shells):

```bash
# Bash (Linux/macOS/WSL/git-bash):
export NODE_PATH=$(pwd)/node_modules
npm test

# PowerShell (Windows):
$env:NODE_PATH = (Resolve-Path .\node_modules).Path
npm test
```

Run a single test file (helps when iterating):

```bash
./node_modules/.bin/mocha test/test_job_success.js --timeout 10000
```

## Test file mapping
Below is a quick reference table showing each test file and what it verifies.

| Test file | Purpose | Key assertions |
|---|---|---|
| `test/test_cli.js` | Basic CLI behavior | `init` succeeds, help/version output |
| `test/test_more.js` | Config & DLQ utilities | `config set/get/list`, `dlq list/retry`, `status` |
| `test/test_bad_input.js` | Invalid input handling | Malformed JSON, missing fields, config misuse |
| `test/test_job_success.js` | End-to-end success path | Worker executes job; job state -> `completed` |
| `test/test_worker_retry.js` | Retry and DLQ flow | Attempts increment, backoff applies, move to `dead` |
| `test/test_concurrency.js` | Concurrency across workers | Multiple workers process jobs; no double-processing |
| `test/test_persistence.js` | Persistence across restart | Jobs survive worker kill/restart and complete |

How tests are structured
- Each test creates a temporary working directory under the OS temp directory.
- Required runtime files are copied into the temp workspace: `dbHandler.js`, `worker.js`, and the `bin/` entry.
- The tests often start worker child processes using `spawn` and point `NODE_PATH` to the repo's `node_modules` so child processes can resolve dependencies.
- Tests poll the test-specific DB (`job-queue.db` inside the temp workspace) until the desired state is reached or a timeout occurs. Timeouts are generous but short enough for CI.

Why this approach
- Running real CLI + worker processes gives high confidence that the integration behaves like production.
- Isolated temp-workspace prevents accidental mutation of developer working state.

---

## CI

We run the test suite in GitHub Actions on `push` and `pull_request` to `main` using `.github/workflows/ci.yml`.

### GitHub Actions workflow
- Matrix: Node 18, 20, 22
- Steps: checkout, setup-node (with npm cache), `npm ci`, `npm test`.

CI Notes
- Tests spawn worker child processes; CI runners (Ubuntu latest) support this and `node_modules` are available after `npm ci`.
- If adding platform-specific code, add additional OS runners to the matrix.

---

## Troubleshooting

### Common failures and fixes

- "Cannot find module 'sqlite3'" in worker child process:
  - Ensure `npm ci` has been run and `node_modules` are present in the project root. Tests set `NODE_PATH` for child processes, which expects `node_modules` to be at the repo root.

- Tests failing because of stale DB state:
  - Tests create and use temp workspaces (`job-queue.db` in tmp dir). Ensure the workspace is writable and cleanup is allowed.

- Favicon 404/Network errors for the dashboard:
  - Confirm `web/server.js` serves static assets from the repo root `assets/` folder; check `app.use('/assets'...)` and `/favicon.ico` route.

- Test timing flakes:
  - Increase timeouts in the test or the Mocha `--timeout` in `package.json` test script.

---
<!-- 
Notes:
- When using `npm link` or a global install, npm creates OS-specific shims. On Windows, use the `.cmd` shim or run from PowerShell; on Unix-like shells the shebang is used. If you've recently edited the CLI entry, re-run `npm link` so your global shim points to the updated code.
- For test runs spawned by Mocha, tests use `node` directly to execute `bin/queuectl.js` in isolated temp workspaces rather than relying on a globally installed `queuectl`. -->

