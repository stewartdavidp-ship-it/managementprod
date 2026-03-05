// ═══════════════════════════════════════════════════════════════
// Signal Computation — Compute active signal codes per request
// ═══════════════════════════════════════════════════════════════
// Evaluates signal conditions based on request context and returns
// an array of active signal code strings. Called once per request
// and cached in AsyncLocalStorage for piggybacking by
// response-metadata.ts.
//
// Signal codes are lightweight flags — absence means not triggered.
// Parameterized codes use colon syntax: "load:cc-job-creation-protocol"
// ═══════════════════════════════════════════════════════════════

import type { Surface } from "./surfaces.js";
import type { SessionMetadata } from "./session-lifecycle.js";
import type { PendingMessagesInfo } from "./context.js";
import { getJobsRef, getProfileRef, getSignalsRef } from "./firebase.js";

// ─── Signal Definition (as stored in Firebase registry) ───
export interface SignalDefinition {
  name: string;
  description: string;
  surfaces: Surface[];
  computation: string; // Human-readable description of what triggers this signal
  action: string; // Human-readable description of what the client should do
}

// ─── Computation Context ───
// Everything needed to evaluate signals, gathered once per request.
export interface SignalContext {
  uid: string;
  surface: Surface | undefined;
  sessionMeta: SessionMetadata | undefined;
  pendingMessages: PendingMessagesInfo | null | undefined;
  turnDeltaProvided: boolean;
  // Profile and job data loaded on-demand below
}

// ─── Cached per-request job query results ───
interface JobSignalData {
  hasJobsInReview: boolean;
  hasJobsInDraft: boolean;
}

/**
 * Compute active signal codes for the current request.
 * Returns an array of active signal code name strings.
 *
 * Design: Most checks use data already loaded in request context
 * (session meta, pending messages). Only profile flags and job queries
 * require additional Firebase reads — batched into one parallel call.
 */
export async function computeSignals(ctx: SignalContext): Promise<string[]> {
  const signals: string[] = [];
  const { uid, surface, sessionMeta, pendingMessages } = ctx;

  // ─── Firebase reads (parallel batch) ───
  // Only load what we need: profile + jobs (batched, cached per-request)
  const [profileData, jobData] = await Promise.all([
    loadProfileFlags(uid),
    loadJobSignalData(uid),
  ]);

  // ─── 1. instructions-dirty (all surfaces) ───
  if (profileData.projectInstructionsDirty) {
    signals.push("instructions-dirty");
  }

  // ─── 2. show-tutorial (chat only) ───
  if (surface === "claude-chat" && profileData.showTutorial) {
    signals.push("show-tutorial");
  }

  // ─── 3. needs-attention (chat only) ───
  if (surface === "claude-chat" && profileData.needsAttention) {
    signals.push("needs-attention");
  }

  // ─── 4. jobs-in-review (chat, code) ───
  if (
    (surface === "claude-chat" || surface === "claude-code") &&
    jobData.hasJobsInReview
  ) {
    signals.push("jobs-in-review");
  }

  // ─── 5. jobs-in-draft (code only) ───
  if (surface === "claude-code" && jobData.hasJobsInDraft) {
    signals.push("jobs-in-draft");
  }

  // ─── 6. pending-messages (all surfaces) ───
  if (pendingMessages && pendingMessages.count > 0) {
    // Filter to messages for this surface
    if (surface) {
      const forThisSurface = pendingMessages.messages.filter(
        (m) => m.to === surface
      );
      if (forThisSurface.length > 0) {
        signals.push("pending-messages");
      }
    } else {
      // No surface specified — include if any pending
      signals.push("pending-messages");
    }
  }

  // ─── 7. session-enrich (all surfaces) ───
  if (sessionMeta?.autoCreated) {
    signals.push("session-enrich");
  }

  // ─── 8. session-mismatch (all surfaces) ───
  if (sessionMeta?.mismatch) {
    signals.push("session-mismatch");
  }

  // ─── 9. session-stale-closed (all surfaces) ───
  if (sessionMeta?.staleClosed) {
    signals.push("session-stale-closed");
  }

  // ─── 10. bootstrap-required (all surfaces) ───
  if (!surface) {
    // No initiator param = cold surface, needs bootstrap
    signals.push("bootstrap-required");
  }

  // ─── 11. context-estimate-missing (production surfaces only) ───
  // Fires when turnDelta is not provided by claude-chat or claude-code
  if (!ctx.turnDeltaProvided && (surface === "claude-chat" || surface === "claude-code")) {
    signals.push("context-estimate-missing");
  }

  // ─── 12. load:{skill-name} — server-determined skill triggers ───
  // Future: add context-aware skill loading signals here.
  // For now, this is a placeholder for the load: parameterized code pattern.
  // Example: signals.push("load:cc-job-creation-protocol");

  return signals;
}

/**
 * Load the signal registry from Firebase.
 * Used by bootstrap to return signal definitions to the client.
 */
export async function loadSignalRegistry(
  uid: string
): Promise<Record<string, SignalDefinition>> {
  const snap = await getSignalsRef(uid).once("value");
  return snap.val() || {};
}

// ─── Internal helpers ───

interface ProfileFlags {
  projectInstructionsDirty: boolean;
  showTutorial: boolean;
  needsAttention: boolean;
}

async function loadProfileFlags(uid: string): Promise<ProfileFlags> {
  try {
    const snap = await getProfileRef(uid).once("value");
    const data = snap.val() || {};
    return {
      projectInstructionsDirty: data.projectInstructionsDirty === true,
      showTutorial: data.showTutorial === true,
      needsAttention: data.needsAttention === true,
    };
  } catch {
    return {
      projectInstructionsDirty: false,
      showTutorial: false,
      needsAttention: false,
    };
  }
}

async function loadJobSignalData(uid: string): Promise<JobSignalData> {
  try {
    // Single query: get all non-terminal jobs, check status in memory
    // Using limitToLast to avoid unbounded reads (safety rule)
    const snap = await getJobsRef(uid)
      .orderByChild("status")
      .limitToLast(50)
      .once("value");

    const data = snap.val();
    if (!data) {
      return { hasJobsInReview: false, hasJobsInDraft: false };
    }

    let hasJobsInReview = false;
    let hasJobsInDraft = false;

    for (const job of Object.values(data as Record<string, any>)) {
      if (job.status === "review") hasJobsInReview = true;
      if (job.status === "draft") hasJobsInDraft = true;
      if (hasJobsInReview && hasJobsInDraft) break; // Early exit
    }

    return { hasJobsInReview, hasJobsInDraft };
  } catch {
    return { hasJobsInReview: false, hasJobsInDraft: false };
  }
}
