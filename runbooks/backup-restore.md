# Runbook: backup & restore

What needs to be preserved:

1. **Postgres data** (`postgres_data` volume) — all workflows, executions,
   credentials (encrypted), users, settings.
2. **`N8N_ENCRYPTION_KEY`** from `.env` — without it, the credentials in the
   Postgres dump are unreadable garbage.
3. **`n8n_data` volume** (`/home/node/.n8n`) — local n8n state. Mostly
   re-derivable from Postgres, but contains some cache and a fallback config.
4. **Repo itself** (this directory minus `.env`/`files/`) — already in git.

Back up #1 and #2 together. Lose either and the other is useless.

## Manual backup

```sh
cd /root/n8n
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups

# 1. Postgres dump
docker compose exec -T postgres pg_dump -U n8n -d n8n -Fc \
    > backups/n8n-${TS}.dump

# 2. n8n_data snapshot (optional)
docker run --rm -v n8n-stack_n8n_data:/data -v $(pwd)/backups:/out \
    alpine tar czf /out/n8n_data-${TS}.tar.gz -C /data .

# 3. Encryption key — store SEPARATELY (password manager / 1Password vault)
grep N8N_ENCRYPTION_KEY .env
```

Resulting files in `backups/`:

```
n8n-20260525T053200Z.dump        ← Postgres custom-format dump
n8n_data-20260525T053200Z.tar.gz ← (optional) n8n_data volume
```

`backups/` is gitignored. Ship to off-host storage (S3, B2, restic to a
remote, etc.).

## Restore (same host or fresh host)

Prereq: bring the stack up once with the **same** `N8N_ENCRYPTION_KEY` as
when the backup was taken, then stop n8n before restoring DB:

```sh
docker compose up -d postgres
docker compose stop n8n

# load the dump (drops & recreates DB)
docker compose exec -T postgres dropdb -U n8n --if-exists n8n
docker compose exec -T postgres createdb -U n8n n8n
docker compose exec -T postgres pg_restore -U n8n -d n8n \
    --no-owner --no-privileges < backups/n8n-<TS>.dump

# restore n8n_data (optional)
docker run --rm -v n8n-stack_n8n_data:/data -v $(pwd)/backups:/in \
    alpine sh -c "cd /data && tar xzf /in/n8n_data-<TS>.tar.gz"

docker compose up -d n8n
docker compose logs -f n8n
```

## Scheduled backups (optional)

Add to root crontab:

```cron
# every night at 03:00 UTC, keep 14 days
0 3 * * * cd /root/n8n && \
  TS=$(date -u +\%Y\%m\%dT\%H\%M\%SZ) && \
  docker compose exec -T postgres pg_dump -U n8n -d n8n -Fc > backups/n8n-$TS.dump && \
  find backups -name 'n8n-*.dump' -mtime +14 -delete
```

## Disaster checklist

If everything burns down:

1. New server → run `runbooks/deploy.md` steps 1–3 (Docker, clone repo, fill
   `.env` with the **exact same** `N8N_ENCRYPTION_KEY`).
2. `docker compose up -d postgres` (only Postgres for now).
3. Restore from `backups/n8n-*.dump` (see above).
4. `docker compose up -d` (full stack).
5. Re-issue cert (Caddy does this automatically; takes ~30s).
6. Sanity check: log in, open one credential, run one workflow.
