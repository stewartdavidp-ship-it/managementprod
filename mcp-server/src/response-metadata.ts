// ═══════════════════════════════════════════════════════════════
// Response Metadata — Auto-inject _responseSize and _contextHealth
// into tool responses
// ═══════════════════════════════════════════════════════════════
// Wraps MCP tool responses to include:
//   _responseSize: character count of the response
//   _contextHealth: zone indicator based on session context usage
//
// Usage: call `withResponseSize(result)` before returning from any
// tool handler.
// ═══════════════════════════════════════════════════════════════

import { getServerSentTotal, getInteractionTotal, getTurnDelta, getCurrentUid, getSessionMeta, getPendingMessages, getSuppressPiggyback, getInitiator, isInitiatorExplicit, getSignals, getToolName } from "./context.js";
import { incrementServerSentTotal } from "./tools/sessions.js";

// Tools exempt from turnDelta compliance warning (first-call or setup tools)
const TURNDELTA_EXEMPT_TOOLS = new Set(["session"]);

interface TextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

// Context health thresholds (based on 624K char context window)
const CONTEXT_CEILING = 624_000;
const ZONE_GREEN_MAX = 374_400;   // < 60%
const ZONE_YELLOW_MAX = 468_000;  // 60-75%
const ZONE_RED_MAX = 561_600;     // 75-90%
// > 90% = imminent

function computeContextZone(used: number): string {
  if (used < ZONE_GREEN_MAX) return "green";
  if (used < ZONE_YELLOW_MAX) return "yellow";
  if (used < ZONE_RED_MAX) return "red";
  return "imminent";
}

/**
 * Measure the total character count of all text content blocks in a tool result.
 */
function measureContentChars(content: TextContent[]): number {
  let total = 0;
  for (const block of content) {
    if (block.text) {
      total += block.text.length;
    }
  }
  return total;
}

/**
 * Inject _responseSize and _contextHealth metadata into a tool result's content array.
 * Also injects any additional metadata fields (e.g., _estimatedFullSize, _fileSize).
 *
 * _contextHealth is included when session context tracking is available
 * (serverSentTotal + interactionTotal loaded once per request in index.ts).
 *
 * @param result - The tool result object with a `content` array
 * @param extraMeta - Optional additional metadata fields to include
 * @returns The same result object with metadata appended
 */
export function withResponseSize(
  result: ToolResult,
  extraMeta?: Record<string, number | string | boolean>
): ToolResult {
  const chars = measureContentChars(result.content);

  // Auto-increment serverSentTotal with actual tool content chars.
  // This runs at the tool-result level (not HTTP level), so it counts only
  // what enters the LLM context — not MCP protocol overhead like tools/list,
  // initialize responses, JSON-RPC framing, or SSE framing.
  try {
    const uid = getCurrentUid();
    const surface = getInitiator();
    if (uid && chars > 0) {
      incrementServerSentTotal(uid, chars, surface || undefined).catch(() => {});
    }
  } catch {
    // No UID in context (shouldn't happen in normal flow)
  }

  const meta: Record<string, any> = { _responseSize: chars };
  if (extraMeta) {
    Object.assign(meta, extraMeta);
  }

  // Include _contextHealth if we have context tracking for this request.
  // compactionEstimate = serverSentTotal + interactionTotal
  const serverSentTotal = getServerSentTotal();
  const interactionTotal = getInteractionTotal();
  if (serverSentTotal !== undefined || interactionTotal !== undefined) {
    const sst = (serverSentTotal || 0) + chars; // Include this response's chars
    const it = interactionTotal || 0;
    const compactionEstimate = sst + it;

    const healthObj: Record<string, any> = {
      compactionEstimate,
      serverSentTotal: sst,
      interactionTotal: it,
      ceiling: CONTEXT_CEILING,
      zone: computeContextZone(compactionEstimate),
    };

    meta._contextHealth = healthObj;
  }

  // Include _session metadata if resolved for this request
  const sessionMeta = getSessionMeta();
  if (sessionMeta) {
    const sessionInfo: Record<string, any> = { id: sessionMeta.id };
    if (sessionMeta.autoCreated) sessionInfo.autoCreated = true;
    if (sessionMeta.mismatch) sessionInfo.mismatch = true;
    if (sessionMeta.staleClosed) sessionInfo.staleClosed = sessionMeta.staleClosed;
    if (sessionMeta.existingSession) sessionInfo.existingSession = sessionMeta.existingSession;
    meta._session = sessionInfo;
  }

  // Include _initiator if resolved for this request
  const initiator = getInitiator();
  if (initiator) {
    meta._initiator = initiator;
  }

  // Include _pendingMessages if there are pending messages for any surface.
  // Suppressed for document(receive) to avoid redundant info.
  if (!getSuppressPiggyback()) {
    const pendingMessages = getPendingMessages();
    if (pendingMessages && pendingMessages.count > 0) {
      meta._pendingMessages = pendingMessages;
    }
  }

  // Include _signals if any signal codes are active for this request.
  // Computed once per request in index.ts and cached in AsyncLocalStorage.
  const signals = getSignals();
  if (signals && signals.length > 0) {
    meta._signals = signals;
  }

  // ── turnDelta compliance warning ──
  // If Chat-family surfaces send 0 or missing turnDelta, prepend a warning
  // so it's the first thing the LLM reads in the response.
  // Exempt: session tool (bootstrap/init are first calls, no count yet).
  // Only fires when initiator was EXPLICITLY provided (not inferred from createdBy),
  // to avoid false positives on tools like job(start) with createdBy="claude-chat".
  const tdWarningSurface = getInitiator();
  const tdWarningValue = getTurnDelta();
  const tdWarningTool = getToolName();
  if (
    isInitiatorExplicit() &&
    tdWarningSurface &&
    (tdWarningSurface === "claude-chat" || tdWarningSurface === "claude-cowork") &&
    (tdWarningValue === undefined || tdWarningValue === 0) &&
    tdWarningTool &&
    !TURNDELTA_EXEMPT_TOOLS.has(tdWarningTool)
  ) {
    result.content.unshift({
      type: "text" as const,
      text: "⚠️ CONTEXT TRACKING WARNING: You sent turnDelta=0 (or omitted it). Your bootstrap instructions require you to estimate characters consumed by the user's question + your response and pass that as turnDelta (or contextEstimate) on every MCP tool call. Without this, compaction prediction is blind. Count characters and include the estimate on your next call.",
    });
  }

  result.content.push({
    type: "text" as const,
    text: JSON.stringify(meta),
  });

  return result;
}
