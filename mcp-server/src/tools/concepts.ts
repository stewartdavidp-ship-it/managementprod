import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConceptsRef, getConceptRef, getAppIdeasRef, getSessionRef, getJobRef, getIdeasRef, getConfigRef, getClaudeMdRef, getAttentionQueueRef, getNodeContentRef } from "../firebase.js";
import { getCurrentUid } from "../context.js";
import { withResponseSize } from "../response-metadata.js";
import { ensureSession } from "../session-lifecycle.js";
import { writeAttentionEntry } from "./sessions.js";

// Mirrors CC's ODRC_TYPES (index.html:4772)
const ODRC_TYPES = ["OPEN", "DECISION", "RULE", "CONSTRAINT"] as const;

// Mirrors CC's CONCEPT_STATUSES (index.html:4775)
const CONCEPT_STATUSES = ["active", "superseded", "resolved", "transitioned", "built"] as const;

// Mirrors CC's ODRC_TRANSITIONS (index.html:4778)
const ODRC_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["DECISION", "RULE", "CONSTRAINT"],
  DECISION: ["RULE"],
  CONSTRAINT: ["DECISION", "RULE"],
  RULE: ["OPEN"],
};

function isValidTransition(fromType: string, toType: string): boolean {
  return ODRC_TRANSITIONS[fromType]?.includes(toType) ?? false;
}

// Helper: increment conceptChangeCount on app record after concept mutations.
// Fire-and-forget — never blocks the mutation response or throws.
// Also checks attention queue threshold every 5th mutation.
async function incrementConceptChangeCount(uid: string, ideaOrigin: string): Promise<void> {
  try {
    // Resolve ideaOrigin → appId
    const ideaSnap = await getIdeasRef(uid).child(ideaOrigin).child("appId").once("value");
    const appId = ideaSnap.val();
    if (!appId) return; // No app linked — skip

    // Atomic increment on app config record
    const countRef = getConfigRef(uid).child("apps").child(appId).child("conceptChangeCount");
    const result = await countRef.transaction((current: number | null) => (current || 0) + 1);
    const newCount = result.snapshot.val() as number;

    // Check attention queue threshold every 5th mutation
    if (newCount % 5 === 0) {
      // Read generatedAtChangeCount from claudeMd record
      const claudeMdSnap = await getClaudeMdRef(uid, appId).child("generatedAtChangeCount").once("value");
      const generatedAt = claudeMdSnap.val() || 0;
      const delta = newCount - generatedAt;

      if (delta >= 5) {
        // Check if there's already an unresolved stale-claude-md entry for this app
        const attentionSnap = await getAttentionQueueRef(uid)
          .orderByChild("type")
          .equalTo("stale-claude-md")
          .once("value");
        const existing = attentionSnap.val();
        const alreadyExists = existing && Object.values(existing).some(
          (e: any) => !e.resolved && e.detail?.includes(appId)
        );

        if (!alreadyExists) {
          await writeAttentionEntry(uid, {
            type: "stale-claude-md",
            detail: `CLAUDE.md for "${appId}" is ${delta} concept changes behind. Regenerate to update project instructions.`,
          });
        }
      }
    }
  } catch {
    // Fire-and-forget — never crash the concept mutation
  }
}

// Helper: update job record when concept tools are called with jobId
async function updateJobRecord(
  uid: string,
  jobId: string,
  action: { type: "created" | "modified"; conceptId: string; eventType: string; detail: string; odrcType?: string }
): Promise<void> {
  const jobRef = getJobRef(uid, jobId);
  const jobSnap = await jobRef.once("value");
  const job = jobSnap.val();
  if (!job) return;

  const now = new Date().toISOString();
  const updates: Record<string, any> = {
    "metadata/toolCallCount": (job.metadata?.toolCallCount || 0) + 1,
  };

  if (action.type === "created") {
    const created = job.conceptsCreated || [];
    created.push(action.conceptId);
    updates.conceptsCreated = created;
  } else {
    const modified = job.conceptsModified || [];
    modified.push(action.conceptId);
    updates.conceptsModified = modified;
  }

  const events = job.events || [];
  events.push({
    timestamp: now,
    type: action.eventType,
    detail: action.detail,
    refId: action.conceptId,
  });
  updates.events = events;

  await jobRef.update(updates);
}

