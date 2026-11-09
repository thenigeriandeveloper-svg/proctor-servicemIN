'use strict';
// Real-browser end-to-end test (Chromium + fake camera). Needs Playwright installed; skipped otherwise.
//   node test/e2e.js            (set E2E_SHOTS=/some/dir to keep failure screenshots)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('Playwright is not installed; skipping browser tests.'); process.exit(0); }

const PORT = 3931, HOST_PORT = 4010;
const BASE = `http://localhost:${PORT}`;
const HOST = `http://localhost:${HOST_PORT}`;
const ADMIN_KEY = 'adm_e2e';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proctor-e2e-'));
const shots = process.env.E2E_SHOTS || os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

async function api(method, url, { key, body, headers } = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}

function spawnNode(args, env, readyText) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes(readyText)) resolve(p); });
    p.on('exit', (c) => reject(new Error(`${args[0]} exited ${c}`)));
    setTimeout(() => reject(new Error(`${args[0]} start timeout`)), 10000);
  });
}

// Walks through an exam in `t` (a Playwright Page or Frame) from the intro screen to the "submitted" screen.
async function takeExam(t, { flagEvents = true } = {}) {
  await t.locator('#btn-camera').click();
  await t.locator('#cam-status', { hasText: 'Camera ready' }).waitFor({ timeout: 15000 });
  await t.locator('#consent').check();
  await t.locator('#btn-start').click();
  await t.locator('#screen-exam').waitFor({ state: 'visible', timeout: 15000 });

  const n = await t.locator('#nav button').count();
  for (let i = 0; i < n; i++) {
    await t.locator('#nav button').nth(i).click();
    const prompt = await t.locator('#question-card .prompt').innerText();
    if (prompt.includes('2+2')) await t.locator('.opt', { hasText: /^4$/ }).click();
    else if (prompt.includes('Capital')) await t.locator('#question-card input[type=text]').fill('Paris');
    else await t.locator('#question-card textarea').fill('function f() { return 1; }');
  }
  await t.locator('#savestate', { hasText: 'All answers saved' }).waitFor({ timeout: 10000 });

  if (flagEvents) {
    await t.evaluate(() => {
      const hide = (v) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
      hide(true); document.dispatchEvent(new Event('visibilitychange'));
      hide(false); document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new ClipboardEvent('copy', { cancelable: true, bubbles: true }));
      document.dispatchEvent(new ClipboardEvent('paste', { cancelable: true, bubbles: true }));
      document.dispatchEvent(new Event('contextmenu', { cancelable: true, bubbles: true }));
    });
    await t.locator('body').press('F12');
  }
  return n;
}

async function submitExam(t) {
  await t.locator('#btn-submit').click();
  await t.locator('#overlay-btn', { hasText: 'Submit now' }).click();
  await t.locator('#screen-done').waitFor({ state: 'visible', timeout: 15000 });
}

