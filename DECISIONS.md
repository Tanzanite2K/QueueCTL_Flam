# DECISIONS.md

## QueueCTL – Backend Developer Internship Assignment 5

### 1. Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?

The critical section is inside `worker.js` where a worker starts a SQLite transaction before selecting and claiming a job.

```javascript
await db.exec("BEGIN IMMEDIATE");

const jobRow = await db.get(`
    SELECT id
    FROM jobs
    WHERE state = 'pending'
      AND next_run_at <= datetime('now')
    ORDER BY created_at ASC
    LIMIT 1
`);

if (jobRow) {
    await db.run(
        "UPDATE jobs SET state='processing', attempts=attempts+1, worker_pid=?, updated_at=datetime('now') WHERE id=?",
        process.pid,
        jobRow.id
    );
}

await db.exec("COMMIT");
```

`BEGIN IMMEDIATE` acquires SQLite's write lock before any worker can modify the database. Since SQLite allows only one writer at a time, another worker trying to claim a job must wait until the current transaction either commits or rolls back.

Because the job selection (`SELECT`) and ownership update (`UPDATE`) happen inside the same transaction, they behave as one atomic operation. This guarantees that even if multiple worker processes are polling simultaneously, only one of them can successfully claim a particular job.

---

## 2. A worker is SIGKILLed halfway through a job. Walk through, step by step, what state the job is in and how it eventually runs again. What is the worst-case delay before recovery?

When a worker starts executing a job, it changes the job's state from **pending** to **processing** and stores its process ID in the `worker_pid` column. At the same time, the worker periodically updates its heartbeat in the `workers` table.

If the worker is forcefully terminated (for example, using `SIGKILL` or `taskkill /F`), it cannot clean up or update its heartbeat anymore. The job therefore remains in the **processing** state.

Every worker periodically runs a stale-worker recovery routine. During this check, it looks for workers whose heartbeat has not been updated within the configured timeout. If a stale worker is found, all jobs owned by that worker are reset back to **pending**, their `worker_pid` is cleared, and `next_run_at` is updated so they become immediately eligible for execution.

Once that happens, any active worker can claim the job and continue processing it normally.

The worst-case recovery time is approximately:

* **Heartbeat timeout** (default 15 seconds)
* **plus the recovery scan interval** (about 10 seconds)

So in the default configuration, recovery can take up to **25 seconds** before another worker resumes the abandoned job.

---

## 3. Does `dlq retry` reset `attempts`? Why is that the right call?

Yes. When a job is retried from the Dead Letter Queue, the retry command resets its attempt counter before moving it back to the pending state.

This is the right behavior because a manual retry should be treated as a fresh execution rather than a continuation of previous failures. If the attempt counter were not reset, the job would immediately exceed its retry limit and return to the Dead Letter Queue without getting a fair chance to run again.

Resetting the attempts counter gives the corrected job the full retry budget while still preserving the previous failure information in the job history and logs.

---

## 4. What designs did you consider and reject for `worker stop` (cross-process signaling), and why?

Several approaches were possible for stopping workers.

One option was sending operating system signals directly to worker processes. While this works well on Linux and macOS, Windows handles process signals differently, making the implementation less portable.

Another option was using sockets or inter-process communication (IPC). Although this provides real-time communication, it significantly increases the complexity of the project by requiring persistent communication channels between the CLI and workers.

Instead, I chose a shared **stop file** (`.stop_workers`). Each worker periodically checks whether this file exists. If it does, the worker finishes its current work, unregisters itself, and exits gracefully.

This approach is simple, cross-platform, and does not require any additional services or communication infrastructure. The trade-off is that workers stop on their next polling cycle rather than immediately, which is acceptable for this assignment.

---

## 5. If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which break?

Most of the existing design would remain unchanged.

The worker architecture, heartbeat mechanism, retry logic, dead-letter queue, database transactions, stale-worker recovery, and graceful shutdown would continue to work exactly as they do today because they are independent of job priority.

The main changes would be in how jobs are selected. The `jobs` table would need a new `priority` column, and the worker's query would be updated to order jobs by priority before creation time, for example:

```sql
ORDER BY priority DESC, created_at ASC
```

This preserves FIFO ordering among jobs with the same priority while ensuring that higher-priority jobs are processed first.

Overall, the change is localized to the job scheduling logic. The core execution, recovery, concurrency control, and fault-tolerance mechanisms do not need to be redesigned, which shows that the current architecture is modular and easy to extend.
