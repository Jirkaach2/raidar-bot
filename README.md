# Raidar Discord Bot (public / multi-tenant)

An always-on Discord bot that connects to Rust servers through Rust+. It's
**multi-tenant**: any Discord server can invite the bot and pair *their own*
Rust server, with isolated credentials, devices and notifications. Works 24/7,
independent of the desktop app.

Built on the same stack as the Raidar app (`@liamcottle/rustplus.js` +
`@liamcottle/push-receiver`).

## How it works

```
 Pairing page (Steam login) ──► registers FCM with Facepunch ──► one-time CODE
                                                                      │
 user runs /pair <code> ───────────────────────────────────────────► Bot
                                                                      │
 per guild:  FCM listener (pairings + alarms)  +  Rust+ connection ──► Discord
```

Each guild:
1. An admin opens the **pairing page** (`PUBLIC_BASE_URL`) and logs in with Steam.
2. Runs **`/pair <code>`** with the code shown — credentials are stored for that
   guild (never pasted into chat).
3. In Rust: menu → **Rust+** → **Pair** with the server. The bot links and
   connects automatically. Smart Switches pair the same way.

## Commands

- **Setup**: `/setup`, `/pair <code>`, `/unpair`
- **Read-only** (everyone): `/status`, `/pop`, `/time`, `/team`, `/events`, `/devices`
- **Control** (restricted): `/toggle <device> on|off`, `/say <message>`, `/alarms here|off`

Control is **default-deny** per guild: allowed only for the guild's
`controlRoleId`, its user allowlist, or — if neither is set — server
Administrators.

## Make it a public bot

1. Developer Portal → your app → **Bot** → enable **Public Bot**. Copy the token.
2. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot
   permissions: *Send Messages*, *Use Slash Commands*, *Embed Links*. Share that
   invite URL.
3. Leave `DISCORD_GUILD_ID` blank so commands register **globally**.
4. (Discord requires bot **verification** once you pass 100 servers.)

## Configure & run

```
npm install
cp .env.example .env      # fill DISCORD_TOKEN, DISCORD_CLIENT_ID, PUBLIC_BASE_URL
npm run deploy-commands   # register slash commands
npm start
```

### Owner shortcut (skip the web flow for your own guild)

Run on the PC that has the Raidar app to seed your guild directly from its data:

```
node scripts/import-from-app.mjs <YOUR_GUILD_ID>
```

## Deploy to the Oracle VM

```
pwsh deploy/deploy.ps1 -KeyPath "C:\Users\jirik\Downloads\ssh-key-2026-06-20.key"
```

Packages the bot, installs deps, registers commands, and runs it as the
`raidar-bot` systemd service.

One-time VM prep:
```
sudo dnf install -y nodejs                  # Node >= 18
# open the pairing port (also add an ingress rule in the OCI security list/NSG)
sudo firewall-cmd --permanent --add-port=3000/tcp && sudo firewall-cmd --reload
```

Manage / logs:
```
sudo systemctl status raidar-bot
journalctl -u raidar-bot -f
```

> **TLS:** the pairing page handles Steam auth tokens, so put it behind HTTPS
> (a domain + reverse proxy like Caddy/nginx, or Cloudflare) for production.
> Set `PUBLIC_BASE_URL` to the https URL.

## Security

- `.env` and `data/` are gitignored — they hold the bot token and every guild's
  Rust+ credentials. Never commit them. Back up `data/tenants.json`.
- Regenerate the bot token if it was ever exposed.
- Control commands can toggle in-game devices and post to team chat — keep the
  default-deny gating.
