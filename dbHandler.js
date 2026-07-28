/**
 * @notice This module handles the SQLite database connection and initialization for the job queue system of queueCTL.
 * @module dbHandler
 * @license GPL-3.0
 * @author Prabhas
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { open } = require('sqlite');
const fs = require('fs');
const { argv } = require('process');

const DB_PATH = path.resolve(process.cwd(), "job-queue.db");

/**
 * Open and return a connection to the job queue database.
 *
 * This returns the Promise-based connection returned by `sqlite.open` with
 * `sqlite3.Database` as the driver. Callers are responsible for closing the
 * connection when finished (db.close()).
 *
 * @async
 * @returns {Promise<import('sqlite').Database>} Promise resolving to an open DB instance
 */
async function getDBConnection() {
    return open({
        filename: DB_PATH,
        driver: sqlite3.Database
    });
}

/**
 * Initialize the database if it doesn't already exist.
 *
 * This will create the database file at `DB_PATH`, create the `jobs`,
 * `config`, and `workers` tables, create helpful indexes, and insert a set of
 * default configuration values. If the DB already exists, the function
 * returns immediately.
 *
 * @async
 * @param {boolean} [silent=false] - When true, suppress non-error console output
 * @returns {Promise<void>} Resolves when initialization is complete
 */
async function initializeDB(silent = false) {
    const db = await getDBConnection();

    try {
        if (!silent) {
            console.log("[*] Initializing database schema...");
        }

        await db.exec(`
            CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY,
                command TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'completed', 'failed', 'dead')) default 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                worker_pid INTEGER,
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP NOT NULL,
                next_run_at TIMESTAMP NOT NULL,
                last_error TEXT
            );
        `);

        if (!silent) {
            console.log("[*] Creating indexes on 'jobs' table...");
        }
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(state, next_run_at);
        `);

        if (!silent) {
            console.log("[*] Creating index on 'updated_at' column...");
        }
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);
        `);

        if (!silent) {
            console.log("[*] Creating 'config' table...");
        }
        await db.exec(`
            CREATE TABLE IF NOT EXISTS config(
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        if (!silent) {
            console.log("[*] Creating 'workers' table...");
        }
        await db.exec(`
            CREATE TABLE IF NOT EXISTS workers (
                pid INTEGER PRIMARY KEY,
                hostname TEXT NOT NULL,
                started_at TIMESTAMP NOT NULL,
                last_heartbeat TIMESTAMP NOT NULL
            );
        `);

        if (!silent) {
            console.log("[*] Inserting default configuration values...");
        }
        const defaultConfigs = [
            { key: 'max_concurrent_jobs', value: '5' },
            { key: 'job_retry_delay', value: '60' },
            { key: 'worker_heartbeat_interval', value: '30' },
            { key: 'job_timeout', value: '30000' },
            { key: "backoff_strategy", value: "exponential" },
            { key: "backoff_base", value: "2" },
            { key: "default_max_tries", value: "3" }
        ];

        for (const config of defaultConfigs) {
            await db.run(`
                INSERT INTO config (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO NOTHING;
            `, [config.key, config.value]);
        }

        if (!silent) {
            console.log("[*] Database initialized successfully.");
        }
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);   
    if(args.includes('--init')) {
        initializeDB(args.includes('--silent') ? true : false).then(() => {
            console.log("[+] Database initialization complete.");
            process.exit(0);
        }).catch(err => {
            console.error("[-] Error during database initialization:", err);
            process.exit(1);
        });
    } else {
        console.log("Usage: node dbHandler.js --init");
    }
}

module.exports = {
    getDBConnection,
    initializeDB
};