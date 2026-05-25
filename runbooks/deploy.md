# Runbook: deploy from zero

Bootstrap n8n.nurassyl.com on a fresh Ubuntu 22.04+ host.

## Prerequisites

- Public IPv4 address, ports 80/443 open in firewall.
- DNS A-record `n8n.<your-domain>` → server IP. **Wait for propagation** before
  starting Caddy, otherwise the ACME HTTP-01 challenge will fail.
- root or sudo access.

## 1. Install Docker

```sh
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
docker compose version
```

## 2. Clone repo

```sh
git clone git@github.com:nurassyl/n8n.git /root/n8n
cd /root/n8n
```

## 3. Configure secrets

```sh
cp .env.example .env
chmod 600 .env

# strong Postgres password (48 hex chars)
sed -i "s|__generate_with__openssl_rand_hex_24__|$(openssl rand -hex 24)|" .env

# n8n encryption key — IMMUTABLE after first start
sed -i "s|__generate_with__openssl_rand_hex_32__|$(openssl rand -hex 32)|" .env
```

Then open `.env` and adjust:

- `DOMAIN` (must match the A-record)
- `ACME_EMAIL` (Let's Encrypt notifications)
- `TZ` / `GENERIC_TIMEZONE`

## 4. Verify DNS

```sh
dig +short n8n.nurassyl.com @1.1.1.1
# must return the server's public IP
```

If using Cloudflare, disable proxy (grey cloud) until cert is issued.

## 5. Start stack

```sh
docker compose up -d
docker compose ps        # all 3 services Up / healthy
docker compose logs -f caddy
# wait for: "certificate obtained successfully" for your domain
```

Typical issuance time: 10–60 seconds.

## 6. Create owner account

Open `https://n8n.nurassyl.com` in browser, fill in:

- Email
- Password (use a password manager)
- Owner profile name

## 7. Verify

```sh
curl -fsSI https://n8n.nurassyl.com | head -5
# HTTP/2 200
# strict-transport-security: max-age=31536000; includeSubDomains
```

## Troubleshooting

| Symptom                                          | Likely cause / fix                                                |
|--------------------------------------------------|-------------------------------------------------------------------|
| Caddy logs `no such host`                        | DNS not propagated yet. `dig` first.                              |
| Caddy logs `connection refused` on port 80       | Firewall / cloud security group blocks :80. ACME needs it open.   |
| n8n container restart loop                       | Check `docker compose logs n8n`. Usually wrong DB password in env.|
| Browser shows Caddy default page                 | `DOMAIN` env not set or doesn't match `Caddyfile` directive.      |
| 502 Bad Gateway                                  | n8n not healthy yet — wait, or check `docker compose logs n8n`.   |
