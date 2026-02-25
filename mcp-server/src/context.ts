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
  contextEstimate?: number; // Cached from Firebase per-request for _contextHealth
  contextPerSurface?: Record<string, number>; // Per-surface breakdown from Firebase + pending
  pendingMessages?: PendingMessagesInfo | null; // Cached per-request for piggyback notifications (null = checked, none found)
  suppressPiggyback?: boolean; // Set by document(receive) to avoid redundant info
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

// Get the cached context estimate for this request
export function getContextEstimate(): number | undefined {
  const ctx = requestContext.getStore();
  return ctx?.contextEstimate;
}

// Set the cached context estimate for this request (called once per request)
export function setContextEstimate(estimate: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.contextEstimate = estimate;
  }
}

// Get per-surface context estimate breakdown for this request
export function getContextPerSurface(): Record<string, number> | undefined {
  const ctx = requestContext.getStore();
  return ctx?.contextPerSurface;
}

// Set per-surface context estimate breakdown (called once per request in index.ts)
export function setContextPerSurface(perSurface: Record<string, number>): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.contextPerSurface = perSurface;
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
