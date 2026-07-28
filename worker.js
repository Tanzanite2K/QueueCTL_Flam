// CHANGED: Use new dbHandler
const { getDBConnection } = require('./dbHandler.js');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);
const STOP_FILE = path.resolve(process.cwd(), '.stop_workers');

let isShuttingDown = false;

// NEW: Timestamp helper for heartbeat/lifecycle logging, so recovery tests
// and interview demos show exactly when each event happened.
function getCurrentTime() {
    return new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

async function registerWorker(db) {
    try {
        await db.run(
            `INSERT OR REPLACE INTO workers (pid, hostname, started_at, last_heartbeat)
             VALUES (?, ?, datetime('now'), datetime('now'))`,
            process.pid, os.hostname()
        );
        console.log(`${getCurrentTime()}  Worker [${process.pid}] registered.`);
    } catch (e) { console.error("Heartbeat register failed:", e.message); }
}

async function sendHeartbeat(db) {
    try {
        await db.run("UPDATE workers SET last_heartbeat = datetime('now') WHERE pid = ?", process.pid);
        console.log(`${getCurrentTime()}  Heartbeat from worker [${process.pid}]`);
    } catch (e) { /* ignore */ }
}

async function unregisterWorker() {
    let db;
    try {
        db = await getDBConnection();
        await db.run("DELETE FROM workers WHERE pid = ?", process.pid);
    } catch (e) { /* ignore */ } finally { if (db) await db.close(); }
}

// NEW: Recover jobs owned by workers that have stopped sending heartbeats.
// Without this, a killed worker leaves its claimed jobs stuck in 'processing'
// forever, since nothing else ever re-queues them.
// CHANGED: Called from within the caller's BEGIN IMMEDIATE transaction, so
// errors are rethrown (not swallowed) to let the caller ROLLBACK cleanly
// instead of continuing inside a partially-applied, possibly-aborted transaction.
async function recoverStaleJobs(db, timeoutSeconds) {
    const staleWorkers = await db.all(
        `SELECT pid FROM workers WHERE last_heartbeat < datetime('now', '-' || ? || ' seconds')`,
        timeoutSeconds
    );

    for (const worker of staleWorkers) {
        const result = await db.run(
            `UPDATE jobs SET state = 'pending', worker_pid = NULL, next_run_at = datetime('now'), updated_at = datetime('now')
             WHERE state = 'processing' AND worker_pid = ?`,
            worker.pid
        );
        if (result && result.changes) {
            console.log(`${getCurrentTime()}  Recovered ${result.changes} job(s) from stale worker [${worker.pid}].`);
        }
        await db.run("DELETE FROM workers WHERE pid = ?", worker.pid);
        console.log(`${getCurrentTime()}  Removed stale worker record [${worker.pid}].`);
    }
}

// NEW: Seed 'worker_timeout' if it's missing so the stale-worker sweep is
// configurable via `queuectl config set worker_timeout <seconds>` instead of
// silently relying on getConfigValue's in-code fallback. Safe to call every
// startup — INSERT OR IGNORE is a no-op once the row exists.
async function ensureConfigDefaults(db) {
    try {
        await db.run(
            `INSERT OR IGNORE INTO config (key, value) VALUES ('worker_timeout', '15')`
        );
    } catch (e) { console.error("Config default seed failed:", e.message); }
}

async function getConfigValue(db, key, defaultValue) {
    try {
        const result = await db.get("SELECT value FROM config WHERE key = ?", key);
        if (!result) return defaultValue;
        const intVal = parseInt(result.value, 10);
        return isNaN(intVal) ? result.value : intVal;
    } catch (e) { return defaultValue; }
}

async function handleJobFailure(db, job, errorMessage) {
    // CHANGED: Use 'max_attempts' from schema
    let maxAttempts = parseInt(job.max_attempts, 10); 
    if (isNaN(maxAttempts) || maxAttempts <= 0) {
         // CHANGED: Use new config key 'default_max_tries'
         maxAttempts = parseInt(await getConfigValue(db, 'default_max_tries', 3), 10);
    }

    console.log(`Job '${job.id}' failed attempt ${job.attempts}/${maxAttempts}`);

    if (job.attempts >= maxAttempts) {
        console.log(`Job '${job.id}' failed max retries. Moving to DLQ.`);
        // CHANGED: Clear worker_pid — job is no longer owned by anyone.
        await db.run(`UPDATE jobs SET state = 'dead', worker_pid = NULL, last_error = ?, updated_at = datetime('now') WHERE id = ?`, errorMessage, job.id);
    } else {
        const backoffBase = await getConfigValue(db, 'backoff_base', 2);
        const delaySeconds = Math.pow(backoffBase, job.attempts);
        console.log(`Job '${job.id}' will retry in ${delaySeconds}s.`);
        
        // CHANGED: Use 'next_run_at'; also clear worker_pid so a stale-worker
        // sweep never mistakenly touches a job that's back in the pending pool.
        await db.run(
            `UPDATE jobs SET state = 'pending', worker_pid = NULL, last_error = ?, next_run_at = datetime('now', '+' || ? || ' seconds'), updated_at = datetime('now') WHERE id = ?`,
            errorMessage, delaySeconds, job.id
        );
    }
}

async function startWorker() {
    console.log(`${getCurrentTime()}  Worker [${process.pid}] starting...`);
    process.on('SIGINT', () => { isShuttingDown = true; });
    process.on('SIGTERM', () => { isShuttingDown = true; });

    let lastHeartbeatTime = 0;
    let lastRecoveryTime = 0;

    // NEW: Make sure 'worker_timeout' exists in config before the first
    // recovery sweep runs, so recoverStaleJobs() always reads an explicit,
    // operator-configurable value rather than only the getConfigValue fallback.
    try {
        const initDb = await getDBConnection();
        try { await ensureConfigDefaults(initDb); } finally { await initDb.close(); }
    } catch (e) { console.error("Startup config init failed:", e.message); }

    while (!isShuttingDown) {
        if (fs.existsSync(STOP_FILE)) { console.log("Stop file detected. Shutting down..."); break; }

        let db;
        let job = null;

        try {
            db = await getDBConnection();

            const now = Date.now();
            if (now - lastHeartbeatTime > 5000) {
                if (lastHeartbeatTime === 0) await registerWorker(db);
                else await sendHeartbeat(db);
                lastHeartbeatTime = now;
            }

            // NEW: Periodically sweep for workers that stopped heartbeating
            // (e.g. killed/crashed) and put their jobs back into 'pending'.
            // Runs on the very first loop iteration too, so a leftover stale
            // job from a previous crash gets recovered as soon as any worker
            // comes online, not just the worker that owned it.
            const runRecovery = lastRecoveryTime === 0 || now - lastRecoveryTime > 10000;

            // CHANGED: Recovery now happens inside the same BEGIN IMMEDIATE
            // transaction as the job claim, so recover-then-claim is one
            // atomic, single-writer sequence instead of two separate windows.
            await db.exec("BEGIN IMMEDIATE");
            if (runRecovery) {
                const workerTimeout = await getConfigValue(db, 'worker_timeout', 15);
                await recoverStaleJobs(db, workerTimeout);
                lastRecoveryTime = now;
            }
            // CHANGED: Use 'next_run_at'
            const jobRow = await db.get(`SELECT id FROM jobs WHERE state = 'pending' AND next_run_at <= datetime('now') ORDER BY created_at ASC LIMIT 1`);
            if (jobRow) {
                // CHANGED: Record worker_pid so a stale-worker sweep knows which
                // jobs to reclaim if this worker dies mid-processing.
                await db.run("UPDATE jobs SET state = 'processing', attempts = attempts + 1, worker_pid = ?, updated_at = datetime('now') WHERE id = ?", process.pid, jobRow.id);
                await db.exec("COMMIT");
                job = await db.get("SELECT * FROM jobs WHERE id = ?", jobRow.id);
            } else {
                await db.exec("COMMIT");
            }
        } catch (e) {
            if (e.code !== 'SQLITE_BUSY' && !e.message.includes('database is locked')) {
                 console.error(`Error polling: ${e.message}`);
            }
            if (db) try { await db.exec("ROLLBACK"); } catch (e) {}
        }
        
        if (job) {
            try {
                // CHANGED: Use new config key 'job_timeout'
                const timeoutMs = await getConfigValue(db, 'job_timeout', 30000);
                console.log(`Worker [${process.pid}] executing job '${job.id}' (Attempt ${job.attempts}/${job.max_attempts})`);
                
                // NEW: execPromise below blocks this worker's own loop for the
                // full duration of the job, so its normal heartbeat (sent only
                // between jobs) never fires while a long job is running. Other
                // workers keep polling and recovering stale workers in the
                // meantime, so without this a job that runs longer than
                // worker_timeout can get reclaimed and re-run elsewhere while
                // this worker is still legitimately executing it. Keep
                // heartbeating on an interval for the duration of the job.
                const heartbeatTimer = setInterval(() => {
                    sendHeartbeat(db).catch(() => {});
                }, 5000);

                let stdout, stderr;
                try {
                    ({ stdout, stderr } = await execPromise(job.command, { timeout: timeoutMs }));
                } finally {
                    clearInterval(heartbeatTimer);
                }

                if (stdout && stdout.trim()) {
                    console.log(stdout.trim());
                }
                if (stderr && stderr.trim()) {
                    console.error(stderr.trim());
                }
                
                console.log(`Job '${job.id}' completed.`);
                // CHANGED: Clear worker_pid on completion — job is finished, not owned.
                await db.run("UPDATE jobs SET state = 'completed', worker_pid = NULL, updated_at = datetime('now'), last_error = NULL WHERE id = ?", job.id);
            } catch (error) {
                let errorMessage = error.stderr || error.message || "Unknown error";
                if (error.killed && error.signal === 'SIGTERM') {
                     // CHANGED: Use new config key 'job_timeout'
                    errorMessage = `Job timed out after ${await getConfigValue(db, 'job_timeout', 30000)}ms`;
                }
                await handleJobFailure(db, job, errorMessage);
            }
        } else {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (db) try { await db.close(); } catch (e) {}
    }
    await unregisterWorker();
    console.log(`Worker [${process.pid}] shutdown complete.`);
    process.exit(0);
}

if (require.main === module) {
    startWorker().catch(err => { console.error("FATAL:", err); process.exit(1); });
}