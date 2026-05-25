# n8n self-hosted — n8n.nurassyl.com

Self-hosted [n8n](https://n8n.io) deployment with Caddy (auto-TLS) and Postgres.
Used to bridge Notion ↔ Excel/OneDrive and to expose workflows as an MCP server
for Claude.ai and ChatGPT Custom Connectors.

## Architecture

```
                                     ┌────────────────────┐
   claude.ai / ChatGPT  ───MCP───►   │                    │
                                     │       n8n          │
   browser (UI)         ───HTTPS─►   │  (Docker, :5678)   │  ─► Postgres
                                     │                    │
   webhooks             ───HTTPS─►   └────────┬───────────┘
                                              │
                                Caddy (:80/:443) — auto Let's Encrypt
                                              │
                                       n8n.nurassyl.com
```

External integrations the workflows talk to:
- Microsoft Graph (Excel / OneDrive)
- Notion API
- Anthropic API (Claude) — optional, for in-workflow LLM steps
- OpenAI API — optional, same idea

## Quick start

See [`runbooks/deploy.md`](runbooks/deploy.md) for a from-zero bootstrap.

```sh
cp .env.example .env
# generate secrets
sed -i "s|__generate_with__openssl_rand_hex_24__|$(openssl rand -hex 24)|" .env
sed -i "s|__generate_with__openssl_rand_hex_32__|$(openssl rand -hex 32)|" .env
# edit DOMAIN, ACME_EMAIL, TZ as needed
chmod 600 .env

docker compose up -d
```

First visit `https://n8n.nurassyl.com` and create the owner account.

## Layout

| Path                | What it is                                                |
|---------------------|-----------------------------------------------------------|
| `docker-compose.yml`| Stack: caddy + n8n + postgres                             |
| `Caddyfile`         | Reverse proxy + automatic Let's Encrypt                   |
| `.env`              | Real secrets — **never** commit                           |
| `.env.example`      | Safe template, commit                                     |
| `CLAUDE.md`         | Working notes for Claude Code sessions                    |
| `runbooks/`         | Operational procedures (deploy, backup, upgrade, creds)   |
| `workflows/`        | Exported n8n workflow JSON                                |
| `files/`            | Host bind-mount available inside n8n at `/files`          |

## Operating

| Action                | Command                                                  |
|-----------------------|----------------------------------------------------------|
| Start                 | `docker compose up -d`                                   |
| Stop                  | `docker compose down`                                    |
| Logs (n8n)            | `docker compose logs -f n8n`                             |
| Logs (TLS issuance)   | `docker compose logs -f caddy`                           |
| Upgrade n8n           | `docker compose pull n8n && docker compose up -d n8n`    |
| Backup                | See [`runbooks/backup-restore.md`](runbooks/backup-restore.md) |

## Security notes

- `.env` is `chmod 600` and gitignored.
- `N8N_ENCRYPTION_KEY` is immutable — losing it means all stored credentials
  must be re-entered. Keep an out-of-band backup.
- Owner account is created via the n8n UI on first visit. Use a strong
  password + enable MFA in the UI once configured.
- Caddy enforces HSTS (1 year, includeSubDomains).

## License

Internal use. n8n itself is under the [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/).
