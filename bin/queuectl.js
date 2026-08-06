#!/usr/bin/env node
const { Command } = require('commander');  
const { initializeDB, getDBConnection } = require('../dbHandler');
const chalk = require('chalk'); // chalk@4 supports CommonJS
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// stop file used to signal workers
const STOP_FILE = path.resolve(process.cwd(), '.stop_workers');

const program = new Command(); 

/**
 * @notice banner for queueCTL CLI
 */

function printBanner() {
    // Use chalk if available for cross-platform color support (esp. Windows)
    let chalkCyan, chalkRedBright;
    try {
        chalkCyan = (s) => chalk.cyan(s);
        chalkRedBright = (s) => chalk.redBright(s);
    } catch (e) {
        // fallback to raw ANSI sequences
        chalkCyan = (s) => '\x1b[36m' + s + '\x1b[0m';
        chalkRedBright = (s) => '\x1b[91m' + s + '\x1b[0m';
    }
    const left = [
        ' ██████╗ ██╗   ██╗███████╗██╗   ██╗███████╗',
        '██╔═══██╗██║   ██║██╔════╝██║   ██║██╔════╝',
        '██║   ██║██║   ██║█████╗  ██║   ██║█████╗  ',
        '██║▄▄ ██║██║   ██║██╔══╝  ██║   ██║██╔══╝  ',
        '╚██████╔╝╚██████╔╝███████╗╚██████╔╝███████╗',
        ' ╚══▀▀═╝  ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝',
        '',
        '      QueueCTL • Background Job Queue',
        '',
        '      [[ Author  : Karri Pavan Prabhas ]]',
        '      [[ License : GPL-3.0             ]]'
        ];

    const right = [
        ' ██████╗████████╗██╗     ',
        '██╔════╝╚══██╔══╝██║     ',
        '██║        ██║   ██║     ',
        '██║        ██║   ██║     ',
        '╚██████╗   ██║   ███████╗',
        ' ╚═════╝   ╚═╝   ╚══════╝',
        '',
        ' Worker Management System',
        '',
        ' Version : v1.0.0',
        ''
        ];

    const lines = Math.max(left.length, right.length);
    const leftWidth = Math.max(...left.map(l => l.length));

    const out = [];
    for (let i = 0; i < lines; i++) {
        const l = (left[i] || '').padEnd(leftWidth, ' ');
        const r = (right[i] || '');
        out.push(chalkCyan(l) + chalkRedBright(r));
    }

    console.log(out.join('\n'));
}
async function ensureDBInitialized() {
    try {
        await initializeDB(true);
    } catch (error) {
        console.error('[-] Database initialization failed:', error);
        process.exit(1);
    }
}

program
    .name('queueCTL')
    .description('CLI to manage the job queue system')
    .version('1.0.0'); 

program
    .command('init')
    .description('Initialize the job queue database')
    .option('--silent', 'suppress non-error output')
    .action(async (opts) => {
        try {
            await initializeDB()
            console.log('[+] Database initialization complete.');
            process.exit(0);
        } catch (err) {
            console.error('[-] Database initialization failed:', err);
            process.exit(1);
        }
    });


// Enqueue Command
program
    .command('enqueue')
    .description('Enqueue a new job. Pass job details as a JSON string.')
    .argument('<json>', 'Job details in JSON format (e.g., \'{"id":"job1", "command":"sleep 2"}\')')
    .action(async (jsonStr) => {

        console.log("RAW:", JSON.stringify(jsonStr));
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();

            const jobData = JSON.parse(jsonStr);
            if (!jobData.id || !jobData.command) {
                throw new Error("Job must have 'id' and 'command' fields.");
            }

            console.log(`[+] Attempting to enqueue job: ${jsonStr}`);

            // Accept either `max_attempts` or `max_retries` from input (backwards-compatible)
            const max_attempts = jobData.max_attempts !== undefined
                ? jobData.max_attempts
                : (jobData.max_retries !== undefined ? jobData.max_retries : null);

            // Use COALESCE to fall back to the config key `default_max_tries` (this key is inserted during DB init).
            // Also provide a literal '3' default as a final fallback so we never insert NULL into the NOT NULL column.
            const insertSql = `INSERT INTO jobs (id, command, max_attempts, state, created_at, updated_at, next_run_at)
                 VALUES (?, ?, CAST(COALESCE(?, (SELECT value FROM config WHERE key='default_max_tries'), '3') AS INTEGER), 'pending', datetime('now'), datetime('now'), datetime('now'))`;

            await db.run(insertSql, jobData.id, jobData.command, max_attempts);

            console.log(`[+] Successfully enqueued job '${jobData.id}'.`);
        } catch (e) {
            console.error("[!!] Error enqueuing job:", e.message);
        } finally {
            if (db) await db.close();
        }
    });


