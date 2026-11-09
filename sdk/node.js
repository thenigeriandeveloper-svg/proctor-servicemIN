'use strict';
/*
 * Server-side client for the proctor service. Zero dependencies (Node 18+).
 * Use it from YOUR website's backend only: it holds secrets that must never reach a browser.
 *
 *   const { ProctorClient } = require('./sdk/node');
 *   const proctor = new ProctorClient({ baseUrl, apiKey, launchSecret, webhookSecret });
 */
const crypto = require('node:crypto');

class ProctorError extends Error {
  constructor(message, status, body) { super(message); this.name = 'ProctorError'; this.status = status; this.body = body; }
}

// Verify a webhook. `rawBody` MUST be the exact bytes received (string or Buffer), not re-serialised JSON.
function verifyWebhook(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!signatureHeader || !webhookSecret) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // replay protection
  const expected = crypto.createHmac('sha256', webhookSecret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signLaunchJwt(claims, launchSecret) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(claims);
  const sig = crypto.createHmac('sha256', launchSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

class ProctorClient {
  constructor({ baseUrl, apiKey, tenantId, launchSecret, webhookSecret, timeoutMs = 15000 }) {
    if (!baseUrl || !apiKey) throw new Error('baseUrl and apiKey are required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.tenantId = tenantId; // needed only for launchUrl() (it is the JWT `iss`)
    this.launchSecret = launchSecret;
    this.webhookSecret = webhookSecret;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body, headers = {}) {
    const r = await fetch(this.baseUrl + '/api/v1' + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let data = null;
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw new ProctorError((data && data.error) || `HTTP ${r.status}`, r.status, data);
    return data;
  }

  // ---- tests (pass owner_ref to attribute a test to one of your users)
  createTest(test) { return this.request('POST', '/tests', test); }
  listTests(ownerRef) { return this.request('GET', '/tests' + (ownerRef ? `?owner_ref=${encodeURIComponent(ownerRef)}` : '')); }
  getTest(id) { return this.request('GET', `/tests/${encodeURIComponent(id)}`); }
  archiveTest(id) { return this.request('DELETE', `/tests/${encodeURIComponent(id)}`); }

  // ---- candidates: create an invite and give the returned `url` to Proctor.open() or redirect to it.
  // Pass an idempotencyKey (e.g. your application id) so retries never create duplicate invites.
  createSession(params, { idempotencyKey } = {}) {
    return this.request('POST', '/sessions', params, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
  }
  revokeSession(id) { return this.request('POST', `/sessions/${encodeURIComponent(id)}/revoke`, {}); }
  launchUrl(claims, { ttlSec = 600 } = {}) {
    if (!this.launchSecret || !this.tenantId) throw new Error('launchSecret and tenantId are required to sign launch URLs');
    const jwt = signLaunchJwt({ jti: crypto.randomUUID(), ...claims, iss: this.tenantId, exp: Math.floor(Date.now() / 1000) + ttlSec }, this.launchSecret);
    return `${this.baseUrl}/launch?jwt=${jwt}`;
  }

  // ---- embedded test builder for one of your users (employer / instructor)
  createBuilderToken(ownerRef, ttlMinutes = 30) { return this.request('POST', '/builder-tokens', { owner_ref: ownerRef, ttl_minutes: ttlMinutes }); }

  // ---- results
  listAttempts(query = {}) { return this.request('GET', '/attempts?' + new URLSearchParams(query)); }
  getAttempt(id) { return this.request('GET', `/attempts/${encodeURIComponent(id)}`); }
  gradeAttempt(id, questionId, points) { return this.request('POST', `/attempts/${encodeURIComponent(id)}/grade`, { question_id: questionId, points }); }
  reviewAttempt(id, decision, note) { return this.request('POST', `/attempts/${encodeURIComponent(id)}/review`, { decision, note }); }
  extendAttempt(id, minutes) { return this.request('POST', `/attempts/${encodeURIComponent(id)}/extend`, { minutes }); }
  eraseAttempt(id) { return this.request('DELETE', `/attempts/${encodeURIComponent(id)}`); }
  eraseCandidate(ref) { return this.request('DELETE', `/candidates/${encodeURIComponent(ref)}`); }

  verifyWebhook(rawBody, signatureHeader, toleranceSec) { return verifyWebhook(rawBody, signatureHeader, this.webhookSecret, toleranceSec); }
}

module.exports = { ProctorClient, ProctorError, verifyWebhook, signLaunchJwt };
