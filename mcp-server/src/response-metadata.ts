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

import { getContextEstimate, getContextPerSurface, getSurfaceContextEstimate, getCurrentUid, getSessionMeta, getPendingMessages, getSuppressPiggyback, getInitiator, getSignals } from "./context.js";
import { incrementContextEstimate } from "./tools/sessions.js";

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
const ZONE_GREEN_MAX = 312_000;   // < 50%
const ZONE_YELLOW_MAX = 468_000;  // 50-75%
const ZONE_RED_MAX = 562_000;     // 75-90%
// > 90% = imminent
const BASELINE_OVERHEAD = 85_000; // Approximate non-tool context (system prompt, instructions, etc.)

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
 * _contextHealth is included when a session's contextEstimate is available
 * (loaded once per request in index.ts and cached in AsyncLocalStorage).
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

  // Auto-increment context estimate with actual tool content chars.
  // This runs at the tool-result level (not HTTP level), so it counts only
  // what enters the LLM context — not MCP protocol overhead like tools/list,
  // initialize responses, JSON-RPC framing, or SSE framing.
  try {
    const uid = getCurrentUid();
    if (uid && chars > 0) {
      const initiatorForIncrement = getInitiator();
      incrementContextEstimate(uid, chars, initiatorForIncrement || undefined).catch(() => {});
    }
  } catch {
    // No UID in context (shouldn't happen in normal flow)
  }

  const meta: Record<string, any> = { _responseSize: chars };
  if (extraMeta) {
    Object.assign(meta, extraMeta);
  }

  // Include _contextHealth if we have a context estimate for this request
  const contextEstimate = getContextEstimate();
  if (contextEstimate !== undefined) {
    const initiator = getInitiator();
    const perSurface = getContextPerSurface();
    const surfaceContextEstimate = getSurfaceContextEstimate();

    let healthObj: Record<string, any>;

    if (initiator && perSurface && initiator in perSurface) {
      // Surface-aware: zone/used reflect THIS surface's counter
      const surfaceUsed = perSurface[initiator];
      healthObj = {
        zone: computeContextZone(surfaceUsed),
        used: surfaceUsed,
        ceiling: CONTEXT_CEILING,
        global: {
          zone: computeContextZone(contextEstimate),
          used: contextEstimate,
        },
      };
    } else {
      // No initiator or surface not yet tracked — global-only (backward compat)
      healthObj = {
        zone: computeContextZone(contextEstimate),
        used: contextEstimate,
        ceiling: CONTEXT_CEILING,
      };
    }

    // Enrich with surface-reported estimate when provided
    if (surfaceContextEstimate !== undefined) {
      const serverFloor = contextEstimate + BASELINE_OVERHEAD;
      healthObj.surfaceEstimate = surfaceContextEstimate;
      healthObj.estimatedZone = computeContextZone(surfaceContextEstimate);
      healthObj.driftDetected = surfaceContextEstimate < contextEstimate;
      healthObj.serverFloor = serverFloor;
    }

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

  result.content.push({
    type: "text" as const,
    text: JSON.stringify(meta),
  });

  return result;
}
