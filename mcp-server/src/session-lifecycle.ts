// ═══════════════════════════════════════════════════════════════
// Server-Managed Session Lifecycle
// ═══════════════════════════════════════════════════════════════
// Pre-handler that runs before tool execution to auto-detect and
// manage sessions. Firebase is the source of truth — the in-memory
// cache is only an optimization within a single request scope.
//
// Decision tree (4 branches):
// 1. No active session → auto-create
// 2. Active session >24h old → stale-close + auto-create
// 3. Active session <24h, context matches → keep open
// 4. Active session <24h, context mismatch → flag mismatch
// ═══════════════════════════════════════════════════════════════

import { getSessionsRef, getSessionRef } from "./firebase.js";
import { getSessionMeta, setSessionMeta, getCurrentUid } from "./context.js";
import { setActiveSessionId } from "./tools/sessions.js";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionMetadata {
  id: string;
  autoCreated?: boolean;
  mismatch?: boolean;
  existingSession?: {
    id: string;
    title: string;
    appId: string | null;
    ideaId: string | null;
    startedAt: string;
  };
  staleClosed?: string; // ID of the stale session that was closed
  _sessionData?: any;   // Internal: cached session record for tool-level mismatch checks (not serialized to responses)
}

/**
 * Resolve the active session for a user. Implements the 4-branch decision tree.
 *
 * @param uid - Firebase UID
 * @param toolContext - Optional context from the tool call (appId, ideaId)
 *                      If not provided, defaults to "context matches" (branch 3)
 * @returns SessionMetadata to include in tool response
 */
export async function resolveSession(
  uid: string,
  toolContext?: { appId?: string; ideaId?: string }
): Promise<SessionMetadata> {
  // Query Firebase for active session (source of truth)
  const activeQuery = getSessionsRef(uid)
    .orderByChild("status")
    .equalTo("active")
    .limitToLast(1);

  const snap = await activeQuery.once("value");
  const data = snap.val();

  // ─── Branch 1: No active session → auto-create ───
  if (!data) {
    return await autoCreateSession(uid);
  }

  const entries = Object.entries(data);
  const [sessionId, session] = entries[0] as [string, any];
  const startedAt = new Date(session.startedAt || session.createdAt).getTime();
  const age = Date.now() - startedAt;

  // ─── Branch 2: Active session >24h old → stale-close + auto-create ───
  if (age > STALE_THRESHOLD_MS) {
    await staleCloseSession(uid, sessionId);
    const newSession = await autoCreateSession(uid);
    newSession.staleClosed = sessionId;
    return newSession;
  }

  // ─── Branch 3 & 4: Active session <24h ───
  // Check context match only if tool provides context
  if (toolContext && (toolContext.appId || toolContext.ideaId)) {
    const sessionAppId = session.activeAppId || session.appId || null;
    const sessionIdeaId = session.activeIdeaId || session.ideaId || null;

    const appMatch = !toolContext.appId || toolContext.appId === sessionAppId;
    const ideaMatch = !toolContext.ideaId || toolContext.ideaId === sessionIdeaId;

    if (!appMatch || !ideaMatch) {
      // ─── Branch 4: Context mismatch ───
      return {
        id: sessionId,
        mismatch: true,
        existingSession: {
          id: sessionId,
          title: session.title,
          appId: sessionAppId,
          ideaId: sessionIdeaId,
          startedAt: session.startedAt,
        },
      };
    }
  }

  // ─── Branch 3: Context matches (or no context to compare) ───
  // Update cache so serverSentTotal/interactionTotal auto-increment knows the active session
  setActiveSessionId(uid, sessionId);
  // Include session data for tool-level mismatch checks (not serialized to responses)
  return { id: sessionId, _sessionData: session };
}

