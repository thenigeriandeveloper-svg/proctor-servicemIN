# Proctor service

One central proctored-test service that all of your websites plug into. No npm dependencies: Node 22.13+ and the built-in `node:sqlite`.

- **Candidates** take exams inside your site (embedded widget) or via a link: server-side timer, autosave and resume, webcam snapshots, tab/fullscreen/clipboard monitoring, face detection where the browser supports it, server-side integrity checks, risk score.
- **Employers / instructors** on your sites create and manage their own tests through an embedded builder, isolated from each other (`owner_ref`).
- **Your backend** gets signed, retried webhooks and a JSON API. A zero-dependency Node SDK is included.
- **Reviewers** use a dashboard: event timeline, snapshots, manual grading, approve/reject, extend time, erase data, audit log.
- **Operations**: Docker + automatic HTTPS, health check, structured logs, automatic backups, retention, key rotation, rate limiting, graceful shutdown.

## Try it locally (Windows PowerShell, macOS, Linux)

```
node server.js                 # terminal 1: http://localhost:3000, seeds a demo tenant and test
node demo.js                   # terminal 2: prints a candidate link + dashboard login
```

Open the candidate link in Chrome or Edge, enable the camera, take the exam, then sign in to `/admin` with the printed `pk_…` key to review it.

To see the **embedded** experience (widget + builder on a pretend customer site):

```
# terminal 1 (needs ALLOW_PRIVATE_WEBHOOKS because the demo site's webhook is on localhost)
PowerShell:  $env:ALLOW_PRIVATE_WEBHOOKS="1"; node server.js
bash:        ALLOW_PRIVATE_WEBHOOKS=1 node server.js
# terminal 2
node examples/host-site/server.js     # http://localhost:4000
```

## Using it on your websites

1. Create a tenant per website: `node scripts/create-tenant.js "My School" --webhook https://mysite.com/hooks/proctor --origins https://mysite.com`
2. Follow **[docs/INTEGRATION.md](docs/INTEGRATION.md)**: take exams in your site, embed the test builder for your users, receive results.
3. Reference: [docs/API.md](docs/API.md).
4. Go live: **[docs/DEPLOY.md](docs/DEPLOY.md)** (Docker + HTTPS, backups, monitoring, capacity, privacy).

## Tests

```
npm test            # 84 API/security/ops checks (starts the real server)
npm run test:e2e    # 24 real-browser checks with Chromium + fake camera (needs Playwright)
node test/load.js 1000 30   # load test: 1000 simulated concurrent candidates
```

## Layout

```
server.js          API, exam backend, jobs (single file, organised by section)
lib/safe-http.js   SSRF-safe outbound webhook delivery
public/            exam client, dashboard/builder, widget.js
sdk/node.js        server-side client for your site's backend
examples/          a pretend customer website using every integration point
scripts/           create-tenant
Dockerfile, docker-compose.yml, Caddyfile, deploy/, .env.example
docs/              integration guide, API reference, deployment guide
```

## Honest limits

Browser-based proctoring is evidence for human review, not proof. It cannot see a second device or a person off-camera, and a determined candidate can tamper with browser code (the server cross-checks what it can). Face detection uses the browser's `FaceDetector`, available in some Chromium builds only; elsewhere snapshots are still captured for human review. There is no audio/screen recording or lockdown browser. For high-stakes decisions combine it with a live interview or coding session, and read the privacy section of the deployment guide. Runs as a single instance (see the scaling notes).
