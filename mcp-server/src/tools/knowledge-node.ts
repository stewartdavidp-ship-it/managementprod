import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTreeRef, getTreeIndexRef, getNodeContentRef, getNodesRef } from "../firebase.js";
import { getCurrentUid } from "../context.js";
import { withResponseSize } from "../response-metadata.js";

const TRUST_LEVELS = ["authoritative", "credible", "unverified", "questionable"] as const;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function registerKnowledgeNodeTools(server: McpServer): void {

  server.tool(
    "knowledge_node",
    `Knowledge node content CRUD with selective loading. Nodes contain the actual knowledge — curated findings, sources, and cross-references. Each node has an index entry (cheap, always loaded with tree) and a content record (expensive, loaded on demand).

Actions:
  - "create": Create a node in a tree. Requires treeId, question, content. Optional: trust, parentId, keyFinding, sources (JSON string), consensusNotes, crossRefs (JSON string). Auto-computes tokenCount. Creates index entry + content record atomically. Updates tree aggregates.
  - "update": Update a node. Requires nodeId. Optional: question, content, trust, keyFinding, parentId, sources, consensusNotes, crossRefs, lastVerified. Recomputes token cost if content changes. Updates tree aggregates if trust/content changes.
  - "delete": Delete a node. Requires nodeId. Removes index entry + content record. Updates tree aggregates and parent childIds.
  - "load": Load a single node's full content. Requires nodeId. Returns content, sources, crossRefs, tokenCount.
  - "load_batch": Load multiple nodes in parallel. Requires nodeIds (array, max 10). Returns map of nodeId → content record.
  - "move": Reparent a node. Requires nodeId, newParentId (use "root" to make a root node). Updates hierarchy.`,
    {
      action: z.enum(["create", "update", "delete", "load", "load_batch", "move"]).describe("Action to perform"),
      treeId: z.string().optional().describe("Tree ID (required for create)"),
      nodeId: z.string().optional().describe("Node ID (required for update/delete/load/move)"),
      nodeIds: z.array(z.string()).optional().describe("Node IDs for load_batch (max 10)"),
      question: z.string().optional().describe("Routing question the node answers (required for create, optional for update)"),
      content: z.string().optional().describe("Full curated findings in markdown (required for create, optional for update)"),
      keyFinding: z.string().optional().describe("One-line key finding summary (auto-generated from content if not provided on create)"),
      trust: z.enum(TRUST_LEVELS).optional().describe("Trust rating (default: unverified)"),
      parentId: z.string().optional().describe("Parent node ID for hierarchy (optional for create, update)"),
      newParentId: z.string().optional().describe("New parent node ID for move (use 'root' to make a root node)"),
      sources: z.string().optional().describe("JSON array of source objects: [{url, document, section, credibility, credibilityRationale, discoveryQuery?}]. discoveryQuery records the search query that surfaced this source."),
      consensusNotes: z.string().optional().describe("Agreement/divergence notes across sources"),
      crossRefs: z.string().optional().describe("JSON array of cross-references: [{nodeId, treeId, relationship}]"),
      lastVerified: z.string().optional().describe("ISO date when node was last verified (optional for update)"),
    },
    async ({ action, treeId, nodeId, nodeIds, question, content, keyFinding, trust, parentId, newParentId, sources, consensusNotes, crossRefs, lastVerified }) => {
      const uid = getCurrentUid();

      // Parse JSON string params
      let parsedSources: any[] | undefined;
      let parsedCrossRefs: any[] | undefined;
      if (sources) {
        try { parsedSources = JSON.parse(sources); } catch {
          return withResponseSize({ content: [{ type: "text", text: "sources must be a valid JSON array" }], isError: true });
        }
      }
      if (crossRefs) {
        try { parsedCrossRefs = JSON.parse(crossRefs); } catch {
          return withResponseSize({ content: [{ type: "text", text: "crossRefs must be a valid JSON array" }], isError: true });
        }
      }

      // ─── CREATE ───
      if (action === "create") {
        if (!treeId) return withResponseSize({ content: [{ type: "text", text: "create requires treeId" }], isError: true });
        if (!question) return withResponseSize({ content: [{ type: "text", text: "create requires question" }], isError: true });
        if (!content) return withResponseSize({ content: [{ type: "text", text: "create requires content" }], isError: true });

        // Verify tree exists
        const treeSnap = await getTreeRef(uid, treeId).once("value");
        const tree = treeSnap.val();
        if (!tree) return withResponseSize({ content: [{ type: "text", text: `Tree not found: ${treeId}` }], isError: true });

        const tokenCount = estimateTokens(content);
        const effectiveTrust = trust || "unverified";
        const now = new Date().toISOString();
        const autoKeyFinding = keyFinding || content.substring(0, 120) + (content.length > 120 ? "..." : "");

        // Generate node ID via push
        const nodeRef = getNodesRef(uid).push();
        const nId = nodeRef.key!;

        // Build index entry
        const indexEntry = {
          id: nId,
          question,
          keyFinding: autoKeyFinding,
          tokenCost: tokenCount,
          trust: effectiveTrust,
          lastVerified: now,
          parentId: parentId || null,
          childIds: [],
          order: 0,
          createdAt: now,
          updatedAt: now,
        };

        // Build content record
        const contentRecord: Record<string, any> = {
          id: nId,
          treeId,
          content,
          sources: parsedSources || [],
          consensusNotes: consensusNotes || null,
          crossRefs: parsedCrossRefs || [],
          tokenCount,
          createdAt: now,
          updatedAt: now,
        };

        // Compute new tree aggregates
        const newTokenUsed = (tree.tokenUsed || 0) + tokenCount;
        const newNodeCount = (tree.nodeCount || 0) + 1;
        const newTrustProfile = { ...(tree.trustProfile || { authoritative: 0, credible: 0, unverified: 0, questionable: 0 }) };
        newTrustProfile[effectiveTrust] = (newTrustProfile[effectiveTrust] || 0) + 1;

        // Multi-path atomic update: index entry + content record + tree aggregates
        // Index is under trees/{treeId}/index/{nodeId}
        // Content is under nodes/{nodeId}
        // We need two separate updates since they're in different top-level paths
        const treeUpdates: Record<string, any> = {
          [`index/${nId}`]: indexEntry,
          tokenUsed: newTokenUsed,
          nodeCount: newNodeCount,
          trustProfile: newTrustProfile,
          updatedAt: now,
        };

        // Update lastVerified on tree if this is newer
        if (!tree.lastVerified || now > tree.lastVerified) {
          treeUpdates.lastVerified = now;
        }

        // Update parent's childIds if parentId specified
        if (parentId) {
          const parentIndexSnap = await getTreeIndexRef(uid, treeId).child(parentId).once("value");
          const parentIndex = parentIndexSnap.val();
          if (parentIndex) {
            const childIds: string[] = parentIndex.childIds || [];
            if (!childIds.includes(nId)) {
              childIds.push(nId);
              treeUpdates[`index/${parentId}/childIds`] = childIds;
            }
          }
          // Compute order as last among siblings
          indexEntry.order = parentIndex ? (parentIndex.childIds || []).length : 0;
        }

        await Promise.all([
          getTreeRef(uid, treeId).update(treeUpdates),
          getNodeContentRef(uid, nId).set(contentRecord),
        ]);

        // Build response
        const result: any = { indexEntry, contentRecord };
        const budgetRemaining = (tree.tokenBudget || 150000) - newTokenUsed;
        if (budgetRemaining < 0) {
          result.warning = `Tree token budget exceeded! Used: ${newTokenUsed}, Budget: ${tree.tokenBudget || 150000}. Consider splitting the tree.`;
        }

        return withResponseSize(
          { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
          { _nodeTokenCost: tokenCount, _treeBudgetRemaining: budgetRemaining }
        );
      }

      // ─── UPDATE ───
      if (action === "update") {
        if (!nodeId) return withResponseSize({ content: [{ type: "text", text: "update requires nodeId" }], isError: true });

        // Load existing content record to find treeId
        const contentSnap = await getNodeContentRef(uid, nodeId).once("value");
        const existing = contentSnap.val();
        if (!existing) return withResponseSize({ content: [{ type: "text", text: `Node not found: ${nodeId}` }], isError: true });

        const nodeTreeId = existing.treeId;
        const now = new Date().toISOString();

        // Load current index entry
        const indexSnap = await getTreeIndexRef(uid, nodeTreeId).child(nodeId).once("value");
        const currentIndex = indexSnap.val();
        if (!currentIndex) return withResponseSize({ content: [{ type: "text", text: `Index entry not found for node: ${nodeId}` }], isError: true });

        // Build content updates
        const contentUpdates: Record<string, any> = { updatedAt: now };
        if (content !== undefined) {
          contentUpdates.content = content;
          contentUpdates.tokenCount = estimateTokens(content);
        }
        if (parsedSources !== undefined) contentUpdates.sources = parsedSources;
        if (consensusNotes !== undefined) contentUpdates.consensusNotes = consensusNotes;
        if (parsedCrossRefs !== undefined) contentUpdates.crossRefs = parsedCrossRefs;

        // Build index updates
        const indexUpdates: Record<string, any> = { updatedAt: now };
        if (question !== undefined) indexUpdates.question = question;
        if (keyFinding !== undefined) indexUpdates.keyFinding = keyFinding;
        if (lastVerified !== undefined) indexUpdates.lastVerified = lastVerified;
        if (parentId !== undefined) indexUpdates.parentId = parentId;

        // Tree aggregate updates
        const treeUpdates: Record<string, any> = { updatedAt: now };
        let needTreeUpdate = false;

        // Handle token cost change
        if (content !== undefined) {
          const oldTokenCost = currentIndex.tokenCost || 0;
          const newTokenCost = contentUpdates.tokenCount;
          indexUpdates.tokenCost = newTokenCost;

          const treeSnap = await getTreeRef(uid, nodeTreeId).once("value");
          const tree = treeSnap.val();
          treeUpdates.tokenUsed = (tree.tokenUsed || 0) - oldTokenCost + newTokenCost;
          needTreeUpdate = true;
        }

        // Handle trust change
        if (trust !== undefined && trust !== currentIndex.trust) {
          indexUpdates.trust = trust;
          const treeSnap = needTreeUpdate ? null : await getTreeRef(uid, nodeTreeId).once("value");
          const tree = treeSnap ? treeSnap.val() : (await getTreeRef(uid, nodeTreeId).once("value")).val();
          const tp = { ...(tree.trustProfile || { authoritative: 0, credible: 0, unverified: 0, questionable: 0 }) };
          const oldTrust = currentIndex.trust || "unverified";
          tp[oldTrust] = Math.max(0, (tp[oldTrust] || 0) - 1);
          tp[trust] = (tp[trust] || 0) + 1;
          treeUpdates.trustProfile = tp;
          needTreeUpdate = true;
        }

        // Apply updates
        const promises: Promise<void>[] = [
          getNodeContentRef(uid, nodeId).update(contentUpdates),
          getTreeIndexRef(uid, nodeTreeId).child(nodeId).update(indexUpdates),
        ];
        if (needTreeUpdate) {
          promises.push(getTreeRef(uid, nodeTreeId).update(treeUpdates));
        }
        await Promise.all(promises);

        return withResponseSize({
          content: [{ type: "text", text: JSON.stringify({ updated: nodeId, contentUpdates, indexUpdates, treeUpdated: needTreeUpdate }, null, 2) }],
        });
      }

      // ─── DELETE ───
      if (action === "delete") {
        if (!nodeId) return withResponseSize({ content: [{ type: "text", text: "delete requires nodeId" }], isError: true });

        // Load content record to find treeId
        const contentSnap = await getNodeContentRef(uid, nodeId).once("value");
        const existing = contentSnap.val();
        if (!existing) return withResponseSize({ content: [{ type: "text", text: `Node not found: ${nodeId}` }], isError: true });

        const nodeTreeId = existing.treeId;
        const now = new Date().toISOString();

        // Load index entry for aggregate adjustments
        const indexSnap = await getTreeIndexRef(uid, nodeTreeId).child(nodeId).once("value");
        const indexEntry = indexSnap.val();

        // Load tree for aggregate updates
        const treeSnap = await getTreeRef(uid, nodeTreeId).once("value");
        const tree = treeSnap.val();

        const treeUpdates: Record<string, any> = { updatedAt: now };

        if (tree && indexEntry) {
          treeUpdates.nodeCount = Math.max(0, (tree.nodeCount || 0) - 1);
          treeUpdates.tokenUsed = Math.max(0, (tree.tokenUsed || 0) - (indexEntry.tokenCost || 0));

          const tp = { ...(tree.trustProfile || { authoritative: 0, credible: 0, unverified: 0, questionable: 0 }) };
          const nodeTrust = indexEntry.trust || "unverified";
          tp[nodeTrust] = Math.max(0, (tp[nodeTrust] || 0) - 1);
          treeUpdates.trustProfile = tp;
        }

        // Remove from parent's childIds
        if (indexEntry?.parentId) {
          const parentSnap = await getTreeIndexRef(uid, nodeTreeId).child(indexEntry.parentId).once("value");
          const parentIndex = parentSnap.val();
          if (parentIndex) {
            const childIds: string[] = (parentIndex.childIds || []).filter((id: string) => id !== nodeId);
            treeUpdates[`index/${indexEntry.parentId}/childIds`] = childIds;
          }
        }

        // Delete index entry by setting to null in tree update
        treeUpdates[`index/${nodeId}`] = null;

        // Atomic: update tree (removes index entry + adjusts aggregates) + delete content
        await Promise.all([
          getTreeRef(uid, nodeTreeId).update(treeUpdates),
          getNodeContentRef(uid, nodeId).remove(),
        ]);

        return withResponseSize({
          content: [{ type: "text", text: JSON.stringify({ deleted: nodeId, treeId: nodeTreeId }, null, 2) }],
        });
      }

      // ─── LOAD ───
      if (action === "load") {
        if (!nodeId) return withResponseSize({ content: [{ type: "text", text: "load requires nodeId" }], isError: true });

        const snap = await getNodeContentRef(uid, nodeId).once("value");
        const node = snap.val();
        if (!node) return withResponseSize({ content: [{ type: "text", text: `Node not found: ${nodeId}` }], isError: true });

        return withResponseSize(
          { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] },
          { _nodeTokenCost: node.tokenCount || 0 }
        );
      }

      // ─── LOAD_BATCH ───
      if (action === "load_batch") {
        if (!nodeIds || nodeIds.length === 0) return withResponseSize({ content: [{ type: "text", text: "load_batch requires nodeIds (non-empty array)" }], isError: true });
        if (nodeIds.length > 10) return withResponseSize({ content: [{ type: "text", text: `load_batch capped at 10 nodes. Requested: ${nodeIds.length}. Split into multiple calls.` }], isError: true });

        // Parallel load
        const snaps = await Promise.all(
          nodeIds.map((nId) => getNodeContentRef(uid, nId).once("value"))
        );

        const results: Record<string, any> = {};
        let totalTokenCost = 0;
        let found = 0;
        for (let i = 0; i < nodeIds.length; i++) {
          const val = snaps[i].val();
          if (val) {
            results[nodeIds[i]] = val;
            totalTokenCost += val.tokenCount || 0;
            found++;
          } else {
            results[nodeIds[i]] = null;
          }
        }

        return withResponseSize(
          { content: [{ type: "text", text: JSON.stringify({ nodes: results, found, requested: nodeIds.length }, null, 2) }] },
          { _totalNodeTokenCost: totalTokenCost }
        );
      }

      // ─── MOVE ───
      if (action === "move") {
        if (!nodeId) return withResponseSize({ content: [{ type: "text", text: "move requires nodeId" }], isError: true });

        // Load content record to get treeId
        const contentSnap = await getNodeContentRef(uid, nodeId).once("value");
        const existing = contentSnap.val();
        if (!existing) return withResponseSize({ content: [{ type: "text", text: `Node not found: ${nodeId}` }], isError: true });

        const nodeTreeId = existing.treeId;
        const now = new Date().toISOString();

        // Load current index entry
        const indexSnap = await getTreeIndexRef(uid, nodeTreeId).child(nodeId).once("value");
        const currentIndex = indexSnap.val();
        if (!currentIndex) return withResponseSize({ content: [{ type: "text", text: `Index entry not found: ${nodeId}` }], isError: true });

        const oldParentId = currentIndex.parentId || null;
        // "root" sentinel means make a root node (no parent)
        const effectiveNewParentId = newParentId === undefined ? oldParentId : (newParentId === "root" ? null : newParentId);

        if (oldParentId === effectiveNewParentId) {
          return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ moved: nodeId, parentId: effectiveNewParentId, note: "No change — same parent" }, null, 2) }] });
        }

        const treeUpdates: Record<string, any> = {
          [`index/${nodeId}/parentId`]: effectiveNewParentId,
          [`index/${nodeId}/updatedAt`]: now,
          updatedAt: now,
        };

        // Remove from old parent's childIds
        if (oldParentId) {
          const oldParentSnap = await getTreeIndexRef(uid, nodeTreeId).child(oldParentId).once("value");
          const oldParent = oldParentSnap.val();
          if (oldParent) {
            treeUpdates[`index/${oldParentId}/childIds`] = (oldParent.childIds || []).filter((id: string) => id !== nodeId);
          }
        }

        // Add to new parent's childIds
        if (effectiveNewParentId) {
          const newParentSnap = await getTreeIndexRef(uid, nodeTreeId).child(effectiveNewParentId).once("value");
          const newParent = newParentSnap.val();
          if (newParent) {
            const childIds: string[] = newParent.childIds || [];
            if (!childIds.includes(nodeId)) {
              childIds.push(nodeId);
              treeUpdates[`index/${effectiveNewParentId}/childIds`] = childIds;
            }
          }
        }

        await getTreeRef(uid, nodeTreeId).update(treeUpdates);

        return withResponseSize({
          content: [{ type: "text", text: JSON.stringify({ moved: nodeId, oldParentId, newParentId: effectiveNewParentId }, null, 2) }],
        });
      }

      return withResponseSize({ content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true });
    }
  );
}
