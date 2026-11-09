'use strict';
// Creates an invite for the seeded demo test and prints the candidate URL.
// Run the server once first (node server.js) so data/demo-credentials.json exists.
const fs = require('node:fs');
const path = require('node:path');

const credsFile = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'demo-credentials.json');
if (!fs.existsSync(credsFile)) {
  console.error('Start the server first (node server.js) so the demo tenant is seeded.');
  process.exit(1);
}
const c = JSON.parse(fs.readFileSync(credsFile, 'utf8'));

(async () => {
  const r = await fetch(`${c.url}/api/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      test_id: c.demo_test_id,
      candidate_ref: 'demo-user-1',
      candidate_name: process.argv[2] || 'Demo Candidate',
    }),
  });
  const data = await r.json();
  if (!r.ok) { console.error(data); process.exit(1); }
  console.log('Candidate exam link:\n  ' + data.url);
  console.log('\nReviewer dashboard:\n  ' + c.url + '/admin\n  API key: ' + c.api_key);
  console.log('\nNote: camera access needs HTTPS or http://localhost.');
})();
