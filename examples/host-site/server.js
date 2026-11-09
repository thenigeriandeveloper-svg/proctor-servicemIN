'use strict';
/*
 * A tiny "customer website" showing every integration point, using the SDK.
 *   - "Take the exam"   -> backend creates an invite, page opens it with the widget (no visible link)
 *   - "Create a test"   -> backend creates a builder token for the logged-in employer, page embeds the builder
 *   - POST /hooks/proctor receives signed results
 *
 * Run the proctor service first (with ALLOW_PRIVATE_WEBHOOKS=1 for this local demo), then:
 *   node examples/host-site/server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { ProctorClient } = require('../../sdk/node');

let creds = {};
try { creds = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'demo-credentials.json'), 'utf8')); } catch { /* use env */ }
const PROCTOR_URL = process.env.PROCTOR_URL || creds.url || 'http://localhost:3000';
const PORT = Number(process.env.PORT || 4000);
const TEST_ID = process.env.TEST_ID || creds.demo_test_id;
const proctor = new ProctorClient({
  baseUrl: PROCTOR_URL,
  apiKey: process.env.API_KEY || creds.api_key,
  tenantId: process.env.TENANT_ID || creds.tenant_id,
  launchSecret: process.env.LAUNCH_SECRET || creds.launch_secret,
  webhookSecret: process.env.WEBHOOK_SECRET || creds.webhook_secret,
});

const received = [];
const PAGE = `<!doctype html><meta charset="utf-8"><title>Host site demo</title>
<body style="font:16px system-ui;max-width:760px;margin:30px auto;padding:0 16px">
<h1>Acme Tech School (host site demo)</h1>
<p>Signed in as <b>student-42</b> / employer <b>demo-owner</b>.</p>
<p><button id="take">Take the exam</button> <button id="build">Create / manage tests</button></p>
<div id="builder" style="height:640px;display:none;border:1px solid #ccc"></div>
<h3>Events from the widget</h3><pre id="log" style="background:#f4f4f4;padding:8px;min-height:60px"></pre>
<h3>Webhooks received by this site</h3><pre id="hooks" style="background:#f4f4f4;padding:8px;min-height:60px"></pre>
<script src="${PROCTOR_URL}/widget.js"></script>
<script>
const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
document.getElementById('take').onclick = async () => {
  const { url } = await (await fetch('/api/start-exam', { method: 'POST' })).json();
  Proctor.open({ url, onReady: (m) => log('ready ' + m.status), onStarted: () => log('started'),
    onFlag: (m) => log('flag ' + m.event), onSubmitted: (m) => log('submitted ' + JSON.stringify(m.result)) });
};
document.getElementById('build').onclick = async () => {
  const { url } = await (await fetch('/api/builder', { method: 'POST' })).json();
  const el = document.getElementById('builder'); el.style.display = 'block'; el.replaceChildren();
  Proctor.builder({ url, container: el, onTestCreated: (m) => log('test created: ' + m.test_id) });
};
setInterval(async () => { document.getElementById('hooks').textContent = JSON.stringify(await (await fetch('/api/webhooks')).json(), null, 1); }, 2000);
</script>`;

function json(res, status, obj) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
    if (req.method === 'POST' && req.url === '/api/start-exam') {
      // In a real site: look up the logged-in user, check they are allowed to take this test.
      const s = await proctor.createSession({ test_id: TEST_ID, candidate_ref: 'student-42', candidate_name: 'Student 42' }, { idempotencyKey: 'demo-' + Date.now() });
      return json(res, 200, { url: s.url });
    }
    if (req.method === 'POST' && req.url === '/api/builder') {
      const b = await proctor.createBuilderToken('demo-owner', 30);
      return json(res, 200, { url: b.url });
    }
    if (req.method === 'GET' && req.url === '/api/webhooks') return json(res, 200, received.slice(-10));
    if (req.method === 'POST' && req.url === '/hooks/proctor') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks);
      if (!proctor.verifyWebhook(raw, req.headers['x-proctor-signature'])) return json(res, 400, { error: 'bad signature' });
      const evt = JSON.parse(raw.toString('utf8'));
      // Idempotent handling: the same delivery_id can arrive more than once.
      if (!received.some((e) => e.delivery_id === evt.delivery_id)) received.push(evt);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e.message) }); }
});

if (require.main === module) {
  server.listen(PORT, async () => {
    console.log(`Host site demo: http://localhost:${PORT}  (proctor service: ${PROCTOR_URL})`);
    try {
      await proctor.request('PATCH', '/me', { webhook_url: `http://localhost:${PORT}/hooks/proctor`, allowed_origins: [`http://localhost:${PORT}`] });
      console.log('Registered this site\'s webhook URL and allowed origin with the proctor service.');
    } catch (e) { console.log('Could not register webhook (start the proctor service with ALLOW_PRIVATE_WEBHOOKS=1 for local demos):', e.message); }
  });
}
module.exports = { server };
