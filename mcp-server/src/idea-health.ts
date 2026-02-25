/**
 * idea-health.ts — Pure health computation for ideas.
 *
 * Evaluates staleness, scope creep, empty primary, and completion
 * candidates. All functions are pure (callers provide data) except
 * updateAppTriageFlags which writes to Firebase.
 */

import { getConfigRef } from "./firebase.js";

// ─── Types ───

export interface HealthAlert {
  alertType: "stale" | "scope_creep" | "empty_primary" | "completion_candidate" | "mistyped";
  severity: "high" | "medium" | "low";
  message: string;
  recommendation: string;
}

export interface IdeaHealthInput {
  idea: {
    id: string;
    name: string;
    ideaType?: string | null;      // primary | auxiliary | placeholder
    intention?: string | null;     // new | add | fix
    primaryOutput?: string | null; // code | presentation | document | analysis | spreadsheet
    status?: string;
    sessionCountAtLastHealth?: number;
  };
  totalAppSessionCount: number;     // ALL completed sessions for this app
  conceptCount: number;             // active concepts for this idea
  activeOpenCount: number;          // active OPENs for this idea
  completedJobCount: number;        // completed jobs for this idea
  totalJobCount: number;            // all jobs (any status) for this idea
}

// ─── Staleness Threshold Matrix ───
// Key: `${ideaType}:${intention}` → { threshold (sessions), severity }
// threshold = number of app sessions without this idea being active before alert fires

interface StalenessEntry {
  threshold: number;
  severity: "high" | "medium" | "low";
}

const STALENESS_MATRIX: Record<string, StalenessEntry> = {
  // Placeholder: should be promoted or archived quickly
  "placeholder:new": { threshold: 2, severity: "high" },
  "placeholder:add": { threshold: 2, severity: "high" },
  "placeholder:fix": { threshold: 2, severity: "high" },

  // Auxiliary: supporting work, moderate urgency
  "auxiliary:fix":   { threshold: 3, severity: "high" },
  "auxiliary:add":   { threshold: 5, severity: "medium" },
  "auxiliary:new":   { threshold: 5, severity: "medium" },

  // Primary: core platform work, longer thresholds
  "primary:fix":    { threshold: 0, severity: "high" },   // immediate — likely mistyped
  "primary:add":    { threshold: 8, severity: "medium" },
  "primary:new":    { threshold: 12, severity: "low" },
};

// Fallback thresholds when intention is null (most lenient for ideaType)
const STALENESS_FALLBACK: Record<string, StalenessEntry> = {
  "primary":     { threshold: 12, severity: "low" },
  "auxiliary":   { threshold: 5, severity: "medium" },
  "placeholder": { threshold: 2, severity: "high" },
};

// ─── computeIdeaHealth ───

export function computeIdeaHealth(input: IdeaHealthInput): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const { idea, totalAppSessionCount, conceptCount, activeOpenCount, completedJobCount, totalJobCount } = input;

  const ideaType = idea.ideaType || "primary";
  const intention = idea.intention || null;
  const primaryOutput = idea.primaryOutput || "code";

  // Session delta since last health check
  const lastCount = idea.sessionCountAtLastHealth || 0;
  const sessionDelta = totalAppSessionCount - lastCount;

  // ── 1. Staleness check ──
  const matrixKey = intention ? `${ideaType}:${intention}` : null;
  const entry = matrixKey
    ? STALENESS_MATRIX[matrixKey] || STALENESS_FALLBACK[ideaType]
    : STALENESS_FALLBACK[ideaType];

  if (entry) {
    // Analysis primaryOutput gets 1.5x multiplier
    let threshold = entry.threshold;
    if (primaryOutput === "analysis") {
      threshold = Math.ceil(threshold * 1.5);
    }

    if (sessionDelta > threshold) {
      // Special case: primary + fix = 0 threshold → likely mistyped
      if (ideaType === "primary" && intention === "fix" && threshold === 0) {
        alerts.push({
          alertType: "mistyped",
          severity: "high",
          message: `"${idea.name}" is a primary idea with fix intention — primary ideas are rarely fixes.`,
          recommendation: "Demote to auxiliary or change intention to add/new.",
        });
      } else {
        alerts.push({
          alertType: "stale",
          severity: entry.severity,
          message: `"${idea.name}" has been idle for ${sessionDelta} app sessions (threshold: ${threshold}).`,
          recommendation: ideaType === "placeholder"
            ? "Promote to auxiliary/primary or archive."
            : "Resume work, split into smaller scope, or archive.",
        });
      }
    }
  }

  // ── 2. Scope creep check ──
  if (ideaType === "placeholder" && conceptCount >= 3) {
    alerts.push({
      alertType: "scope_creep",
      severity: "medium",
      message: `Placeholder "${idea.name}" has ${conceptCount} concepts — too many for a parked idea.`,
      recommendation: "Promote to auxiliary/primary or split into multiple ideas.",
    });
  }
  if (ideaType === "auxiliary" && conceptCount >= 10) {
    alerts.push({
      alertType: "scope_creep",
      severity: "medium",
      message: `Auxiliary "${idea.name}" has ${conceptCount} concepts — may deserve primary status.`,
      recommendation: "Promote to primary or split scope.",
    });
  }

  // ── 3. Empty primary check ──
  if (ideaType === "primary" && conceptCount === 0 && sessionDelta >= 3) {
    alerts.push({
      alertType: "empty_primary",
      severity: "medium",
      message: `Primary idea "${idea.name}" has 0 concepts after ${sessionDelta} app sessions.`,
      recommendation: "Run an ideation session or demote to placeholder.",
    });
  }

  // ── 4. Completion candidate check ──
  if (intention === "fix" && completedJobCount > 0 && completedJobCount >= totalJobCount) {
    alerts.push({
      alertType: "completion_candidate",
      severity: "low",
      message: `Fix idea "${idea.name}" has all ${completedJobCount} jobs completed.`,
      recommendation: "Mark as completed.",
    });
  }
  if (intention === "add" && completedJobCount > 0 && completedJobCount >= totalJobCount && activeOpenCount === 0) {
    alerts.push({
      alertType: "completion_candidate",
      severity: "low",
      message: `Add idea "${idea.name}" has all ${completedJobCount} jobs completed with no active OPENs.`,
      recommendation: "Mark as completed.",
    });
  }

  return alerts;
}

// ─── updateAppTriageFlags ───
// Writes triageNeeded, triageAlertCount, lastTriageAt to app config record.

export async function updateAppTriageFlags(
  uid: string,
  appId: string,
  alertCount?: number,
): Promise<void> {
  try {
    const appRef = getConfigRef(uid).child("apps").child(appId);
    const updates: Record<string, any> = {
      lastTriageAt: new Date().toISOString(),
    };

    if (alertCount !== undefined) {
      updates.triageNeeded = alertCount > 0;
      updates.triageAlertCount = alertCount;
    } else {
      // Caller didn't provide count — just update timestamp
      updates.triageNeeded = false;
      updates.triageAlertCount = 0;
    }

    await appRef.update(updates);
  } catch {
    // Fire-and-forget — never throw
  }
}
