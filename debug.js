const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('job-queue.db');

db.all(
    "SELECT name FROM sqlite_master WHERE type='table'",
    (err, tables) => {
        if (err) {
            console.error(err);
            return;
        }

        console.log("TABLES:");
        console.log(tables);

        tables.forEach(table => {
            db.all(`PRAGMA table_info(${table.name})`, (e, cols) => {
                console.log("\n========================");
                console.log(table.name);
                console.table(cols);
            });
        });

        setTimeout(() => db.close(), 1000);
    }
);