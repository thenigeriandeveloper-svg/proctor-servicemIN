'use strict';
/*
 * Proctored test service. Zero npm dependencies; needs Node 22.13+ (built-in node:sqlite).
 *
 * One central service, many websites ("tenants"). A website integrates by:
 *   - server-to-server API calls with its API key (create tests, invites, read results),
 *   - a signed JWT redirect (/launch), or the embeddable widget (/widget.js),
 *   - signed webhooks for results.
 * Users on a website (employers, instructors) are separated by `owner_ref`; they get a
 * short-lived builder token instead of the site's API key.
 *
 * Runs as a SINGLE process (SQLite + local snapshot files). See docs/DEPLOY.md.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { postJson, checkWebhookUrl } = require('./lib/safe-http');

// ------------------------------------------------------------------ config
const env = process.env;
const PRODUCTION = env.NODE_ENV === 'production';
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const EMBED_ORIGINS = (env.EMBED_ORIGINS || '').split(/[\s,]+/).filter(Boolean); // extra origins allowed for every tenant
const TRUST_PROXY = env.TRUST_PROXY === '1';
const RATE_EXAM = Number(env.RATE_LIMIT_PER_MIN || 6000); // candidate endpoints, per IP (classrooms share one NAT IP)
const RATE_API = Number(env.RATE_LIMIT_API_PER_MIN || 1200); // management API, per tenant
const RETENTION_DAYS = Number(env.RETENTION_DAYS || 90); // snapshot images
const ATTEMPT_RETENTION_DAYS = Number(env.ATTEMPT_RETENTION_DAYS || 0); // whole attempts (0 = keep)
const BACKUP_HOURS = Number(env.BACKUP_INTERVAL_HOURS ?? 24); // 0 = off
const BACKUP_KEEP = Number(env.BACKUP_KEEP || 7);
const ALLOW_PRIVATE_WEBHOOKS = env.ALLOW_PRIVATE_WEBHOOKS === '1'; // only for local development
const GRACE_MS = 10_000; // autosave grace after the deadline
const WEBHOOK_MAX_TRIES = 10;
const PUBLIC_DIR = path.join(__dirname, 'public');

function log(level, msg, fields) {
  if (level === 'debug' && env.LOG_LEVEL !== 'debug') return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}
function die(msg) { log('error', msg); process.exit(1); }

if (PRODUCTION && !PUBLIC_URL.startsWith('https://')) die('PUBLIC_URL must be https:// in production (browsers only allow camera access over HTTPS)');
fs.mkdirSync(path.join(DATA_DIR, 'snapshots'), { recursive: true });

// ----------------------------------------------------------------- helpers
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hashKey = (s) => sha256(s).toString('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => Date.now();
const clip = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function validUrl(u) {
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}

function normalizeOrigin(o) {
  let u;
  try { u = new URL(String(o)); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return null;
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) return null;
  return u.origin;
}
function parseOrigins(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw bad('allowed_origins must be an array of at most 20 origins');
  return [...new Set(list.map((o) => {
    const n = normalizeOrigin(o);
    if (!n) throw bad(`invalid origin "${o}" (use https://example.com; http is only allowed for localhost)`);
    return n;
  }))];
}

function checkWebhook(url) {
  const err = checkWebhookUrl(url, { allowPrivate: ALLOW_PRIVATE_WEBHOOKS, requireHttps: PRODUCTION && !ALLOW_PRIVATE_WEBHOOKS });
  if (err) throw bad('webhook_url ' + err);
}

let ADMIN_KEY = env.ADMIN_KEY;
const adminKeyFile = path.join(DATA_DIR, 'admin_key');
if (!ADMIN_KEY) {
  if (fs.existsSync(adminKeyFile)) ADMIN_KEY = fs.readFileSync(adminKeyFile, 'utf8').trim();
  else {
    ADMIN_KEY = 'adm_' + rid(24);
    fs.writeFileSync(adminKeyFile, ADMIN_KEY, { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------- db
const db = new DatabaseSync(path.join(DATA_DIR, 'proctor.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=OFF;
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL,
  launch_secret TEXT NOT NULL, webhook_url TEXT, webhook_secret TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tests(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT,
  duration_min INTEGER NOT NULL, pick INTEGER, settings_json TEXT NOT NULL,
  questions_json TEXT NOT NULL, created_at INTEGER NOT NULL, owner_ref TEXT, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL,
  candidate_ref TEXT, candidate_name TEXT, candidate_email TEXT, return_url TEXT,
  expires_at INTEGER NOT NULL, attempt_id TEXT, created_at INTEGER NOT NULL,
  id TEXT, idem_key TEXT, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS attempts(
  id TEXT PRIMARY KEY, session_token TEXT UNIQUE NOT NULL, tenant_id TEXT NOT NULL, test_id TEXT NOT NULL,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, submitted_at INTEGER,
  order_json TEXT NOT NULL, answers_json TEXT NOT NULL DEFAULT '{}', grading_json TEXT,
  score REAL, max_score REAL, pending_manual INTEGER DEFAULT 0, risk_score INTEGER DEFAULT 0,
  last_heartbeat INTEGER, review_decision TEXT, review_note TEXT, webhook_status TEXT, ip TEXT, user_agent TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, ts INTEGER NOT NULL,
  client_ts INTEGER, type TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL, ts INTEGER NOT NULL,
  file TEXT NOT NULL, faces INTEGER);
CREATE TABLE IF NOT EXISTS builder_tokens(
  token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_ref TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, attempt_id TEXT NOT NULL, event TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  status TEXT NOT NULL, last_error TEXT);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
`);

// Migrations for databases created by earlier versions.
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('tenants', 'allowed_origins', "TEXT NOT NULL DEFAULT '[]'");
addColumn('tests', 'owner_ref', 'TEXT');
addColumn('tests', 'archived', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'id', 'TEXT');
addColumn('sessions', 'idem_key', 'TEXT');
addColumn('sessions', 'revoked', 'INTEGER NOT NULL DEFAULT 0');
for (const s of db.prepare('SELECT token FROM sessions WHERE id IS NULL').all()) db.prepare('UPDATE sessions SET id=? WHERE token=?').run('s_' + rid(6), s.token);
// API keys are stored hashed; convert any plaintext keys left by the first version.
for (const t of db.prepare("SELECT id, api_key FROM tenants WHERE api_key LIKE 'pk\\_%' ESCAPE '\\'").all()) db.prepare('UPDATE tenants SET api_key=? WHERE id=?').run(hashKey(t.api_key), t.id);
db.exec(`
CREATE INDEX IF NOT EXISTS ev_attempt ON events(attempt_id, ts);
CREATE INDEX IF NOT EXISTS sn_attempt ON snapshots(attempt_id, ts);
CREATE INDEX IF NOT EXISTS at_tenant ON attempts(tenant_id, started_at);
CREATE INDEX IF NOT EXISTS te_tenant ON tests(tenant_id, owner_ref);
CREATE UNIQUE INDEX IF NOT EXISTS se_id ON sessions(id);
CREATE UNIQUE INDEX IF NOT EXISTS se_idem ON sessions(tenant_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ob_due ON outbox(status, next_at);
CREATE INDEX IF NOT EXISTS au_tenant ON audit_log(tenant_id, ts);
`);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
const getTest = (id) => db.prepare('SELECT * FROM tests WHERE id=?').get(id);
const getAttempt = (id) => db.prepare('SELECT * FROM attempts WHERE id=?').get(id);
const getTenant = (id) => db.prepare('SELECT * FROM tenants WHERE id=?').get(id);
const tenantOrigins = (t) => { try { return JSON.parse(t.allowed_origins || '[]'); } catch { return []; } };

function audit(t, action, target, detail = '') {
  db.prepare('INSERT INTO audit_log(ts,tenant_id,actor,action,target,detail) VALUES(?,?,?,?,?,?)')
    .run(now(), t.id, t.owner === null || t.owner === undefined ? 'api' : 'builder:' + t.owner, action, target, String(detail).slice(0, 300));
}

// ------------------------------------------------------- test definition
const DEFAULT_SETTINGS = {
  snapshot_interval_sec: 20, require_camera: true, require_fullscreen: true,
  block_clipboard: true, shuffle_questions: true, show_result: false,
};

function normalizeSettings(s = {}) {
  const o = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (s[k] !== undefined) o[k] = s[k];
  o.snapshot_interval_sec = Math.min(120, Math.max(5, Number(o.snapshot_interval_sec) || 20));
  for (const k of ['require_camera', 'require_fullscreen', 'block_clipboard', 'shuffle_questions', 'show_result']) o[k] = !!o[k];
  return o;
}

function normalizeQuestions(qs) {
  if (!Array.isArray(qs) || qs.length === 0 || qs.length > 500) throw bad('questions must be a non-empty array (max 500)');
  const seen = new Set();
  return qs.map((q, idx) => {
    if (!q || typeof q !== 'object') throw bad(`question ${idx + 1} is invalid`);
    const type = q.type || 'mcq';
    if (!['mcq', 'short', 'text', 'code'].includes(type)) throw bad(`question ${idx + 1}: unknown type "${type}"`);
    const id = String(q.id || 'q' + (idx + 1)).slice(0, 40);
    if (seen.has(id)) throw bad(`duplicate question id "${id}"`);
    seen.add(id);
    const prompt = String(q.prompt || '').trim();
    if (!prompt || prompt.length > 10000) throw bad(`question ${id}: prompt required (max 10000 chars)`);
    const points = q.points === undefined ? 1 : Number(q.points);
    if (!(points >= 0 && points <= 1000)) throw bad(`question ${id}: points must be 0..1000`);
    const out = { id, type, prompt, points };
    if (type === 'mcq') {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10) throw bad(`question ${id}: mcq needs 2-10 options`);
      out.options = q.options.map((o) => String(o).slice(0, 1000));
      if (out.options.some((o) => !o.trim())) throw bad(`question ${id}: options cannot be empty`);
      if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= out.options.length) throw bad(`question ${id}: answer must be the index of the correct option`);
      out.answer = q.answer;
      out.shuffle_options = q.shuffle_options !== false;
    }
    if (type === 'short') {
      if (!Array.isArray(q.accepted) || !q.accepted.length) throw bad(`question ${id}: short needs accepted[]`);
      out.accepted = q.accepted.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      if (!out.accepted.length) throw bad(`question ${id}: accepted[] cannot be empty`);
    }
    return out;
  });
}

function buildOrder(test) {
  const settings = JSON.parse(test.settings_json);
  let list = JSON.parse(test.questions_json);
  if (test.pick && test.pick < list.length) list = shuffle(list).slice(0, test.pick);
  if (settings.shuffle_questions) list = shuffle(list);
  return list.map((q) => ({
    id: q.id,
    opts: q.type === 'mcq' ? (q.shuffle_options ? shuffle(q.options.map((_, i) => i)) : q.options.map((_, i) => i)) : null,
  }));
}

function publicQuestions(test, order) {
  const byId = Object.fromEntries(JSON.parse(test.questions_json).map((q) => [q.id, q]));
  return order.map((o) => {
    const q = byId[o.id];
    const pub = { id: q.id, type: q.type, prompt: q.prompt, points: q.points };
    if (q.type === 'mcq') pub.options = o.opts.map((i) => ({ i, text: q.options[i] }));
    return pub;
  });
}

function totals(detail) {
  let score = 0, max = 0, pending = 0;
  for (const d of Object.values(detail)) {
    max += d.max;
    if (d.points === null) pending++; else score += d.points;
  }
  return { score, max, pending };
}

function gradeAttempt(test, order, answers) {
  const byId = Object.fromEntries(JSON.parse(test.questions_json).map((q) => [q.id, q]));
  const detail = {};
  for (const o of order) {
    const q = byId[o.id];
    const v = answers[o.id];
    if (q.type === 'mcq') detail[q.id] = { points: v === q.answer ? q.points : 0, max: q.points, auto: true };
    else if (q.type === 'short') {
      const ok = typeof v === 'string' && q.accepted.includes(v.trim().toLowerCase());
      detail[q.id] = { points: ok ? q.points : 0, max: q.points, auto: true };
    } else if (v === undefined || v === '') detail[q.id] = { points: 0, max: q.points, auto: true };
    else detail[q.id] = { points: null, max: q.points, auto: false, manual: false };
  }
  return { detail, ...totals(detail) };
}

// ----------------------------------------------------- proctoring / risk
const RISK_WEIGHTS = {
  tab_hidden: 5, window_blur: 2, fullscreen_exit: 8, copy_attempt: 2, cut_attempt: 2, paste_attempt: 3,
  contextmenu_attempt: 1, key_shortcut: 1, print_attempt: 3, no_face: 4, multiple_faces: 10,
  camera_denied: 20, camera_lost: 15, connection_gap: 4,
  snapshot_gap: 15, ip_changed: 6, // generated by the server, never accepted from the client
};
const CLIENT_EVENT_TYPES = new Set([
  ...Object.keys(RISK_WEIGHTS).filter((k) => !['snapshot_gap', 'ip_changed'].includes(k)),
  'tab_visible', 'window_focus', 'fullscreen_enter', 'face_ok', 'camera_ok',
]);

function computeRisk(attemptId) {
  const rows = db.prepare('SELECT type, COUNT(*) n FROM events WHERE attempt_id=? GROUP BY type').all(attemptId);
  let score = 0;
  const counts = {};
  for (const r of rows) {
    counts[r.type] = r.n;
    score += Math.min(r.n * (RISK_WEIGHTS[r.type] || 0), 30); // cap each signal's contribution
  }
  score = Math.min(100, Math.round(score));
  return { score, level: score < 20 ? 'low' : score < 50 ? 'medium' : 'high', counts };
}

function addEvent(attemptId, type, detail = '', clientTs = null) {
  db.prepare('INSERT INTO events(attempt_id, ts, client_ts, type, detail) VALUES(?,?,?,?,?)')
    .run(attemptId, now(), clientTs, type, String(detail).slice(0, 300));
}

// A candidate who blocks the client script can suppress client events, but they cannot
// fake the absence of snapshots the server expected: flag attempts that went quiet.
function checkSnapshotGap(a, test) {
  const s = JSON.parse(test.settings_json);
  if (!s.require_camera) return;
  const elapsed = (Math.min(now(), a.deadline) - a.started_at) / 1000;
  const expected = Math.floor(elapsed / s.snapshot_interval_sec) - 1;
  if (expected < 3) return;
  const n = db.prepare('SELECT COUNT(*) n FROM snapshots WHERE attempt_id=?').get(a.id).n;
  if (n < expected * 0.5) addEvent(a.id, 'snapshot_gap', `${n} of ~${expected} expected snapshots`);
}

// ------------------------------------------------- finalize + webhooks
function finalizeAttempt(a, reason) {
  a = getAttempt(a.id);
  if (a.status !== 'in_progress') return a;
  const test = getTest(a.test_id);
  checkSnapshotGap(a, test);
  const g = gradeAttempt(test, JSON.parse(a.order_json), JSON.parse(a.answers_json));
  const risk = computeRisk(a.id);
  const submittedAt = reason === 'timeout' ? Math.min(now(), a.deadline) : now();
  db.prepare(`UPDATE attempts SET status='submitted', submitted_at=?, score=?, max_score=?, pending_manual=?,
              grading_json=?, risk_score=? WHERE id=? AND status='in_progress'`)
    .run(submittedAt, g.score, g.max, g.pending, JSON.stringify(g.detail), risk.score, a.id);
  addEvent(a.id, reason === 'candidate' ? 'submitted' : 'auto_submitted', reason);
  enqueueWebhook(a.id, 'attempt.completed');
  return getAttempt(a.id);
}

function settle(a) {
  if (a.status === 'in_progress' && now() > a.deadline + GRACE_MS) return finalizeAttempt(a, 'timeout');
  return a;
}

function webhookPayload(eventName, a) {
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(a.session_token);
  const te = getTest(a.test_id);
  const risk = computeRisk(a.id);
  return {
    event: eventName, attempt_id: a.id, test_id: a.test_id, owner_ref: te ? te.owner_ref : null,
    candidate_ref: s.candidate_ref, candidate_name: s.candidate_name, candidate_email: s.candidate_email,
    status: a.status, started_at: a.started_at, submitted_at: a.submitted_at,
    score: a.score, max_score: a.max_score,
    percent: a.max_score ? Math.round((a.score / a.max_score) * 1000) / 10 : null,
    pending_manual: !!a.pending_manual, risk_score: risk.score, risk_level: risk.level,
    review_decision: a.review_decision, review_note: a.review_note,
  };
}

// Durable outbox: events survive restarts and are retried with exponential backoff for ~hours.
function enqueueWebhook(attemptId, eventName) {
  const a = getAttempt(attemptId);
  if (!a) return;
  const tenant = getTenant(a.tenant_id);
  if (!tenant || !tenant.webhook_url) return;
  const id = 'dlv_' + rid(8);
  const body = JSON.stringify({ delivery_id: id, occurred_at: now(), ...webhookPayload(eventName, a) });
  db.prepare("INSERT INTO outbox(id,tenant_id,attempt_id,event,body,created_at,next_at,status) VALUES(?,?,?,?,?,?,?,'pending')")
    .run(id, tenant.id, attemptId, eventName, body, now(), now());
  db.prepare('UPDATE attempts SET webhook_status=? WHERE id=?').run('pending:' + eventName, attemptId);
  setImmediate(processOutbox);
}

async function deliver(o) {
  const tenant = getTenant(o.tenant_id);
  const finish = (status, err, nextAt) => {
    db.prepare('UPDATE outbox SET status=?, tries=tries+1, last_error=?, next_at=? WHERE id=?').run(status, err, nextAt, o.id);
    if (db.prepare('SELECT 1 FROM attempts WHERE id=?').get(o.attempt_id)) {
      const label = status === 'delivered' ? 'delivered' : status === 'failed' ? 'failed' : 'retrying';
      db.prepare('UPDATE attempts SET webhook_status=? WHERE id=?').run(`${label}:${o.event}`, o.attempt_id);
    }
  };
  if (!tenant || !tenant.webhook_url) return finish('failed', 'tenant has no webhook_url', now());
  const ts = Math.floor(now() / 1000);
  const sig = crypto.createHmac('sha256', tenant.webhook_secret).update(`${ts}.${o.body}`).digest('hex');
  let err = null;
  try {
    const r = await postJson(tenant.webhook_url, o.body, {
      'X-Proctor-Event': o.event, 'X-Proctor-Delivery': o.id, 'X-Proctor-Signature': `t=${ts},v1=${sig}`,
    }, { allowPrivate: ALLOW_PRIVATE_WEBHOOKS });
    if (r.status < 200 || r.status >= 300) err = `HTTP ${r.status}`;
  } catch (e) { err = String(e.message || e).slice(0, 200); }
  if (!err) return finish('delivered', null, now());
  const tries = o.tries + 1;
  if (tries >= WEBHOOK_MAX_TRIES) return finish('failed', err, now());
  return finish('pending', err, now() + Math.min(30_000 * 2 ** (tries - 1), 6 * 3600_000));
}

let outboxRunning = false;
async function processOutbox() {
  if (outboxRunning) return;
  outboxRunning = true;
  try {
    for (let round = 0; round < 50; round++) {
      const due = db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY created_at LIMIT 20").all(now());
      if (!due.length) break;
      await Promise.all(due.map((o) => deliver(o).catch((e) => log('error', 'webhook delivery crashed', { error: String(e) }))));
    }
  } finally { outboxRunning = false; }
}

// ---------------------------------------------------------- rate limits
const buckets = new Map();
setInterval(() => buckets.clear(), 60_000).unref();
function hit(bucket, key, max) {
  const k = bucket + ':' + key;
  const n = (buckets.get(k) || 0) + 1;
  buckets.set(k, n);
  if (n > max) throw bad('too many requests', 429);
}
const failKey = (ip) => 'authfail:' + ip;
function noteAuthFailure(ip) { buckets.set(failKey(ip), (buckets.get(failKey(ip)) || 0) + 1); }
function checkAuthLockout(ip) { if ((buckets.get(failKey(ip)) || 0) >= 30) throw bad('too many failed attempts, try again in a minute', 429); }

// ----------------------------------------------------------------- router
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  routes.push({ method, pattern, re: new RegExp(`^${src}$`), keys, handler });
}
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { handler: r.handler, pattern: r.pattern, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

function secHeaders(frameAncestors = "'none'") {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), fullscreen=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${frameAncestors}`,
  };
  if (PUBLIC_URL.startsWith('https://')) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function frameAncestorsFor(tenant) {
  const list = [...new Set([...(tenant ? tenantOrigins(tenant) : []), ...EMBED_ORIGINS])];
  return list.length ? list.join(' ') : "'none'";
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

const STATIC = {};
for (const [file, type] of [
  ['admin.html', 'text/html; charset=utf-8'], ['exam.html', 'text/html; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'],
  ['exam.js', 'application/javascript; charset=utf-8'], ['admin.js', 'application/javascript; charset=utf-8'],
  ['widget.js', 'application/javascript; charset=utf-8'],
]) {
  const buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
  STATIC[file] = { buf, type, etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"' };
}

function sendStatic(ctx, file, { frameAncestors = "'none'", html = false } = {}) {
  const f = STATIC[file];
  const headers = {
    'Content-Type': f.type, ETag: f.etag, ...secHeaders(frameAncestors),
    'Cache-Control': html ? 'no-store' : 'public, max-age=300',
  };
  if (file === 'widget.js') headers['Access-Control-Allow-Origin'] = '*';
  if (!html && ctx.req.headers['if-none-match'] === f.etag) { ctx.res.writeHead(304, headers); return ctx.res.end(); }
  ctx.res.writeHead(200, headers);
  ctx.res.end(f.buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > limit) { tooBig = true; reject(bad('payload too large', 413)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(bad('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Authenticates a tenant API key (full access) or a builder token (scoped to one owner_ref).
function auth(ctx, { full = false } = {}) {
  checkAuthLockout(ctx.ip);
  const h = ctx.req.headers.authorization || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  let t = null;
  if (key.startsWith('bt_')) {
    const row = db.prepare('SELECT * FROM builder_tokens WHERE token_hash=?').get(hashKey(key));
    if (row && row.expires_at > now()) {
      const ten = getTenant(row.tenant_id);
      if (ten) t = { ...ten, owner: row.owner_ref };
    }
  } else if (key) {
    const ten = db.prepare('SELECT * FROM tenants WHERE api_key=?').get(hashKey(key));
    if (ten) t = { ...ten, owner: null };
  }
  if (!t) { noteAuthFailure(ctx.ip); throw bad('invalid or missing API key', 401); }
  if (full && t.owner !== null) throw bad('this endpoint requires the tenant API key', 403);
  hit('api', t.id, RATE_API);
  return t;
}
const visibleTest = (t, test) => !!test && test.tenant_id === t.id && (t.owner === null || test.owner_ref === t.owner);

function adminAuth(ctx) {
  checkAuthLockout(ctx.ip);
  const k = ctx.req.headers['x-admin-key'];
  if (!k || !safeEq(k, ADMIN_KEY)) { noteAuthFailure(ctx.ip); throw bad('invalid admin key', 401); }
}

// ===================================================== super-admin: tenants
function createTenant(name, webhookUrl, origins) {
  name = String(name || '').trim();
  if (!name || name.length > 200) throw bad('name required (max 200 chars)');
  if (webhookUrl) checkWebhook(webhookUrl);
  const allowed = parseOrigins(origins);
  const t = {
    id: 't_' + rid(6), name, api_key: 'pk_' + rid(24), launch_secret: 'ls_' + rid(24),
    webhook_url: webhookUrl || null, webhook_secret: 'whsec_' + rid(24),
  };
  db.prepare('INSERT INTO tenants(id,name,api_key,launch_secret,webhook_url,webhook_secret,allowed_origins,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(t.id, t.name, hashKey(t.api_key), t.launch_secret, t.webhook_url, t.webhook_secret, JSON.stringify(allowed), now());
  return { tenant_id: t.id, name: t.name, api_key: t.api_key, launch_secret: t.launch_secret, webhook_secret: t.webhook_secret, webhook_url: t.webhook_url, allowed_origins: allowed };
}

route('POST', '/api/v1/tenants', (ctx) => { adminAuth(ctx); return createTenant(ctx.body.name, ctx.body.webhook_url, ctx.body.allowed_origins); });
route('GET', '/api/v1/tenants', (ctx) => {
  adminAuth(ctx);
  return { tenants: db.prepare('SELECT * FROM tenants ORDER BY created_at').all().map((t) => ({ tenant_id: t.id, name: t.name, webhook_url: t.webhook_url, allowed_origins: tenantOrigins(t), created_at: t.created_at })) };
});

// ===================================================== tenant self-service
route('GET', '/api/v1/me', (ctx) => {
  const t = auth(ctx);
  return { tenant_id: t.id, name: t.name, scope: t.owner === null ? 'tenant' : 'builder', owner_ref: t.owner, webhook_url: t.owner === null ? t.webhook_url : undefined, allowed_origins: tenantOrigins(t) };
});

route('PATCH', '/api/v1/me', (ctx) => {
  const t = auth(ctx, { full: true });
  const b = ctx.body;
  if ('webhook_url' in b) {
    if (b.webhook_url) checkWebhook(b.webhook_url);
    db.prepare('UPDATE tenants SET webhook_url=? WHERE id=?').run(b.webhook_url || null, t.id);
  }
  if ('allowed_origins' in b) db.prepare('UPDATE tenants SET allowed_origins=? WHERE id=?').run(JSON.stringify(parseOrigins(b.allowed_origins)), t.id);
  audit(t, 'settings.update', t.id, Object.keys(b).join(','));
  const n = getTenant(t.id);
  return { tenant_id: n.id, webhook_url: n.webhook_url, allowed_origins: tenantOrigins(n) };
});

route('POST', '/api/v1/me/rotate', (ctx) => {
  const t = auth(ctx, { full: true });
  const what = ctx.body.what;
  const map = { api_key: ['api_key', 'pk_'], launch_secret: ['launch_secret', 'ls_'], webhook_secret: ['webhook_secret', 'whsec_'] };
  if (!map[what]) throw bad('what must be api_key, launch_secret or webhook_secret');
  const value = map[what][1] + rid(24);
  db.prepare(`UPDATE tenants SET ${map[what][0]}=? WHERE id=?`).run(what === 'api_key' ? hashKey(value) : value, t.id);
  audit(t, 'secret.rotate', t.id, what);
  return { [what]: value, note: what === 'api_key' ? 'The old API key stopped working immediately.' : 'Update your site with the new value now.' };
});

route('POST', '/api/v1/builder-tokens', (ctx) => {
  const t = auth(ctx, { full: true });
  const owner = clip(ctx.body.owner_ref, 200);
  if (!owner) throw bad('owner_ref required (the id of the employer/instructor on your site)');
  const ttl = Math.min(Math.max(Number(ctx.body.ttl_minutes) || 30, 1), 480);
  const token = 'bt_' + rid(24);
  const expires = now() + ttl * 60_000;
  db.prepare('INSERT INTO builder_tokens(token_hash,tenant_id,owner_ref,expires_at) VALUES(?,?,?,?)').run(hashKey(token), t.id, owner, expires);
  return { token, url: `${PUBLIC_URL}/builder/${token}`, expires_at: expires };
});

route('GET', '/api/v1/audit', (ctx) => {
  const t = auth(ctx, { full: true });
  return { entries: db.prepare('SELECT ts, actor, action, target, detail FROM audit_log WHERE tenant_id=? ORDER BY id DESC LIMIT 300').all(t.id) };
});

// ============================================================== tests
const testListItem = (x) => ({
  id: x.id, title: x.title, duration_min: x.duration_min, pick: x.pick, owner_ref: x.owner_ref, archived: !!x.archived,
  question_count: JSON.parse(x.questions_json).length, settings: JSON.parse(x.settings_json), created_at: x.created_at,
});

route('POST', '/api/v1/tests', (ctx) => {
  const t = auth(ctx);
  const b = ctx.body;
  const title = String(b.title || '').trim();
  if (!title || title.length > 300) throw bad('title required (max 300 chars)');
  const duration = Number(b.duration_min);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) throw bad('duration_min must be an integer 1..600');
  const questions = normalizeQuestions(b.questions);
  let pick = null;
  if (b.pick !== undefined && b.pick !== null && b.pick !== '') {
    pick = Number(b.pick);
    if (!Number.isInteger(pick) || pick < 1 || pick > questions.length) throw bad('pick must be 1..number of questions');
  }
  const owner = t.owner !== null ? t.owner : clip(b.owner_ref, 200);
  const id = 'test_' + rid(6);
  db.prepare('INSERT INTO tests(id,tenant_id,title,instructions,duration_min,pick,settings_json,questions_json,created_at,owner_ref) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, t.id, title, String(b.instructions || '').slice(0, 5000), duration, pick, JSON.stringify(normalizeSettings(b.settings)), JSON.stringify(questions), now(), owner);
  audit(t, 'test.create', id);
  return { test_id: id, question_count: questions.length, owner_ref: owner };
});

route('GET', '/api/v1/tests', (ctx) => {
  const t = auth(ctx);
  const owner = t.owner !== null ? t.owner : ctx.url.searchParams.get('owner_ref');
  const rows = owner
    ? db.prepare('SELECT * FROM tests WHERE tenant_id=? AND archived=0 AND owner_ref=? ORDER BY created_at DESC').all(t.id, owner)
    : db.prepare('SELECT * FROM tests WHERE tenant_id=? AND archived=0 ORDER BY created_at DESC').all(t.id);
  return { tests: rows.map(testListItem) };
});

route('GET', '/api/v1/tests/:id', (ctx) => {
  const t = auth(ctx);
  const x = getTest(ctx.params.id);
  if (!visibleTest(t, x)) throw bad('test not found', 404);
  return { ...testListItem(x), instructions: x.instructions, questions: JSON.parse(x.questions_json) };
});

// Tests are immutable once created (running attempts depend on them): "delete" archives.
route('DELETE', '/api/v1/tests/:id', (ctx) => {
  const t = auth(ctx);
  const x = getTest(ctx.params.id);
  if (!visibleTest(t, x)) throw bad('test not found', 404);
  db.prepare('UPDATE tests SET archived=1 WHERE id=?').run(x.id);
  audit(t, 'test.archive', x.id);
  return { archived: true };
});

// ============================================================ sessions
route('POST', '/api/v1/sessions', (ctx) => {
  const t = auth(ctx);
  const b = ctx.body;
  const test = getTest(String(b.test_id || ''));
  if (!visibleTest(t, test) || test.archived) throw bad('test not found', 404);
  if (b.return_url && !validUrl(b.return_url)) throw bad('return_url must be http(s)');
  const idem = clip(ctx.req.headers['idempotency-key'], 200);
  if (idem) {
    const prev = db.prepare('SELECT * FROM sessions WHERE tenant_id=? AND idem_key=?').get(t.id, idem);
    if (prev) return { id: prev.id, token: prev.token, url: `${PUBLIC_URL}/exam/${prev.token}`, expires_at: prev.expires_at, idempotent_replay: true };
  }
  const ttl = Math.min(Math.max(Number(b.ttl_minutes) || 60 * 24 * 7, 1), 60 * 24 * 30);
  const token = rid(24), id = 's_' + rid(6), expires = now() + ttl * 60_000;
  db.prepare('INSERT INTO sessions(token,tenant_id,test_id,candidate_ref,candidate_name,candidate_email,return_url,expires_at,created_at,id,idem_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(token, t.id, test.id, clip(b.candidate_ref, 200), clip(b.candidate_name, 200), clip(b.candidate_email, 200), b.return_url || null, expires, now(), id, idem);
  return { id, token, url: `${PUBLIC_URL}/exam/${token}`, expires_at: expires };
});

route('GET', '/api/v1/sessions', (ctx) => {
  const t = auth(ctx);
  const base = `SELECT s.*, a.status AS attempt_status, a.id AS aid FROM sessions s JOIN tests te ON te.id=s.test_id
    LEFT JOIN attempts a ON a.session_token=s.token WHERE s.tenant_id=?`;
  const rows = t.owner !== null
    ? db.prepare(base + ' AND te.owner_ref=? ORDER BY s.created_at DESC LIMIT 200').all(t.id, t.owner)
    : db.prepare(base + ' ORDER BY s.created_at DESC LIMIT 200').all(t.id);
  return {
    sessions: rows.map((r) => ({
      id: r.id, test_id: r.test_id, candidate_ref: r.candidate_ref, candidate_name: r.candidate_name, candidate_email: r.candidate_email,
      created_at: r.created_at, expires_at: r.expires_at, attempt_id: r.aid,
      status: r.revoked ? 'revoked' : r.attempt_status ? (r.attempt_status === 'in_progress' ? 'in_progress' : 'submitted') : now() > r.expires_at ? 'expired' : 'not_started',
    })),
  };
});

route('POST', '/api/v1/sessions/:id/revoke', (ctx) => {
  const t = auth(ctx);
  const s = db.prepare('SELECT s.*, te.owner_ref FROM sessions s JOIN tests te ON te.id=s.test_id WHERE s.id=?').get(ctx.params.id);
  if (!s || s.tenant_id !== t.id || (t.owner !== null && s.owner_ref !== t.owner)) throw bad('session not found', 404);
  if (s.attempt_id) throw bad('the candidate already started this exam', 409);
  db.prepare('UPDATE sessions SET revoked=1 WHERE token=?').run(s.token);
  audit(t, 'session.revoke', s.id);
  return { revoked: true };
});

// ============================================================= attempts
function attemptSummary(a) {
  const risk = computeRisk(a.id);
  return {
    id: a.id, test_id: a.test_id, test_title: a.test_title, owner_ref: a.owner_ref, candidate_ref: a.candidate_ref, candidate_name: a.candidate_name,
    candidate_email: a.candidate_email, status: a.status, started_at: a.started_at, deadline: a.deadline,
    submitted_at: a.submitted_at, score: a.score, max_score: a.max_score,
    percent: a.max_score ? Math.round((a.score / a.max_score) * 1000) / 10 : null,
    pending_manual: !!a.pending_manual, risk_score: risk.score, risk_level: risk.level,
    review_decision: a.review_decision, review_note: a.review_note, webhook_status: a.webhook_status,
  };
}
const ATTEMPT_SELECT = `SELECT a.*, s.candidate_ref, s.candidate_name, s.candidate_email, s.id AS session_id, te.owner_ref AS owner_ref, te.title AS test_title
  FROM attempts a JOIN sessions s ON s.token=a.session_token JOIN tests te ON te.id=a.test_id`;

function ownAttempt(t, id) {
  const a = db.prepare(`${ATTEMPT_SELECT} WHERE a.id=?`).get(id);
  if (!a || a.tenant_id !== t.id || (t.owner !== null && a.owner_ref !== t.owner)) throw bad('attempt not found', 404);
  return a;
}
const freshSummary = (id) => attemptSummary(db.prepare(`${ATTEMPT_SELECT} WHERE a.id=?`).get(id));

route('GET', '/api/v1/attempts', (ctx) => {
  const t = auth(ctx);
  const q = ctx.url.searchParams;
  for (const x of db.prepare("SELECT * FROM attempts WHERE tenant_id=? AND status='in_progress'").all(t.id)) settle(x);
  let sql = `${ATTEMPT_SELECT} WHERE a.tenant_id=?`;
  const args = [t.id];
  const owner = t.owner !== null ? t.owner : q.get('owner_ref');
  if (owner) { sql += ' AND te.owner_ref=?'; args.push(owner); }
  for (const [param, col] of [['test_id', 'a.test_id'], ['status', 'a.status'], ['candidate_ref', 's.candidate_ref']]) {
    if (q.get(param)) { sql += ` AND ${col}=?`; args.push(q.get(param)); }
  }
  sql += ' ORDER BY a.started_at DESC LIMIT ? OFFSET ?';
  args.push(Math.min(Number(q.get('limit') || 100), 500), Math.max(Number(q.get('offset') || 0), 0));
  return { attempts: db.prepare(sql).all(...args).map(attemptSummary) };
});

route('GET', '/api/v1/attempts/:id', (ctx) => {
  const t = auth(ctx);
  const a = ownAttempt(t, ctx.params.id);
  const test = getTest(a.test_id);
  const byId = Object.fromEntries(JSON.parse(test.questions_json).map((q) => [q.id, q]));
  const answers = JSON.parse(a.answers_json);
  const grading = a.grading_json ? JSON.parse(a.grading_json) : {};
  const questions = JSON.parse(a.order_json).map((o) => ({ ...byId[o.id], response: answers[o.id], grading: grading[o.id] || null }));
  return {
    ...attemptSummary(a), risk: computeRisk(a.id), questions,
    events: db.prepare('SELECT ts, type, detail FROM events WHERE attempt_id=? ORDER BY ts, id').all(a.id),
    snapshots: db.prepare('SELECT ts, file, faces FROM snapshots WHERE attempt_id=? ORDER BY ts').all(a.id),
  };
});

route('GET', '/api/v1/attempts/:id/snapshots/:file', (ctx) => {
  const t = auth(ctx);
  const a = ownAttempt(t, ctx.params.id);
  const f = ctx.params.file;
  if (!/^[a-z0-9_.-]+$/i.test(f) || !db.prepare('SELECT 1 FROM snapshots WHERE attempt_id=? AND file=?').get(a.id, f)) throw bad('not found', 404);
  const p = path.join(DATA_DIR, 'snapshots', a.id, f);
  if (!fs.existsSync(p)) throw bad('snapshot purged by retention policy', 404);
  ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(p).pipe(ctx.res);
});

route('POST', '/api/v1/attempts/:id/grade', (ctx) => {
  const t = auth(ctx);
  const a = ownAttempt(t, ctx.params.id);
  if (a.status !== 'submitted') throw bad('attempt not submitted yet', 409);
  const qid = String(ctx.body.question_id || '');
  const grading = JSON.parse(a.grading_json);
  const g = grading[qid];
  if (!g || g.auto) throw bad('question is not manually gradable', 400);
  const pts = Number(ctx.body.points);
  if (!(pts >= 0 && pts <= g.max)) throw bad(`points must be 0..${g.max}`);
  grading[qid] = { points: pts, max: g.max, auto: false, manual: true };
  const tot = totals(grading);
  db.prepare('UPDATE attempts SET grading_json=?, score=?, max_score=?, pending_manual=? WHERE id=?').run(JSON.stringify(grading), tot.score, tot.max, tot.pending, a.id);
  addEvent(a.id, 'manual_grade', `${qid}=${pts}`);
  audit(t, 'attempt.grade', a.id, `${qid}=${pts}`);
  enqueueWebhook(a.id, 'attempt.graded');
  return freshSummary(a.id);
});

route('POST', '/api/v1/attempts/:id/review', (ctx) => {
  const t = auth(ctx);
  const a = ownAttempt(t, ctx.params.id);
  const d = ctx.body.decision ?? null;
  if (d !== null && !['approved', 'rejected', 'invalidated'].includes(d)) throw bad('decision must be approved, rejected, invalidated or null');
  db.prepare('UPDATE attempts SET review_decision=?, review_note=? WHERE id=?').run(d, clip(ctx.body.note, 2000), a.id);
  addEvent(a.id, 'review', String(d));
  audit(t, 'attempt.review', a.id, String(d));
  enqueueWebhook(a.id, 'attempt.reviewed');
  return freshSummary(a.id);
});

// Accommodation: give a candidate extra time (connection trouble, disability, proctor error).
route('POST', '/api/v1/attempts/:id/extend', (ctx) => {
  const t = auth(ctx);
  const a0 = ownAttempt(t, ctx.params.id);
  const a = settle(getAttempt(a0.id));
  if (a.status !== 'in_progress') throw bad('the exam is no longer in progress', 409);
  const minutes = Number(ctx.body.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw bad('minutes must be an integer 1..120');
  db.prepare('UPDATE attempts SET deadline=deadline+? WHERE id=?').run(minutes * 60_000, a.id);
  addEvent(a.id, 'time_extended', `+${minutes} min`);
  audit(t, 'attempt.extend', a.id, `+${minutes} min`);
  return { deadline: a.deadline + minutes * 60_000 };
});

route('POST', '/api/v1/attempts/:id/webhook/resend', (ctx) => {
  const t = auth(ctx);
  const a = ownAttempt(t, ctx.params.id);
  if (!getTenant(t.id).webhook_url) throw bad('no webhook_url configured', 409);
  enqueueWebhook(a.id, String(ctx.body.event || 'attempt.completed'));
  return { queued: true };
});

// ---- erasure (privacy requests / retention)
function eraseAttempt(attemptId) {
  fs.rmSync(path.join(DATA_DIR, 'snapshots', attemptId), { recursive: true, force: true });
  tx(() => {
    const a = getAttempt(attemptId);
    db.prepare('DELETE FROM snapshots WHERE attempt_id=?').run(attemptId);
    db.prepare('DELETE FROM events WHERE attempt_id=?').run(attemptId);
    db.prepare('DELETE FROM outbox WHERE attempt_id=?').run(attemptId);
    db.prepare('DELETE FROM attempts WHERE id=?').run(attemptId);
    if (a) db.prepare('DELETE FROM sessions WHERE token=?').run(a.session_token);
  });
}

route('DELETE', '/api/v1/attempts/:id', (ctx) => {
  const t = auth(ctx);
  const a = ownAttempt(t, ctx.params.id);
  eraseAttempt(a.id);
  audit(t, 'attempt.erase', a.id);
  return { erased: true };
});

route('DELETE', '/api/v1/candidates/:ref', (ctx) => {
  const t = auth(ctx);
  const rows = db.prepare('SELECT s.token, s.attempt_id, te.owner_ref FROM sessions s JOIN tests te ON te.id=s.test_id WHERE s.tenant_id=? AND s.candidate_ref=?').all(t.id, ctx.params.ref)
    .filter((r) => t.owner === null || r.owner_ref === t.owner);
  let attempts = 0;
  for (const r of rows) {
    if (r.attempt_id) { eraseAttempt(r.attempt_id); attempts++; }
    db.prepare('DELETE FROM sessions WHERE token=?').run(r.token);
  }
  audit(t, 'candidate.erase', '-', `${rows.length} sessions, ${attempts} attempts`);
  return { deleted_sessions: rows.length, deleted_attempts: attempts };
});

// ============================================================ JWT launch
function verifyJwt(token, secret) {
  const [h, p, s] = token.split('.');
  if (!s) return null;
  try {
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (head.alg !== 'HS256') return null;
    const expect = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const got = Buffer.from(s, 'base64url');
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now()) return null;
    return claims;
  } catch { return null; }
}

route('GET', '/launch', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const jwt = ctx.url.searchParams.get('jwt') || '';
  const parts = jwt.split('.');
  if (parts.length !== 3) throw bad('invalid token', 400);
  let unverified;
  try { unverified = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { throw bad('invalid token', 400); }
  const tenant = getTenant(String(unverified.iss || ''));
  const claims = tenant && verifyJwt(jwt, tenant.launch_secret);
  if (!claims) throw bad('invalid or expired token', 401);
  if (claims.exp * 1000 > now() + 24 * 3600_000) throw bad('token exp too far in the future (max 24h)', 400);
  if (!claims.jti || !claims.test || !claims.sub) throw bad('token needs jti, test and sub claims', 400);
  const test = getTest(String(claims.test));
  if (!test || test.tenant_id !== tenant.id || test.archived) throw bad('test not found', 404);
  if (claims.return_url && !validUrl(claims.return_url)) throw bad('return_url must be http(s)', 400);
  const token = 'j_' + sha256(`${tenant.id}:${claims.jti}`).toString('hex').slice(0, 40);
  db.prepare('INSERT OR IGNORE INTO sessions(token,tenant_id,test_id,candidate_ref,candidate_name,candidate_email,return_url,expires_at,created_at,id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(token, tenant.id, test.id, clip(claims.sub, 200), clip(claims.name, 200), clip(claims.email, 200), claims.return_url || null, claims.exp * 1000, now(), 's_' + rid(6));
  ctx.res.writeHead(302, { Location: `/exam/${token}`, 'Cache-Control': 'no-store' });
  ctx.res.end();
});

// ======================================================== candidate API
function loadSession(token) {
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (!s) throw bad('invalid exam link', 404);
  if (s.revoked) throw bad('this exam link has been cancelled', 410);
  return s;
}

function activeAttempt(token) {
  const s = loadSession(token);
  if (!s.attempt_id) throw bad('exam not started', 409);
  const a = settle(getAttempt(s.attempt_id));
  return { s, a, test: getTest(s.test_id) };
}

const publicSettings = (st) => ({ snapshot_interval_sec: st.snapshot_interval_sec, require_camera: st.require_camera, require_fullscreen: st.require_fullscreen, block_clipboard: st.block_clipboard });
const resultFor = (a, st) => st.show_result
  ? { score: a.score, max_score: a.max_score, percent: a.max_score ? Math.round((a.score / a.max_score) * 1000) / 10 : null, pending_manual: !!a.pending_manual }
  : null;

route('GET', '/api/exam/:token/info', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const s = loadSession(ctx.params.token);
  const test = getTest(s.test_id);
  const settings = JSON.parse(test.settings_json);
  const a = s.attempt_id ? settle(getAttempt(s.attempt_id)) : null;
  const out = {
    title: test.title, instructions: test.instructions, duration_min: test.duration_min,
    question_count: test.pick || JSON.parse(test.questions_json).length,
    settings: publicSettings(settings), candidate_name: s.candidate_name, status: 'not_started',
    allowed_origins: [...new Set([...tenantOrigins(getTenant(s.tenant_id)), ...EMBED_ORIGINS])],
  };
  if (a) {
    if (a.status === 'in_progress') { out.status = 'in_progress'; out.remaining_ms = Math.max(0, a.deadline - now()); }
    else { out.status = 'submitted'; out.return_url = s.return_url; out.result = resultFor(a, settings); }
  } else if (now() > s.expires_at) throw bad('this exam link has expired', 410);
  return out;
});

route('POST', '/api/exam/:token/start', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const s = loadSession(ctx.params.token);
  const test = getTest(s.test_id);
  const settings = JSON.parse(test.settings_json);
  let a = s.attempt_id ? settle(getAttempt(s.attempt_id)) : null;
  if (a && a.status !== 'in_progress') throw bad('this exam has already been submitted', 409);
  if (ctx.body.consent !== true) throw bad('consent is required to start a proctored exam');
  let resumed = false;
  if (a) {
    resumed = true;
    addEvent(a.id, 'exam_resumed', '');
    if (a.ip && a.ip !== ctx.ip) addEvent(a.id, 'ip_changed', 'network address changed on resume');
  } else {
    if (now() > s.expires_at) throw bad('this exam link has expired', 410);
    const id = 'att_' + rid(8);
    const t0 = now();
    db.prepare(`INSERT INTO attempts(id,session_token,tenant_id,test_id,status,started_at,deadline,order_json,last_heartbeat,ip,user_agent)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, s.token, s.tenant_id, s.test_id, 'in_progress', t0, t0 + test.duration_min * 60_000, JSON.stringify(buildOrder(test)), t0, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300));
    db.prepare('UPDATE sessions SET attempt_id=? WHERE token=?').run(id, s.token);
    a = getAttempt(id);
    addEvent(id, 'consent_given', '');
    addEvent(id, 'started', '');
  }
  return {
    resumed, remaining_ms: Math.max(0, a.deadline - now()),
    questions: publicQuestions(test, JSON.parse(a.order_json)), answers: JSON.parse(a.answers_json), settings: publicSettings(settings),
  };
});

route('POST', '/api/exam/:token/answer', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const { a } = activeAttempt(ctx.params.token);
  if (a.status !== 'in_progress') throw bad('time_up', 409);
  const qid = String(ctx.body.question_id || '');
  const slot = JSON.parse(a.order_json).find((o) => o.id === qid);
  if (!slot) throw bad('unknown question', 400);
  const q = JSON.parse(getTest(a.test_id).questions_json).find((x) => x.id === qid);
  const v = ctx.body.value;
  if (q.type === 'mcq') {
    if (v !== null && !(Number.isInteger(v) && slot.opts.includes(v))) throw bad('invalid option');
  } else if (typeof v !== 'string' || v.length > 20000) throw bad('answer must be a string (max 20000 chars)');
  const answers = JSON.parse(a.answers_json);
  if (v === null) delete answers[qid]; else answers[qid] = v;
  db.prepare('UPDATE attempts SET answers_json=? WHERE id=?').run(JSON.stringify(answers), a.id);
  return { saved: true, remaining_ms: Math.max(0, a.deadline - now()) };
});

route('POST', '/api/exam/:token/events', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const { a } = activeAttempt(ctx.params.token);
  if (a.status !== 'in_progress') throw bad('exam is over', 409);
  const evs = Array.isArray(ctx.body.events) ? ctx.body.events.slice(0, 50) : [];
  let n = 0;
  for (const e of evs) {
    if (!e || !CLIENT_EVENT_TYPES.has(e.type)) continue;
    addEvent(a.id, e.type, e.detail || '', Number.isFinite(e.ts) ? e.ts : null);
    n++;
  }
  if (n) db.prepare('UPDATE attempts SET risk_score=? WHERE id=?').run(computeRisk(a.id).score, a.id);
  return { accepted: n };
});

route('POST', '/api/exam/:token/snapshot', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const { a } = activeAttempt(ctx.params.token);
  if (a.status !== 'in_progress') throw bad('exam is over', 409);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.image || ''));
  if (!m) throw bad('invalid image');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 20 || buf.length > 300_000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw bad('invalid image');
  if (db.prepare('SELECT COUNT(*) n FROM snapshots WHERE attempt_id=?').get(a.id).n >= 600) throw bad('snapshot limit reached', 429);
  const dir = path.join(DATA_DIR, 'snapshots', a.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${now()}_${rid(3)}.jpg`;
  fs.writeFileSync(path.join(dir, file), buf);
  db.prepare('INSERT INTO snapshots(attempt_id, ts, file, faces) VALUES(?,?,?,?)').run(a.id, now(), file, Number.isInteger(ctx.body.faces) ? ctx.body.faces : null);
  return { saved: true };
});

route('POST', '/api/exam/:token/heartbeat', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const { a } = activeAttempt(ctx.params.token);
  if (a.status !== 'in_progress') return { status: 'submitted' };
  const t = now();
  if (a.last_heartbeat && t - a.last_heartbeat > 45_000) addEvent(a.id, 'connection_gap', `${Math.round((t - a.last_heartbeat) / 1000)}s`);
  db.prepare('UPDATE attempts SET last_heartbeat=? WHERE id=?').run(t, a.id);
  return { status: 'in_progress', remaining_ms: Math.max(0, a.deadline - t) };
});

route('POST', '/api/exam/:token/submit', (ctx) => {
  hit('exam', ctx.ip, RATE_EXAM);
  const s = loadSession(ctx.params.token);
  if (!s.attempt_id) throw bad('exam not started', 409);
  let a = getAttempt(s.attempt_id);
  if (a.status === 'in_progress') a = finalizeAttempt(a, 'candidate');
  return { status: 'submitted', return_url: s.return_url, result: resultFor(a, JSON.parse(getTest(s.test_id).settings_json)) };
});

// ================================================================ pages
route('GET', '/', (ctx) => { ctx.res.writeHead(302, { Location: '/admin' }); ctx.res.end(); });
route('GET', '/healthz', (ctx) => {
  db.prepare('SELECT 1').get();
  return { status: 'ok', uptime_s: Math.round(process.uptime()) };
});
route('GET', '/admin', (ctx) => sendStatic(ctx, 'admin.html', { html: true }));
route('GET', '/builder/:token', (ctx) => {
  const row = db.prepare('SELECT tenant_id FROM builder_tokens WHERE token_hash=?').get(hashKey(ctx.params.token));
  sendStatic(ctx, 'admin.html', { html: true, frameAncestors: frameAncestorsFor(row ? getTenant(row.tenant_id) : null) });
});
route('GET', '/exam/:token', (ctx) => {
  const s = db.prepare('SELECT tenant_id FROM sessions WHERE token=?').get(ctx.params.token);
  sendStatic(ctx, 'exam.html', { html: true, frameAncestors: frameAncestorsFor(s ? getTenant(s.tenant_id) : null) });
});
route('GET', '/style.css', (ctx) => sendStatic(ctx, 'style.css', { frameAncestors: '*' }));
route('GET', '/exam.js', (ctx) => sendStatic(ctx, 'exam.js'));
route('GET', '/admin.js', (ctx) => sendStatic(ctx, 'admin.js'));
route('GET', '/widget.js', (ctx) => sendStatic(ctx, 'widget.js'));

// ============================================================== server
const server = http.createServer(async (req, res) => {
  const t0 = now();
  const reqId = rid(6);
  let pattern = '-';
  res.setHeader('X-Request-Id', reqId);
  res.on('finish', () => { if (pattern !== '/healthz') log('info', 'req', { reqId, method: req.method, route: pattern, status: res.statusCode, ms: now() - t0 }); });
  try {
    const url = new URL(req.url, 'http://x');
    const r = matchRoute(req.method, url.pathname);
    if (!r) throw bad('not found', 404);
    pattern = r.pattern;
    const body = req.method === 'POST' || req.method === 'PATCH'
      ? await readBody(req, pattern === '/api/v1/tests' ? 5_000_000 : 1_000_000) : {};
    const out = await r.handler({ req, res, url, params: r.params, body, ip: clientIp(req) });
    if (!res.headersSent) sendJson(res, 200, out ?? {});
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) log('error', 'unhandled error', { reqId, route: pattern, error: String(e && e.stack || e) });
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'internal error' : e.message });
    else res.end();
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;

// -------------------------------------------------------- background jobs
function expireAbandoned() {
  for (const a of db.prepare("SELECT * FROM attempts WHERE status='in_progress' AND deadline < ?").all(now() - GRACE_MS)) finalizeAttempt(a, 'timeout');
}

function purgeSnapshots() {
  const cutoff = now() - RETENTION_DAYS * 86_400_000;
  const rows = db.prepare("SELECT s.id, s.attempt_id, s.file FROM snapshots s JOIN attempts a ON a.id=s.attempt_id WHERE a.status='submitted' AND a.submitted_at < ?").all(cutoff);
  for (const r of rows) {
    try { fs.rmSync(path.join(DATA_DIR, 'snapshots', r.attempt_id, r.file), { force: true }); } catch { /* ignore */ }
    db.prepare('DELETE FROM snapshots WHERE id=?').run(r.id);
  }
  if (rows.length) log('info', 'retention: purged snapshots', { count: rows.length });
}

