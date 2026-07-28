const express = require('express');
const { getDBConnection } = require('../dbHandler.js');
const path = require('path');
const open = require('open');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'assets')));

// API Endpoint to get job and worker summary
app.get('/api/summary', async (req, res) => {
    let db;
    try {
        db = await getDBConnection();
        
        //Job Stats
        const jobStatsRaw = await db.all("SELECT state, COUNT(*) as count FROM jobs GROUP BY state");
        const jobStats = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
        jobStatsRaw.forEach(row => { jobStats[row.state] = row.count; });

        //Active Workers (heartbeat in last 15s)
        const workerStats = await db.get("SELECT COUNT(*) as count FROM workers WHERE last_heartbeat > datetime('now', '-15 seconds')");

        //Recent Jobs (last 20)
        const recentJobs = await db.all("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 20");
        
        //Active Workers List
        const activeWorkers = await db.all("SELECT * FROM workers WHERE last_heartbeat > datetime('now', '-15 seconds') ORDER BY pid ASC");

        res.json({
            stats: { jobs: jobStats, workers: workerStats.count },
            recentJobs,
            activeWorkers
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        if (db) await db.close();
    }
});

//SERVE STATIC HTML DASHBOARD
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

//Only start if run directly
if (require.main === module) {
    app.listen(PORT, async () => {
        console.log(`Dashboard running at http://localhost:${PORT}`);
        try { await open(`http://localhost:${PORT}`); } catch (e) {}
    });
}

module.exports = app;