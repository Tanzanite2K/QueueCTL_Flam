const { expect } = require('chai');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

function runCliSync(args, cwd) {
  const script = path.join(__dirname, '..', 'bin', 'queuectl.js');
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { stdout: out, exitCode: 0 };
}

describe('worker retry and DLQ', function() {
  this.timeout(30000);
  let tmpDir, workerProc;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-test-'));
    const rootFiles = ['dbHandler.js', 'worker.js'];
    for (const f of rootFiles) {
      fs.copyFileSync(path.join(__dirname, '..', f), path.join(tmpDir, f));
    }
    const binSrc = path.join(__dirname, '..', 'bin');
    const binDest = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDest);
    fs.copyFileSync(path.join(binSrc, 'queuectl.js'), path.join(binDest, 'queuectl.js'));

    // init DB
    runCliSync(['init'], tmpDir);

  // start worker in foreground pointing to the tmpDir
  // ensure the worker can resolve the project's node_modules by setting NODE_PATH
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
  workerProc = spawn(process.execPath, [path.join(tmpDir, 'worker.js')], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: nodeModulesPath } });
    workerProc.stdout.on('data', d => process.stdout.write(`[WOUT] ${d}`));
    workerProc.stderr.on('data', d => process.stderr.write(`[WERR] ${d}`));

    // small delay to allow worker to register
    await new Promise(r => setTimeout(r, 500));
  });

  afterEach(async () => {
    if (workerProc && !workerProc.killed) {
      try { workerProc.kill('SIGTERM'); } catch (e) {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  it('retries failing job and moves it to DLQ after max attempts', async () => {
    // enqueue a job that exits 1 immediately
    runCliSync(['enqueue', JSON.stringify({ id: 'fail-job-1', command: 'node -e "process.exit(1)"', max_attempts: 2 })], tmpDir);

    const dbPath = path.join(tmpDir, 'job-queue.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    // poll until job state becomes 'dead' or timeout
    const start = Date.now();
    let state = null;
    while (Date.now() - start < 20000) {
      const row = await db.get("SELECT state, attempts FROM jobs WHERE id = 'fail-job-1'");
      if (row) {
        state = row.state;
        if (state === 'dead') break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    await db.close();

    expect(state).to.equal('dead');
  });
});
