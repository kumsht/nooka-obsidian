# Nooka Inbox

Save notes, voice messages and Instagram Reels from the [Nooka](https://nooka.pro) Telegram bot straight into your vault.

Works with any sync method — iCloud, Obsidian Sync, Git, Syncthing, Google Drive — and on mobile, because the plugin itself pulls new notes into the vault; nothing writes to your cloud storage from outside.

## Setup

1. Send `/obsidian` to [@n8n_nooka_bot](https://t.me/n8n_nooka_bot) — you'll get a one-time code (valid 10 minutes).
2. Settings → Nooka Inbox → paste the code → **Connect**.
3. New notes appear in the `Nooka Inbox` folder (configurable). The plugin checks on startup and every 5 minutes, or run the command **Nooka Inbox: Забрать заметки сейчас**.

Disconnect all devices with `/obsidian_off` in the bot.

### Install before the plugin is in the community catalog

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) → *Add beta plugin* → `kumsht/nooka-obsidian`.

## Privacy and network use

This plugin makes network requests **only** to `https://obsidian.nooka.pro`:

- `POST /obsidian/pair` — once, to exchange the code for a device token and register this vault's public key;
- `GET /obsidian/pending` — to fetch queued notes;
- `POST /obsidian/ack` — to confirm delivered notes so the server deletes them.

Notes are **end-to-end encrypted**: on connect the plugin generates an RSA-OAEP key pair; the private key never leaves the plugin's `data.json`. The bot encrypts each note with your public key (AES-256-GCM + RSA-OAEP-SHA-256), so the queue on the server holds only ciphertext, and a note encrypted for someone else cannot be decrypted — the plugin never writes such items. Delivered notes are deleted immediately; undelivered ones after 7 days.

Note: `data.json` (device token and private key) lives inside your vault's `.obsidian` folder and syncs with it — treat it like the vault itself.

No telemetry, no analytics.

## Development

```bash
npm install
npm run build   # main.js
```
