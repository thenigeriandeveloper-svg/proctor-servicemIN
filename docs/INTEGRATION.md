# Integrating a website

Each website is a **tenant**. It gets an API key, a launch secret and a webhook secret (shown once when the tenant is created). These live on **your site's server only**, never in browser code.

```
node scripts/create-tenant.js "Acme Tech School" --webhook https://acme.com/hooks/proctor --origins https://acme.com,https://www.acme.com
```

`--origins` are the sites allowed to embed the exam widget and the test builder (https only; `http://localhost` is allowed for development).

There are three jobs, and a site can use any combination.

| Job | Who | How |
|---|---|---|
| Take an exam inside your site | Candidates / students | Widget (`Proctor.open`) or a redirect |
| Create and manage tests | Employers / instructors on your site | Embedded builder (`Proctor.builder`) or the API |
| Get results | Your backend | Signed webhook and/or API |

## 1. Candidates take the exam inside your site (no visible link)

**Your backend** creates an invite when a logged-in user is allowed to take a test:

```js
const { ProctorClient } = require('./sdk/node');
const proctor = new ProctorClient({ baseUrl: PROCTOR_URL, apiKey: API_KEY, tenantId: TENANT_ID,
                                    launchSecret: LAUNCH_SECRET, webhookSecret: WEBHOOK_SECRET });

app.post('/exams/:testId/start', requireLogin, async (req, res) => {
  // 1. check your own rules: is this user allowed to sit this test, have they paid, etc.
  const s = await proctor.createSession(
    { test_id: req.params.testId, candidate_ref: req.user.id, candidate_name: req.user.name, candidate_email: req.user.email },
    { idempotencyKey: `application-${req.body.applicationId}` },   // a retry returns the same invite
  );
  res.json({ url: s.url });
});
```

**Your page** opens it with the widget:

```html
<script src="https://exams.example.com/widget.js"></script>
<script>
  async function takeExam() {
    const { url } = await (await fetch('/exams/test_abc/start', { method: 'POST' })).json();
    Proctor.open({
      url,
      onStarted:   ()  => console.log('exam running'),
      onFlag:      (m) => console.log('warning shown to candidate:', m.event),
      onSubmitted: (m) => { /* m.result is null unless the test shows scores */ location.href = '/exams/done'; },
    });
  }
</script>
```

The exam opens in a full-screen layer on your page. The close button is hidden while an exam is running. If the candidate reloads your page, calling `Proctor.open` again with the **same** `url` resumes where they left off (the timer never paused).

Widget callbacks: `onReady`, `onStarted`, `onFlag`, `onSubmitted`, `onError`, `onClose`, and a catch-all `onEvent`. Pass `container: '#el'` to render inline instead of a full-screen layer.

**No JavaScript on your side?** Just redirect the candidate to `s.url` (or to a signed `/launch?jwt=` URL, see below). Add `return_url` when creating the invite to send them back afterwards.

### Signed launch URL (alternative to calling the API)

Sign an HS256 JWT with your **launch secret** and redirect to `/launch?jwt=…`. Required claims: `iss` (tenant id), `sub` (your user id), `test`, `jti` (unique per invite; replays reuse the same session), `exp` (max 24 h ahead). Optional: `name`, `email`, `return_url`.

```js
res.redirect(proctor.launchUrl({ sub: user.id, name: user.name, test: 'test_abc' }));
```

## 2. Employers / instructors create tests on your site

Never give browsers your API key. Instead mint a **short-lived builder token** for the logged-in user. It only sees and edits tests owned by that `owner_ref`.

```js
app.post('/builder-link', requireLogin, async (req, res) => {
  const b = await proctor.createBuilderToken(req.user.id /* owner_ref */, 30 /* minutes */);
  res.json({ url: b.url });
});
```

```html
<div id="builder" style="height:720px"></div>
<script>
  const { url } = await (await fetch('/builder-link', { method: 'POST' })).json();
  Proctor.builder({ url, container: '#builder',
    onTestCreated: (m) => fetch('/my-tests', { method: 'POST', body: JSON.stringify({ test_id: m.test_id }) }) });
</script>
```

The builder shows that owner's tests, a form-based test editor (multiple choice, short answer, essay, code; random question pools; proctoring options), invites, results, manual grading and review. Tests are immutable once created, so "edit" means Duplicate, change and create a new one.

You can also create tests entirely from your backend: `proctor.createTest({ ..., owner_ref: user.id })` and list them with `proctor.listTests(user.id)`.

## 3. Getting results

**Webhook** (recommended): `attempt.completed`, `attempt.graded` (after manual grading), `attempt.reviewed`. Respond 2xx. Failed deliveries are retried for about 12 hours (exponential backoff) and survive restarts. A delivery can arrive more than once; de-duplicate on `delivery_id`.

```js
// Express: you MUST verify against the raw body
app.post('/hooks/proctor', express.raw({ type: 'application/json' }), (req, res) => {
  if (!proctor.verifyWebhook(req.body, req.headers['x-proctor-signature'])) return res.sendStatus(400);
  const e = JSON.parse(req.body);
  // e.event, e.attempt_id, e.candidate_ref, e.owner_ref, e.score, e.max_score, e.percent,
  // e.pending_manual, e.risk_level ('low'|'medium'|'high'), e.review_decision
  res.sendStatus(200);
});
```

Signature header: `X-Proctor-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC_SHA256(webhook_secret, t + "." + rawBody)`. Reject if `t` is more than 5 minutes old.

**Not using Node?** Same thing in PHP and Python:

```php
$raw = file_get_contents('php://input');
parse_str(str_replace(',', '&', $_SERVER['HTTP_X_PROCTOR_SIGNATURE']), $p);
$ok = abs(time() - (int)$p['t']) < 300
   && hash_equals(hash_hmac('sha256', $p['t'] . '.' . $raw, $WEBHOOK_SECRET), $p['v1']);
```

```python
import hmac, hashlib, time
def verify(raw: bytes, header: str, secret: str) -> bool:
    p = dict(x.split("=", 1) for x in header.split(","))
    if abs(time.time() - int(p["t"])) > 300: return False
    mac = hmac.new(secret.encode(), f"{p['t']}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, p["v1"])
```

**Polling**: `GET /api/v1/attempts?candidate_ref=…` and `GET /api/v1/attempts/:id` (see `docs/API.md`). Every endpoint is plain JSON over HTTPS with a bearer token, so any language works.

## What your site decides

The proctor service records evidence and a risk level; **your policy decides what happens**. A sensible default: `risk_level: low` auto-passes the proctoring check, `medium` and `high` go to a human reviewer (the dashboard, or your own screen using the API), and nothing is auto-failed on the risk score alone.

Other tools: extend a candidate's time (`extendAttempt`) when they have connection trouble; revoke an unused invite (`revokeSession`); erase a person's data on request (`eraseCandidate`).
