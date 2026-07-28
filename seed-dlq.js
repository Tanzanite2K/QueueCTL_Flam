const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

(async () => {
  const db = await open({ filename: 'job-queue.db', driver: sqlite3.Database });
  for (const id of ['fail-job-1', 'fail-job-2']) {
    await db.run(
      "INSERT OR REPLACE INTO jobs (id, command, state, attempts, max_attempts, created_at, updated_at, next_run_at, last_error) VALUES (?, ?, 'dead', 1, 1, datetime('now'), datetime('now'), datetime('now'), ?)",
      [id, 'demo-command', 'seeded']
    );
  }
  await db.close();
})();
