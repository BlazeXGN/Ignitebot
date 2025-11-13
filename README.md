# IgniteBot - Isle Primal Reign Bot

A Discord bot for the **Isle: Primal Reign** private server providing:

- Economy system (Ember Coins / EC)
- Dinosaur shop with role-based access
- Player inventory & storage
- SFTP-based character injection to the game server
- Background queue for deferred injections

## Features

### Economy & Shop

- `!bal` / `!balance` — Check your EC balance
- `!work` — Earn EC via work
- `!gamble <amount>` — Gamble your EC (50/50 win rate)
- `!top` — View top 10 EC holders
- `!buy` — Open the dinosaur shop (restricted to 🔥 Kindled role)
- `!storage` — View your stored dinosaurs (up to 20)
- `!store` — Store your current dinosaur

### Character Injection

When you purchase and inject a dinosaur (via the **Overwrite Character ⚔️** button):

1. The bot connects to the game server via SFTP
2. Checks if the remote player file is "safe" (old enough / not recently modified)
3. Backs up the existing remote player file to `./backups/<steamid>_<timestamp>.bak`
4. Uploads the selected dinosaur template to the server's `Survival/Players/` directory
5. If the file is too recent (player online), the injection is queued and retried periodically

### Important: In-Game Refresh Behavior

**IsleV3 caches player files in memory.** When the bot uploads a new character file to the server:

- ✅ The file is written to disk on the game server
- ❌ The game does **NOT** automatically reload the player data from disk
- ✅ The player must **disconnect and reconnect** to the server to load the new character

**If you want immediate effect without player relog:**

- Restart the game server (refreshes all player cache)
- Or modify the IsleV3 server code to support hot-reload on player data change

### Admin Commands

- `!inject <discordId> <species> [force]` — Inject a dinosaur for a player (Admin only)

## Setup

### Environment Variables (`.env`)

```
TOKEN=<discord-bot-token>
OWNER_ID=<discord-user-id>
SFTP_HOST=<game-server-ip>
SFTP_PORT=22
SFTP_USER=<sftp-username>
SFTP_PASS=<sftp-password>
SFTP_REMOTE_ROOT=<remote-sftp-root>
SFTP_SAFE_THRESHOLD_SEC=120
QUEUE_RETRY_INTERVAL_MS=60000
```

- **SFTP_REMOTE_ROOT**: The folder visible when you log in via SFTP (e.g., `198.37.111.135_7575/TheIsle/Saved/Databases`)
- **SFTP_SAFE_THRESHOLD_SEC**: Seconds to wait before re-uploading a player file (prevents conflicts if player is online)
- **QUEUE_RETRY_INTERVAL_MS**: Milliseconds between queue checks (default 60 seconds)

### Templates

Dinosaur templates are stored in `templates/survival/`. Each template is a JSON file matching the structure of an IsleV3 player save file.

Example: `templates/survival/Spino.json`

```json
{
  "CharacterClass": "SpinoAdultS",
  "DNA": "",
  "Location_Isle_V3": "X=-341802.656 Y=-122799.562 Z=-70786.953",
  "Growth": "1.0",
  "Health": "1000",
  ...
}
```

### Data Files

- `economy.json` — User balances and linked Steam IDs
- `storage.json` — Player inventories
- `dinos.json` — Species pricing and template mapping
- `injection_queue.json` — Pending injections (auto-retried when safe)
- `ignite.db` — SQLite database for verified users (optional)

## Architecture

### Main Files

- **index.js** — Discord bot logic, events, interactions, commands
- **injector.js** — SFTP helpers (connect, backup, upload, safety checks)
- **database.js** — SQLite helper for user verification
- **config.json** — Server configuration (channel IDs, role IDs)

### Injection Flow

```
User clicks "Overwrite Character ⚔️"
  ↓
Check if safe to inject (SFTP stat + age check)
  ├─ Safe? → Upload immediately
  └─ Not safe? → Queue + retry later
  ↓
Connect via SFTP
  ↓
Backup existing remote file to ./backups/
  ↓
Upload template from templates/survival/<species>.json
  ↓
Confirm to user
```

### Queue Runner

A background interval (`QUEUE_RETRY_INTERVAL_MS`, default 60 seconds) checks pending injections and retries when safe.

## Deployment

```bash
npm install
node index.js
```

The bot will:

1. Load environment variables from `.env`
2. Create local directories (`./backups`, `./templates/survival`, `./templates/sandbox`)
3. Initialize JSON data files if missing
4. Connect to Discord
5. Start listening for commands and interactions

## Troubleshooting

### Bot not connecting

- Verify `TOKEN` in `.env` is valid
- Check internet connection
- Ensure Discord bot application is created and invited to server

### SFTP upload fails

- Verify `SFTP_HOST`, `SFTP_USER`, `SFTP_PASS` in `.env`
- Ensure remote path `SFTP_REMOTE_ROOT` is correct
- Check that the bot user has write permissions on the remote server
- See `./backups/` for backup files (indicates at least one successful connection)

### Character doesn't appear in-game after injection

- ✅ Check that the file is uploaded (verify via WinSCP or SFTP)
- ❌ **Player must disconnect and reconnect** (IsleV3 caches in memory)
- ❌ Or restart the game server to refresh all player data

### Injection queued instead of immediate

- File was too recent (player online or just logged off)
- Wait for `SFTP_SAFE_THRESHOLD_SEC` seconds (default 120) and the bot will retry
- Or manually check the server and use `!inject <id> <species> force` to skip the safety check

## Contributing

- Add new dino templates to `templates/survival/`
- Update `dinos.json` with pricing and template mappings
- New commands should follow the existing pattern in the interaction handler

## License

Private use for Isle: Primal Reign server