function purgeOldAttempts() {
  if (!ATTEMPT_RETENTION_DAYS) return;
  const rows = db.prepare("SELECT id FROM attempts WHERE status='submitted' AND submitted_at < ?").all(now() - ATTEMPT_RETENTION_DAYS * 86_400_000);
  for (const r of rows) eraseAttempt(r.id);
  if (rows.length) log('info', 'retention: erased attempts', { count: rows.length });
}

function backupDb() {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `proctor-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  const all = fs.readdirSync(dir).filter((f) => /^proctor-.*\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  log('info', 'database backup written', { file: path.basename(file), kept: Math.min(all.length, BACKUP_KEEP) });
}

function maybeBackup() {
  if (!BACKUP_HOURS) return;
  const dir = path.join(DATA_DIR, 'backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^proctor-.*\.db$/.test(f)) : [];
  const newest = files.reduce((m, f) => Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs), 0);
  if (!newest || now() - newest > BACKUP_HOURS * 3600_000) backupDb();
}

function maintenance() {
  try {
    db.prepare('DELETE FROM builder_tokens WHERE expires_at < ?').run(now() - 86_400_000);
    db.prepare("DELETE FROM outbox WHERE status!='pending' AND created_at < ?").run(now() - 30 * 86_400_000);
    purgeSnapshots();
    purgeOldAttempts();
    maybeBackup();
  } catch (e) { log('error', 'maintenance failed', { error: String(e) }); }
}

const timers = [];
function startJobs() {
  timers.push(setInterval(() => { try { expireAbandoned(); } catch (e) { log('error', 'expiry job failed', { error: String(e) }); } }, 15_000));
  timers.push(setInterval(() => processOutbox(), 5_000));
  timers.push(setInterval(maintenance, 10 * 60_000));
  for (const t of timers) t.unref();
  setTimeout(() => { maintenance(); processOutbox(); }, 2_000).unref();
}

function seedDemo() {
  if (PRODUCTION && env.SEED_DEMO !== '1') return; // never ship a demo tenant to production
  if (db.prepare('SELECT COUNT(*) n FROM tenants').get().n > 0) return;
  const t = createTenant('Demo School', null, ['http://localhost:4000']);
  const id = 'test_demo';
  db.prepare('INSERT INTO tests(id,tenant_id,title,instructions,duration_min,pick,settings_json,questions_json,created_at,owner_ref) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
    id, t.tenant_id, 'Demo: Web Fundamentals', 'Answer all questions. Keep this window in fullscreen and your face visible.', 15, null,
    JSON.stringify(normalizeSettings({ show_result: true, snapshot_interval_sec: 15 })),
    JSON.stringify(normalizeQuestions([
      { id: 'q1', type: 'mcq', prompt: 'Which HTTP status code means "Not Found"?', options: ['200', '301', '404', '500'], answer: 2 },
      { id: 'q2', type: 'mcq', prompt: 'Which JavaScript keyword declares a block-scoped variable that cannot be reassigned?', options: ['var', 'let', 'const', 'static'], answer: 2 },
      { id: 'q3', type: 'mcq', prompt: 'What does CSS stand for?', options: ['Computer Style Sheets', 'Cascading Style Sheets', 'Creative Style Syntax', 'Colorful Style Sheets'], answer: 1 },
      { id: 'q4', type: 'short', prompt: 'Which HTML tag is used for the largest heading? (answer with the tag name only, e.g. p)', accepted: ['h1', '<h1>'] },
      { id: 'q5', type: 'code', prompt: 'Write a JavaScript function isPalindrome(s) that returns true if s reads the same forwards and backwards.', points: 5 },
    ])), now(), 'demo-owner');
  fs.writeFileSync(path.join(DATA_DIR, 'demo-credentials.json'), JSON.stringify({ ...t, demo_test_id: id, url: PUBLIC_URL }, null, 2), { mode: 0o600 });
  log('info', 'seeded demo tenant; credentials saved to data/demo-credentials.json');
}

function shutdown(signal) {
  log('info', 'shutting down', { signal });
  for (const t of timers) clearInterval(t);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  if (server.closeIdleConnections) server.closeIdleConnections();
}

function start() {
  seedDemo();
  startJobs();
  server.listen(PORT, HOST, () => {
    log('info', `Proctor service listening on ${PUBLIC_URL}`, { port: PORT, production: PRODUCTION });
    if (PRODUCTION && !TRUST_PROXY) log('warn', 'TRUST_PROXY is not set: if you run behind a reverse proxy, every candidate will share one IP for rate limiting');
    log('info', `Dashboard: ${PUBLIC_URL}/admin`);
    log('info', `Super-admin key is in ${env.ADMIN_KEY ? 'the ADMIN_KEY env var' : adminKeyFile}`);
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { error: String(e && e.stack || e) }));
  process.on('uncaughtException', (e) => { log('error', 'uncaughtException', { error: String(e && e.stack || e) }); process.exit(1); });
}

if (require.main === module) start();
module.exports = { server, start };
