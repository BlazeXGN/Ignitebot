// =======================
// Injector.js – Dino Injection System
// =======================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Client = require("ssh2-sftp-client");

const sftp = new Client();
const SAFE_THRESHOLD_SEC = parseInt(process.env.SFTP_SAFE_THRESHOLD_SEC || "0");
const TEMPLATE_FOLDER = process.env.TEMPLATE_FOLDER || "./templates";
const REMOTE_ROOT = process.env.SFTP_REMOTE_ROOT;

// --- Spawn point safety (fixed for Survival map) ---
const SAFE_SPAWN = "X=-341802.656 Y=-122799.562 Z=-70786.953";

// --- Utility ---
function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// =======================
// Core: check if file is safe to overwrite
// =======================
async function isSafeToInject(steamId) {
    const remoteFile = path.posix.join(REMOTE_ROOT, "Survival/Players", `${steamId}.json`);
    try {
        await sftp.connect({
            host: process.env.SFTP_HOST,
            port: parseInt(process.env.SFTP_PORT),
            username: process.env.SFTP_USER,
            password: process.env.SFTP_PASS,
            readyTimeout: 20000
        });

        const stats = await sftp.stat(remoteFile);
        const lastModified = new Date(stats.modifyTime).getTime();
        const ageSec = (Date.now() - lastModified) / 1000;

        console.log(`[SAFE CHECK] ${steamId}.json last modified ${Math.round(ageSec)}s ago`);
        await sftp.end();

        return ageSec >= SAFE_THRESHOLD_SEC;
    } catch (err) {
        console.warn(`[SAFE CHECK] Could not verify last modified time for ${steamId}: ${err.message}`);
        await sftp.end();
        return false;
    }
}

// =======================
// Core: Inject dino into server
// =======================
async function injectDinoToServer(steamId, species, mode = "survival", forceMode = false) {
    const remoteDir = path.posix.join(REMOTE_ROOT, "Survival/Players");
    const remoteFile = path.posix.join(remoteDir, `${steamId}.json`);
    const templatePath = path.join(TEMPLATE_FOLDER, mode.toLowerCase(), `${species}.json`);

    console.log(`[SFTP] Inject start: forceMode=${forceMode}, species=${species}, template=${templatePath}`);

    if (!fs.existsSync(templatePath)) {
        console.error(`[SFTP] Template missing: ${templatePath}`);
        return false;
    }

    try {
        await sftp.connect({
            host: process.env.SFTP_HOST,
            port: parseInt(process.env.SFTP_PORT),
            username: process.env.SFTP_USER,
            password: process.env.SFTP_PASS,
            readyTimeout: 20000
        });

        // Backup old file if exists
        try {
            const backupDir = path.resolve("./backups");
            if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

            const localBackupPath = path.join(backupDir, `${steamId}_${Date.now()}.bak`);
            await sftp.fastGet(remoteFile, localBackupPath);
            console.log(`[SFTP] Backed up ${remoteFile} -> ${localBackupPath}`);
        } catch {
            console.log(`[SFTP] No existing file to back up for ${steamId}.json`);
        }

        // Load and modify template
        const dinoData = JSON.parse(fs.readFileSync(templatePath, "utf8"));
        dinoData.Location_Isle_V3 = SAFE_SPAWN;
        dinoData.Rotation_Isle_V3 = "P=0.000000 Y=0.000000 R=0.000000";
        dinoData.CameraRotation_Isle_V3 = "P=0.000000 Y=0.000076 R=0.000000";
        dinoData.CameraDistance_Isle_V3 = "800.0";

        // Write temp file locally
        const tempFile = path.join("./temp", `${steamId}.json`);
        if (!fs.existsSync("./temp")) fs.mkdirSync("./temp");
        fs.writeFileSync(tempFile, JSON.stringify(dinoData, null, 2));

        // Ensure remote dir exists
        try {
            await sftp.mkdir(remoteDir, true);
        } catch (err) {
            console.warn(`[SFTP] mkdir skipped or failed: ${err.message}`);
        }

        // Upload file
        await sftp.fastPut(tempFile, remoteFile);
        const uploadedStats = await sftp.stat(remoteFile);
        console.log(`[SFTP] ✅ Uploaded ${species}.json (${uploadedStats.size} bytes) → ${remoteFile}`);

        await sftp.end();
        console.log(`[Queue] Injection for ${steamId} completed.`);
        return true;
    } catch (err) {
        console.error(`[injectDinoToServer] error: ${err.message}`);
        await sftp.end();
        return false;
    }
}

module.exports = { injectDinoToServer, isSafeToInject };