// List Command ---
program
    .command('list')
    .description('List jobs by state')
    .requiredOption('--state <state>', 'Filter by job state (pending, processing, completed, failed, dead)')
    .action(async (options) => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const rows = await db.all("SELECT * FROM jobs WHERE state = ?", options.state);
            if (rows.length === 0) {
                console.log(`[!] No jobs found in state '${options.state}'.`);
            } else {
                console.table(rows);
            }
        } catch (e) {
            console.error("[!!] Error listing jobs:", e.message);
        } finally {
            if (db) await db.close();
        }
    });


// Worker Commands
const worker = program.command('worker').description('Manage worker processes');

worker
    .command('start')
    .description('Start one or more background worker processes')
    .option('-c, --count <number>', 'Number of workers to start', '1')
    .action(async (options) => {
    // Ensure DB exists before starting workers
    await ensureDBInitialized();
        
        if (fs.existsSync(STOP_FILE)) {
            try {
                fs.unlinkSync(STOP_FILE);
                console.log("[+] Cleared previous stop signal (.stop_workers file deleted).");
            } catch (e) {
                console.warn("[!] Warning: Could not delete .stop_workers file:", e.message);
            }
        }

        const count = parseInt(options.count, 10);
        console.log(`[+] Starting ${count} worker(s) in the background...`);

        // worker.js lives in the project root (one level up from bin/)
        const workerScript = path.join(__dirname, '..', 'worker.js');

        for (let i = 0; i < count; i++) {
            // Use process.execPath to reliably invoke Node
            const child = spawn(process.execPath, [workerScript], {
                detached: true,
                stdio: 'ignore',
                cwd: process.cwd()
            });
            child.unref();
        }
        console.log(`[+] ${count} worker(s) started.`);
    });

worker
    .command('stop')
    .description('Signal all workers to stop gracefully')
    .action(() => {
        try {
            fs.writeFileSync(STOP_FILE, 'STOP');
            console.log("[+] Stop signal sent to all workers (created .stop_workers file).");
            console.log("[+] Workers will finish their current jobs and exit.");
        } catch (e) {
            console.error("[!!] Failed to send stop signal:", e.message);
        }
    });

worker
    .command('list')
    .description('List currently active workers')
    .action(async () => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const workers = await db.all("SELECT * FROM workers WHERE last_heartbeat > datetime('now', '-15 seconds')");
            if (workers.length === 0) {
                console.log("[!] No active workers found.");
            } else {
                console.table(workers);
            }
        } catch (e) {
            console.error("[!!] Error listing workers:", e.message);
        } finally {
            if (db) await db.close();
        }
    });

// Status Command
program
    .command('status')
    .description('Show summary of job states')
    .action(async () => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const rows = await db.all("SELECT state, COUNT(*) as count FROM jobs GROUP BY state");
            const workerStats = await db.get("SELECT COUNT(*) as count FROM workers WHERE last_heartbeat > datetime('now', '-15 seconds')");
            console.log(`[*] Active Workers: ${workerStats.count}\n`);
            
            if (rows.length === 0) {
                console.log("[!] No jobs in queue.");
            } else {
                console.table(rows.reduce((acc, row) => {
                    acc[row.state] = row.count;
                    return acc;
                }, {}));
            }
        } catch (e) {
            console.error("[!!] Error getting status:", e.message);
        } finally {
            if (db) await db.close();
        }
    });

// DLQ Commands
const dlq = program.command('dlq').description('Manage Dead Letter Queue');

dlq
    .command('list')
    .description('List all jobs in DLQ (state=dead)')
    .action(async () => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const rows = await db.all("SELECT * FROM jobs WHERE state = 'dead'");
            if (rows.length === 0) {
                console.log("[!] DLQ is empty.");
            } else {
                console.table(rows);
            }
        } catch (e) {
            console.error("[!!] Error listing DLQ:", e.message);
        } finally {
            if (db) await db.close();
        }
    });

dlq
    .command('retry')
    .description('Move a job from DLQ back to pending')
    .argument('<id>', 'Job ID to retry')
    .action(async (id) => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const result = await db.run(
                `UPDATE jobs
                 SET state = 'pending', attempts = 0, next_run_at = datetime('now'), updated_at = datetime('now'), last_error = NULL
                 WHERE id = ? AND state = 'dead'`,
                id
            );
            if (result.changes > 0) {
                console.log(`[+] Job '${id}' moved from DLQ to pending.`);
            } else {
                console.log(`[!] Job '${id}' not found in DLQ.`);
            }
        } catch (e) {
            console.error("[!!] Error retrying DLQ job:", e.message);
        } finally {
            if (db) await db.close();
        }
    });

