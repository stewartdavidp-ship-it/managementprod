#!/bin/bash
# Migrate compiled skill constants to Firebase RTDB.
# Idempotent — overwrites existing skills with version bump.
#
# Usage:
#   bash migrate-skills.sh          # Run against TEST (default)
#   bash migrate-skills.sh --prod   # Run against PRODUCTION
#   bash migrate-skills.sh --dry    # Preview what would be migrated

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
echo "  CC Skill Migration — Compiled Constants → Firebase"
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

is_error() {
  echo "$1" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('true' if d.get('result',{}).get('isError') else 'false')
except:
    print('true')
"
}

# Step 1: Get current skill list from server
echo "── Step 1: Reading current skills from server ──"
RAW=$(call_tool "skill" '{"action":"list"}')
TEXT=$(get_text "$RAW")
CURRENT_COUNT=$(echo "$TEXT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('count', 0))")
SOURCE=$(echo "$TEXT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('source', 'unknown'))")
echo "  Current skills: $CURRENT_COUNT (source: $SOURCE)"

# Step 2: For each skill, get its content via skill(get) and write via skill(update)
# Since the cache is loaded from compiled constants on first deploy (before migration),
# we can use skill(get) to read each skill's compiled content and then
# skill(update) to write it to Firebase (which write-through updates the cache).

# Get list of skill names
SKILL_NAMES=$(echo "$TEXT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for s in d.get('skills', []):
    print(s['name'])
")

MIGRATED=0
FAILED=0
SKIPPED=0

echo ""
echo "── Step 2: Migrating skills to Firebase ──"

for SKILL_NAME in $SKILL_NAMES; do
  if [ "$DRY_RUN" = true ]; then
    echo "  [dry] Would migrate: $SKILL_NAME"
    MIGRATED=$((MIGRATED + 1))
    continue
  fi

  # Get full skill content
  RAW=$(call_tool "skill" "{\"action\":\"get\",\"skillName\":\"$SKILL_NAME\"}")
  CONTENT=$(get_text "$RAW")

  if [ -z "$CONTENT" ]; then
    echo "  ❌ $SKILL_NAME — empty content, skipping"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Get metadata from the list
  SKILL_DESC=$(echo "$TEXT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for s in d.get('skills', []):
    if s['name'] == '$SKILL_NAME':
        print(s.get('description', ''))
        break
")
  SKILL_CAT=$(echo "$TEXT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for s in d.get('skills', []):
    if s['name'] == '$SKILL_NAME':
        print(s.get('category', 'custom'))
        break
")

  # Escape content for JSON
  ESCAPED_CONTENT=$(python3 -c "
import json,sys
content = sys.stdin.read()
print(json.dumps(content))
" <<< "$CONTENT")

  ESCAPED_DESC=$(python3 -c "
import json,sys
print(json.dumps(sys.stdin.read().strip()))
" <<< "$SKILL_DESC")

  # Use skill(update) to write to Firebase (write-through)
  UPDATE_ARGS="{\"action\":\"update\",\"skillName\":\"$SKILL_NAME\",\"description\":$ESCAPED_DESC,\"content\":$ESCAPED_CONTENT,\"category\":\"$SKILL_CAT\",\"initiator\":\"claude-code\"}"

  RAW=$(call_tool "skill" "$UPDATE_ARGS")
  ERR=$(is_error "$RAW")

  if [ "$ERR" = "true" ]; then
    echo "  ❌ $SKILL_NAME — update failed"
    FAILED=$((FAILED + 1))
  else
    VERSION=$(echo "$(get_text "$RAW")" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('version', '?'))")
    echo "  ✅ $SKILL_NAME (v$VERSION, $SKILL_CAT)"
    MIGRATED=$((MIGRATED + 1))
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Migration complete"
echo "  Migrated: $MIGRATED"
echo "  Failed: $FAILED"
echo "  Skipped: $SKIPPED"
echo "═══════════════════════════════════════════════════════════"

# Step 3: Verify by re-reading skill list
if [ "$DRY_RUN" = false ]; then
  echo ""
  echo "── Step 3: Verification ──"
  RAW=$(call_tool "skill" '{"action":"list"}')
  TEXT=$(get_text "$RAW")
  FINAL_COUNT=$(echo "$TEXT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('count', 0))")
  FINAL_SOURCE=$(echo "$TEXT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('source', 'unknown'))")
  echo "  Final skills: $FINAL_COUNT (source: $FINAL_SOURCE)"

  if [ "$FINAL_COUNT" -eq "$CURRENT_COUNT" ]; then
    echo "  ✅ Skill count matches — migration verified"
  else
    echo "  ⚠️  Skill count mismatch: expected $CURRENT_COUNT, got $FINAL_COUNT"
  fi
fi