export function registerConceptTools(server: McpServer): void {

  // Concept scope values
  const CONCEPT_SCOPES = ["global", "app", "idea"] as const;

  // list_concepts — primary query tool for concepts (replaces get_active_concepts for grouped views)
  server.tool(
    "list_concepts",
    `List ODRC concepts. Filter by ideaId, appId, type, or status. Returns all concepts if no filters provided.
Set grouped=true to return concepts organized by type (rules, constraints, decisions, opens) instead of a flat list. When grouped=true, status defaults to "active".`,
    {
      ideaId: z.string().optional().describe("Filter by origin idea ID"),
      appId: z.string().optional().describe("Filter by app ID (returns concepts from all ideas linked to this app)"),
      type: z.enum(ODRC_TYPES).optional().describe("Filter by concept type: OPEN, DECISION, RULE, or CONSTRAINT"),
      status: z.enum(CONCEPT_STATUSES).optional().describe("Filter by status: active, superseded, resolved, or transitioned"),
      scope: z.enum(CONCEPT_SCOPES).optional().describe("Filter by scope: global, app, or idea"),
      summary: z.boolean().optional().describe("If true (default), return lean summary with content truncated to 150 chars. Set false for full objects."),
      grouped: z.boolean().optional().describe("If true, return concepts grouped by type { rules, constraints, decisions, opens, totalCount }. Defaults status to 'active'."),
      limit: z.number().int().optional().describe("Max results to return (default: 20)"),
      offset: z.number().int().optional().describe("Number of items to skip for pagination (default: 0)"),
    },
    async ({ ideaId, appId, type, status, scope, summary, grouped, limit, offset }) => {
      const uid = getCurrentUid();
      const useSummary = summary !== false; // default true
      const useGrouped = grouped === true;

      // When grouped=true, default status to "active" (the aggregate "current truth" view)
      const effectiveStatus = status || (useGrouped ? "active" : undefined);

      const snapshot = await getConceptsRef(uid).once("value");
      const data = snapshot.val();
      if (!data) {
        if (useGrouped) {
          return withResponseSize({ content: [{ type: "text" as const, text: JSON.stringify({ rules: [], constraints: [], decisions: [], opens: [], totalCount: 0 }, null, 2) }] });
        }
        return withResponseSize({ content: [{ type: "text" as const, text: JSON.stringify({ items: [], total: 0, offset: 0, limit: 20 }, null, 2) }] });
      }

      let concepts: any[] = Object.values(data);

      // Filter by app — get all idea IDs for this app first
      if (appId) {
        const appIdeasSnap = await getAppIdeasRef(uid, appId).once("value");
        const ideaIds: string[] = appIdeasSnap.val() || [];
        concepts = concepts.filter((c) => ideaIds.includes(c.ideaOrigin));
      }

      if (ideaId) concepts = concepts.filter((c) => c.ideaOrigin === ideaId);
      if (type) concepts = concepts.filter((c) => c.type === type);
      if (effectiveStatus) concepts = concepts.filter((c) => c.status === effectiveStatus);
      if (scope) concepts = concepts.filter((c) => (c.scope || "idea") === scope);

      // Projection function: summary (truncated) or full objects
      const project = useSummary
        ? (c: any) => ({
            id: c.id,
            type: c.type,
            content: c.content?.length > 150 ? c.content.substring(0, 150) + "..." : c.content,
            status: c.status,
            scopeTags: c.scopeTags || [],
            scope: c.scope || null,
            ideaOrigin: c.ideaOrigin,
            knowledgeRefCount: c.knowledgeRefCount || 0,
          })
        : (c: any) => c;

      // Grouped mode: return { rules, constraints, decisions, opens, totalCount }
      if (useGrouped) {
        const grouped = {
          rules: concepts.filter((c) => c.type === "RULE").map(project),
          constraints: concepts.filter((c) => c.type === "CONSTRAINT").map(project),
          decisions: concepts.filter((c) => c.type === "DECISION").map(project),
          opens: concepts.filter((c) => c.type === "OPEN").map(project),
          totalCount: concepts.length,
        };

        const AVG_CONCEPT_FULL_SIZE = 500;
        const extraMeta: Record<string, number> = {};
        if (useSummary && concepts.length > 0) {
          extraMeta._estimatedFullSize = concepts.length * AVG_CONCEPT_FULL_SIZE;
        }

        return withResponseSize(
          { content: [{ type: "text" as const, text: JSON.stringify(grouped, null, 2) }] },
          extraMeta
        );
      }

      // Flat list mode (original behavior): paginated results
      const total = concepts.length;
      const skip = offset && offset > 0 ? offset : 0;
      const take = limit && limit > 0 ? limit : 20;
      concepts = concepts.slice(skip, skip + take);

      const projected = concepts.map(project);

      // Estimate average full-detail item size from current page
      const avgItemSize = concepts.length > 0
        ? Math.round(concepts.reduce((sum, c) => sum + JSON.stringify(c).length, 0) / concepts.length)
        : 0;

      return withResponseSize(
        { content: [{ type: "text" as const, text: JSON.stringify({ items: projected, total, offset: skip, limit: take }, null, 2) }] },
        { _estimatedItemSize: avgItemSize }
      );
    }
  );

  // concept — Consolidated ODRC concept mutation tool
  server.tool(
    "concept",
    `ODRC concept mutation tool. Actions:
  - "get": Get a single concept by ID. Requires conceptId. Returns full record including knowledgeRefs.
  - "create": Create a new concept. Requires type (OPEN/DECISION/RULE/CONSTRAINT), content, ideaOrigin. Optional: scopeTags, sessionId, jobId.
  - "update": Update content or scopeTags on an active concept. Requires conceptId. Optional: content, scopeTags.
  - "transition": Transition to a new type following state machine (OPEN→DECISION/RULE/CONSTRAINT, DECISION→RULE, CONSTRAINT→DECISION/RULE, RULE→OPEN). Requires conceptId, newType. Optional: sessionId, jobId.
  - "supersede": Replace content, same type. Requires conceptId, newContent. Optional: sessionId, jobId.
  - "resolve": Mark as resolved (typically OPENs). Requires conceptId. Optional: sessionId, jobId.
  - "mark_built": Mark a DECISION as "built" (implemented in code). Requires conceptId. Only valid for active DECISIONs.
  - "migrate": Re-parent a concept to a different idea. Requires conceptId, newIdeaId. Updates ideaOrigin.
  - "add_knowledge_ref": Link a concept to a knowledge tree node. Requires conceptId, nodeId, treeId, treeName. Optional: relationship (supports|informs|constrains|contradicts, default: supports).
  - "remove_knowledge_ref": Unlink a concept from a knowledge tree node. Requires conceptId, nodeId.
  - "check_evidence_drift": Check if a concept's linked knowledge nodes have been updated since they were linked. Requires conceptId. Returns drift status per ref.
  - "delete": Delete a concept. Requires conceptId. Use for test cleanup only.`,
    {
      action: z.enum(["get", "create", "update", "transition", "supersede", "resolve", "mark_built", "migrate", "add_knowledge_ref", "remove_knowledge_ref", "check_evidence_drift", "delete"]).describe("Action to perform"),
      conceptId: z.string().optional().describe("Concept ID (required for update/transition/supersede/resolve/mark_built/migrate)"),
      type: z.enum(ODRC_TYPES).optional().describe("Concept type (required for create): OPEN, DECISION, RULE, or CONSTRAINT"),
      content: z.string().optional().describe("Concept text (required for create, optional for update)"),
      newContent: z.string().optional().describe("Replacement text (required for supersede)"),
      newType: z.enum(ODRC_TYPES).optional().describe("Target type (required for transition)"),
      ideaOrigin: z.string().optional().describe("Origin idea ID (required for create)"),
      newIdeaId: z.string().optional().describe("New idea ID to migrate concept to (required for migrate)"),
      scope: z.enum(["global", "app", "idea"]).optional().describe("Concept scope: global (cross-app), app (within one app), or idea (current phase only). Optional for create/update."),
      scopeTags: z.array(z.string()).optional().describe("Scope tags (optional for create/update)"),
      nodeId: z.string().optional().describe("Knowledge node ID (required for add_knowledge_ref/remove_knowledge_ref)"),
      treeId: z.string().optional().describe("Knowledge tree ID (required for add_knowledge_ref)"),
      treeName: z.string().optional().describe("Knowledge tree name for display (required for add_knowledge_ref)"),
      relationship: z.enum(["supports", "informs", "constrains", "contradicts"]).optional().describe("How the knowledge relates to this concept (default: supports). For add_knowledge_ref."),
      sessionId: z.string().optional().describe("Active session ID for tracking (optional for create/transition/supersede/resolve)"),
      jobId: z.string().optional().describe("Active job ID for tracking (optional for create/transition/supersede/resolve)"),
    },
    async ({ action, conceptId, type, content, newContent, newType, ideaOrigin, newIdeaId, scope, scopeTags, nodeId, treeId, treeName, relationship, sessionId, jobId }) => {
      const uid = getCurrentUid();

      // ─── GET ───
      if (action === "get") {
        if (!conceptId) return withResponseSize({ content: [{ type: "text", text: "action 'get' requires conceptId" }], isError: true });

        const ref = getConceptRef(uid, conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();
        if (!concept) return withResponseSize({ content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true });

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(concept, null, 2) }] });
      }

      // ─── CREATE ───
      if (action === "create") {
        if (!type) return { content: [{ type: "text", text: "action 'create' requires type (OPEN/DECISION/RULE/CONSTRAINT)" }], isError: true };
        if (!content) return { content: [{ type: "text", text: "action 'create' requires content" }], isError: true };
        if (!ideaOrigin) return { content: [{ type: "text", text: "action 'create' requires ideaOrigin" }], isError: true };

        // Mismatch detection: resolve idea's appId and check against active session
        // Cache hit on ensureSession (free) — Firebase query was done in middleware
        let sessionMismatch: any = null;
        try {
          const ideaSnap = await getIdeasRef(uid).child(ideaOrigin).child("appId").once("value");
          const ideaAppId = ideaSnap.val();
          if (ideaAppId) {
            const sessionCheck = await ensureSession({ appId: ideaAppId, ideaId: ideaOrigin });
            if (sessionCheck.mismatch) {
              sessionMismatch = {
                warning: "Concept's idea/app context does not match active session",
                activeSession: sessionCheck.existingSession,
              };
            }
          }
        } catch {
          // Non-critical — skip mismatch check if idea lookup fails
        }

        const ref = getConceptsRef(uid).push();
        const now = new Date().toISOString();
        const concept: Record<string, any> = {
          id: ref.key,
          type,
          content,
          ideaOrigin,
          status: "active",
          resolvedBy: null,
          transitionedFrom: null,
          scopeTags: scopeTags || [],
          knowledgeRefs: [],
          knowledgeRefCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        if (scope) concept.scope = scope;
        await ref.set(concept);

        // Update session record if sessionId provided
        if (sessionId) {
          const sessionRef = getSessionRef(uid, sessionId);
          const sessionSnap = await sessionRef.once("value");
          const session = sessionSnap.val();
          if (session) {
            const created = session.conceptsCreated || [];
            created.push(ref.key!);
            const events = session.events || [];
            events.push({
              timestamp: now,
              type: "concept_created",
              detail: `Created ${type}: ${content.substring(0, 80)}${content.length > 80 ? "..." : ""}`,
              refId: ref.key,
            });
            const conceptCount = session.metadata?.conceptCount || { OPEN: 0, DECISION: 0, RULE: 0, CONSTRAINT: 0 };
            conceptCount[type] = (conceptCount[type] || 0) + 1;
            await sessionRef.update({
              conceptsCreated: created,
              events,
              "metadata/toolCallCount": (session.metadata?.toolCallCount || 0) + 1,
              "metadata/conceptCount": conceptCount,
            });
          }
        }

        // Update job record if jobId provided
        if (jobId) {
          await updateJobRecord(uid, jobId, {
            type: "created",
            conceptId: ref.key!,
            eventType: "concept_created",
            detail: `Created ${type}: ${content.substring(0, 80)}${content.length > 80 ? "..." : ""}`,
            odrcType: type,
          });
        }

        // Increment conceptChangeCount on app record (fire-and-forget)
        incrementConceptChangeCount(uid, ideaOrigin);

        const result: any = concept;
        if (sessionMismatch) result._sessionMismatch = sessionMismatch;
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ─── UPDATE ───
      if (action === "update") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'update' requires conceptId" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const existing = snapshot.val();
        if (!existing) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };

        const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
        if (content !== undefined) updates.content = content;
        if (scope !== undefined) updates.scope = scope;
        if (scopeTags !== undefined) updates.scopeTags = scopeTags;

        await ref.update(updates);

        // Increment conceptChangeCount if content or scopeTags changed (affects CLAUDE.md output)
        if (content !== undefined || scopeTags !== undefined) {
          incrementConceptChangeCount(uid, existing.ideaOrigin);
        }

        return { content: [{ type: "text", text: JSON.stringify({ ...existing, ...updates }, null, 2) }] };
      }

      // ─── TRANSITION ───
      if (action === "transition") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'transition' requires conceptId" }], isError: true };
        if (!newType) return { content: [{ type: "text", text: "action 'transition' requires newType" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();

        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };
        if (concept.status !== "active") {
          return { content: [{ type: "text", text: `Cannot transition non-active concept (status: ${concept.status})` }], isError: true };
        }
        if (!isValidTransition(concept.type, newType)) {
          return {
            content: [{ type: "text", text: `Invalid transition: ${concept.type} → ${newType}. Allowed: ${ODRC_TRANSITIONS[concept.type].join(", ")}` }],
            isError: true,
          };
        }

        const now = new Date().toISOString();
        const newRef = getConceptsRef(uid).push();
        const newConcept: Record<string, any> = {
          id: newRef.key,
          type: newType,
          content: concept.content,
          ideaOrigin: concept.ideaOrigin,
          status: "active",
          resolvedBy: null,
          transitionedFrom: conceptId,
          scopeTags: concept.scopeTags || [],
          createdAt: now,
          updatedAt: now,
        };
        if (concept.scope) newConcept.scope = concept.scope;

        // Flag related concepts if CONSTRAINT transitions
        let flaggedConcepts: any[] = [];
        if (concept.type === "CONSTRAINT" && concept.scopeTags?.length > 0) {
          const allSnap = await getConceptsRef(uid).once("value");
          const allData = allSnap.val() || {};
          const allConcepts: any[] = Object.values(allData);
          flaggedConcepts = allConcepts.filter(
            (c) =>
              c.id !== conceptId &&
              c.status === "active" &&
              (c.type === "DECISION" || c.type === "RULE") &&
              (c.scopeTags || []).some((tag: string) => concept.scopeTags.includes(tag))
          );
        }

        // Atomic multi-path update
        const fbUpdates: Record<string, any> = {};
        fbUpdates[`${conceptId}/status`] = "transitioned";
        fbUpdates[`${conceptId}/resolvedBy`] = newRef.key;
        fbUpdates[`${conceptId}/updatedAt`] = now;
        fbUpdates[newRef.key!] = newConcept;
        await getConceptsRef(uid).update(fbUpdates);

        // Update session record if sessionId provided
        if (sessionId) {
          const sessionRef = getSessionRef(uid, sessionId);
          const sessionSnap = await sessionRef.once("value");
          const session = sessionSnap.val();
          if (session) {
            const modified = session.conceptsModified || [];
            modified.push(conceptId);
            const created = session.conceptsCreated || [];
            created.push(newRef.key!);
            const events = session.events || [];
            events.push({
              timestamp: now,
              type: "concept_transitioned",
              detail: `Transitioned ${concept.type} → ${newType}: ${concept.content.substring(0, 80)}${concept.content.length > 80 ? "..." : ""}`,
              refId: newRef.key,
            });
            const conceptCount = session.metadata?.conceptCount || { OPEN: 0, DECISION: 0, RULE: 0, CONSTRAINT: 0 };
            conceptCount[newType] = (conceptCount[newType] || 0) + 1;
            await sessionRef.update({
              conceptsModified: modified,
              conceptsCreated: created,
              events,
              "metadata/toolCallCount": (session.metadata?.toolCallCount || 0) + 1,
              "metadata/conceptCount": conceptCount,
            });
          }
        }

        // Update job record if jobId provided
        if (jobId) {
          await updateJobRecord(uid, jobId, {
            type: "modified",
            conceptId,
            eventType: "concept_transitioned",
            detail: `Transitioned ${concept.type} → ${newType}: ${concept.content.substring(0, 80)}${concept.content.length > 80 ? "..." : ""}`,
          });
          await updateJobRecord(uid, jobId, {
            type: "created",
            conceptId: newRef.key!,
            eventType: "concept_created",
            detail: `Created ${newType} (from transition): ${concept.content.substring(0, 80)}${concept.content.length > 80 ? "..." : ""}`,
          });
        }

        // Increment conceptChangeCount on app record (fire-and-forget)
        incrementConceptChangeCount(uid, concept.ideaOrigin);

        const result: any = { newConcept };
        if (flaggedConcepts.length > 0) {
          result.flaggedForReview = flaggedConcepts;
          result.warning = `${flaggedConcepts.length} related DECISION/RULE concepts share scope tags with this CONSTRAINT and should be reviewed.`;
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ─── SUPERSEDE ───
      if (action === "supersede") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'supersede' requires conceptId" }], isError: true };
        if (!newContent) return { content: [{ type: "text", text: "action 'supersede' requires newContent" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();

        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };

        const now = new Date().toISOString();
        const newRef = getConceptsRef(uid).push();
        const newConcept: Record<string, any> = {
          id: newRef.key,
          type: concept.type,
          content: newContent,
          ideaOrigin: concept.ideaOrigin,
          status: "active",
          resolvedBy: null,
          transitionedFrom: conceptId,
          scopeTags: concept.scopeTags || [],
          createdAt: now,
          updatedAt: now,
        };
        if (concept.scope) newConcept.scope = concept.scope;

        const fbUpdates: Record<string, any> = {};
        fbUpdates[`${conceptId}/status`] = "superseded";
        fbUpdates[`${conceptId}/resolvedBy`] = newRef.key;
        fbUpdates[`${conceptId}/updatedAt`] = now;
        fbUpdates[newRef.key!] = newConcept;
        await getConceptsRef(uid).update(fbUpdates);

        // Update session record if sessionId provided
        if (sessionId) {
          const sessionRef = getSessionRef(uid, sessionId);
          const sessionSnap = await sessionRef.once("value");
          const session = sessionSnap.val();
          if (session) {
            const modified = session.conceptsModified || [];
            modified.push(conceptId);
            const created = session.conceptsCreated || [];
            created.push(newRef.key!);
            const events = session.events || [];
            events.push({
              timestamp: now,
              type: "concept_transitioned",
              detail: `Superseded ${concept.type}: ${newContent.substring(0, 80)}${newContent.length > 80 ? "..." : ""}`,
              refId: newRef.key,
            });
            await sessionRef.update({
              conceptsModified: modified,
              conceptsCreated: created,
              events,
              "metadata/toolCallCount": (session.metadata?.toolCallCount || 0) + 1,
            });
          }
        }

        // Update job record if jobId provided
        if (jobId) {
          await updateJobRecord(uid, jobId, {
            type: "modified",
            conceptId,
            eventType: "concept_transitioned",
            detail: `Superseded ${concept.type}: ${newContent.substring(0, 80)}${newContent.length > 80 ? "..." : ""}`,
          });
          await updateJobRecord(uid, jobId, {
            type: "created",
            conceptId: newRef.key!,
            eventType: "concept_created",
            detail: `Created ${concept.type} (superseded): ${newContent.substring(0, 80)}${newContent.length > 80 ? "..." : ""}`,
          });
        }

        // Increment conceptChangeCount on app record (fire-and-forget)
        incrementConceptChangeCount(uid, concept.ideaOrigin);

        return { content: [{ type: "text", text: JSON.stringify(newConcept, null, 2) }] };
      }

      // ─── RESOLVE ───
      if (action === "resolve") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'resolve' requires conceptId" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();

        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };

        const now = new Date().toISOString();
        await ref.update({ status: "resolved", updatedAt: now });

        // Update session record if sessionId provided
        if (sessionId) {
          const sessionRef = getSessionRef(uid, sessionId);
          const sessionSnap = await sessionRef.once("value");
          const session = sessionSnap.val();
          if (session) {
            const modified = session.conceptsModified || [];
            modified.push(conceptId);
            const events = session.events || [];
            events.push({
              timestamp: now,
              type: "concept_transitioned",
              detail: `Resolved ${concept.type}: ${concept.content.substring(0, 80)}${concept.content.length > 80 ? "..." : ""}`,
              refId: conceptId,
            });
            await sessionRef.update({
              conceptsModified: modified,
              events,
              "metadata/toolCallCount": (session.metadata?.toolCallCount || 0) + 1,
            });
          }
        }

        // Update job record if jobId provided
        if (jobId) {
          await updateJobRecord(uid, jobId, {
            type: "modified",
            conceptId,
            eventType: "concept_transitioned",
            detail: `Resolved ${concept.type}: ${concept.content.substring(0, 80)}${concept.content.length > 80 ? "..." : ""}`,
          });
        }

        // Increment conceptChangeCount on app record (fire-and-forget)
        incrementConceptChangeCount(uid, concept.ideaOrigin);

        return { content: [{ type: "text", text: JSON.stringify({ ...concept, status: "resolved", updatedAt: now }, null, 2) }] };
      }

      // ─── MARK_BUILT ───
      if (action === "mark_built") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'mark_built' requires conceptId" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();

        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };
        if (concept.status !== "active") {
          return { content: [{ type: "text", text: `Cannot mark non-active concept as built (status: ${concept.status})` }], isError: true };
        }
        if (concept.type !== "DECISION") {
          return { content: [{ type: "text", text: `Only DECISIONs can be marked as built (type: ${concept.type}). RULEs/CONSTRAINTs are ongoing governance, OPENs get resolved.` }], isError: true };
        }

        const now = new Date().toISOString();
        await ref.update({ status: "built", updatedAt: now });

        // Increment conceptChangeCount on app record (fire-and-forget)
        incrementConceptChangeCount(uid, concept.ideaOrigin);

        return { content: [{ type: "text", text: JSON.stringify({ ...concept, status: "built", updatedAt: now }, null, 2) }] };
      }

      // ─── MIGRATE ───
      if (action === "migrate") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'migrate' requires conceptId" }], isError: true };
        if (!newIdeaId) return { content: [{ type: "text", text: "action 'migrate' requires newIdeaId" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();

        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };
        if (concept.status !== "active") {
          return { content: [{ type: "text", text: `Cannot migrate non-active concept (status: ${concept.status})` }], isError: true };
        }

        const now = new Date().toISOString();
        const oldIdeaOrigin = concept.ideaOrigin;
        await ref.update({ ideaOrigin: newIdeaId, updatedAt: now });

        // Increment conceptChangeCount on both old and new app (affects both CLAUDE.md outputs)
        incrementConceptChangeCount(uid, oldIdeaOrigin);
        incrementConceptChangeCount(uid, newIdeaId);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...concept,
              ideaOrigin: newIdeaId,
              updatedAt: now,
              migratedFrom: oldIdeaOrigin,
            }, null, 2),
          }],
        };
      }

      // ─── ADD_KNOWLEDGE_REF ───
      if (action === "add_knowledge_ref") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'add_knowledge_ref' requires conceptId" }], isError: true };
        if (!nodeId) return { content: [{ type: "text", text: "action 'add_knowledge_ref' requires nodeId" }], isError: true };
        if (!treeId) return { content: [{ type: "text", text: "action 'add_knowledge_ref' requires treeId" }], isError: true };
        if (!treeName) return { content: [{ type: "text", text: "action 'add_knowledge_ref' requires treeName" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();
        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };

        const refs: any[] = concept.knowledgeRefs || [];

        // Check for duplicate
        if (refs.some((r: any) => r.nodeId === nodeId)) {
          return { content: [{ type: "text", text: JSON.stringify({ warning: "Knowledge ref already exists", conceptId, nodeId }, null, 2) }] };
        }

        const now = new Date().toISOString();
        const knowledgeRef = {
          nodeId,
          treeId,
          treeName,
          relationship: relationship || "supports",
          addedAt: now,
        };
        refs.push(knowledgeRef);

        await ref.update({
          knowledgeRefs: refs,
          knowledgeRefCount: refs.length,
          updatedAt: now,
        });

        return { content: [{ type: "text", text: JSON.stringify({ added: knowledgeRef, knowledgeRefCount: refs.length }, null, 2) }] };
      }

      // ─── REMOVE_KNOWLEDGE_REF ───
      if (action === "remove_knowledge_ref") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'remove_knowledge_ref' requires conceptId" }], isError: true };
        if (!nodeId) return { content: [{ type: "text", text: "action 'remove_knowledge_ref' requires nodeId" }], isError: true };

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();
        if (!concept) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };

        const refs: any[] = concept.knowledgeRefs || [];
        const filtered = refs.filter((r: any) => r.nodeId !== nodeId);

        if (filtered.length === refs.length) {
          return { content: [{ type: "text", text: JSON.stringify({ warning: "Knowledge ref not found", conceptId, nodeId }, null, 2) }] };
        }

        const now = new Date().toISOString();
        await ref.update({
          knowledgeRefs: filtered,
          knowledgeRefCount: filtered.length,
          updatedAt: now,
        });

        return { content: [{ type: "text", text: JSON.stringify({ removed: nodeId, knowledgeRefCount: filtered.length }, null, 2) }] };
      }

      // ─── CHECK_EVIDENCE_DRIFT ───
      if (action === "check_evidence_drift") {
        if (!conceptId) return withResponseSize({ content: [{ type: "text", text: "action 'check_evidence_drift' requires conceptId" }], isError: true });

        const ref = getConceptsRef(uid).child(conceptId);
        const snapshot = await ref.once("value");
        const concept = snapshot.val();
        if (!concept) return withResponseSize({ content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true });

        const refs: any[] = concept.knowledgeRefs || [];
        if (refs.length === 0) {
          return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ hasDrift: false, refs: [], conceptId }, null, 2) }] });
        }

        // Parallel-load all referenced node content records
        const nodeSnaps = await Promise.all(
          refs.map((r: any) => getNodeContentRef(uid, r.nodeId).once("value"))
        );

        let hasDrift = false;
        const refResults = refs.map((r: any, i: number) => {
          const node = nodeSnaps[i].val();
          if (!node) {
            return { nodeId: r.nodeId, treeId: r.treeId, status: "missing", drifted: true };
          }
          const addedAt = r.addedAt || concept.createdAt;
          const nodeUpdatedAt = node.updatedAt || node.createdAt;
          const drifted = nodeUpdatedAt > addedAt;
          if (drifted) hasDrift = true;
          return {
            nodeId: r.nodeId,
            treeId: r.treeId,
            relationship: r.relationship || "supports",
            addedAt,
            nodeUpdatedAt,
            drifted,
          };
        });

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ hasDrift, driftedRefCount: refResults.filter((r: any) => r.drifted).length, totalRefs: refs.length, refs: refResults, conceptId }, null, 2) }] });
      }

      // ─── DELETE ───
      if (action === "delete") {
        if (!conceptId) return { content: [{ type: "text", text: "action 'delete' requires conceptId" }], isError: true };

        const ref = getConceptRef(uid, conceptId);
        const snapshot = await ref.once("value");
        if (!snapshot.val()) return { content: [{ type: "text", text: `Concept not found: ${conceptId}` }], isError: true };

        await ref.remove();
        return { content: [{ type: "text", text: JSON.stringify({ deleted: conceptId }) }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
    }
  );

  // get_active_concepts — thin wrapper over list_concepts(grouped=true) for backward compat
  // Prefer list_concepts with grouped=true for new code.
  server.tool(
    "get_active_concepts",
    `Get all active ODRC concepts across all ideas for an app. This is the 'current truth' view — all active RULEs, CONSTRAINTs, DECISIONs, and unresolved OPENs.
By default returns summary fields (content truncated to 150 chars, timestamps stripped). Set summary=false for full objects.
Note: Prefer list_concepts with grouped=true for the same result with more filtering options.`,
    {
      appId: z.string().describe("The app ID to get active concepts for"),
      summary: z.boolean().optional().describe("If true (default), return lean summary with truncated content. Set false for full objects."),
      includeDriftCheck: z.boolean().optional().describe("If true, check evidence drift for concepts with knowledgeRefs. Adds evidenceDrift field to each concept. Default false."),
    },
    async ({ appId, summary, includeDriftCheck }) => {
      // Delegate to the same logic as list_concepts(grouped=true, status="active")
      const useSummary = summary !== false;
      const uid = getCurrentUid();
      const appIdeasSnap = await getAppIdeasRef(uid, appId).once("value");
      const ideaIds: string[] = appIdeasSnap.val() || [];

      if (ideaIds.length === 0) {
        return withResponseSize({ content: [{ type: "text" as const, text: JSON.stringify({ rules: [], constraints: [], decisions: [], opens: [], totalCount: 0 }, null, 2) }] });
      }

      const allSnap = await getConceptsRef(uid).once("value");
      const allData = allSnap.val() || {};
      const allConcepts: any[] = Object.values(allData);
      const active = allConcepts.filter((c) => ideaIds.includes(c.ideaOrigin) && c.status === "active");

      // Evidence drift check: load referenced nodes and compare timestamps
      let driftMap: Map<string, { hasDrift: boolean; driftedRefCount: number }> | null = null;
      if (includeDriftCheck) {
        driftMap = new Map();
        const conceptsWithRefs = active.filter((c) => (c.knowledgeRefCount || 0) > 0 && (c.knowledgeRefs || []).length > 0);

        // Collect all unique nodeIds across all concepts
        const allNodeIds = new Set<string>();
        for (const c of conceptsWithRefs) {
          for (const r of (c.knowledgeRefs || [])) {
            allNodeIds.add(r.nodeId);
          }
        }

        // Batch-load all referenced nodes in parallel
        const nodeIdList = Array.from(allNodeIds);
        const nodeSnaps = await Promise.all(
          nodeIdList.map((nId) => getNodeContentRef(uid, nId).once("value"))
        );
        const nodeMap = new Map<string, any>();
        for (let i = 0; i < nodeIdList.length; i++) {
          nodeMap.set(nodeIdList[i], nodeSnaps[i].val());
        }

        // Compute drift per concept
        for (const c of conceptsWithRefs) {
          let driftedCount = 0;
          for (const r of (c.knowledgeRefs || [])) {
            const node = nodeMap.get(r.nodeId);
            if (!node) { driftedCount++; continue; }
            const addedAt = r.addedAt || c.createdAt;
            const nodeUpdatedAt = node.updatedAt || node.createdAt;
            if (nodeUpdatedAt > addedAt) driftedCount++;
          }
          driftMap.set(c.id, { hasDrift: driftedCount > 0, driftedRefCount: driftedCount });
        }
      }

      const project = useSummary
        ? (c: any) => {
            const base: any = {
              id: c.id,
              type: c.type,
              content: c.content?.length > 150 ? c.content.substring(0, 150) + "..." : c.content,
              status: c.status,
              scopeTags: c.scopeTags || [],
              scope: c.scope || null,
              ideaOrigin: c.ideaOrigin,
              knowledgeRefCount: c.knowledgeRefCount || 0,
            };
            if (driftMap?.has(c.id)) base.evidenceDrift = driftMap.get(c.id);
            return base;
          }
        : (c: any) => {
            if (driftMap?.has(c.id)) return { ...c, evidenceDrift: driftMap.get(c.id) };
            return c;
          };

      const grouped = {
        rules: active.filter((c) => c.type === "RULE").map(project),
        constraints: active.filter((c) => c.type === "CONSTRAINT").map(project),
        decisions: active.filter((c) => c.type === "DECISION").map(project),
        opens: active.filter((c) => c.type === "OPEN").map(project),
        totalCount: active.length,
      };

      const AVG_CONCEPT_FULL_SIZE = 500;
      const extraMeta: Record<string, number> = {};
      if (useSummary && active.length > 0) {
        extraMeta._estimatedFullSize = active.length * AVG_CONCEPT_FULL_SIZE;
      }

      return withResponseSize(
        { content: [{ type: "text" as const, text: JSON.stringify(grouped, null, 2) }] },
        extraMeta
      );
    }
  );
}
