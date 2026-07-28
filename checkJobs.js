const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("job-queue.db");

db.all(
  "SELECT id, state, attempts, next_run_at, worker_pid FROM jobs",
  (err, rows) => {
    if (err) {
      console.error(err);
    } else {
      console.table(rows);
    }
    db.close();
  }
);