# CLAUDE.md — context for future Claude Code sessions

This file is read by Claude Code on every session. Keep it concise, factual,
and updated when architecture/decisions change. Treat it as the durable
"runtime instructions" for working in this repository.

## What this repo is

Self-hosted **n8n** deployment for **n8n.nurassyl.com**. Three goals:

1. Two-way Notion ↔ **Google Sheets** sync. Sheets = source of truth; Notion is
   mostly a view, optionally accepts edits that flow back.
2. Expose selected n8n workflows as an **MCP server** so Claude.ai and ChatGPT
   can be wired up as Custom Connectors and edit the Sheets via chat.
3. In-workflow LLM nodes (Anthropic / OpenAI) for ad-hoc automation.

**Note**: originally planned around Excel/OneDrive via Microsoft Graph. Pivoted
to Google Sheets because the user's personal Microsoft Account is locked out
of an inactive-blocked Azure AD tenant. Two ledger spreadsheets (personal +
ИП "Тездет") are being migrated from `.xlsx` on OneDrive to Google Sheets on
Google Drive. n8n authenticates via a Google Cloud Service Account.

## Server

- IP: `157.230.213.253` (no IPv6)
- OS: Ubuntu 24.04 LTS, root access
- Project dir: `/root/n8n`
- Docker Engine 29.x + Compose plugin v5.x installed
- Ports exposed publicly: 80, 443 (UDP+TCP). n8n's 5678 stays on the internal
  Docker network — only Caddy reaches it.

## Stack

| Service  | Image                                                 | Purpose                            |
|----------|-------------------------------------------------------|------------------------------------|
| caddy    | `caddy:2-alpine`                                      | TLS termination, reverse proxy     |
| n8n      | `n8n-nurassyl:latest` (built from `Dockerfile.n8n`)   | Workflow engine + UI + MCP server  |
| postgres | `postgres:16-alpine`                                  | n8n persistent storage             |

The n8n image is a custom build: base `docker.n8n.io/n8nio/n8n:latest`
plus the `rclone` binary copied from `rclone/rclone:latest` in a
multi-stage build. The base image is a Docker Hardened Image with no
package manager, so binaries must be staged in. `rclone` is invoked
from n8n's Execute Command nodes to read/write OneDrive Personal files
without any Azure AD app registration — `rclone` ships with a bundled
client ID that authenticates against `login.live.com/consumers`. This
bypasses the user's blocked Azure tenant entirely.

`rclone` config (with the OAuth refresh token) is stored at
`/home/node/.n8n/rclone.conf` inside the `n8n_data` volume, so it
survives container rebuilds.

Volumes (Docker-managed): `postgres_data`, `n8n_data`, `caddy_data`,
`caddy_config`. A host bind-mount `./files` → `/files` is available inside n8n
for ad-hoc shared files.

## File map

```
/root/n8n/
├── CLAUDE.md              ← this file
├── README.md              ← human-facing intro
├── .env                   ← real secrets (gitignored, chmod 600)
├── .env.example           ← template, committed
├── docker-compose.yml     ← stack definition
├── Caddyfile              ← reverse-proxy + auto-TLS
├── Dockerfile.n8n         ← custom n8n image (base + rclone)
├── .gitignore
├── runbooks/
│   ├── deploy.md          ← bootstrap from zero
│   ├── backup-restore.md  ← postgres + n8n_data
│   ├── upgrade.md         ← image pin/bump procedure
│   └── credentials.md     ← OAuth setup for MS365 / Notion / LLMs
├── workflows/             ← exported n8n workflow JSON (committed)
└── files/                 ← runtime bind-mount, gitignored
```

## Commit rules (HARD)

- **Never add `Co-Authored-By: Claude …` (or any AI co-author trailer) to
  commit messages.** Commits must look like they were written by Nurassyl
  alone. No "Generated with Claude Code", no `🤖`, no author footer.
- `git config user.email` is `contact@nurassyl.com` and `user.name` is
  `Nurassyl Aldan`. Do not change these.
- Commit subject ≤ 70 chars, imperative mood. Body wrapped at ~72 cols,
  separated from subject by a blank line. Explain *why*, not *what*.
- Use only the canonical project email `contact@nurassyl.com` in any file,
  config, runbook or commit body. Do not surface any personal address.

## Operating conventions

- **Secrets never enter git.** `.env` is gitignored and chmod 600. Anything
  resembling a secret in a workflow JSON must be replaced with an `={{ $env.X }}`
  reference before committing (n8n exports include credential *names* but not
  values — verify when exporting).
- **N8N_ENCRYPTION_KEY is immutable.** Changing it after first run makes every
  stored credential unreadable. Treat as load-bearing; back it up out-of-band.
- **Workflow export is the source of truth** for workflows. Pattern: edit in
  UI → export JSON → commit to `workflows/`. Reverse: when importing on a
  fresh deploy, restore credentials manually then import the JSON.
- **Caddy auto-renews certs.** No cron needed. Renewal happens silently in
  background; logs visible via `docker compose logs caddy`.
- **Branch model:** `master` is the live branch. No PR workflow yet — direct
  commits. If/when this grows, switch to feature branches + PRs.

## Common commands

```sh
cd /root/n8n

# bring stack up / down
docker compose up -d
docker compose down

# tail logs
docker compose logs -f n8n
docker compose logs -f caddy

# upgrade n8n to latest image
docker compose pull n8n && docker compose up -d n8n

# psql shell
docker compose exec postgres psql -U n8n -d n8n
```

## Decisions worth remembering

- Postgres over SQLite: needed for credential encryption stability and
  potential horizontal scaling; also SQLite file corruption risk on long-
  running stacks.
- Caddy over nginx+certbot: zero-config TLS, native HTTP/3, simpler reload
  story. Caddyfile in this repo is ~25 lines.
- MCP exposure goes through the same `n8n.nurassyl.com` host on dedicated
  paths (see `runbooks/credentials.md` once configured). No separate subdomain.

## When making changes

- Edit on this server, commit, push to `origin master`.
- After a structural change (new service, new volume, port change, env-var
  rename), update `CLAUDE.md` and the relevant runbook in the same commit.
- After exporting workflows, commit the JSON under `workflows/` with a
  descriptive filename — these are diffable.

## Out of scope (do not silently add)

- Kubernetes / Helm. Compose is intentional for this size.
- Cloudflare Tunnel / Tailscale. Direct A-record + Caddy is the chosen
  exposure path. Revisit only if user asks.
- Queue mode / workers / Redis. Adding these is a major architecture change;
  require explicit user decision first.
