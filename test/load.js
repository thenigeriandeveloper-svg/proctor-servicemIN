'use strict';
// Simulates N concurrent candidates at realistic request rates and reports latency/errors.
//   node test/load.js [candidates=300] [seconds=30]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const N = Number(process.argv[2] || 300);
const SECONDS = Number(process.argv[3] || 30);
const PORT = 3951;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-load-'));
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(9000, 7), Buffer.from([0xff, 0xd9])]).toString('base64'); // ~9 KB like a 320px frame
const lat = [];
let errors = 0, total = 0;

async function j(method, url, { key, body } = {}) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), 'X-Admin-Key': 'k' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    lat.push(performance.now() - t0); total++;
    if (!r.ok) { errors++; if (errors < 4) console.log('error', r.status, url, JSON.stringify(data)); }
    return data;
  } catch (e) { errors++; total++; if (errors < 4) console.log('fetch failed', url, String(e)); return {}; }
}

(async () => {
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY: 'k', PUBLIC_URL: BASE, RATE_LIMIT_PER_MIN: '100000000', RATE_LIMIT_API_PER_MIN: '100000000', BACKUP_INTERVAL_HOURS: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  srv.stdout.on('data', () => {});
  await new Promise((r) => setTimeout(r, 1500));
  const T = await j('POST', '/api/v1/tenants', { body: { name: 'Load' } });
  const test = await j('POST', '/api/v1/tests', { key: T.api_key, body: { title: 'Load', duration_min: 60, settings: { snapshot_interval_sec: 20 }, questions: Array.from({ length: 20 }, (_, i) => ({ id: 'q' + i, type: 'mcq', prompt: 'Q' + i, options: ['a', 'b', 'c', 'd'], answer: 1 })) } });
  const cands = [];
  for (let i = 0; i < N; i++) cands.push((await j('POST', '/api/v1/sessions', { key: T.api_key, body: { test_id: test.test_id, candidate_ref: 'c' + i } })).token);
  const started = await Promise.all(cands.map((tok) => j('POST', `/api/exam/${tok}/start`, { body: { consent: true } })));
  lat.length = 0; total = 0; errors = 0;
  console.log(`${N} candidates started; running ${SECONDS}s at realistic rates (answer/5s, events/4s, heartbeat/15s, snapshot/20s)…`);
  const end = Date.now() + SECONDS * 1000;
  const loop = (tok, qs, period, fn) => (async () => {
    await new Promise((r) => setTimeout(r, Math.random() * period));
    while (Date.now() < end) { await fn(); await new Promise((r) => setTimeout(r, period)); }
  })();
  const work = cands.map((tok, i) => {
    const qs = started[i].questions;
    return Promise.all([
      loop(tok, qs, 5000, () => { const q = qs[Math.floor(Math.random() * qs.length)]; return j('POST', `/api/exam/${tok}/answer`, { body: { question_id: q.id, value: q.options[Math.floor(Math.random() * 4)].i } }); }),
      loop(tok, qs, 4000, () => j('POST', `/api/exam/${tok}/events`, { body: { events: [{ type: 'window_focus', ts: Date.now() }] } })),
      loop(tok, qs, 15000, () => j('POST', `/api/exam/${tok}/heartbeat`, { body: {} })),
      loop(tok, qs, 20000, () => j('POST', `/api/exam/${tok}/snapshot`, { body: { image: JPEG, faces: 1 } })),
    ]);
  });
  await Promise.all(work);
  // dashboard query while loaded
  const t0 = performance.now(); await j('GET', '/api/v1/attempts?limit=200', { key: T.api_key }); const listMs = performance.now() - t0;
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
  console.log(`requests: ${total}  (${(total / SECONDS).toFixed(0)}/s)  errors: ${errors}`);
  console.log(`latency ms  p50 ${pct(0.5)}  p95 ${pct(0.95)}  p99 ${pct(0.99)}  max ${lat[lat.length - 1].toFixed(1)}`);
  console.log(`attempt list with ${N} in progress: ${listMs.toFixed(0)} ms`);
  const snapMB = (fs.readdirSync(path.join(dataDir, 'snapshots')).reduce((s, d) => s + fs.readdirSync(path.join(dataDir, 'snapshots', d)).length, 0) * 9 / 1024).toFixed(1);
  console.log(`snapshots written: ~${snapMB} MB`);
  srv.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(errors ? 1 : 0);
})();
