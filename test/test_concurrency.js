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

describe('concurrency: multiple workers', function() {
  this.timeout(30000);
  let tmpDir, workers = [];

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

    // init DB
    runCliSync(['init'], tmpDir);
  });

  afterEach(() => {
    for (const w of workers) {
      try { w.kill('SIGTERM'); } catch (e) {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    workers = [];
  });

  it('processes many jobs across multiple workers without double-processing', async () => {
    const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
    // start 3 workers
    for (let i = 0; i < 3; i++) {
      const w = spawn(process.execPath, [path.join(tmpDir, 'worker.js')], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: nodeModulesPath } });
      w.stdout.on('data', d => process.stdout.write(`[W${i}] ${d}`));
      w.stderr.on('data', d => process.stderr.write(`[W${i}]ERR ${d}`));
      workers.push(w);
    }

    // enqueue 9 small jobs that print their id
    for (let j = 0; j < 9; j++) {
      runCliSync(['enqueue', JSON.stringify({ id: `job-${j}`, command: `node -e "console.log(\\\"job-${j}\\\")"`, max_attempts: 1 })], tmpDir);
    }

    const dbPath = path.join(tmpDir, 'job-queue.db');
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    const start = Date.now();
    let completed = [];
    while (Date.now() - start < 20000) {
      const rows = await db.all("SELECT id FROM jobs WHERE state = 'completed'");
      completed = rows.map(r => r.id);
      if (completed.length === 9) break;
      await new Promise(r => setTimeout(r, 300));
    }

    await db.close();

    expect(completed.length).to.equal(9);
    // ensure unique
    const uniq = new Set(completed);
    expect(uniq.size).to.equal(9);
  });
});
