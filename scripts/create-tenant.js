'use strict';
// Usage: node scripts/create-tenant.js "My Tech School" [--webhook https://site/hooks] [--origins https://a.com,https://b.com]
// Reads the super-admin key from ADMIN_KEY or data/admin_key, and the service URL from PROCTOR_URL (default http://localhost:3000).
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
if (!name) { console.error('Usage: node scripts/create-tenant.js "Site name" [--webhook URL] [--origins a,b]'); process.exit(1); }

const url = (process.env.PROCTOR_URL || 'http://localhost:3000').replace(/\/+$/, '');
let key = process.env.ADMIN_KEY;
if (!key) {
  try { key = fs.readFileSync(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'admin_key'), 'utf8').trim(); } catch { /* */ }
}
if (!key) { console.error('Set ADMIN_KEY or run this next to the data/ folder.'); process.exit(1); }

(async () => {
  const r = await fetch(`${url}/api/v1/tenants`, {
    method: 'POST', headers: { 'X-Admin-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, webhook_url: opt('--webhook'), allowed_origins: opt('--origins') ? opt('--origins').split(',') : [] }),
  });
  const data = await r.json();
  if (!r.ok) { console.error('Failed:', data.error); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
  console.log('\nSave these now: the API key is stored hashed and cannot be shown again.');
})();
