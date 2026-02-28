// ═══════════════════════════════════════════════════════════════
// Session Bootstrap & Init — Single-call startup replacement
// ═══════════════════════════════════════════════════════════════
// handleBootstrap(): Fan-out reads across Firebase, returns
// orientation payload (instructions, session, idea, jobs, signals).
//
// handleInit(): One-time onboarding entry point. Sets initialized
// flag, returns memory boot loader lines.
// ═══════════════════════════════════════════════════════════════

import { getCurrentUid } from "./context.js";
import {
  getProfileRef,
  getSessionsRef,
  getSessionRef,
  getJobsRef,
  getIdeasRef,
  getConceptsRef,
} from "./firebase.js";
import { getCachedSkill } from "./skill-cache.js";
import { ensureSession, type SessionMetadata } from "./session-lifecycle.js";
import { loadSignalRegistry, type SignalDefinition } from "./signal-computation.js";
import { withResponseSize } from "./response-metadata.js";
import type { Surface } from "./surfaces.js";

// ─── Types ───
// Use the same shape as MCP tool results — must have index signature for compatibility
interface ToolResult {
  content: { type: "text"; text: string; [key: string]: unknown }[];
  isError?: boolean;
  [key: string]: unknown;
}

interface ActiveIdeaInfo {
  id: string;
  name: string;
  description: string;
  conceptCounts: {
    rules: number;
    constraints: number;
    decisions: number;
    opens: number;
  };
}

interface PriorSessionInfo {
  id: string;
  title: string;
  closingSummary: string | null;
  nextSessionRecommendation: string | null;
  completedAt: string | null;
}

interface JobSummary {
  id: string;
  title: string;
  appId: string;
  status: string;
  createdAt: string;
  jobType?: string;
}

// ─── Bootstrap Instruction Skill Names ───
const INSTRUCTION_SKILLS: Record<string, string> = {
  "claude-chat": "cc-bootstrap-instructions-chat",
  "claude-code": "cc-bootstrap-instructions-code",
  "claude-cowork": "cc-bootstrap-instructions-cowork",
};

// ─── handleBootstrap ───

export async function handleBootstrap(
  uid: string,
  surface: Surface
): Promise<ToolResult> {
  // Fan-out all reads in parallel for <200ms target
  const [
    profileData,
    sessionMeta,
    priorSession,
    activeIdeaData,
    jobsData,
    signalDefs,
    instructions,
  ] = await Promise.all([
    loadProfile(uid),
    resolveBootstrapSession(uid),
    loadPriorSession(uid),
    loadActiveIdea(uid),
    loadJobs(uid),
    loadSignalRegistryLean(uid, surface),
    loadInstructions(surface),
  ]);

  // Build session info from ensureSession result
  let activeSession: Record<string, any> | null = null;
  if (sessionMeta) {
    activeSession = {
      id: sessionMeta.id,
      autoCreated: sessionMeta.autoCreated || false,
    };
    // Enrich with session data if available
    if (sessionMeta._sessionData) {
      const s = sessionMeta._sessionData;
      activeSession.title = s.title || null;
      activeSession.mode = s.mode || null;
      activeSession.goal = s.sessionGoal || null;
      activeSession.ideaId = s.activeIdeaId || s.ideaId || null;
      activeSession.appId = s.activeAppId || s.appId || null;
    }
  }

  const payload = {
    instructions,
    profile: {
      initialized: profileData.initialized || false,
      presentationMode: profileData.presentationMode || "interactive",
      projectInstructionsDirty: profileData.projectInstructionsDirty || false,
      showTutorial: profileData.showTutorial || false,
      needsAttention: profileData.needsAttention || false,
    },
    activeSession,
    activeIdea: activeIdeaData,
    priorSession,
    jobs: jobsData,
    signalDefinitions: signalDefs,
  };

  return withResponseSize({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });
}

// ─── handleInit ───

export async function handleInit(
  uid: string,
  surface: Surface
): Promise<ToolResult> {
  const profileRef = getProfileRef(uid);

  // Set initialized flag (idempotent)
  await profileRef.update({
    initialized: true,
    initializedAt: new Date().toISOString(),
    initializedSurface: surface,
    updatedAt: new Date().toISOString(),
  });

  // Surface-appropriate memory boot loader lines
  const memoryLines = getMemoryLines(surface);

  const payload = {
    memoryLines,
    confirmation:
      "Memory boot loader ready. Write these lines to your Claude Memory, then call session(bootstrap) to start.",
  };

  return withResponseSize({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });
}

// ─── Internal Helpers ───

async function loadProfile(uid: string): Promise<Record<string, any>> {
  try {
    const snap = await getProfileRef(uid).once("value");
    return snap.val() || {};
  } catch {
    return {};
  }
}

async function resolveBootstrapSession(
  uid: string
): Promise<SessionMetadata | null> {
  try {
    return await ensureSession();
  } catch {
    return null;
  }
}

