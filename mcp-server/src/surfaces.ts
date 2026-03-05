// ═══════════════════════════════════════════════════════════════
// Surface Registry — Valid agent/user surface identifiers
// ═══════════════════════════════════════════════════════════════
// Single source of truth for all Claude surfaces that can call
// MCP tools, send/receive messages, and create jobs.
// Also exports INITIATOR_PARAM — shared Zod schema fragment
// spread into every tool to identify the calling surface.
// ═══════════════════════════════════════════════════════════════

import { z } from "zod";
import { setInitiator } from "./context.js";
import { isInRegistryCache } from "./surface-registry.js";

export const SURFACES = [
  "claude-code",
  "claude-chat",
  "claude-cowork",
  "claude-chrome",
  "claude-powerpoint",
  "claude-excel",
  "user",
] as const;

export type Surface = (typeof SURFACES)[number];

export const SURFACE_LABELS: Record<Surface, string> = {
  "claude-code": "Claude Code (CLI)",
  "claude-chat": "Claude Chat (claude.ai / desktop)",
  "claude-cowork": "Claude Cowork (desktop agent)",
  "claude-chrome": "Claude in Chrome (browser extension)",
  "claude-powerpoint": "Claude PowerPoint (Office document agent)",
  "claude-excel": "Claude Excel (Office document agent)",
  "user": "Human user",
};

/**
 * Check if a value is a recognized surface — checks registry cache first,
 * falls back to the hardcoded SURFACES list for backward compatibility.
 * New surfaces added via the registry tool are immediately valid.
 */
export function isRegisteredSurface(value: string): boolean {
  if (SURFACES.includes(value as Surface)) return true;
  return isInRegistryCache(value);
}

/** Validate a string as a known surface. Returns null if invalid.
 *  Checks both hardcoded list and registry cache. */
export function parseSurface(value: string | undefined): Surface | null {
  if (!value) return null;
  if (isRegisteredSurface(value)) return value as Surface;
  return null;
}

/**
 * Shared Zod schema fragment for base parameters included on every tool.
 * Spread into every tool's schema: { ...INITIATOR_PARAM, action: z.enum(...), ... }
 *
 * Includes:
 *   - initiator: calling surface identifier
 *   - turnDelta: total characters consumed since last MCP call
 *     (extracted at middleware level in index.ts, not per-tool)
 */
export const INITIATOR_PARAM = {
  initiator: z.enum(SURFACES).optional().describe(
    "Calling surface identifier. Helps the server tailor responses and track provenance."
  ),
  turnDelta: z.number().int().default(0).describe(
    "Total characters consumed since last MCP call (assistant responses, user messages, tool results). Pass 0 if unknown. Required on every call."
  ),
} as const;

/**
 * Extract initiator from tool args, store in RequestContext, return resolved surface.
 * Fallback chain: initiator → createdBy → "unknown".
 * Call at the top of every tool handler.
 */
export function resolveInitiator(args: { initiator?: string; createdBy?: string }): Surface | "unknown" {
  const surface = parseSurface(args.initiator) || parseSurface(args.createdBy);
  if (surface) {
    setInitiator(surface);
    return surface;
  }
  return "unknown";
}
