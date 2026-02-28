#!/bin/bash
# Seed signal registry definitions into Firebase RTDB.
# Idempotent — overwrites existing signal definitions.
#
# Usage:
#   bash migrate-signals.sh          # Run against TEST (default)
#   bash migrate-signals.sh --prod   # Run against PRODUCTION
#   bash migrate-signals.sh --dry    # Preview what would be seeded

set -e

# ── Environment Selection ─────────────────────────────────────
ENV="test"
DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --prod) ENV="prod" ;;
    --dry) DRY_RUN=true ;;
  esac
done

if [ "$ENV" = "prod" ]; then
  URL="https://cc-mcp-server-300155036194.us-central1.run.app/mcp"
else
  URL="https://cc-mcp-server-test-300155036194.us-central1.run.app/mcp"
fi
AUTH="Authorization: Bearer cc_oUt4ba0dYVRBfPREqoJ1yIsJKjr1_wxityxnkh8pqw1vu7ztmp"

echo "═══════════════════════════════════════════════════════════"
echo "  CC Signal Registry Migration — Seed Definitions"
echo "  Environment: $ENV"
echo "  Dry run: $DRY_RUN"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Helper: call MCP tool
call_tool() {
  local tool="$1"
  local args="$2"
  curl -s -X POST "$URL" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
    2>/dev/null | grep "^data:" | sed 's/^data: //' || true
}

get_text() {
  echo "$1" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('result',{}).get('content',[{}])[0].get('text',''))
except:
    print('')
"
}

# Signal definitions — the registry entries
# Each signal has: name, description, surfaces, computation (human-readable), action (what client should do)
SIGNALS='[
  {
    "name": "instructions-dirty",
    "description": "Project instructions have been updated and need to be refreshed",
    "surfaces": ["claude-chat", "claude-code", "claude-cowork", "claude-chrome", "claude-powerpoint", "claude-excel"],
    "computation": "profile.projectInstructionsDirty === true",
    "action": "Notify user that project instructions have been updated. Load latest instructions."
  },
  {
    "name": "show-tutorial",
    "description": "User should see the onboarding tutorial",
    "surfaces": ["claude-chat"],
    "computation": "profile.showTutorial === true",
    "action": "Show onboarding tutorial flow. Call session(profile, clearShowTutorial=true) when dismissed."
  },
  {
    "name": "needs-attention",
    "description": "Items in attention queue need user review",
    "surfaces": ["claude-chat"],
    "computation": "profile.needsAttention === true",
    "action": "Check attention queue and surface items for user review."
  },
  {
    "name": "jobs-in-review",
    "description": "Jobs are in review status and need attention",
    "surfaces": ["claude-chat", "claude-code"],
    "computation": "Any job with status=review exists for the current app",
    "action": "List jobs in review. Chat: review and approve/revise. Code: check for review feedback."
  },
  {
    "name": "jobs-in-draft",
    "description": "Draft jobs are available to claim",
    "surfaces": ["claude-code"],
    "computation": "Any job with status=draft exists",
    "action": "List draft jobs. Offer to claim and start building."
  },
  {
    "name": "pending-messages",
    "description": "Unread messages waiting for this surface",
    "surfaces": ["claude-chat", "claude-code", "claude-cowork", "claude-chrome", "claude-powerpoint", "claude-excel"],
    "computation": "Pending messages exist where to=this surface",
    "action": "Call document(receive) to read and process pending messages."
  },
  {
    "name": "session-enrich",
    "description": "Session was auto-created and needs enrichment",
    "surfaces": ["claude-chat", "claude-code", "claude-cowork", "claude-chrome", "claude-powerpoint", "claude-excel"],
    "computation": "session.autoCreated === true",
    "action": "Update session with meaningful title, goal, and app/idea context."
  },
  {
    "name": "session-mismatch",
    "description": "Session app/idea context does not match current tool call context",
    "surfaces": ["claude-chat", "claude-code", "claude-cowork", "claude-chrome", "claude-powerpoint", "claude-excel"],
    "computation": "session.mismatch === true (app/idea mismatch detected)",
    "action": "Session context is stale. Consider starting a new session for the current work."
  },
  {
    "name": "session-stale-closed",
    "description": "Previous session was closed due to staleness",
    "surfaces": ["claude-chat", "claude-code", "claude-cowork", "claude-chrome", "claude-powerpoint", "claude-excel"],
    "computation": "session.staleClosed === true",
    "action": "Previous session was auto-closed. A new session has been created. Review closing summary if available."
  },
  {
    "name": "bootstrap-required",
    "description": "Surface needs to bootstrap — no initiator detected or cold start",
    "surfaces": ["claude-chat", "claude-code", "claude-cowork", "claude-chrome", "claude-powerpoint", "claude-excel"],
    "computation": "No initiator parameter on request OR server detects cold surface",
    "action": "Call session(bootstrap) to get orientation, active context, and signal definitions."
  }
]'

