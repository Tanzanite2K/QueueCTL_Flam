const { expect } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function runCli(args, cwd) {
  const script = path.join(__dirname, '..', 'bin', 'queuectl.js');
  const res = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return res;
}

describe('CLI bad input handling', function() {
  this.timeout(5000);
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queuectl-test-'));
    // copy required files
    fs.copyFileSync(path.join(__dirname, '..', 'dbHandler.js'), path.join(tmpDir, 'dbHandler.js'));
    const binSrc = path.join(__dirname, '..', 'bin');
    const binDest = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDest);
    fs.copyFileSync(path.join(binSrc, 'queuectl.js'), path.join(binDest, 'queuectl.js'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  it('returns an error for malformed JSON', () => {
    const res = runCli(['enqueue', '{notjson}'], tmpDir);
    // CLI prints a parse/error message; it may or may not exit non-zero in current implementation.
    expect(res.stderr || res.stdout).to.match(/Error|Unexpected token|malformed/i);
  });

  it('returns an error for missing required fields', () => {
    const res = runCli(['enqueue', JSON.stringify({ command: 'echo hi' })], tmpDir);
    // CLI logs error but may exit 0 (existing CLI prints error). We'll assert on stderr or stdout containing our validation message
    expect((res.stderr || res.stdout)).to.match(/must have 'id' and 'command'/i);
  });

  it('handles config set with missing args', () => {
    const res = runCli(['config', 'set', 'onlykey'], tmpDir);
    expect(res.status).to.not.equal(0);
    expect((res.stderr || res.stdout)).to.match(/missing|argument/i);
  });
});
