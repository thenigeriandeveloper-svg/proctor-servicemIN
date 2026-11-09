'use strict';
// End-to-end API test: starts the real server + a webhook receiver and walks every feature.
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { isPrivateAddress, checkWebhookUrl, postJson } = require('../lib/safe-http');
const { ProctorClient, verifyWebhook, signLaunchJwt } = require('../sdk/node');

const PORT = 3917, HOOK_PORT = 3918, MIG_PORT = 3919;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = 'adm_test_key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-test-'));
const migDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-mig-'));
const hooks = [];
const logLines = [];
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function call(method, url, { key, body, headers, base = BASE } = {}) {
  const r = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* not json */ }
  return { status: r.status, data, headers: r.headers };
}

const TINY_JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(1), 0xff, 0xd9]).toString('base64');

async function startServer(port, dir, extraEnv = {}, collect = null) {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, PUBLIC_URL: `http://127.0.0.1:${port}`, ...extraEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    srv.stdout.on('data', (d) => { const s = String(d); if (collect) collect.push(s); if (s.includes('listening')) resolve(); });
    srv.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
  return srv;
}

async function main() {
  const hookServer = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { hooks.push({ headers: req.headers, body: b }); res.end('ok'); });
  }).listen(HOOK_PORT);

  const srv = await startServer(PORT, dataDir, { ADMIN_KEY, ALLOW_PRIVATE_WEBHOOKS: '1' }, logLines);
  const db = () => new DatabaseSync(path.join(dataDir, 'proctor.db'));
  const adm = { 'X-Admin-Key': ADMIN_KEY };

  // helper: run a quick attempt (start + submit) and return ids
  async function quickAttempt(key, testId, ref = 'u1', submit = true) {
    const s = await call('POST', '/api/v1/sessions', { key, body: { test_id: testId, candidate_ref: ref } });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    const st = await call('POST', `/api/exam/${s.data.token}/start`, { body: { consent: true } });
    assert.equal(st.status, 200);
    if (submit) await call('POST', `/api/exam/${s.data.token}/submit`, { body: {} });
    const list = await call('GET', `/api/v1/attempts?candidate_ref=${ref}`, { key });
    return { token: s.data.token, sessionId: s.data.id, attemptId: list.data.attempts[0].id };
  }
  const mcq = (extra = {}) => ({ id: 'm1', type: 'mcq', prompt: 'Q?', options: ['a', 'b'], answer: 0, ...extra });

  try {
    console.log('tenants & auth');
    let r = await call('POST', '/api/v1/tenants', { body: { name: 'X' } });
    assert.equal(r.status, 401); ok('tenant creation needs admin key');
    r = await call('POST', '/api/v1/tenants', { headers: adm, body: { name: 'School A', webhook_url: `http://127.0.0.1:${HOOK_PORT}/hook`, allowed_origins: ['http://localhost:4000'] } });
    assert.equal(r.status, 200);
    const A = r.data;
    assert.deepEqual(A.allowed_origins, ['http://localhost:4000']);
    r = await call('POST', '/api/v1/tenants', { headers: adm, body: { name: 'School B' } });
    const B = r.data; ok('two tenants created');
    r = await call('GET', '/api/v1/tests', { key: 'wrong' });
    assert.equal(r.status, 401); ok('bad API key rejected');
    r = await call('GET', '/api/v1/tenants', { headers: adm });
    assert.equal(r.data.tenants.length, 3); // seeded demo tenant + A + B
    assert.ok(r.data.tenants.every((t) => !('api_key' in t))); ok('super-admin can list tenants (no secrets in the list)');
    {
      const d = db();
      const row = d.prepare('SELECT api_key FROM tenants WHERE id=?').get(A.tenant_id);
      d.close();
      assert.equal(row.api_key, sha(A.api_key));
      assert.ok(!JSON.stringify(row).includes(A.api_key)); ok('API keys are stored hashed');
    }

    console.log('tests & sessions');
    r = await call('POST', '/api/v1/tests', { key: A.api_key, body: { title: 'bad', duration_min: 10, questions: [{ type: 'mcq', prompt: 'x', options: ['a', 'b'], answer: 5 }] } });
    assert.equal(r.status, 400); ok('invalid test rejected');
    r = await call('POST', '/api/v1/tests', { key: A.api_key, body: {
      title: 'Smoke', duration_min: 10, settings: { show_result: true },
      questions: [
        { id: 'm1', type: 'mcq', prompt: '2+2?', options: ['3', '4', '5'], answer: 1, points: 2 },
        { id: 's1', type: 'short', prompt: 'Capital of France?', accepted: ['Paris'], points: 1 },
        { id: 'c1', type: 'code', prompt: 'Write code', points: 4 },
      ] } });
    assert.equal(r.status, 200);
    const testId = r.data.test_id;
    r = await call('GET', `/api/v1/tests/${testId}`, { key: B.api_key });
    assert.equal(r.status, 404); ok('tenant B cannot read tenant A test');

    r = await call('POST', '/api/v1/sessions', { key: A.api_key, body: { test_id: testId, candidate_ref: 'user-42', candidate_name: 'Ada', return_url: 'https://school.example/done' } });
    assert.equal(r.status, 200);
    const token = r.data.token;
    assert.ok(r.data.url.endsWith('/exam/' + token) && r.data.id.startsWith('s_')); ok('session created');

    console.log('candidate flow');
    r = await call('GET', `/api/exam/${token}/info`);
    assert.equal(r.data.status, 'not_started');
    assert.equal(r.data.question_count, 3);
    assert.ok(!JSON.stringify(r.data).includes('"answer"')); ok('info does not leak answers');
    r = await call('POST', `/api/exam/${token}/start`, { body: {} });
    assert.equal(r.status, 400); ok('start requires consent');
    r = await call('POST', `/api/exam/${token}/start`, { body: { consent: true } });
    assert.equal(r.status, 200);
    const qs = r.data.questions;
    assert.equal(qs.length, 3);
    assert.ok(!JSON.stringify(qs).includes('"answer"') && !JSON.stringify(qs).includes('accepted')); ok('questions contain no answer keys');
    assert.ok(r.data.remaining_ms > 9 * 60_000 && r.data.remaining_ms <= 10 * 60_000);
    const m1 = qs.find((q) => q.id === 'm1');
    const correct = m1.options.find((o) => o.text === '4').i;

    r = await call('POST', `/api/exam/${token}/answer`, { body: { question_id: 'm1', value: correct } });
    assert.equal(r.status, 200);
    r = await call('POST', `/api/exam/${token}/answer`, { body: { question_id: 'm1', value: 99 } });
    assert.equal(r.status, 400); ok('invalid option rejected');
    r = await call('POST', `/api/exam/${token}/answer`, { body: { question_id: 'nope', value: 'x' } });
    assert.equal(r.status, 400); ok('unknown question rejected');
    await call('POST', `/api/exam/${token}/answer`, { body: { question_id: 's1', value: ' paris ' } });
    await call('POST', `/api/exam/${token}/answer`, { body: { question_id: 'c1', value: 'function f(){}' } });
    ok('answers autosaved');

    r = await call('POST', `/api/exam/${token}/events`, { body: { events: [
      { type: 'tab_hidden', ts: Date.now() }, { type: 'tab_hidden', ts: Date.now() },
      { type: 'fullscreen_exit' }, { type: 'multiple_faces', detail: '2' }, { type: 'submitted' }, { type: 'snapshot_gap' }, { type: 'bogus' }] } });
    assert.equal(r.data.accepted, 4); ok('events accepted; forged/server-only/unknown types dropped');
    r = await call('POST', `/api/exam/${token}/snapshot`, { body: { image: 'data:image/png;base64,AAAA' } });
    assert.equal(r.status, 400); ok('non-jpeg snapshot rejected');
    r = await call('POST', `/api/exam/${token}/snapshot`, { body: { image: TINY_JPEG, faces: 1 } });
    assert.equal(r.status, 200); ok('snapshot stored');
    r = await call('POST', `/api/exam/${token}/heartbeat`, { body: {} });
    assert.equal(r.data.status, 'in_progress'); ok('heartbeat');

    r = await call('POST', `/api/exam/${token}/start`, { body: { consent: true } });
    assert.equal(r.data.resumed, true);
    assert.equal(Object.keys(r.data.answers).length, 3); ok('resume returns saved answers');

    r = await call('POST', `/api/exam/${token}/submit`, { body: {} });
    assert.equal(r.data.status, 'submitted');
    assert.deepEqual(r.data.result, { score: 3, max_score: 7, percent: 42.9, pending_manual: true });
    assert.equal(r.data.return_url, 'https://school.example/done'); ok('submitted & auto-graded (mcq 2 + short 1; code pending)');
    r = await call('POST', `/api/exam/${token}/answer`, { body: { question_id: 'm1', value: correct } });
    assert.equal(r.status, 409); ok('no answers after submit');
    r = await call('POST', `/api/exam/${token}/start`, { body: { consent: true } });
    assert.equal(r.status, 409); ok('cannot restart after submit');
    r = await call('POST', `/api/exam/${token}/submit`, { body: {} });
    assert.equal(r.data.status, 'submitted'); ok('submit is idempotent');
    r = await call('GET', '/api/exam/does-not-exist/info');
    assert.equal(r.status, 404); ok('bad token → 404');

    console.log('webhook (durable outbox)');
    await sleep(700);
    assert.equal(hooks.length, 1);
    const hk = hooks[0];
    const sigParts = Object.fromEntries(hk.headers['x-proctor-signature'].split(',').map((x) => x.split('=')));
    assert.equal(sigParts.v1, crypto.createHmac('sha256', A.webhook_secret).update(`${sigParts.t}.${hk.body}`).digest('hex')); ok('webhook signature verifies');
    const payload = JSON.parse(hk.body);
    assert.equal(payload.event, 'attempt.completed');
    assert.equal(payload.candidate_ref, 'user-42');
    assert.equal(payload.pending_manual, true);
    assert.ok(payload.delivery_id && hk.headers['x-proctor-delivery'] === payload.delivery_id); ok('webhook payload + delivery id correct');

    console.log('reviewer API');
    r = await call('GET', '/api/v1/attempts', { key: A.api_key });
    assert.equal(r.data.attempts.length, 1);
    const attId = r.data.attempts[0].id;
    assert.match(r.data.attempts[0].webhook_status, /^delivered:/); ok('webhook status recorded on attempt');
    r = await call('GET', '/api/v1/attempts', { key: B.api_key });
    assert.equal(r.data.attempts.length, 0);
    r = await call('GET', `/api/v1/attempts/${attId}`, { key: B.api_key });
    assert.equal(r.status, 404); ok('tenant isolation on attempts');
    r = await call('GET', `/api/v1/attempts/${attId}`, { key: A.api_key });
    assert.equal(r.data.risk.counts.tab_hidden, 2);
    assert.equal(r.data.risk.counts.multiple_faces, 1);
    assert.ok(!r.data.risk.counts.snapshot_gap);
    assert.equal(r.data.risk.score, 28);
    assert.equal(r.data.risk.level, 'medium');
    assert.equal(r.data.snapshots.length, 1);
    assert.ok(r.data.events.some((e) => e.type === 'submitted')); ok('risk score, events, snapshots in detail');
    const snapFile = r.data.snapshots[0].file;
    const snapUrl = `/api/v1/attempts/${attId}/snapshots/${snapFile}`;
    let sr = await fetch(BASE + snapUrl, { headers: { Authorization: 'Bearer ' + A.api_key } });
    assert.equal(sr.status, 200); assert.equal(sr.headers.get('content-type'), 'image/jpeg');
    sr = await fetch(BASE + snapUrl, { headers: { Authorization: 'Bearer ' + B.api_key } });
    assert.equal(sr.status, 404); ok('snapshot access is tenant-scoped');
    sr = await fetch(BASE + snapUrl + '?key=' + A.api_key);
    assert.equal(sr.status, 401); ok('API keys in URLs are not accepted');
    r = await call('POST', `/api/v1/attempts/${attId}/grade`, { key: A.api_key, body: { question_id: 'm1', points: 2 } });
    assert.equal(r.status, 400); ok('auto-graded question cannot be manually graded');
    r = await call('POST', `/api/v1/attempts/${attId}/grade`, { key: A.api_key, body: { question_id: 'c1', points: 9 } });
    assert.equal(r.status, 400); ok('manual grade bounded by max points');
    r = await call('POST', `/api/v1/attempts/${attId}/grade`, { key: A.api_key, body: { question_id: 'c1', points: 3 } });
    assert.equal(r.data.score, 6); assert.equal(r.data.pending_manual, false); ok('manual grading updates score');
    r = await call('POST', `/api/v1/attempts/${attId}/review`, { key: A.api_key, body: { decision: 'approved', note: 'looks fine' } });
    assert.equal(r.data.review_decision, 'approved');
    await sleep(700);
    assert.deepEqual(hooks.map((h) => JSON.parse(h.body).event), ['attempt.completed', 'attempt.graded', 'attempt.reviewed']); ok('graded/reviewed webhooks fired');
    r = await call('POST', `/api/v1/attempts/${attId}/webhook/resend`, { key: A.api_key, body: {} });
    await sleep(700);
    assert.equal(hooks.length, 4);
    assert.notEqual(JSON.parse(hooks[3].body).delivery_id, payload.delivery_id); ok('webhook resend');

    console.log('timer enforcement');
    r = await call('POST', '/api/v1/sessions', { key: A.api_key, body: { test_id: testId, candidate_ref: 'late' } });
    const t2 = r.data.token;
    await call('POST', `/api/exam/${t2}/start`, { body: { consent: true } });
    await call('POST', `/api/exam/${t2}/answer`, { body: { question_id: 's1', value: 'paris' } });
    {
      const d = db();
      d.prepare('UPDATE attempts SET deadline=? WHERE session_token=?').run(Date.now() - 60_000, t2);
      d.close();
    }
    r = await call('POST', `/api/exam/${t2}/answer`, { body: { question_id: 'm1', value: 0 } });
    assert.equal(r.status, 409); ok('answers rejected after deadline (server-side timer)');
    r = await call('GET', `/api/exam/${t2}/info`);
    assert.equal(r.data.status, 'submitted');
    r = await call('GET', '/api/v1/attempts?candidate_ref=late', { key: A.api_key });
    assert.equal(r.data.attempts[0].score, 1); ok('expired attempt auto-submitted with saved answers');

    console.log('integrity signals');
    r = await call('POST', '/api/v1/tests', { key: A.api_key, body: { title: 'Cam', duration_min: 10, settings: { snapshot_interval_sec: 5 }, questions: [mcq()] } });
    const camTest = r.data.test_id;
    let q = await quickAttempt(A.api_key, camTest, 'gap-user', false);
    {
      const d = db();
      d.prepare('UPDATE attempts SET started_at=?, deadline=? WHERE id=?').run(Date.now() - 300_000, Date.now() + 300_000, q.attemptId);
      d.prepare('UPDATE attempts SET ip=? WHERE id=?').run('10.9.9.9', q.attemptId);
      d.close();
    }
    r = await call('POST', `/api/exam/${q.token}/start`, { body: { consent: true } });
    assert.equal(r.data.resumed, true);
    await call('POST', `/api/exam/${q.token}/submit`, { body: {} });
    r = await call('GET', `/api/v1/attempts/${q.attemptId}`, { key: A.api_key });
    assert.ok(r.data.risk.counts.snapshot_gap === 1); ok('missing snapshots are flagged by the server (snapshot_gap)');
    assert.ok(r.data.risk.counts.ip_changed === 1); ok('network change on resume is flagged (ip_changed)');
    assert.ok(r.data.risk.score >= 21);

    console.log('accommodations: extend time');
    q = await quickAttempt(A.api_key, camTest, 'extend-user', false);
    r = await call('POST', `/api/v1/attempts/${q.attemptId}/extend`, { key: A.api_key, body: { minutes: 0 } });
    assert.equal(r.status, 400);
    r = await call('POST', `/api/v1/attempts/${q.attemptId}/extend`, { key: A.api_key, body: { minutes: 5 } });
    assert.equal(r.status, 200);
    r = await call('GET', `/api/exam/${q.token}/info`);
    assert.ok(r.data.remaining_ms > 10 * 60_000); ok('extend adds time to a running attempt');
    await call('POST', `/api/exam/${q.token}/submit`, { body: {} });
    r = await call('POST', `/api/v1/attempts/${q.attemptId}/extend`, { key: A.api_key, body: { minutes: 5 } });
    assert.equal(r.status, 409); ok('cannot extend a finished attempt');

    console.log('invites: idempotency & revoke');
    r = await call('POST', '/api/v1/sessions', { key: A.api_key, headers: { 'Idempotency-Key': 'app-1' }, body: { test_id: camTest } });
    const idem1 = r.data;
    r = await call('POST', '/api/v1/sessions', { key: A.api_key, headers: { 'Idempotency-Key': 'app-1' }, body: { test_id: camTest } });
    assert.equal(r.data.token, idem1.token); assert.equal(r.data.idempotent_replay, true); ok('Idempotency-Key returns the same invite');
    r = await call('POST', `/api/v1/sessions/${idem1.id}/revoke`, { key: A.api_key, body: {} });
    assert.equal(r.data.revoked, true);
    r = await call('GET', `/api/exam/${idem1.token}/info`);
    assert.equal(r.status, 410); ok('revoked invite cannot be opened');
    r = await call('POST', `/api/v1/sessions/${sessionIdOf(q)}/revoke`, { key: A.api_key, body: {} });
    assert.equal(r.status, 409); ok('cannot revoke an invite that was already used');
    function sessionIdOf(x) { return x.sessionId; }

    console.log('owner scoping & builder tokens');
    r = await call('POST', '/api/v1/tests', { key: A.api_key, body: { title: 'E1 test', duration_min: 5, owner_ref: 'emp-1', questions: [mcq()] } });
    const e1Test = r.data.test_id;
    r = await call('POST', '/api/v1/tests', { key: A.api_key, body: { title: 'E2 test', duration_min: 5, owner_ref: 'emp-2', questions: [mcq()] } });
    const e2Test = r.data.test_id;
    r = await call('POST', '/api/v1/builder-tokens', { key: A.api_key, body: {} });
    assert.equal(r.status, 400); ok('builder token needs owner_ref');
    r = await call('POST', '/api/v1/builder-tokens', { key: A.api_key, body: { owner_ref: 'emp-1' } });
    assert.equal(r.status, 200);
    const bt = r.data.token;
    assert.ok(r.data.url.endsWith('/builder/' + bt) && bt.startsWith('bt_'));
    r = await call('GET', '/api/v1/tests', { key: bt });
    assert.deepEqual(r.data.tests.map((t) => t.id), [e1Test]); ok('builder token only sees its owner\'s tests');
    r = await call('GET', `/api/v1/tests/${e2Test}`, { key: bt });
    assert.equal(r.status, 404); ok('builder token cannot read another owner\'s test');
    r = await call('POST', '/api/v1/sessions', { key: bt, body: { test_id: e2Test } });
    assert.equal(r.status, 404);
    r = await call('POST', '/api/v1/sessions', { key: bt, body: { test_id: e1Test } });
    assert.equal(r.status, 200); ok('builder token can only invite to its own tests');
    for (const [m, p, body] of [['PATCH', '/api/v1/me', { webhook_url: null }], ['POST', '/api/v1/builder-tokens', { owner_ref: 'x' }], ['GET', '/api/v1/audit'], ['POST', '/api/v1/me/rotate', { what: 'api_key' }]]) {
      r = await call(m, p, { key: bt, body });
      assert.equal(r.status, 403, p);
    }
    ok('builder token cannot change settings, mint tokens, read audit or rotate keys');
    r = await call('POST', '/api/v1/tests', { key: bt, body: { title: 'By builder', duration_min: 5, owner_ref: 'emp-2', questions: [mcq()] } });
    assert.equal(r.data.owner_ref, 'emp-1'); ok('tests created via builder token are forced to its owner');
    const a2 = await quickAttempt(A.api_key, e2Test, 'cand-e2');
    r = await call('GET', '/api/v1/attempts', { key: bt });
    assert.equal(r.data.attempts.length, 0);
    r = await call('GET', `/api/v1/attempts/${a2.attemptId}`, { key: bt });
    assert.equal(r.status, 404);
    r = await call('POST', `/api/v1/attempts/${a2.attemptId}/review`, { key: bt, body: { decision: 'approved' } });
    assert.equal(r.status, 404); ok('builder token cannot see or act on another owner\'s attempts');
    r = await call('GET', '/api/v1/attempts?owner_ref=emp-2', { key: A.api_key });
    assert.equal(r.data.attempts.length, 1); ok('tenant key can filter by owner_ref');
    {
      const d = db();
      d.prepare('UPDATE builder_tokens SET expires_at=? WHERE token_hash=?').run(Date.now() - 1000, sha(bt));
      d.close();
    }
    r = await call('GET', '/api/v1/me', { key: bt });
    assert.equal(r.status, 401); ok('expired builder token rejected');

    console.log('embedding: allowed origins & widget');
    r = await call('PATCH', '/api/v1/me', { key: A.api_key, body: { allowed_origins: ['http://evil.example.com'] } });
    assert.equal(r.status, 400); ok('non-https/non-localhost origin rejected');
    r = await call('PATCH', '/api/v1/me', { key: A.api_key, body: { allowed_origins: ['https://school.example', 'http://localhost:4000'] } });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/v1/me', { key: A.api_key });
    assert.equal(r.data.webhook_url, `http://127.0.0.1:${HOOK_PORT}/hook`); ok('PATCH /me leaves unspecified fields alone');
    r = await call('POST', '/api/v1/builder-tokens', { key: A.api_key, body: { owner_ref: 'emp-1' } });
    let page = await fetch(`${BASE}/builder/${r.data.token}`);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/school\.example http:\/\/localhost:4000/); ok('builder page frameable only by the tenant\'s origins');
    page = await fetch(`${BASE}/exam/${token}`);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/school\.example/); ok('exam page frameable only by the tenant\'s origins');
    page = await fetch(`${BASE}/exam/not-a-token`);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    page = await fetch(`${BASE}/admin`);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); ok('unknown tokens and the admin page cannot be framed');
    r = await call('GET', `/api/exam/${token}/info`);
    assert.ok(r.data.allowed_origins.includes('https://school.example'));
    page = await fetch(`${BASE}/widget.js`);
    const wtxt = await page.text();
    assert.equal(page.status, 200); assert.ok(wtxt.includes('Proctor') && wtxt.includes('postMessage') === false || wtxt.includes('Proctor'));
    const etag = page.headers.get('etag');
    const again = await fetch(`${BASE}/widget.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304); ok('widget.js served with ETag caching');

    console.log('SDK');
    const c = new ProctorClient({ baseUrl: BASE, apiKey: A.api_key, tenantId: A.tenant_id, launchSecret: A.launch_secret, webhookSecret: A.webhook_secret });
    const s1 = await c.createSession({ test_id: testId, candidate_ref: 'sdk-1' }, { idempotencyKey: 'sdk-k1' });
    const s2 = await c.createSession({ test_id: testId, candidate_ref: 'sdk-1' }, { idempotencyKey: 'sdk-k1' });
    assert.equal(s1.token, s2.token); ok('SDK createSession + idempotency');
    r = await fetch(c.launchUrl({ sub: 'sdk-2', test: testId }), { redirect: 'manual' });
    assert.equal(r.status, 302); ok('SDK launchUrl accepted by /launch');
    await assert.rejects(c.getAttempt('att_missing'), (e) => e.status === 404); ok('SDK surfaces API errors');
    assert.equal(verifyWebhook(hooks[0].body, hooks[0].headers['x-proctor-signature'], A.webhook_secret, 1e9), true);
    assert.equal(verifyWebhook(hooks[0].body + ' ', hooks[0].headers['x-proctor-signature'], A.webhook_secret, 1e9), false);
    assert.equal(verifyWebhook(hooks[0].body, hooks[0].headers['x-proctor-signature'], A.webhook_secret), true); // fresh, inside the default 300 s window
    const oldT = Math.floor(Date.now() / 1000) - 1000;
    const oldSig = `t=${oldT},v1=${crypto.createHmac('sha256', A.webhook_secret).update(`${oldT}.{}`).digest('hex')}`;
    assert.equal(verifyWebhook('{}', oldSig, A.webhook_secret), false); ok('SDK verifyWebhook: good, tampered and stale signatures');

    console.log('JWT launch');
    const claims = { iss: A.tenant_id, sub: 'user-77', name: 'Grace', test: testId, jti: 'j1', exp: Math.floor(Date.now() / 1000) + 600 };
    r = await call('GET', '/launch?jwt=' + signLaunchJwt(claims, A.launch_secret));
    assert.equal(r.status, 302);
    const loc = r.headers.get('location');
    assert.match(loc, /^\/exam\/j_/); ok('valid JWT redirects to exam');
    r = await call('GET', '/launch?jwt=' + signLaunchJwt(claims, A.launch_secret));
    assert.equal(r.headers.get('location'), loc); ok('same jti → same session (no extra attempts)');
    r = await call('GET', '/launch?jwt=' + signLaunchJwt(claims, 'wrong-secret'));
    assert.equal(r.status, 401); ok('bad signature rejected');
    r = await call('GET', '/launch?jwt=' + signLaunchJwt({ ...claims, jti: 'j2', exp: Math.floor(Date.now() / 1000) - 5 }, A.launch_secret));
    assert.equal(r.status, 401); ok('expired JWT rejected');
    r = await call('GET', '/launch?jwt=' + signLaunchJwt({ ...claims, jti: 'j3', test: 'someone-elses' }, A.launch_secret));
    assert.equal(r.status, 404); ok('JWT cannot reference another tenant\'s test');

    console.log('webhook safety & retries');
    assert.equal(isPrivateAddress('169.254.169.254'), true);
    assert.equal(isPrivateAddress('10.1.2.3'), true);
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateAddress('fd00::1'), true);
    assert.equal(isPrivateAddress('93.184.216.34'), false);
    assert.ok(checkWebhookUrl('http://169.254.169.254/latest'));
    assert.ok(checkWebhookUrl('http://localhost:8080/x'));
    assert.ok(checkWebhookUrl('https://user:pw@example.com/x'));
    assert.ok(checkWebhookUrl('http://example.com/x', { requireHttps: true }));
    assert.equal(checkWebhookUrl('https://example.com/hook'), null); ok('SSRF: private/metadata/localhost targets rejected at registration');
    await assert.rejects(postJson(`http://127.0.0.1:${HOOK_PORT}/x`, '{}'), /not allowed/);
    await assert.rejects(postJson(`http://localhost:${HOOK_PORT}/x`, '{}'), /not allowed/); ok('SSRF: blocked at connection time (literal IP and DNS name)');

    r = await call('PATCH', '/api/v1/me', { key: B.api_key, body: { webhook_url: 'http://127.0.0.1:1/never' } });
    assert.equal(r.status, 200);
    r = await call('POST', '/api/v1/tests', { key: B.api_key, body: { title: 'B', duration_min: 5, questions: [mcq()] } });
    const bq = await quickAttempt(B.api_key, r.data.test_id, 'b1');
    await sleep(900);
    r = await call('GET', `/api/v1/attempts/${bq.attemptId}`, { key: B.api_key });
    assert.match(r.data.webhook_status, /^retrying:attempt\.completed/);
    {
      const d = db();
      const o = d.prepare('SELECT tries, next_at, status, last_error FROM outbox WHERE attempt_id=?').get(bq.attemptId);
      d.close();
      assert.equal(o.status, 'pending'); assert.equal(o.tries, 1); assert.ok(o.next_at > Date.now() + 10_000); assert.ok(o.last_error);
    }
    ok('failed webhook is queued for retry with backoff');

    console.log('key rotation');
    r = await call('POST', '/api/v1/me/rotate', { key: B.api_key, body: { what: 'api_key' } });
    assert.equal(r.status, 200);
    const newKey = r.data.api_key;
    r = await call('GET', '/api/v1/me', { key: B.api_key });
    assert.equal(r.status, 401);
    r = await call('GET', '/api/v1/me', { key: newKey });
    assert.equal(r.status, 200); ok('API key rotation invalidates the old key');

    console.log('privacy: erasure & audit');
    assert.ok(fs.existsSync(path.join(dataDir, 'snapshots', attId)));
    r = await call('DELETE', `/api/v1/attempts/${attId}`, { key: newKey });
    assert.equal(r.status, 404); ok('cannot erase another tenant\'s attempt');
    r = await call('DELETE', `/api/v1/attempts/${attId}`, { key: A.api_key });
    assert.equal(r.data.erased, true);
    assert.ok(!fs.existsSync(path.join(dataDir, 'snapshots', attId)));
    r = await call('GET', `/api/v1/attempts/${attId}`, { key: A.api_key });
    assert.equal(r.status, 404);
    r = await call('GET', `/api/exam/${token}/info`);
    assert.equal(r.status, 404); ok('erasing an attempt removes answers, events, snapshots files and the session');
    const g1 = await quickAttempt(A.api_key, camTest, 'gdpr-1');
    await call('POST', '/api/v1/sessions', { key: A.api_key, body: { test_id: camTest, candidate_ref: 'gdpr-1' } });
    r = await call('DELETE', '/api/v1/candidates/gdpr-1', { key: A.api_key });
    assert.deepEqual(r.data, { deleted_sessions: 2, deleted_attempts: 1 });
    r = await call('GET', `/api/v1/attempts/${g1.attemptId}`, { key: A.api_key });
    assert.equal(r.status, 404); ok('erase-by-candidate removes all of a person\'s data');
    r = await call('GET', '/api/v1/audit', { key: A.api_key });
    const actions = r.data.entries.map((e) => e.action);
    for (const want of ['attempt.review', 'attempt.grade', 'attempt.erase', 'candidate.erase', 'attempt.extend', 'session.revoke', 'settings.update']) assert.ok(actions.includes(want), want);
    ok('audit log records admin actions');

    console.log('ops: health, logs, pages');
    r = await call('GET', '/healthz');
    assert.equal(r.data.status, 'ok'); ok('/healthz');
    for (const p of ['/admin', `/exam/${s1.token}`, '/exam.js', '/admin.js', '/style.css']) assert.equal((await fetch(BASE + p)).status, 200, p);
    const all = logLines.join('');
    assert.ok(all.includes('"route":"/api/exam/:token/answer"'));
    assert.ok(!all.includes(token) && !all.includes(A.api_key) && !all.includes(bt)); ok('structured logs contain route patterns but no tokens or keys');

    console.log('migration from v1 database + backups + graceful shutdown');
    {
      const old = new DatabaseSync(path.join(migDir, 'proctor.db'));
      old.exec(`
CREATE TABLE tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL, launch_secret TEXT NOT NULL, webhook_url TEXT, webhook_secret TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE tests(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT, duration_min INTEGER NOT NULL, pick INTEGER, settings_json TEXT NOT NULL, questions_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions(token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, candidate_ref TEXT, candidate_name TEXT, candidate_email TEXT, return_url TEXT, expires_at INTEGER NOT NULL, attempt_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE attempts(id TEXT PRIMARY KEY, session_token TEXT UNIQUE NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, submitted_at INTEGER, order_json TEXT NOT NULL, answers_json TEXT NOT NULL DEFAULT '{}', grading_json TEXT, score REAL, max_score REAL, pending_manual INTEGER DEFAULT 0, risk_score INTEGER DEFAULT 0, last_heartbeat INTEGER, review_decision TEXT, review_note TEXT, webhook_status TEXT, ip TEXT, user_agent TEXT);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, ts INTEGER NOT NULL, client_ts INTEGER, type TEXT NOT NULL, detail TEXT);
CREATE TABLE snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, ts INTEGER NOT NULL, file TEXT NOT NULL, faces INTEGER);`);
      old.prepare('INSERT INTO tenants VALUES(?,?,?,?,?,?,?)').run('t_old', 'Old School', 'pk_oldplaintextkey', 'ls_x', null, 'whsec_x', Date.now());
      old.prepare('INSERT INTO tests VALUES(?,?,?,?,?,?,?,?,?)').run('test_old', 't_old', 'Old test', '', 10, null, JSON.stringify({ snapshot_interval_sec: 20, require_camera: true, require_fullscreen: true, block_clipboard: true, shuffle_questions: true, show_result: false }), JSON.stringify([mcq()]), Date.now());
      old.prepare('INSERT INTO sessions(token,tenant_id,test_id,expires_at,created_at) VALUES(?,?,?,?,?)').run('oldtoken', 't_old', 'test_old', Date.now() + 1e8, Date.now());
      old.close();
    }
    const mig = await startServer(MIG_PORT, migDir, { ADMIN_KEY });
    const MB = `http://127.0.0.1:${MIG_PORT}`;
    r = await call('GET', '/api/v1/me', { key: 'pk_oldplaintextkey', base: MB });
    assert.equal(r.status, 200); assert.equal(r.data.name, 'Old School'); ok('v1 database: old API key still works after migration');
    r = await call('GET', '/api/exam/oldtoken/info', { base: MB });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/v1/sessions', { key: 'pk_oldplaintextkey', base: MB });
    assert.ok(r.data.sessions[0].id.startsWith('s_'));
    {
      const d = new DatabaseSync(path.join(migDir, 'proctor.db'));
      assert.equal(d.prepare('SELECT api_key FROM tenants').get().api_key, sha('pk_oldplaintextkey'));
      d.close();
    }
    ok('v1 database: plaintext keys hashed, sessions given ids, old invites still open');
    await sleep(3500);
    const bdir = path.join(migDir, 'backups');
    const bfiles = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
    assert.equal(bfiles.length, 1);
    const bk = new DatabaseSync(path.join(bdir, bfiles[0]));
    assert.equal(bk.prepare('SELECT COUNT(*) n FROM tenants').get().n, 1); bk.close(); ok('automatic database backup written and readable');
    const exited = new Promise((res) => mig.on('exit', (code) => res(code)));
    mig.kill('SIGTERM');
    assert.equal(await Promise.race([exited, sleep(6000).then(() => 'timeout')]), 0); ok('graceful shutdown on SIGTERM (exit code 0)');

    console.log('brute-force protection');
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await call('GET', '/api/v1/me', { key: 'guess' + i })).status;
    assert.equal(last, 429); ok('repeated bad API keys are rate limited');

    console.log(`\nAll ${passed} checks passed.`);
  } finally {
    srv.kill();
    hookServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(migDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
