// database.js - small wrapper around better-sqlite3 with close support
const Database = require('better-sqlite3');
const db = new Database('./ignite.db');

db.prepare(`
    CREATE TABLE IF NOT EXISTS users(
        discordId TEXT PRIMARY KEY,
        joinedAt TEXT,
        verified INTEGER DEFAULT 0
    )
`).run();

module.exports = {
  addUser(discordId) {
    const stmt = db.prepare('INSERT OR IGNORE INTO users (discordId, joinedAt) VALUES (?, ?)');
    stmt.run(discordId, new Date().toISOString());
  },
  setVerified(discordId, val = 1) {
    const stmt = db.prepare('UPDATE users SET verified = ? WHERE discordId = ?');
    stmt.run(val, discordId);
  },
  isVerified(discordId) {
    const row = db.prepare('SELECT verified FROM users WHERE discordId = ?').get(discordId);
    return row ? !!row.verified : false;
  },
  close() {
    try { db.close(); } catch (e) { /* ignore */ }
  }
};