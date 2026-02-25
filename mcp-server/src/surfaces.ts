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

/** Validate a string as a known surface. Returns null if invalid. */
export function parseSurface(value: string | undefined): Surface | null {
  if (!value) return null;
  return SURFACES.includes(value as Surface) ? (value as Surface) : null;
}

/**
 * Shared Zod schema fragment for base parameters included on every tool.
 * Spread into every tool's schema: { ...INITIATOR_PARAM, action: z.enum(...), ... }
 *
 * Includes:
 *   - initiator: calling surface identifier
 *   - contextEstimate: optional context window usage reported by the surface
 *     (extracted at middleware level in index.ts, not per-tool)
 */
export const INITIATOR_PARAM = {
  initiator: z.enum(SURFACES).optional().describe(
    "Calling surface identifier. Helps the server tailor responses and track provenance."
  ),
  contextEstimate: z.number().int().optional().describe(
    "Surface-reported context window usage in characters. Server compares against its own floor to detect drift."
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