async function autoCreateSession(uid: string): Promise<SessionMetadata> {
  const ref = getSessionsRef(uid).push();
  const now = new Date().toISOString();
  const session = {
    id: ref.key,
    ideaId: null,
    appId: null,
    status: "active",
    title: "Auto-created session",
    startedAt: now,
    completedAt: null,
    summary: null,
    conceptsCreated: [],
    conceptsModified: [],
    events: [],
    metadata: {
      toolCallCount: 0,
      conceptCount: { OPEN: 0, DECISION: 0, RULE: 0, CONSTRAINT: 0 },
      autoCreated: true,
    },
    mode: "base",
    activeIdeaId: null,
    activeAppId: null,
    activeLens: null,
    targetOpens: [],
    sessionGoal: null,
    conceptBlockCount: 0,
    contextBySurface: {},
    presentationMode: "interactive",
    configSnapshot: null,
    closingSummary: null,
    nextSessionRecommendation: null,
    conceptsResolved: 0,
    lastActivityAt: now,
  };

  await ref.set(session);

  // Update the active session cache for serverSentTotal/interactionTotal auto-increment
  setActiveSessionId(uid, ref.key!);

  return {
    id: ref.key!,
    autoCreated: true,
  };
}

async function staleCloseSession(uid: string, sessionId: string): Promise<void> {
  const ref = getSessionRef(uid, sessionId);
  const now = new Date().toISOString();
  await ref.update({
    status: "completed",
    completedAt: now,
    summary: "stale-closed: session exceeded 24h without completion",
    closingSummary: "Auto-closed by server — session was stale (>24h)",
    lastActivityAt: now,
  });
}

/**
 * Convenience helper for tools: resolve session once per request, cache in AsyncLocalStorage.
 * Returns cached result on subsequent calls within the same request.
 *
 * Usage in tool handlers:
 *   const sessionMeta = await ensureSession({ appId, ideaId });
 *   // sessionMeta.id is the active session ID
 *   // sessionMeta.autoCreated is true if a new session was auto-created
 *   // sessionMeta.mismatch is true if context doesn't match active session
 */
export async function ensureSession(
  toolContext?: { appId?: string; ideaId?: string }
): Promise<SessionMetadata> {
  // Check if already resolved for this request
  const cached = getSessionMeta();

  if (cached) {
    // If no tool context provided, return cached result as-is
    if (!toolContext || (!toolContext.appId && !toolContext.ideaId)) {
      return cached;
    }

    // Tool provided context — run mismatch check against the cached session
    // This avoids re-querying Firebase. We use _cachedSessionData (set during resolveSession)
    // to compare context locally.
    if (cached._sessionData) {
      const session = cached._sessionData;
      const sessionAppId = session.activeAppId || session.appId || null;
      const sessionIdeaId = session.activeIdeaId || session.ideaId || null;

      const appMatch = !toolContext.appId || toolContext.appId === sessionAppId;
      const ideaMatch = !toolContext.ideaId || toolContext.ideaId === sessionIdeaId;

      if (!appMatch || !ideaMatch) {
        return {
          id: cached.id,
          mismatch: true,
          existingSession: {
            id: cached.id,
            title: session.title,
            appId: sessionAppId,
            ideaId: sessionIdeaId,
            startedAt: session.startedAt,
          },
        };
      }
    }

    return cached;
  }

  // Resolve from Firebase
  const uid = getCurrentUid();
  const meta = await resolveSession(uid, toolContext);

  // Cache in request context
  setSessionMeta(meta);

  return meta;
}

/**
 * Append _session metadata to a tool response content array.
 * Call this before returning from any tool handler that wants session info in response.
 */
export function appendSessionMeta(
  content: Array<{ type: string; text: string }>,
  sessionMeta?: SessionMetadata
): Array<{ type: string; text: string }> {
  const meta = sessionMeta || getSessionMeta();
  if (!meta) return content;

  // Add _session metadata as a separate text block
  content.push({
    type: "text",
    text: JSON.stringify({ _session: meta }),
  });

  return content;
}
