# API reference

Base URL: your deployment, e.g. `https://exams.example.com`. JSON in, JSON out.
Auth: `Authorization: Bearer <tenant API key>` (full access) or `Bearer bt_…` (builder token, scoped to one `owner_ref`).
Tenant creation uses `X-Admin-Key`. Errors: `{ "error": "message" }` with a normal HTTP status (400 validation, 401 auth, 403 wrong key type, 404 not found or not yours, 409 wrong state, 410 expired/cancelled, 429 rate limited).

"Full only" means a builder token gets 403.

## Tenants (super-admin, header `X-Admin-Key`)
| | |
|---|---|
| `POST /api/v1/tenants` | `{ name, webhook_url?, allowed_origins? }` → `{ tenant_id, api_key, launch_secret, webhook_secret }`. Secrets are shown once. |
| `GET /api/v1/tenants` | List tenants (no secrets). |

## Your tenant
| | |
|---|---|
| `GET /api/v1/me` | Tenant info and scope (`tenant` or `builder`). |
| `PATCH /api/v1/me` | Full only. `{ webhook_url?, allowed_origins? }`; omitted fields are unchanged. |
| `POST /api/v1/me/rotate` | Full only. `{ what: "api_key" \| "launch_secret" \| "webhook_secret" }` → new value, shown once. The old one stops working immediately. |
| `POST /api/v1/builder-tokens` | Full only. `{ owner_ref, ttl_minutes?=30 (max 480) }` → `{ token, url, expires_at }`. |
| `GET /api/v1/audit` | Full only. Last 300 admin actions. |

## Tests
| | |
|---|---|
| `POST /api/v1/tests` | `{ title, duration_min, instructions?, pick?, owner_ref?, settings?, questions[] }` → `{ test_id }`. With a builder token `owner_ref` is forced to the token's owner. |
| `GET /api/v1/tests` | Optional `?owner_ref=` (full key). |
| `GET /api/v1/tests/:id` | Includes questions with answers (never sent to candidates). |
| `DELETE /api/v1/tests/:id` | Archives (hidden, no new invites, results kept). |

Question: `{ id?, type: "mcq"\|"short"\|"text"\|"code", prompt, points?=1, options[], answer (index), accepted[] }`.
`mcq` and `short` are auto-graded, `text` and `code` wait for manual grading.
Settings: `snapshot_interval_sec` (5–120), `require_camera`, `require_fullscreen`, `block_clipboard`, `shuffle_questions`, `show_result`.

## Invites
| | |
|---|---|
| `POST /api/v1/sessions` | `{ test_id, candidate_ref?, candidate_name?, candidate_email?, return_url?, ttl_minutes? }`, optional header `Idempotency-Key`. → `{ id, token, url, expires_at }`. |
| `GET /api/v1/sessions` | Latest 200 with status `not_started \| in_progress \| submitted \| expired \| revoked`. |
| `POST /api/v1/sessions/:id/revoke` | Only before the candidate started. |
| `GET /launch?jwt=…` | Signed redirect launch (see INTEGRATION.md). |

## Attempts and results
| | |
|---|---|
| `GET /api/v1/attempts` | Filters: `test_id`, `status`, `candidate_ref`, `owner_ref` (full key), `limit`, `offset`. |
| `GET /api/v1/attempts/:id` | Answers with grading, events, snapshot list, risk breakdown. |
| `GET /api/v1/attempts/:id/snapshots/:file` | JPEG (auth header required; keys in URLs are rejected). |
| `POST /api/v1/attempts/:id/grade` | `{ question_id, points }` for `text`/`code` questions. |
| `POST /api/v1/attempts/:id/review` | `{ decision: "approved"\|"rejected"\|"invalidated"\|null, note? }` |
| `POST /api/v1/attempts/:id/extend` | `{ minutes: 1..120 }` while in progress. |
| `POST /api/v1/attempts/:id/webhook/resend` | `{ event? }` queue the webhook again. |
| `DELETE /api/v1/attempts/:id` | Erase the attempt, answers, events, snapshot files and invite. |
| `DELETE /api/v1/candidates/:ref` | Erase everything for a `candidate_ref`. |

## Webhooks
Events: `attempt.completed`, `attempt.graded`, `attempt.reviewed`. Headers: `X-Proctor-Event`, `X-Proctor-Delivery`, `X-Proctor-Signature`.
Body: `delivery_id, occurred_at, event, attempt_id, test_id, owner_ref, candidate_ref, candidate_name, candidate_email, status, started_at, submitted_at, score, max_score, percent, pending_manual, risk_score, risk_level, review_decision, review_note`.
Webhook URLs must be https in production and must not point at private or internal addresses.

## Risk signals
Each signal contributes `count × weight`, capped at 30 per signal; total capped at 100. `low < 20 ≤ medium < 50 ≤ high`.

| Signal | Weight | Source |
|---|---|---|
| `tab_hidden` 5, `window_blur` 2, `fullscreen_exit` 8 | | browser |
| `copy_attempt` 2, `cut_attempt` 2, `paste_attempt` 3, `contextmenu_attempt` 1, `key_shortcut` 1, `print_attempt` 3 | | browser |
| `no_face` 4, `multiple_faces` 10 | | browser FaceDetector (Chromium) |
| `camera_denied` 20, `camera_lost` 15 | | browser |
| `connection_gap` 4 | | server heartbeat |
| `snapshot_gap` 15 | | **server**: far fewer snapshots than expected |
| `ip_changed` 6 | | **server**: network address changed when resuming |

Tune the weights in `RISK_WEIGHTS` in `server.js` once you have real data.
