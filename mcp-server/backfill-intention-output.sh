#!/bin/bash
# Backfill intention + primaryOutput for all 29 CC ideas
# Usage: bash backfill-intention-output.sh [--prod]

ENDPOINT="https://cc-mcp-server-test-300155036194.us-central1.run.app/mcp"
if [ "$1" = "--prod" ]; then
  ENDPOINT="https://cc-mcp-server-300155036194.us-central1.run.app/mcp"
  echo "⚠️  Running against PROD"
fi

AUTH="Bearer cc_oUt4ba0dYVRBfPREqoJ1yIsJKjr1_wxityxnkh8pqw1vu7ztmp"
echo "Endpoint: $ENDPOINT"

SUCCESS=0
FAIL=0

update_idea() {
  local ID="$1"
  local INTENTION="$2"
  local PRIMARY_OUTPUT="$3"
  local NAME="$4"

  RESPONSE=$(curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: $AUTH" \
    --max-time 30 \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"idea\",\"arguments\":{\"action\":\"update\",\"ideaId\":\"$ID\",\"intention\":\"$INTENTION\",\"primaryOutput\":\"$PRIMARY_OUTPUT\",\"initiator\":\"claude-code\"}}}")

  # SSE response: look for "intention" in data: line
  if echo "$RESPONSE" | grep -q "\"intention\":"; then
    echo "✅ $NAME: intention=$INTENTION, primaryOutput=$PRIMARY_OUTPUT"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "❌ $NAME: FAILED — $RESPONSE"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Updating 29 ideas sequentially..."
echo ""

# intention=fix (2)
update_idea "-OmKWU6WU-NIwLO86UJL" "fix" "code" "Job Concurrency #63"
update_idea "-OliU4NB8qFk3T8YRWp2" "fix" "code" "CC Maintenance Backlog #45"

# intention=add (12)
update_idea "-OlMeQUtqNbbNYnHknuI" "add" "code" "Test Infrastructure #8"
update_idea "-OlO6yEDlG9FFkjXgAxl" "add" "code" "Session Tab #15"
update_idea "-OlWFzqWcwuCqAMLW_fE" "add" "code" "Nav Redesign #17"
update_idea "-OlWSHTS3obSDSQB37TX" "add" "code" "Spec Quality #18"
update_idea "-OlhBOdYNbvD1cK9-kRP" "add" "code" "Doc Queue #25"
update_idea "-OlNkLYzkzDW4I8q7jJI" "add" "code" "Defined Skills #14"
update_idea "-OlgS8zXShFNqpAe0TgF" "add" "code" "Session SM #22"
update_idea "-OliGKclAoGIYTtq228y" "add" "code" "Cold Start #37"
update_idea "-OmKPkoThhMPZfdqZbXH" "add" "code" "Budget Tracking #62"
update_idea "-OmFr-bhux6vo7ElFPDE" "add" "code" "Messaging #59"
update_idea "-Om80t3CUTqL1m1oaq_d" "add" "code" "KT Ingestion #55"
update_idea "-OlwlFNxqh3BN7HcQnTF" "add" "code" "Agent Teams #49"

# intention=new, primaryOutput=code (9)
update_idea "-OlMeQZp-TxQ-_fDhL2I" "new" "code" "Ideation Platform #10"
update_idea "-OlMeQbDnYUrnze32KAp" "new" "code" "Arch Rules #11"
update_idea "-OlhJSPEAiBls30hzaV-" "new" "code" "Job Work Order #32"
update_idea "-Om0rNGna4E6Fz6tuEkP" "new" "code" "Doc Storage #50"
update_idea "-Om5Lk_A0AoEzTi0FPSc" "new" "code" "Evidence Engine #52"
update_idea "-OlgPRn2c0hpQBpUjFZO" "new" "code" "Platform Arch #21"
update_idea "-OlMeQIflB-qnd1NBZNU" "new" "code" "Ingestion Pipeline #4"
update_idea "-Om82ULsd6kWzU9LCtJO" "new" "code" "Model-Aware #56"
update_idea "-Om12TBKaLQU8cBPzy3F" "new" "code" "Keyword Intel #51"

# Non-code outputs
update_idea "-OmKES-Um5VtRKeGMpsD" "new" "analysis" "Alignment Signals #60"
update_idea "-OlvtiHrgNrkECxrdxWy" "new" "analysis" "Claude Ecosystem #48"
update_idea "-OmCojYj55dQ-cGSQBR0" "new" "presentation" "Marketing Deck #58"
update_idea "-OllTNR_cGE49oqiFsBe" "new" "presentation" "Brand Identity #46"
update_idea "-OmKMHNzp5dgvLnk7UT0" "new" "document" "SOC 2 #61"
update_idea "-Olob_S1mA96Ak2x9TiN" "new" "document" "Retro Journal #47"

echo ""
echo "Done! $SUCCESS succeeded, $FAIL failed out of 29."
