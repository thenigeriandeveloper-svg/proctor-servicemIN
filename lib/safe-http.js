'use strict';
// Outbound HTTP for webhooks with SSRF protection: the destination IP is validated at
// connection time (inside the DNS lookup), so DNS rebinding cannot slip past a pre-check.
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true; // not an IP at all: refuse
}

// Static checks used when a webhook URL is registered. Returns an error string or null.
function checkWebhookUrl(raw, { allowPrivate = false, requireHttps = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'must be a valid URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'must be http(s)';
  if (requireHttps && u.protocol !== 'https:') return 'must use https';
  if (u.username || u.password) return 'must not contain credentials';
  if (allowPrivate) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'must be a public host';
  if (net.isIP(host) && isPrivateAddress(host)) return 'must not point to a private or reserved address';
  return null;
}

function makeLookup(allowPrivate) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a.address));
      if (!ok.length) return cb(Object.assign(new Error('destination address not allowed'), { code: 'EBLOCKED' }));
      if (options.all) return cb(null, ok);
      return cb(null, ok[0].address, ok[0].family);
    });
  };
}

function postJson(urlStr, body, headers = {}, { allowPrivate = false, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(new Error('destination address not allowed'));
    const req = lib.request({
      protocol: u.protocol, hostname: host, port: u.port || undefined, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'proctor-service-webhook/1', ...headers },
      lookup: makeLookup(allowPrivate), timeout: timeoutMs,
    }, (res) => {
      res.resume(); // never follow redirects, discard the body
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { isPrivateAddress, checkWebhookUrl, postJson };