async function main() {
  const proctor = await spawnNode(['server.js'], { PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY, PUBLIC_URL: BASE, ALLOW_PRIVATE_WEBHOOKS: '1', BACKUP_INTERVAL_HOURS: '0' }, 'listening');
  const procs = [proctor];
  let browser;
  try {
    const T = await api('POST', '/api/v1/tenants', { headers: { 'X-Admin-Key': ADMIN_KEY }, body: { name: 'E2E School' } });
    const test = await api('POST', '/api/v1/tests', { key: T.api_key, body: {
      title: 'E2E exam', duration_min: 10, owner_ref: 'demo-owner',
      settings: { snapshot_interval_sec: 5, show_result: true },
      questions: [
        { id: 'a', type: 'mcq', prompt: 'What is 2+2?', options: ['3', '4', '5'], answer: 1, points: 2 },
        { id: 'b', type: 'short', prompt: 'Capital of France?', accepted: ['paris'], points: 1 },
        { id: 'c', type: 'code', prompt: 'Write code that returns 1', points: 4 },
      ] } });
    const host = await spawnNode(['examples/host-site/server.js'], {
      PORT: String(HOST_PORT), PROCTOR_URL: BASE, API_KEY: T.api_key, TENANT_ID: T.tenant_id, LAUNCH_SECRET: T.launch_secret, WEBHOOK_SECRET: T.webhook_secret, TEST_ID: test.test_id,
    }, 'Registered this site');
    procs.push(host);
    const me = await api('GET', '/api/v1/me', { key: T.api_key });
    assert.deepEqual(me.allowed_origins, [HOST]); assert.equal(me.webhook_url, `${HOST}/hooks/proctor`);
    ok('example host site registered its webhook URL and allowed origin');

    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
    let page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // ---------------------------------------------------------- A. standalone exam page
    console.log('A. standalone exam (invite link)');
    const inv = await api('POST', '/api/v1/sessions', { key: T.api_key, body: { test_id: test.test_id, candidate_ref: 'e2e-standalone', candidate_name: 'E2E Standalone' } });
    await page.goto(inv.url);
    await page.locator('#screen-intro').waitFor({ state: 'visible' });
    assert.match(await page.locator('#intro-meta').innerText(), /10 minutes · 3 questions/);
    assert.ok(await page.locator('#btn-start').isDisabled()); ok('intro screen loads; Start disabled until camera + consent');
    await takeExam(page);
    ok('camera enabled (fake device), exam started, all question types answered, autosaved');
    const fs1 = await page.evaluate(() => !!document.fullscreenElement);
    console.log('    (fullscreen active in this browser:', fs1, ')');
    await sleep(6500); // snapshots + event flush
    await submitExam(page);
    assert.match(await page.locator('#done-result').innerText(), /Score: 3 \/ 7 \(42\.9%\).*manual grading/); ok('submitted; score shown to candidate');

    let list = await api('GET', '/api/v1/attempts?candidate_ref=e2e-standalone', { key: T.api_key });
    const att = list.data ? list.data : list;
    const attemptId = att.attempts[0].id;
    const detail = await api('GET', `/api/v1/attempts/${attemptId}`, { key: T.api_key });
    const types = detail.events.map((e) => e.type);
    for (const want of ['consent_given', 'started', 'tab_hidden', 'copy_attempt', 'paste_attempt', 'contextmenu_attempt', 'key_shortcut', 'submitted']) assert.ok(types.includes(want), 'missing event ' + want + ' in ' + types.join(','));
    ok('proctoring events reached the server (tab hidden, copy, paste, right-click, F12)');
    assert.ok(detail.snapshots.length >= 2, 'snapshots: ' + detail.snapshots.length);
    const img = await fetch(`${BASE}/api/v1/attempts/${attemptId}/snapshots/${detail.snapshots[0].file}`, { headers: { Authorization: 'Bearer ' + T.api_key } });
    const buf = Buffer.from(await img.arrayBuffer());
    assert.ok(buf[0] === 0xff && buf[1] === 0xd8 && buf.length > 1500, 'jpeg bytes ' + buf.length); ok(`webcam snapshots captured and stored (${detail.snapshots.length} JPEGs, first ${buf.length} bytes)`);
    assert.ok(detail.risk.score > 0); ok('risk score computed from the events: ' + detail.risk.score + ' (' + detail.risk.level + ')');

    // fullscreen enforcement (only meaningful when the browser granted fullscreen)
    console.log('B. fullscreen enforcement');
    const inv2 = await api('POST', '/api/v1/sessions', { key: T.api_key, body: { test_id: test.test_id, candidate_ref: 'e2e-fs' } });
    const p2 = await ctx.newPage();
    await p2.goto(inv2.url);
    await takeExam(p2, { flagEvents: false });
    const inFs = await p2.evaluate(() => !!document.fullscreenElement);
    if (inFs) {
      await p2.evaluate(() => document.exitFullscreen());
      await p2.locator('#overlay-title', { hasText: 'Fullscreen required' }).waitFor({ timeout: 5000 });
      ok('leaving fullscreen shows the blocking overlay');
      await p2.locator('#overlay-btn').click();
      await p2.locator('#overlay').waitFor({ state: 'hidden', timeout: 5000 });
      ok('returning to fullscreen dismisses it');
    } else console.log('    - skipped: this headless browser did not grant fullscreen');
    await p2.close();

    // ---------------------------------------------------------- C. embedded widget
    console.log('C. embedded widget on a host site');
    await page.goto(HOST);
    await page.locator('#take').click();
    const frameEl = page.locator('iframe[title="Proctored exam"]');
    await frameEl.waitFor({ state: 'visible' });
    const fr = await (await frameEl.elementHandle()).contentFrame();
    await fr.locator('#screen-intro').waitFor({ state: 'visible', timeout: 15000 });
    ok('widget opens the exam in a full-screen modal iframe on the host page');
    await takeExam(fr);
    await sleep(5000);
    await submitExam(fr);
    const hostLog = await page.locator('#log').innerText();
    for (const want of ['ready not_started', 'started', 'flag tab_hidden', 'flag copy_attempt', 'submitted {"score":3,"max_score":7']) assert.ok(hostLog.includes(want), `host page did not receive "${want}":\n${hostLog}`);
    ok('host page received ready / started / flag / submitted messages from the iframe');
    // The webhook reaches the host site's backend
    let hooksSeen = [];
    for (let i = 0; i < 20 && !hooksSeen.some((h) => h.candidate_ref === 'student-42'); i++) { await sleep(500); hooksSeen = await (await fetch(HOST + '/api/webhooks')).json(); }
    const wh = hooksSeen.find((h) => h.candidate_ref === 'student-42');
    assert.ok(wh && wh.event === 'attempt.completed' && wh.score === 3); ok('signed webhook delivered to the host site backend and verified by the SDK');
    await page.locator('iframe[title="Proctored exam"]').waitFor({ state: 'attached' });

    // ---------------------------------------------------------- D. embedded builder
    console.log('D. embedded test builder');
    await page.reload();
    await page.locator('#build').click();
    const bf = page.frameLocator('#builder iframe');
    await bf.locator('#tabs button.active', { hasText: 'Tests' }).waitFor({ timeout: 15000 });
    assert.equal(await bf.locator('#tabs button[data-full]').first().isHidden(), true); ok('builder shows only owner-level tabs (no settings/audit)');
    await bf.locator('table >> text=E2E exam').waitFor();
    await bf.locator('button', { hasText: '+ New test' }).click();
    await bf.getByLabel('Title', { exact: true }).fill('Built in the iframe');
    await bf.locator('.qedit textarea').first().fill('Which keyword declares a constant?');
    const opts = bf.locator('.qedit input[type=text]');
    await opts.nth(0).fill('var'); await opts.nth(1).fill('const'); await opts.nth(2).fill('let'); await opts.nth(3).fill('def');
    await bf.locator('.qedit input[type=radio]').nth(1).check();
    await bf.locator('button', { hasText: 'Create test' }).click();
    await bf.locator('.msg.ok', { hasText: 'Created test_' }).waitFor({ timeout: 10000 });
    ok('test created through the form editor inside the iframe');
    await page.locator('#log', { hasText: 'test created: test_' }).waitFor({ timeout: 5000 }); ok('host page was told the new test id via postMessage');
    const mine = await api('GET', '/api/v1/tests?owner_ref=demo-owner', { key: T.api_key });
    const built = mine.tests.find((x) => x.title === 'Built in the iframe');
    assert.ok(built && built.owner_ref === 'demo-owner'); ok('the new test is owned by the builder token\'s owner');
    const full = await api('GET', `/api/v1/tests/${built.id}`, { key: T.api_key });
    assert.equal(full.questions[0].answer, 1); ok('correct answer saved from the radio selection');

    // ---------------------------------------------------------- E. admin dashboard
    console.log('E. reviewer dashboard');
    const ap = await ctx.newPage();
    await ap.goto(BASE + '/admin');
    await ap.locator('#key').fill(T.api_key);
    await ap.locator('#btn-login').click();
    await ap.locator('tr.clickable', { hasText: 'E2E Standalone' }).waitFor({ timeout: 10000 });
    ok('dashboard lists attempts after signing in with the API key');
    await ap.locator('tr.clickable', { hasText: 'E2E Standalone' }).click();
    await ap.locator('h2', { hasText: /Snapshots \(\d+\)/ }).waitFor();
    await ap.waitForFunction(() => [...document.querySelectorAll('.grid img')].some((i) => i.naturalWidth > 0), null, { timeout: 10000 });
    ok('snapshots load in the dashboard via authenticated fetch (no key in image URLs)');
    assert.equal(await ap.locator('.timeline').innerText().then((s) => s.includes('copy attempt')), true); ok('event timeline shows proctoring flags');
    await ap.locator('input[type=number]').first().fill('3');
    await ap.locator('button', { hasText: 'Save grade' }).click();
    await ap.locator('p', { hasText: 'Score 6/7' }).waitFor({ timeout: 5000 }); ok('manual grading of the code answer updates the score');
    await ap.locator('button', { hasText: 'Approve' }).click();
    await ap.locator('span.badge', { hasText: 'approved' }).first().waitFor({ timeout: 5000 }); ok('review decision saved');
    await ap.locator('#tabs button', { hasText: 'Audit log' }).click();
    await ap.locator('td', { hasText: 'attempt.grade' }).first().waitFor({ timeout: 5000 }); ok('audit log tab shows the actions');

    const real = errors.filter((e) => !/favicon|Failed to load resource.*404/.test(e));
    assert.deepEqual(real, [], 'browser console errors:\n' + real.join('\n')); ok('no JavaScript errors in the browser console');
    console.log(`\nAll ${passed} browser checks passed.`);
  } catch (e) {
    try {
      if (browser) for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) await p.screenshot({ path: path.join(shots, `e2e-failure-${i}.png`) });
    } catch { /* ignore */ }
    throw e;
  } finally {
    if (browser) await browser.close();
    for (const p of procs) p.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