SEEDED=0
FAILED=0

echo "── Seeding signal definitions ──"

# Write each signal definition directly to Firebase via a simple session profile update pattern.
# Since we don't have a signal CRUD tool yet, we use the MCP HTTP API to write directly.
# We'll use a custom approach: write via the session tool's profile action to set a marker,
# then use direct Firebase writes.

# Actually, the simplest approach: use curl to call a generic tool that can write,
# or use the Firebase REST API directly. Since migrate-skills.sh uses the skill tool,
# but we don't have a signal tool, let's write directly to Firebase REST API.

# Firebase REST API for signal registry
FIREBASE_DB="https://word-boxing-default-rtdb.firebaseio.com"
# We need a service account token. Let's use the MCP server's auth to validate,
# then write via the MCP HTTP endpoint with a custom tool call.

# Simpler approach: use a Node.js one-liner with firebase-admin
# Or even simpler: use the Firebase REST API with the CC API key pattern.

# Simplest approach: Write a tiny Node script that uses firebase-admin
echo "$SIGNALS" | python3 -c "
import json, sys, subprocess

signals = json.load(sys.stdin)
dry_run = '$DRY_RUN' == 'true'
env = '$ENV'

for sig in signals:
    name = sig['name']
    if dry_run:
        print(f'  [dry] Would seed: {name}')
        continue

    # Use the Firebase REST API with auth token
    # We'll construct the URL and use PUT to write each signal
    db_url = 'https://word-boxing-default-rtdb.firebaseio.com'
    uid = 'oUt4ba0dYVRBfPREqoJ1yIsJKjr1'
    path = f'command-center/{uid}/signals/{name}.json'
    url = f'{db_url}/{path}'

    # Firebase REST API needs an auth token. Let's use a service account.
    # For simplicity in migration, we use the gcloud auth token.
    import urllib.request
    import os

    # Get access token via gcloud
    try:
        token = subprocess.check_output(
            ['gcloud', 'auth', 'print-access-token'],
            stderr=subprocess.DEVNULL
        ).decode().strip()
    except:
        print(f'  ❌ Failed to get gcloud auth token. Run: gcloud auth login')
        sys.exit(1)

    data = json.dumps(sig).encode()
    req = urllib.request.Request(
        f'{url}?access_token={token}',
        data=data,
        method='PUT',
        headers={'Content-Type': 'application/json'}
    )
    try:
        urllib.request.urlopen(req)
        print(f'  ✅ {name} — seeded ({len(sig[\"surfaces\"])} surfaces)')
    except Exception as e:
        print(f'  ❌ {name} — failed: {e}')
"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Migration complete"
echo "═══════════════════════════════════════════════════════════"

# Verify by checking signals appear in a tool response
if [ "$DRY_RUN" = false ]; then
  echo ""
  echo "── Verification: checking _signals in tool response ──"
  RAW=$(call_tool "session" '{"action":"profile","initiator":"claude-code"}')
  echo "$RAW" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    contents = d.get('result', {}).get('content', [])
    for c in contents:
        text = c.get('text', '')
        try:
            meta = json.loads(text)
            signals = meta.get('_signals', [])
            if signals:
                print(f'  ✅ _signals present in response: {signals}')
            elif '_signals' not in meta:
                # Check if this is the metadata block (has _responseSize)
                if '_responseSize' in meta:
                    print(f'  ℹ️  No active signals for claude-code (expected if no flags set)')
        except:
            pass
except Exception as e:
    print(f'  ⚠️  Could not parse response: {e}')
"
fi
