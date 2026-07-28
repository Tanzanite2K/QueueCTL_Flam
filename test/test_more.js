const { expect } = require('chai');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function runCli(args, cwd) {
  const script = path.join(__dirname, '..', 'bin', 'queuectl.js');
  const out = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { stdout: out, exitCode: 0 };
}

function readDbFile(cwd) {
  return path.join(cwd, 'job-queue.db');
}

describe('queuectl CLI - additional flows', function() {
  this.timeout(10000);
  let tmpDir;
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
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets and gets configuration values', async () => {
    runCli(['init'], tmpDir);
    const set = runCli(['config', 'set', 'job_timeout', '12345'], tmpDir);
    expect(set.exitCode).to.equal(0);
    const get = runCli(['config', 'get', 'job_timeout'], tmpDir);
    expect(get.stdout).to.match(/job_timeout = 12345/);
  });

  it('shows status with no jobs gracefully', async () => {
    runCli(['init'], tmpDir);
    const status = runCli(['status'], tmpDir);
    expect(status.stdout).to.match(/Active Workers:/);
  });

  it('handles DLQ retry', async function() {
    runCli(['init'], tmpDir);
    // Programmatically insert a dead job using sqlite package to avoid external deps
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    const dbPath = readDbFile(tmpDir);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    await db.run("INSERT INTO jobs (id, command, state, attempts, max_attempts, created_at, updated_at, next_run_at) VALUES ('dead-job-1', 'false', 'dead', 3, 3, datetime('now'), datetime('now'), datetime('now'));");
    await db.close();

    const dlqList = runCli(['dlq', 'list'], tmpDir);
    expect(dlqList.stdout).to.match(/dead-job-1/);

    const retry = runCli(['dlq', 'retry', 'dead-job-1'], tmpDir);
    expect(retry.stdout).to.match(/moved from DLQ to pending/);
  });

  it('lists workers when none are active', async () => {
    runCli(['init'], tmpDir);
    const out = runCli(['worker', 'list'], tmpDir);
    expect(out.stdout).to.match(/No active workers found/);
  });

});
