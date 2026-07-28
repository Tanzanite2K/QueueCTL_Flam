const { expect } = require('chai');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

function runCliSync(args, cwd) {
  const { execFileSync } = require('child_process');
  const script = path.join(__dirname, '..', 'bin', 'queuectl.js');
  const out = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { stdout: out, exitCode: 0 };
}

describe('basic job success', function() {
  this.timeout(20000);
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

    // start worker
    const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
    workerProc = spawn(process.execPath, [path.join(tmpDir, 'worker.js')], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: nodeModulesPath } });
    workerProc.stdout.on('data', d => process.stdout.write(`[WOUT] ${d}`));
    workerProc.stderr.on('data', d => process.stderr.write(`[WERR] ${d}`));

    await new Promise(r => setTimeout(r, 500));
  });

  afterEach(async () => {
    if (workerProc && !workerProc.killed) {
      try { workerProc.kill('SIGTERM'); } catch (e) {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  it('processes a simple echo job to completion', async () => {
    runCliSync(['enqueue', JSON.stringify({ id: 'ok-job-1', command: 'node -e "console.log(\'ok\')"', max_attempts: 1 })], tmpDir);

    const dbPath = path.join(tmpDir, 'job-queue.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    const start = Date.now();
    let state = null;
    while (Date.now() - start < 10000) {
      const row = await db.get("SELECT state FROM jobs WHERE id = 'ok-job-1'");
      if (row && row.state === 'completed') { state = 'completed'; break; }
      await new Promise(r => setTimeout(r, 200));
    }
    await db.close();

    expect(state).to.equal('completed');
  });
});
