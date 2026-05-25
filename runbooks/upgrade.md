# Runbook: upgrade n8n

n8n ships frequent releases. Default is to track `:latest`, but pin and bump
deliberately for production.

## Routine upgrade (track `:latest`)

```sh
cd /root/n8n
# 1. Take a backup first (see backup-restore.md)
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U n8n -d n8n -Fc \
    > backups/pre-upgrade-${TS}.dump

# 2. Pull and restart
docker compose pull n8n
docker compose up -d n8n

# 3. Verify
docker compose logs -f n8n
curl -fsSI https://n8n.nurassyl.com
```

## Pinning to a specific version

Edit `docker-compose.yml`:

```yaml
  n8n:
    image: docker.n8n.io/n8nio/n8n:1.74.0   # was: :latest
```

Commit the change. Use [docker.n8n.io tags](https://docs.n8n.io/release-notes/)
to pick a version. Avoid major-version skips without reading the release notes.

## Rollback

If the new version misbehaves:

```sh
# Change the image tag back in docker-compose.yml, then:
docker compose up -d n8n
```

If the new version migrated the DB schema and downgrade refuses to start,
restore from the `pre-upgrade-${TS}.dump` backup (see `backup-restore.md`).

## Postgres / Caddy upgrades

These rarely move. When they do:

- **Postgres major bump** (e.g. 16 → 17): non-trivial, needs `pg_dump`/restore
  procedure. Don't change the tag without a planned migration window.
- **Caddy**: safe to bump `caddy:2-alpine` minor versions. Stack restart is
  ~5s downtime.