async function loadPriorSession(
  uid: string
): Promise<PriorSessionInfo | null> {
  try {
    const snap = await getSessionsRef(uid)
      .orderByChild("status")
      .equalTo("completed")
      .limitToLast(1)
      .once("value");

    const data = snap.val();
    if (!data) return null;

    const sessions = Object.values(data as Record<string, any>);
    if (sessions.length === 0) return null;

    const s = sessions[0];
    // Only include if it has useful continuity data
    if (!s.closingSummary && !s.nextSessionRecommendation) return null;

    return {
      id: s.id || Object.keys(data as Record<string, any>)[0],
      title: s.title || "Untitled",
      closingSummary: s.closingSummary || null,
      nextSessionRecommendation: s.nextSessionRecommendation || null,
      completedAt: s.completedAt || null,
    };
  } catch {
    return null;
  }
}

async function loadActiveIdea(uid: string): Promise<ActiveIdeaInfo | null> {
  try {
    // Find the most recent active idea
    const snap = await getIdeasRef(uid)
      .orderByChild("status")
      .equalTo("active")
      .limitToLast(1)
      .once("value");

    const data = snap.val();
    if (!data) return null;

    const ideas = Object.entries(data as Record<string, any>);
    if (ideas.length === 0) return null;

    const [ideaId, idea] = ideas[0];

    // Count concepts by type for this idea
    const conceptSnap = await getConceptsRef(uid)
      .orderByChild("ideaOrigin")
      .equalTo(ideaId)
      .once("value");

    const concepts = conceptSnap.val();
    const counts = { rules: 0, constraints: 0, decisions: 0, opens: 0 };

    if (concepts) {
      for (const c of Object.values(concepts as Record<string, any>)) {
        if (c.status !== "active") continue;
        switch (c.type) {
          case "RULE": counts.rules++; break;
          case "CONSTRAINT": counts.constraints++; break;
          case "DECISION": counts.decisions++; break;
          case "OPEN": counts.opens++; break;
        }
      }
    }

    return {
      id: ideaId,
      name: idea.name || "Untitled",
      description: idea.description || "",
      conceptCounts: counts,
    };
  } catch {
    return null;
  }
}

async function loadJobs(uid: string): Promise<{
  active: JobSummary[];
  draft: JobSummary[];
  review: JobSummary[];
}> {
  try {
    // Single query: get recent jobs, filter in memory
    const snap = await getJobsRef(uid)
      .orderByChild("createdAt")
      .limitToLast(50)
      .once("value");

    const data = snap.val();
    if (!data) return { active: [], draft: [], review: [] };

    const active: JobSummary[] = [];
    const draft: JobSummary[] = [];
    const review: JobSummary[] = [];

    for (const [id, job] of Object.entries(data as Record<string, any>)) {
      const summary: JobSummary = {
        id,
        title: job.title || "Untitled",
        appId: job.appId || "",
        status: job.status,
        createdAt: job.createdAt || "",
        jobType: job.jobType,
      };

      switch (job.status) {
        case "active": active.push(summary); break;
        case "draft": draft.push(summary); break;
        case "review": review.push(summary); break;
      }
    }

    return { active, draft, review };
  } catch {
    return { active: [], draft: [], review: [] };
  }
}

async function loadSignalRegistryLean(
  uid: string,
  surface: Surface
): Promise<Record<string, { description: string; action: string }>> {
  try {
    const registry = await loadSignalRegistry(uid);
    const lean: Record<string, { description: string; action: string }> = {};

    for (const [code, def] of Object.entries(registry)) {
      // Only include signals relevant to this surface
      if (def.surfaces && !def.surfaces.includes(surface)) continue;
      lean[code] = {
        description: def.description,
        action: def.action,
      };
    }

    return lean;
  } catch {
    return {};
  }
}

function loadInstructions(surface: Surface): string {
  const skillName = INSTRUCTION_SKILLS[surface];
  if (!skillName) {
    return getDefaultInstructions(surface);
  }

  const skill = getCachedSkill(skillName);
  if (!skill) {
    return getDefaultInstructions(surface);
  }

  return skill.content;
}

function getDefaultInstructions(surface: Surface): string {
  // Fallback if bootstrap instruction skills aren't created yet
  return [
    `Your surface identity: ${surface}`,
    `Use "${surface}" as your initiator parameter on all MCP tool calls.`,
    `Budget tracking: report estimated context usage every turn.`,
    `Watch for _signals in every MCP response — they indicate actions to take.`,
    `Watch for _pendingMessages — they indicate unread messages for surfaces.`,
  ].join("\n");
}

function getMemoryLines(surface: Surface): string[] {
  const routerSkillName = `cc-router-${surface.replace("claude-", "")}`;

  return [
    "AI Command Center (ACC) user. MCP server connected.",
    `On conversation start: call skill(get, skillName='${routerSkillName}') then follow its bootstrap instructions.`,
    "Budget tracking: report [est]K / [zone] / [headroom] every turn. Zones: Green <360K, Yellow 360-480K, Red 480-580K, Imminent 580K+.",
  ];
}
