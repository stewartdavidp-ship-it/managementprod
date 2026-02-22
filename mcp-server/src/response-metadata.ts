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

import { getContextEstimate } from "./context.js";

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

  const meta: Record<string, any> = { _responseSize: chars };
  if (extraMeta) {
    Object.assign(meta, extraMeta);
  }

  // Include _contextHealth if we have a context estimate for this request
  const contextEstimate = getContextEstimate();
  if (contextEstimate !== undefined) {
    meta._contextHealth = {
      zone: computeContextZone(contextEstimate),
      used: contextEstimate,
      ceiling: CONTEXT_CEILING,
    };
  }

  result.content.push({
    type: "text" as const,
    text: JSON.stringify(meta),
  });

  return result;
}
