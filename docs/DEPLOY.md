# Deploying to production

The service is **one process** with SQLite and local snapshot files. That is deliberate: it is simple to run and, in testing (see below), comfortably handles a thousand concurrent candidates. It cannot run as several replicas behind a load balancer; if you outgrow one machine, see "Scaling".

## Option A: Docker + automatic HTTPS (recommended)

A small VPS is enough (2 vCPU, 2 GB RAM, 40+ GB disk; see storage below). Camera access requires HTTPS, so you need a domain.

1. Point a DNS `A` record (e.g. `exams.yourdomain.com`) at the server. Open ports 80 and 443.
2. Install Docker, copy this project to the server, then:
   ```bash
   cp .env.example .env
   # edit .env: set DOMAIN and a long random ADMIN_KEY (openssl rand -hex 32)
   docker compose up -d --build
   ```
   Caddy obtains and renews the TLS certificate automatically.
3. Create a tenant for each of your websites:
   ```bash
   docker compose exec proctor node scripts/create-tenant.js "Acme Tech School" \
     --webhook https://acme.com/hooks/proctor --origins https://acme.com
   ```
   Save the output: the API key is stored hashed and cannot be shown again (you can rotate it later from the dashboard).
4. Sign in at `https://exams.yourdomain.com/admin` with the tenant's API key.

## Option B: systemd

See `deploy/proctor.service` (header comments list the commands). Put Caddy or nginx in front for HTTPS and set `TRUST_PROXY=1`.

## Configuration

See `.env.example`. The important ones:

| Variable | Default | Notes |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:PORT` | Must be `https://…` when `NODE_ENV=production` (the service refuses to start otherwise). |
| `ADMIN_KEY` | generated into `data/admin_key` | Super-admin (tenant creation). Set it explicitly in production. |
| `TRUST_PROXY` | off | Set to `1` behind Caddy/nginx/Cloudflare so rate limits see real client IPs. |
| `RETENTION_DAYS` | 90 | Snapshot images are deleted this long after submission. |
| `ATTEMPT_RETENTION_DAYS` | 0 (keep) | Optionally erase entire attempts after N days. |
| `RATE_LIMIT_PER_MIN` | 6000 | Candidate requests per IP per minute. A classroom or office behind one NAT address shares this; raise it for big sessions (one candidate uses roughly 35 requests/min). |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | 24 / 7 | Consistent SQLite backups in `data/backups/`. |
| `ALLOW_PRIVATE_WEBHOOKS` | off | Local development only. |

Production mode (`NODE_ENV=production`, set by the Dockerfile) also: refuses http `PUBLIC_URL`, requires https webhooks, never seeds the demo tenant, and sends HSTS.

## What to back up

Two things, both under `DATA_DIR` (`/data` in Docker):

- `proctor.db`: the service writes a consistent copy to `backups/` every 24 h, but that is the **same disk**. Copy `backups/` somewhere else (object storage, another machine) on a schedule, e.g. a nightly `rclone sync` or `rsync`.
- `snapshots/`: webcam images. Back up the same way, or accept losing them with the disk if you only need them for the review window.

Restore: stop the service, copy a backup file over `proctor.db` (delete `proctor.db-wal` and `proctor.db-shm`), start the service.

## Monitoring

- `GET /healthz` returns `{"status":"ok"}` when the database is reachable. Point your uptime monitor at it. Docker's healthcheck already does.
- Logs are one JSON object per line on stdout: `req` (method, route pattern, status, ms), `warn`, `error`. Tokens and keys are never logged (route patterns, not URLs).
- Alert on: `/healthz` failing, rising `"level":"error"` lines, disk usage above 80%, and attempts whose `webhook_status` starts with `failed:` (visible in the dashboard and API; use "Resend webhook" after fixing your endpoint).

## Capacity (measured)

`node test/load.js 1000 30` simulates 1000 concurrent candidates at realistic rates (answer every 5 s, events every 4 s, heartbeat every 15 s, a 9 KB snapshot every 20 s) against one process. On a 2-core sandbox that was also running the load generator: about 570 requests/s, **0 errors, p50 1.2 ms, p95 4.9 ms, p99 10.9 ms**, reviewer list query 33 ms. Real networks add latency, and your hardware will differ, so run it against your own server before a big exam.

**Storage** is dominated by snapshots: about 1.5-3 MB per candidate-hour at a 20 s interval (≈1.6 GB per 1000 candidate-hours). Lengthen `snapshot_interval_sec` per test to reduce it.

## Scaling and limits

- One instance only. If you need more, the usual path is: move snapshots to S3/R2-compatible storage and the database to Postgres. That is a code change (the storage and query layers are small and isolated in `server.js`), not a configuration change.
- Webhook delivery is in-process with persistent retries; it needs no extra queue.
- Not included: audio/screen recording, a lockdown browser, live human proctoring, SSO for reviewers. Reviewers use per-tenant API keys or builder tokens.

## Security notes

- API keys and builder tokens are stored hashed. Launch and webhook secrets are stored in plain text in the database (the service needs the raw value to verify/sign). Treat `proctor.db` and its backups as secret.
- Webhook URLs are checked against private/internal addresses at registration **and** at connection time (SSRF and DNS-rebinding protection); redirects are not followed.
- Candidate-facing endpoints are rate limited per IP; repeated bad API keys lock an IP out for a minute.
- The exam and builder pages can only be framed by the tenant's `allowed_origins`; the dashboard cannot be framed at all. Strict Content-Security-Policy on every page.
- Browser-side proctoring can be tampered with by a determined candidate. The server therefore also flags things the browser cannot hide (missing snapshots, network changes), but this is evidence for human review, not proof.

## Privacy (read before running real exams)

You are collecting images of people and their activity data.
- The consent screen is built in and consent is recorded as an event. Publish a privacy notice that says what is collected, why, who sees it, and how long it is kept (`RETENTION_DAYS`).
- Check your obligations under the NDPA (Nigeria) and, if you have EU/UK candidates, GDPR. Typical requirements: lawful basis (consent or legitimate interest), data minimisation, retention limits, secure storage, and a way to delete data on request (`DELETE /api/v1/candidates/:ref`, also in the dashboard).
- Offer an alternative for candidates without a camera, with poor bandwidth, or with a disability. Use "Extend time" for connection trouble.
- Candidate IP address and browser string are stored with the attempt for review.
