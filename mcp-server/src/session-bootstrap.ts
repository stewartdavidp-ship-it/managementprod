// ═══════════════════════════════════════════════════════════════
// Session Bootstrap & Init — Single-call startup replacement
// ═══════════════════════════════════════════════════════════════
// handleBootstrap(): Fan-out reads across Firebase, returns
// orientation payload (instructions, session, idea, jobs, signals).
//
// handleInit(): One-time onboarding entry point. Sets initialized
// flag, returns memory boot loader lines.
// ═══════════════════════════════════════════════════════════════

import { getCurrentUid, setServerSentTotal, setInteractionTotal } from "./context.js";
import {
  getProfileRef,
  getSessionsRef,
  getSessionRef,
  getJobsRef,
  getIdeasRef,
  getConceptsRef,
  getAppIdeasRef,
  getConfigRef,
} from "./firebase.js";
import { getCachedSkill } from "./skill-cache.js";
import { ensureSession, type SessionMetadata } from "./session-lifecycle.js";
import { loadSignalRegistry, type SignalDefinition } from "./signal-computation.js";
import { withResponseSize } from "./response-metadata.js";
import { resetSurfaceContext } from "./tools/sessions.js";
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
  appId: string | null;
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

  // Bootstrap = new conversation for this surface. Reset per-surface context counters
  // so _contextHealth starts fresh for this context window.
  // MUST await the Firebase write — fire-and-forget caused a race where the next
  // tool call's middleware loaded stale counters before the reset completed,
  // producing inflated _contextHealth (e.g., 577K at conversation start).
  if (sessionMeta) {
    await resetSurfaceContext(uid, sessionMeta.id, surface);
    setServerSentTotal(0);
    setInteractionTotal(0);
  }

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

  // Rule ceiling check — alert if active RULE count exceeds 40 for the active app
  const RULE_CEILING = 40;
  let ruleAlert: { ceiling: number; current: number; message: string } | null = null;
  const appId = activeIdeaData?.appId
    || activeSession?.appId
    || null;
  if (appId) {
    try {
      const appIdeasSnap = await getAppIdeasRef(uid, appId).once("value");
      const ideaIds: string[] = appIdeasSnap.val() || [];
      if (ideaIds.length > 0) {
        const conceptsSnap = await getConceptsRef(uid).once("value");
        const conceptsData = conceptsSnap.val() || {};
        let ruleCount = 0;
        for (const c of Object.values(conceptsData as Record<string, any>)) {
          if (c.status === "active" && c.type === "RULE" && ideaIds.includes(c.ideaOrigin)) {
            ruleCount++;
          }
        }
        if (ruleCount > RULE_CEILING) {
          // Look up app name for the alert message
          let appName = appId;
          try {
            const appSnap = await getConfigRef(uid).child("apps").child(appId).child("name").once("value");
            appName = appSnap.val() || appId;
          } catch { /* use appId as fallback */ }
          ruleAlert = {
            ceiling: RULE_CEILING,
            current: ruleCount,
            message: `⚠️ ${appName} has ${ruleCount} active RULEs — ceiling is ${RULE_CEILING}. A concept curation session is recommended before proceeding.`,
          };
        }
      }
    } catch { /* non-critical — skip alert on error */ }
  }

  const payload: Record<string, any> = {
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
  if (ruleAlert) {
    payload._ruleAlert = ruleAlert;
  }

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
  const writeInstructions = getWriteInstructions(surface);

  const payload = {
    memoryLines,
    writeInstructions,
    nextStep: `After writing memory, immediately call session(bootstrap, initiator='${surface}') to complete setup. Do this in the same conversation.`,
    userMessage:
      "Command Center initialized! Memory boot lines saved — future conversations will auto-bootstrap.",
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
      appId: idea.appId || null,
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

function getWriteInstructions(surface: Surface): string {
  const readBack =
    " After writing, tell the user exactly which lines you saved and where — confirm each one so they can verify.";
  switch (surface) {
    case "claude-code":
      return (
        "Write these lines to your MEMORY.md file using your Write tool. Append them under a '# Command Center' heading. If the file doesn't exist, create it with these lines." +
        readBack
      );
    case "claude-chat":
      return (
        "Save each of these lines to your memory so they persist across all future conversations." +
        readBack
      );
    case "claude-cowork":
    case "claude-chrome":
    case "claude-powerpoint":
    case "claude-excel":
      return (
        "Save these lines to your memory so they persist across sessions." +
        readBack
      );
    default:
      return (
        "Save these lines to your persistent memory. For Claude Code, write them to your MEMORY.md file. For Claude Chat, save them as memory entries." +
        readBack
      );
  }
}
