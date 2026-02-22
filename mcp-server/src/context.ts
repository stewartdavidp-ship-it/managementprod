import { AsyncLocalStorage } from "async_hooks";
import type { SessionMetadata } from "./session-lifecycle.js";

// Per-request context using AsyncLocalStorage
// This lets MCP tool handlers access the authenticated user's Firebase UID
// without needing to pass it through the MCP SDK's tool registration API

export interface RequestContext {
  firebaseUid: string;
  sessionMeta?: SessionMetadata;
  contextEstimate?: number; // Cached from Firebase per-request for _contextHealth
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
