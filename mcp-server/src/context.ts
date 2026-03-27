import { AsyncLocalStorage } from "async_hooks";
import type { SessionMetadata } from "./session-lifecycle.js";
import type { Surface } from "./surfaces.js";

// Per-request context using AsyncLocalStorage
// This lets MCP tool handlers access the authenticated user's Firebase UID
// without needing to pass it through the MCP SDK's tool registration API

export interface PendingMessageSummary {
  to: string;
  from: string;
  subject: string;
}

export interface PendingMessagesInfo {
  count: number;
  messages: PendingMessageSummary[];
}

export interface RequestContext {
  firebaseUid: string;
  initiator?: Surface; // Calling surface, set by resolveInitiator() in tool handlers
  sessionMeta?: SessionMetadata;
  serverSentTotal?: number; // Server-tracked sum of _responseSize for this session (from Firebase + pending)
  interactionTotal?: number; // Server-tracked sum of turnDelta for this session (from Firebase + pending)
  turnDelta?: number; // Surface-reported characters consumed since last MCP call (from turnDelta tool param)
  contextEstimateAbsolute?: number; // Absolute context window usage (from contextEstimate param — NOT a delta)
  pendingMessages?: PendingMessagesInfo | null; // Cached per-request for piggyback notifications (null = checked, none found)
  suppressPiggyback?: boolean; // Set by document(receive) to avoid redundant info
  signals?: string[] | null; // Cached per-request computed signal codes (null = computed, none active)
  toolName?: string; // Tool name being called (e.g., "session", "app", "concept")
  initiatorExplicit?: boolean; // True when initiator was set via explicit `initiator` param (not inferred from createdBy)
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// Get the current request's Firebase UID
// Falls back to FIREBASE_UID env var for dev/testing
export function getCurrentUid(): string {
  const ctx = requestContext.getStore();
  if (ctx?.firebaseUid) return ctx.firebaseUid;

  // Fallback for dev mode
  const envUid = process.env.FIREBASE_UID;
  if (envUid) return envUid;

  throw new Error("No Firebase UID in request context. User must authenticate via OAuth.");
}

// Get the session metadata resolved for this request
export function getSessionMeta(): SessionMetadata | undefined {
  const ctx = requestContext.getStore();
  return ctx?.sessionMeta;
}

// Set the session metadata for this request
export function setSessionMeta(meta: SessionMetadata): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.sessionMeta = meta;
  }
}

// Get the cached serverSentTotal for this request
export function getServerSentTotal(): number | undefined {
  const ctx = requestContext.getStore();
  return ctx?.serverSentTotal;
}

// Set the cached serverSentTotal for this request (called once per request)
export function setServerSentTotal(total: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.serverSentTotal = total;
  }
}

// Get the cached interactionTotal for this request
export function getInteractionTotal(): number | undefined {
  const ctx = requestContext.getStore();
  return ctx?.interactionTotal;
}

// Set the cached interactionTotal for this request (called once per request)
export function setInteractionTotal(total: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.interactionTotal = total;
  }
}

// Get pending messages info for piggyback notifications
export function getPendingMessages(): PendingMessagesInfo | null | undefined {
  const ctx = requestContext.getStore();
  return ctx?.pendingMessages;
}

// Set pending messages info (called once per request in index.ts)
export function setPendingMessages(info: PendingMessagesInfo | null): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.pendingMessages = info;
  }
}

// Set suppress piggyback flag (called by document receive handler)
export function setSuppressPiggyback(suppress: boolean): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.suppressPiggyback = suppress;
  }
}

// Get suppress piggyback flag
export function getSuppressPiggyback(): boolean {
  return requestContext.getStore()?.suppressPiggyback ?? false;
}

// Get the initiator surface for this request
export function getInitiator(): Surface | undefined {
  return requestContext.getStore()?.initiator;
}

// Set the initiator surface for this request (called from resolveInitiator in surfaces.ts)
export function setInitiator(surface: Surface): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.initiator = surface;
  }
}

// Get the surface-reported turnDelta for this request
export function getTurnDelta(): number | undefined {
  return requestContext.getStore()?.turnDelta;
}

// Set the surface-reported turnDelta (called from middleware in index.ts)
export function setTurnDelta(delta: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.turnDelta = delta;
  }
}

// Check if initiator was explicitly set via the `initiator` parameter (not inferred from createdBy)
export function isInitiatorExplicit(): boolean {
  return requestContext.getStore()?.initiatorExplicit ?? false;
}

// Mark that initiator was explicitly provided (called from middleware in index.ts)
export function setInitiatorExplicit(explicit: boolean): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.initiatorExplicit = explicit;
  }
}

// Get the absolute context estimate (if contextEstimate was used instead of turnDelta)
export function getContextEstimateAbsolute(): number | undefined {
  return requestContext.getStore()?.contextEstimateAbsolute;
}

// Set the absolute context estimate
export function setContextEstimateAbsolute(estimate: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.contextEstimateAbsolute = estimate;
  }
}

// Get the tool name for this request
export function getToolName(): string | undefined {
  return requestContext.getStore()?.toolName;
}

// Set the tool name for this request (called from middleware in index.ts)
export function setToolName(name: string): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.toolName = name;
  }
}

// Get cached signal codes for this request
export function getSignals(): string[] | null | undefined {
  return requestContext.getStore()?.signals;
}

// Set computed signal codes for this request (called once per request in index.ts)
export function setSignals(signals: string[] | null): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.signals = signals;
  }
}
