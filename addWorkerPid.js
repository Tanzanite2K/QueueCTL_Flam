const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('job-queue.db');

db.run(
    `ALTER TABLE jobs ADD COLUMN worker_pid INTEGER`,
    (err)=>{
        if(err) console.error(err);
        else console.log("worker_pid column added.");
        db.close();
    }
);