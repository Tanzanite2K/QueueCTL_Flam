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

describe('persistence across restart', function() {
  this.timeout(30000);
  let tmpDir, workerProc;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-test-'));
    const rootFiles = ['dbHandler.js', 'worker.js'];
    for (const f of rootFiles) {
      fs.copyFileSync(path.join(__dirname, '..', f), path.join(tmpDir, f));
    }
    const binSrc = path.join(__dirname, '..', 'bin');
    const binDest = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDest);
    fs.copyFileSync(path.join(binSrc, 'queuectl.js'), path.join(binDest, 'queuectl.js'));

    runCliSync(['init'], tmpDir);
  });

  afterEach(() => {
    try { if (workerProc && !workerProc.killed) workerProc.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  it('job persists and is processed after worker restart', async () => {
    // Enqueue jobs
    runCliSync(['enqueue', JSON.stringify({ id: 'p-1', command: 'node -e "console.log(\'p1\')"', max_attempts: 1 })], tmpDir);
    runCliSync(['enqueue', JSON.stringify({ id: 'p-2', command: 'node -e "console.log(\'p2\')"', max_attempts: 1 })], tmpDir);

    // Start a worker and let it pick one job, then kill it
    const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
    workerProc = spawn(process.execPath, [path.join(tmpDir, 'worker.js')], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: nodeModulesPath } });
    workerProc.stdout.on('data', d => process.stdout.write(`[W] ${d}`));

    // wait briefly for worker to pick a job
    await new Promise(r => setTimeout(r, 800));

    // kill worker abruptly
    try { workerProc.kill('SIGKILL'); } catch (e) {}

    // Start a new worker to resume processing
    workerProc = spawn(process.execPath, [path.join(tmpDir, 'worker.js')], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: nodeModulesPath } });
    workerProc.stdout.on('data', d => process.stdout.write(`[W2] ${d}`));

    // wait until both jobs completed
    const dbPath = path.join(tmpDir, 'job-queue.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    const start = Date.now();
    let completed = [];
    while (Date.now() - start < 20000) {
      const rows = await db.all("SELECT id FROM jobs WHERE state = 'completed'");
      completed = rows.map(r => r.id);
      if (completed.length === 2) break;
      await new Promise(r => setTimeout(r, 300));
    }
    await db.close();

    expect(completed.length).to.equal(2);
  });
});
