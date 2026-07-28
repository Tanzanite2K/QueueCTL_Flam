const { expect } = require('chai');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper to run the CLI with args in a temporary working directory
function runCli(args, cwd) {
  const script = path.join(__dirname, '..', 'bin', 'queuectl.js');
  const out = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { stdout: out, exitCode: 0 };
}

describe('queuectl CLI - core flows', function() {
  this.timeout(10000);

  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-test-'));
    // copy necessary files (dbHandler, worker, bin) into tmpDir so CLI can run
    const rootFiles = ['dbHandler.js', 'worker.js'];
    for (const f of rootFiles) {
      fs.copyFileSync(path.join(__dirname, '..', f), path.join(tmpDir, f));
    }
    // copy bin folder
    const binSrc = path.join(__dirname, '..', 'bin');
    const binDest = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDest);
    fs.copyFileSync(path.join(binSrc, 'queuectl.js'), path.join(binDest, 'queuectl.js'));
    // ensure node_modules exists in test environment (assumes installed)
  });

  afterEach(() => {
    // remove temp directory recursively
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes the database with init command', async () => {
    const res = await runCli(['init'], tmpDir);
    expect(res.exitCode).to.equal(0);
    // DB file should exist
    const dbPath = path.join(tmpDir, 'job-queue.db');
    expect(fs.existsSync(dbPath)).to.be.true;
  });

  it('enqueues a job and lists pending jobs', async () => {
    await runCli(['init'], tmpDir);
    const job = { id: 'test-job-1', command: 'echo hello' };
    const enqueue = await runCli(['enqueue', JSON.stringify(job)], tmpDir);
    expect(enqueue.exitCode).to.equal(0);

    const list = await runCli(['list', '--state', 'pending'], tmpDir);
    // stdout should contain job id
    expect(list.stdout).to.match(/test-job-1/);
  });

  it('preserves a user-configured default_max_tries value after reinitialization', async () => {
    await runCli(['init'], tmpDir);
    await runCli(['config', 'set', 'default_max_tries', '5'], tmpDir);

    const afterSet = await runCli(['config', 'get', 'default_max_tries'], tmpDir);
    expect(afterSet.stdout).to.match(/5/);

    await runCli(['init'], tmpDir);
    const afterReinit = await runCli(['config', 'get', 'default_max_tries'], tmpDir);
    expect(afterReinit.stdout).to.match(/5/);
  });

});