// Config Command
const config = program.command('config').description('Manage system configuration');

config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', 'Config key (e.g., default_max_tries, backoff_base)')
    .argument('<value>', 'Config value')
    .action(async (key, value) => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            await db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, value);
            console.log(`[+] Configuration updated: ${key} = ${value}`);
        } catch (e) {
            console.error("[!!] Error setting config:", e.message);
        } finally {
            if (db) await db.close();
        }
    });

config
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', 'Config key')
    .action(async (key) => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const row = await db.get("SELECT value FROM config WHERE key = ?", key);
            if (row) {
                console.log(`[+] ${key} = ${row.value}`);
            } else {
                console.log(`[!] Configuration key '${key}' not set.`);
            }
        } catch (e) {
             console.error("[!!] Error getting config:", e.message);
        } finally {
            if (db) await db.close();
        }
    });

config
    .command('list')
    .description('List configuration keys and values (defaults marked)')
    .action(async () => {
        let db;
        try {
            await ensureDBInitialized();
            db = await getDBConnection();
            const rows = await db.all('SELECT key, value FROM config ORDER BY key');

            // keys that dbHandler inserts as defaults
            const defaultKeys = new Set([
                'max_concurrent_jobs',
                'job_retry_delay',
                'worker_heartbeat_interval',
                'job_timeout',
                'backoff_strategy',
                'backoff_base',
                'default_max_tries'
            ]);

            if (rows.length === 0) {
                console.log('[!] No configuration keys found.');
                return;
            }

            const table = rows.map(r => ({
                key: r.key,
                value: r.value,
                default: defaultKeys.has(r.key)
            }));
            console.table(table);

        } catch (e) {
            console.error('[!!] Error listing config:', e.message);
        } finally {
            if (db) await db.close();
        }
    });

// Web dashboard commands
const web = program.command('web').alias('app').description('Web dashboard for monitoring the job queue');
web
  .command('start')
  .description('Start the web dashboard (foreground by default). Use --daemon to run in background')
  .option('-d, --daemon', 'Run dashboard in background')
  .action((opts) => {
      const serverScript = path.join(__dirname, '..', 'web', 'server.js');
      if (opts.daemon) {
          try {
              const child = spawn(process.execPath, [serverScript], {
                  detached: true,
                  stdio: 'ignore',
                  cwd: process.cwd()
              });
              child.unref();

              try {
                  const pidFile = path.join(process.cwd(), '.dashboard.pid');
                  //writing pid to stop app afterwards
                  fs.writeFileSync(pidFile, String(child.pid), { encoding: 'utf8' });
                  console.log(`[+] Dashboard started in background (pid: ${child.pid}). PID written to ${pidFile}`);
              } catch (e) {
                  console.log('[+] Dashboard started in background, but failed to write PID file:', e.message);
              }
          } catch (e) {
              console.error('[!!] Failed to start dashboard in background:', e.message);
              process.exit(1);
          }
      } else {
          try {
              console.log('[*] Starting dashboard (foreground). Press CTRL+C to stop.');
              const fg = spawn(process.execPath, [serverScript], { stdio: 'inherit', cwd: process.cwd() });
              fg.on('exit', (code) => process.exit(code || 0));
          } catch (e) {
              console.error('[!!] Failed to start dashboard:', e.message);
              process.exit(1);
          }
      }
  });

web
  .command('stop')
  .description('Stop a dashboard started with `web start --daemon`')
  .action(() => {
      const pidFile = path.join(process.cwd(), '.dashboard.pid');
      if (!fs.existsSync(pidFile)) {
          console.error('[!] No .dashboard.pid file found in current directory — is the dashboard running?');
          process.exit(1);
      }
      try {
          const text = fs.readFileSync(pidFile, 'utf8').trim();
          const pid = parseInt(text, 10);
          if (isNaN(pid)) throw new Error('Invalid PID in pidfile');
          try {
              process.kill(pid);
              console.log(`[+] Sent termination signal to dashboard pid ${pid}.`);
          } catch (e) {
              // if process doesn't exist, report it but remove pidfile
              if (e.code === 'ESRCH') console.warn('[!] No process found with that PID — removing stale pidfile.');
              else throw e;
          }
          try { fs.unlinkSync(pidFile); } catch (e) {}
          process.exit(0);
      } catch (e) {
          console.error('[!!] Failed to stop dashboard:', e.message);
          process.exit(1);
      }
  });

printBanner();
program.parse(process.argv);

