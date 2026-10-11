---
name: arcade-api-test-drive
description: "Use whenever someone wants to try, test, hack on, or build against Arcade's public API, mentions ARCADE_API_KEY, platform.arcade.ai, or an Arcade API key, or wants to report an Arcade API issue or give API feedback. Walks the agent through getting a key, calling the API safely, exercising the main flow, and filing a structured report."
metadata:
  author: arcade
  version: '1.0'
---

# Arcade API test drive

Use this skill to get a working key, exercise the Arcade public API end to end, and report what went wrong or felt awkward. It covers procedure, not reference: for endpoint parameters and workflows, use the `arcade-api` skill installed alongside this one.

## Scope

| Item            | Value                                                      |
| --------------- | ---------------------------------------------------------- |
| Base URL        | `https://platform.arcade.ai/v1`                            |
| Keys            | `https://studio.arcade.ai/settings/api-keys`               |
| Docs index      | `https://docs.arcade.ai/llms.txt`                          |
| OpenAPI spec    | `https://platform.arcade.ai/v1/spec.json`                  |
| Reference skill | `arcade-api`, from `npx skills add https://docs.arcade.ai` |

Every call runs against the human's real Arcade account. Generations, products and checkouts it creates are real. Reads such as `models/list` change nothing; get the human's go-ahead before any call that creates something (see [Exercise the API](#exercise-the-api)).

Every request is a `POST` with a JSON body, reads included. A read with no parameters sends `{}`.

## Get a key

1. Check whether `ARCADE_API_KEY` is set in the environment. Test only whether it is set and what it starts with; do not print it.
2. A key starts with `arcade_sk_live_`. Any other key gets `401` here, so ask the human for a key from the page below instead.
3. If no key is set, ask the human to:
   - open https://studio.arcade.ai/settings/api-keys (**Settings**, then **API keys**),
   - create a key named after the agent, for example `claude-code hackathon`,
   - copy it right away, because Studio shows it only once,
   - run `export ARCADE_API_KEY=...` in the shell the agent uses, or add it to a gitignored `.env` file and load it with `set -a; . ./.env; set +a`. Never `cat` the `.env` file.

A key has its owner's full account access. Keys expire after 90 days by default, and each user can have at most 10 active keys.

If you have browser control and the human explicitly asks you to create the key, you may drive that page, but only when the human is already logged in to Studio. Do not log in on their behalf.

Key rules:

- Never print, echo, log, or commit the key.
- Send it only to `platform.arcade.ai`.
- Never paste it into a report, an issue, or a chat message.

## Client rules

| Rule          | Detail                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization | `Authorization: Bearer $ARCADE_API_KEY`                                                                                                                                                                                                                                                                                |
| Content type  | `Content-Type: application/json`                                                                                                                                                                                                                                                                                       |
| User-Agent    | Required: `User-Agent: <agent-name>/<version> (<your email>)`. The Cloudflare edge returns a non-JSON `403` for a missing User-Agent or a library default such as `Python-urllib`.                                                                                                                                     |
| Rate limit    | The edge rate-limits each source IP and answers `429` when you exceed it. Poll jobs every 2 to 5 seconds. Never run load tests.                                                                                                                                                                                        |
| `requestId`   | 1 to 128 characters, chosen by you, unique per distinct request. Reuse one only to retry an unchanged request.                                                                                                                                                                                                         |
| Retries       | Retry `5xx` and `429` with the same `requestId`; after a `429`, wait `Retry-After` seconds. Retry a `409` unchanged after a short delay while the original is still starting. Fix the body before retrying any other `4xx`. A `checkouts/create` retry after an abandoned request can leave one extra unpaid checkout. |
| Image URLs    | Image URLs in responses expire. Fetch the resource again to get fresh ones.                                                                                                                                                                                                                                            |

## Helper

Write this file to `./arcade-api.sh`, then `source ./arcade-api.sh` in the shell you use for requests. It needs `curl` and `jq`; install them first if they are missing. Before the first call, add `.arcade-api/` to `.gitignore`, because the helper logs every request and response there.

Set `ARCADE_USER_AGENT` to name yourself and the human, for example `export ARCADE_USER_AGENT="claude-code/1.0 (you@arcade.ai)"`. The default is `arcade-api-test-drive/1.0`.

Do not enable `set -x` (xtrace) while the helper runs; it would print the key.

```bash
# arcade-api.sh: source this file. Requires curl and jq.
ARCADE_API_BASE="https://platform.arcade.ai/v1"
ARCADE_USER_AGENT="${ARCADE_USER_AGENT:-arcade-api-test-drive/1.0}"

# arcade_v1 <procedure> [json-body]: POST, print the body, log to .arcade-api/log/.
arcade_v1() {
  local procedure="$1" body="${2:-}" tmp hdr meta http_status seconds stamp log n=1
  [ -n "$body" ] || body='{}'
  [ -n "${ARCADE_API_KEY:-}" ] || { echo "arcade_v1: ARCADE_API_KEY is not set" >&2; return 2; }
  case "$ARCADE_API_KEY" in arcade_sk_live_*) ;; *)
    echo "arcade_v1: that is not an Arcade API key from studio.arcade.ai" >&2; return 2 ;;
  esac
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$body" ||
    { echo "arcade_v1: body must be a JSON object" >&2; return 2; }
  tmp="$(mktemp)" hdr="$(mktemp)"
  # The key goes to curl on stdin, so it never appears in argv or the log.
  meta="$(printf 'Authorization: Bearer %s\n' "$ARCADE_API_KEY" |
    curl --silent --show-error -X POST "$ARCADE_API_BASE/$procedure" \
      -H @- -H "Content-Type: application/json" -H "User-Agent: $ARCADE_USER_AGENT" \
      --data-binary "$body" -D "$hdr" -o "$tmp" -w '%{http_code} %{time_total}')"
  http_status="${meta%% *}" seconds="${meta##* }"
  ARCADE_LAST_STATUS="$http_status"
  ARCADE_LAST_RETRY_AFTER="$(awk -F': *' 'tolower($1) == "retry-after" {v = $2} END {print v}' "$hdr" | tr -d '\r')"
  mkdir -p .arcade-api/log
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  log=".arcade-api/log/$stamp-${procedure//\//-}.json"
  while [ -e "$log" ]; do log=".arcade-api/log/$stamp-${procedure//\//-}-$n.json"; n=$((n + 1)); done
  jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg procedure "$procedure" \
    --argjson body "$body" --arg ua "$ARCADE_USER_AGENT" --arg status "$http_status" \
    --arg seconds "${seconds:-0}" --rawfile response "$tmp" \
    'def redact: walk(
       if type == "string" and startswith("http") and contains("?") then split("?")[0]
       elif type == "object" and ($procedure | startswith("orders/")) then with_entries(
         if .key | IN("shippingAddress", "name", "email", "phone", "firstName", "lastName",
           "customer", "makerName", "number", "url") then .value = "[redacted]" else . end)
       else . end);
     {ts: $ts, procedure: $procedure}
     + (if $body.requestId then {requestId: $body.requestId} else {} end)
     + {request: {body: ($body | redact), userAgent: $ua}, status: ($status | tonumber),
        durationMs: ($seconds | tonumber * 1000 | round),
        response: ((try ($response | fromjson) catch $response) | redact)}' >"$log"
  cat "$tmp"; echo
  rm -f "$tmp" "$hdr"
  case "$http_status" in 2??) return 0 ;; esac
  echo "arcade_v1: $procedure returned HTTP $http_status (log: $log)" >&2
  return 1
}

# arcade_poll <jobId> [interval=3] [timeoutSeconds=600]: wait for a job to finish.
arcade_poll() {
  local job_id="$1" interval="${2:-3}" timeout="${3:-600}" waited=0 delay out job_status=unknown
  [ "$interval" -ge 2 ] || interval=2
  out="$(mktemp)"
  while :; do
    if arcade_v1 jobs/get "$(jq -nc --arg id "$job_id" '{jobId: $id}')" >"$out"; then
      job_status="$(jq -r .status "$out")"
      case "$job_status" in
        succeeded) cat "$out"; rm -f "$out"; return 0 ;;
        failed) cat "$out"; rm -f "$out"; return 1 ;;
      esac
    else
      case "$ARCADE_LAST_STATUS" in 429 | 5??) ;; *) cat "$out"; rm -f "$out"; return 1 ;; esac
    fi
    delay="$interval"
    case "$ARCADE_LAST_STATUS:$ARCADE_LAST_RETRY_AFTER" in
      429:*[!0-9]* | 429:) ;;
      429:*) [ "$ARCADE_LAST_RETRY_AFTER" -le "$interval" ] || delay="$ARCADE_LAST_RETRY_AFTER" ;;
    esac
    if [ "$waited" -ge "$timeout" ]; then
      cat "$out"; rm -f "$out"; echo "arcade_poll: $job_id still $job_status after ${timeout}s" >&2; return 1
    fi
    sleep "$delay"; waited=$((waited + delay))
  done
}
```

| Function                                          | Behavior                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arcade_v1 <procedure> [json-body]`               | Sends the request (body defaults to `{}`), prints the response body, and returns non-zero on a non-2xx status. Writes one record to `.arcade-api/log/` without the key.         |
| `arcade_poll <jobId> [interval] [timeoutSeconds]` | Calls `jobs/get` every `interval` seconds (default 3, minimum 2) until the job is `succeeded` or `failed`. Prints the final job; non-zero on `failed` or timeout (default 600). |

Each log record has `ts`, `procedure`, `requestId` (when the body has one), `request` (`body` and `userAgent`), `status`, `durationMs` and `response`. A non-JSON response is stored as a string. The log is redacted as it is written: every URL in `request.body` and `response` loses its query string, since signed links carry credentials, and for `orders/*` procedures the keys `shippingAddress`, `name`, `email`, `phone`, `firstName`, `lastName`, `customer`, `makerName` and tracking `number` and `url` become `"[redacted]"`. Only the log is redacted; stdout shows the full response. `ARCADE_LAST_STATUS` holds the last HTTP status and `ARCADE_LAST_RETRY_AFTER` the last `Retry-After` header (empty when absent). After a `429`, `arcade_poll` waits the longer of its interval and `Retry-After`.

## Verify the setup

Run `arcade_v1 models/list`. Success is `200` with `{"items": [{"modelId": ..., "name": ...}]}`.

| Result                                 | Meaning and next step                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `401` with JSON `code: "UNAUTHORIZED"` | The key is missing, invalid, expired or revoked. Ask the human for a fresh key.            |
| `403` with a non-JSON body             | The edge rejected the User-Agent. Set `ARCADE_USER_AGENT` to name the agent and a contact. |
| `429`                                  | Slow down. Wait `Retry-After` seconds, then retry.                                         |
| `503`                                  | A temporary outage. Retry with backoff.                                                    |
| DNS or TLS failure                     | The host is wrong. The base URL must be `https://platform.arcade.ai/v1`.                   |

## Exercise the API

These calls create real patterns, products and a checkout in the human's account. Before the first one, tell the human what the path creates and wait for a clear yes. If they only want to report an issue or check their key, stop after [Verify the setup](#verify-the-setup).

Follow this path. Look up each procedure's parameters in the `arcade-api` skill or `spec.json`. Keep every `requestId` so you can quote it in a report.

1. `categories/list`: success is a list of categories with IDs.
2. `patterns/create` with a new `requestId` and a `prompt`: success is a job with `status: "running"`. Generation takes about 1 to 2 minutes.
3. `arcade_poll <jobId>`: success is `status: "succeeded"` and `result.patternId`.
4. `patterns/get` with that `patternId`: success is a pattern with an `imageUrl`. Download or open the image and check that it matches the prompt.
5. `categories/get` with a `print` category's `categoryId` and `selections: {}`. It returns a complete `selections` object with defaults filled in. `canManufacture` describes that returned selection and can already be `true` on the first call. If you want different options, keep only your explicit choices in the request, add one `available: true` value at a time, and call again until the returned selection suits you.
6. When `canManufacture` is `true`, call `products/create` with the `patternId`, `categoryId` and the complete `selections` object from the latest `categories/get` **response**, not the empty or partial object you sent. Pass `fit` if the pattern's aspect ratio does not match the product. Success is a job; poll it, then call `products/get` with `result.productId`.
7. `checkouts/create` with a line for the product: success is a `checkoutId` and a `checkoutUrl`. Give the `checkoutUrl` to the human and tell them that paying places a real, charged order that gets made and shipped. Do not pay, and do not automate payment.
8. `orders/get` with the `checkoutId`: expect `404` until the human pays. That is correct behavior, not an issue.

Optional: make jewelry. Call `patterns/create` with a `prompt` and a `jewelry` category's `categoryId`, poll it until it succeeds, then call `products/get` with `result.productId`.

Optional: guide a pattern with a reference image. Call `references/createUpload` with the image's `mediaType` and `byteLength`, `PUT` the bytes to `uploadUrl` with exactly the returned `requiredHeaders` (use plain `curl`, not `arcade_v1`, since the upload URL is not the API), call `references/create` with the `uploadId`, then pass the `referenceId` in `referenceIds` on `patterns/create`.

Refines (`patterns/refine/*`) each return a new job and create a new pattern, and never modify the source pattern, with two exceptions. `patterns/refine/recolorClusters` is synchronous: it returns `{clusters: [{clusterId, color}]}` directly, with no job and no new pattern. `patterns/refine/upscale` is rejected by the public API with `403`; a `download` job (from an upscale started in Studio) has a `result` of `{downloadUrl, expiresAt}` rather than a `patternId`. Refines work only on print patterns; a jewelry design returns `400`.

A job can succeed with `result: null`, for example a `fixDeformity` that found nothing to repair. Treat that as success.

## What counts as an issue

Report any of these:

- Any `5xx` response.
- A `4xx` the docs did not predict for a request you believe is valid.
- A `422` whose `fieldErrors` do not identify the field at fault.
- An error message that does not say what to do next.
- A job still `running` after 10 minutes, or `failed` with an unhelpful message.
- A response shape that differs from `spec.json`.
- A documented example that does not work as written.
- Anything that took more than two attempts to get right. That is feedback even when nothing was broken.
- Naming that confused you or the human.

## Report an issue

Write one report per issue: a short markdown summary followed by a JSON payload. The payload is the body of `POST /v1/feedback/create`, which forwards it to the Arcade team.

```json
{
  "requestId": "<new unique id for the report>",
  "text": "<what you expected, what happened, what you tried>",
  "procedure": "patterns/create",
  "request": { "body": {}, "userAgent": "claude-code/1.0 (you@arcade.ai)" },
  "response": { "status": 500, "body": {}, "durationMs": 1234 },
  "agent": "<claude-code|codex|cursor|...>",
  "reportedAt": "<ISO-8601 UTC>"
}
```

Build `request` and `response` from the matching records in `.arcade-api/log/`, so the request and response are exact rather than recalled. The log is already redacted, so a report built from it carries no signed URLs or order PII. The log record's `request` is already in this shape; its top-level `status`, `durationMs` and `response` become `response.status`, `response.durationMs` and `response.body`.

Redaction rules, for anything you add that did not come from the log:

- Never include the `Authorization` header or the key.
- Remove email addresses other than the reporter's.
- Keep the host and path of URL fields (`uploadUrl`, `imageUrl`, `thumbnailUrl`, `downloadUrl`, `checkoutUrl`) but drop the query string, because they are signed links.
- Keep request bodies otherwise verbatim, including prompts and IDs.

Delivery:

1. Save the payload to a file such as `report.json`, then send it with `arcade_v1 feedback/create "$(jq -c . report.json)"`. Success is `200` with the report's `requestId`; quote it to the human.
2. Retry a `5xx` or `429` as the [client rules](#client-rules) say, with the same `requestId`. A retry after an error may deliver the report twice.
3. If the call still fails, or returns any other non-2xx, write the report to `.arcade-api/feedback/<UTC-timestamp>.md` (the markdown summary plus the JSON block), print the path, and ask the human to send it to their Arcade contact.

## Don'ts

- Do not send the key or any API request to a host other than `platform.arcade.ai`. Signed URLs the API returns, such as `imageUrl` and `uploadUrl`, may be on other hosts; use them as returned, without the key.
- Do not share, print, or commit the key.
- Do not load-test or probe the rate limit.
- Do not pay for a checkout or automate payment.
- Do not poll faster than every 2 seconds.
- Do not run more than one generation at a time unless the human asks.
