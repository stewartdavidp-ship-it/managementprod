import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getForestsRef, getForestRef, getTreesRef, getTreeRef, getTreeIndexRef, getNodesRef } from "../firebase.js";
import { getCurrentUid } from "../context.js";
import { withResponseSize } from "../response-metadata.js";

const TRUST_LEVELS = ["authoritative", "credible", "unverified", "questionable"] as const;

function emptyTrustProfile() {
  return { authoritative: 0, credible: 0, unverified: 0, questionable: 0 };
}

export function registerKnowledgeTreeTools(server: McpServer): void {

  server.tool(
    "knowledge_tree",
    `Knowledge tree and forest management tool. Forests group related trees by domain. Trees contain indexed knowledge nodes with selective loading.

Actions:
  - "list_forests": List all forests with lean summaries.
  - "create_forest": Create a forest. Requires name. Optional: description, tags.
  - "update_forest": Update forest. Requires forestId. Optional: name, description, tags, treeIds.
  - "delete_forest": Delete forest (does NOT delete member trees). Requires forestId.
  - "list_trees": List trees. Optional: forestId filter. Returns summaries with token budgets and trust profiles.
  - "create_tree": Create a tree. Requires name. Optional: description, forestIds, tokenBudget (default 150000), freshnessPeriodDays (default 90).
  - "update_tree": Update tree metadata. Requires treeId. Optional: name, description, forestIds, tokenBudget, freshnessPeriodDays.
  - "delete_tree": Delete tree + all index entries + all node content. Removes from parent forests. Requires treeId.
  - "get_index": Load a tree's routing-table index — all node index entries for selective content loading. Requires treeId.`,
    {
      action: z.enum([
        "list_forests", "create_forest", "update_forest", "delete_forest",
        "list_trees", "create_tree", "update_tree", "delete_tree", "get_index",
      ]).describe("Action to perform"),
      forestId: z.string().optional().describe("Forest ID (required for update_forest/delete_forest, optional filter for list_trees)"),
      treeId: z.string().optional().describe("Tree ID (required for update_tree/delete_tree/get_index)"),
      name: z.string().optional().describe("Name (required for create_forest/create_tree, optional for updates)"),
      description: z.string().optional().describe("Description (optional for create/update)"),
      tags: z.array(z.string()).optional().describe("Domain tags for forests (optional for create_forest/update_forest)"),
      treeIds: z.array(z.string()).optional().describe("Tree IDs for update_forest"),
      forestIds: z.array(z.string()).optional().describe("Forest IDs for create_tree/update_tree (multi-forest membership)"),
      tokenBudget: z.number().int().optional().describe("Token budget for a tree (default 150000)"),
      freshnessPeriodDays: z.number().int().optional().describe("Days before nodes are considered stale (default 90)"),
    },
    async ({ action, forestId, treeId, name, description, tags, treeIds, forestIds, tokenBudget, freshnessPeriodDays }) => {
      const uid = getCurrentUid();

      // ═══════════════════════════════════════
      // FOREST ACTIONS
      // ═══════════════════════════════════════

      // ─── LIST_FORESTS ───
      if (action === "list_forests") {
        const snap = await getForestsRef(uid).once("value");
        const data = snap.val();
        if (!data) return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ forests: [], total: 0 }, null, 2) }] });

        const forests = Object.values(data).map((f: any) => ({
          id: f.id,
          name: f.name,
          description: f.description || null,
          treeCount: (f.treeIds || []).length,
          tags: f.tags || [],
        }));

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ forests, total: forests.length }, null, 2) }] });
      }

      // ─── CREATE_FOREST ───
      if (action === "create_forest") {
        if (!name) return withResponseSize({ content: [{ type: "text", text: "create_forest requires name" }], isError: true });

        const ref = getForestsRef(uid).push();
        const now = new Date().toISOString();
        const forest = {
          id: ref.key,
          name,
          description: description || null,
          treeIds: [],
          tags: tags || [],
          owner: uid,
          createdAt: now,
          updatedAt: now,
        };
        await ref.set(forest);
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(forest, null, 2) }] });
      }

      // ─── UPDATE_FOREST ───
      if (action === "update_forest") {
        if (!forestId) return withResponseSize({ content: [{ type: "text", text: "update_forest requires forestId" }], isError: true });

        const ref = getForestRef(uid, forestId);
        const snap = await ref.once("value");
        if (!snap.val()) return withResponseSize({ content: [{ type: "text", text: `Forest not found: ${forestId}` }], isError: true });

        const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (tags !== undefined) updates.tags = tags;
        if (treeIds !== undefined) updates.treeIds = treeIds;

        await ref.update(updates);
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ ...snap.val(), ...updates }, null, 2) }] });
      }

      // ─── DELETE_FOREST ───
      if (action === "delete_forest") {
        if (!forestId) return withResponseSize({ content: [{ type: "text", text: "delete_forest requires forestId" }], isError: true });

        const ref = getForestRef(uid, forestId);
        const snap = await ref.once("value");
        if (!snap.val()) return withResponseSize({ content: [{ type: "text", text: `Forest not found: ${forestId}` }], isError: true });

        await ref.remove();
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ deleted: forestId }) }] });
      }

      // ═══════════════════════════════════════
      // TREE ACTIONS
      // ═══════════════════════════════════════

      // ─── LIST_TREES ───
      if (action === "list_trees") {
        const snap = await getTreesRef(uid).once("value");
        const data = snap.val();
        if (!data) return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ trees: [], total: 0 }, null, 2) }] });

        let trees: any[] = Object.values(data);

        // Filter by forest if specified
        if (forestId) {
          const forestSnap = await getForestRef(uid, forestId).once("value");
          const forest = forestSnap.val();
          if (!forest) return withResponseSize({ content: [{ type: "text", text: `Forest not found: ${forestId}` }], isError: true });
          const memberIds: string[] = forest.treeIds || [];
          trees = trees.filter((t: any) => memberIds.includes(t.id));
        }

        const summaries = trees.map((t: any) => ({
          id: t.id,
          name: t.name,
          description: t.description || null,
          forestIds: t.forestIds || [],
          tokenUsed: t.tokenUsed || 0,
          tokenBudget: t.tokenBudget || 150000,
          nodeCount: t.nodeCount || 0,
          trustProfile: t.trustProfile || emptyTrustProfile(),
          lastVerified: t.lastVerified || null,
          freshnessPeriodDays: t.freshnessPeriodDays || 90,
        }));

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ trees: summaries, total: summaries.length }, null, 2) }] });
      }

      // ─── CREATE_TREE ───
      if (action === "create_tree") {
        if (!name) return withResponseSize({ content: [{ type: "text", text: "create_tree requires name" }], isError: true });

        const ref = getTreesRef(uid).push();
        const now = new Date().toISOString();
        const tree = {
          id: ref.key,
          name,
          description: description || null,
          forestIds: forestIds || [],
          tokenBudget: tokenBudget || 150000,
          tokenUsed: 0,
          nodeCount: 0,
          trustProfile: emptyTrustProfile(),
          freshnessPeriodDays: freshnessPeriodDays || 90,
          lastVerified: null,
          visibility: "private",
          owner: uid,
          createdAt: now,
          updatedAt: now,
        };
        await ref.set(tree);

        // Update forest treeIds arrays if forestIds provided
        if (forestIds && forestIds.length > 0) {
          for (const fId of forestIds) {
            const forestSnap = await getForestRef(uid, fId).once("value");
            const forest = forestSnap.val();
            if (forest) {
              const existing: string[] = forest.treeIds || [];
              if (!existing.includes(ref.key!)) {
                existing.push(ref.key!);
                await getForestRef(uid, fId).update({ treeIds: existing, updatedAt: now });
              }
            }
          }
        }

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(tree, null, 2) }] });
      }

      // ─── UPDATE_TREE ───
      if (action === "update_tree") {
        if (!treeId) return withResponseSize({ content: [{ type: "text", text: "update_tree requires treeId" }], isError: true });

        const ref = getTreeRef(uid, treeId);
        const snap = await ref.once("value");
        const existing = snap.val();
        if (!existing) return withResponseSize({ content: [{ type: "text", text: `Tree not found: ${treeId}` }], isError: true });

        const now = new Date().toISOString();
        const updates: Record<string, any> = { updatedAt: now };
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (tokenBudget !== undefined) updates.tokenBudget = tokenBudget;
        if (freshnessPeriodDays !== undefined) updates.freshnessPeriodDays = freshnessPeriodDays;

        // Handle forestIds changes — update old and new forest treeIds arrays
        if (forestIds !== undefined) {
          const oldForestIds: string[] = existing.forestIds || [];
          const newForestIds: string[] = forestIds;
          updates.forestIds = newForestIds;

          // Remove from forests no longer referenced
          for (const fId of oldForestIds) {
            if (!newForestIds.includes(fId)) {
              const forestSnap = await getForestRef(uid, fId).once("value");
              const forest = forestSnap.val();
              if (forest) {
                const tIds: string[] = (forest.treeIds || []).filter((id: string) => id !== treeId);
                await getForestRef(uid, fId).update({ treeIds: tIds, updatedAt: now });
              }
            }
          }

          // Add to newly referenced forests
          for (const fId of newForestIds) {
            if (!oldForestIds.includes(fId)) {
              const forestSnap = await getForestRef(uid, fId).once("value");
              const forest = forestSnap.val();
              if (forest) {
                const tIds: string[] = forest.treeIds || [];
                if (!tIds.includes(treeId)) {
                  tIds.push(treeId);
                  await getForestRef(uid, fId).update({ treeIds: tIds, updatedAt: now });
                }
              }
            }
          }
        }

        await ref.update(updates);
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ ...existing, ...updates }, null, 2) }] });
      }

      // ─── DELETE_TREE ───
      if (action === "delete_tree") {
        if (!treeId) return withResponseSize({ content: [{ type: "text", text: "delete_tree requires treeId" }], isError: true });

        const ref = getTreeRef(uid, treeId);
        const snap = await ref.once("value");
        const tree = snap.val();
        if (!tree) return withResponseSize({ content: [{ type: "text", text: `Tree not found: ${treeId}` }], isError: true });

        const now = new Date().toISOString();

        // Remove from parent forests
        const parentForestIds: string[] = tree.forestIds || [];
        for (const fId of parentForestIds) {
          const forestSnap = await getForestRef(uid, fId).once("value");
          const forest = forestSnap.val();
          if (forest) {
            const tIds: string[] = (forest.treeIds || []).filter((id: string) => id !== treeId);
            await getForestRef(uid, fId).update({ treeIds: tIds, updatedAt: now });
          }
        }

        // Delete node content records where treeId matches
        const nodesSnap = await getNodesRef(uid).orderByChild("treeId").equalTo(treeId).once("value");
        const nodesData = nodesSnap.val();
        let deletedNodes = 0;
        if (nodesData) {
          const nodeIds = Object.keys(nodesData);
          const delUpdates: Record<string, null> = {};
          for (const nId of nodeIds) {
            delUpdates[nId] = null;
          }
          await getNodesRef(uid).update(delUpdates);
          deletedNodes = nodeIds.length;
        }

        // Delete tree record (includes index entries under trees/{treeId}/index/)
        await ref.remove();

        return withResponseSize({
          content: [{
            type: "text",
            text: JSON.stringify({
              deleted: treeId,
              deletedNodes,
              removedFromForests: parentForestIds.length,
            }),
          }],
        });
      }

      // ─── GET_INDEX ───
      if (action === "get_index") {
        if (!treeId) return withResponseSize({ content: [{ type: "text", text: "get_index requires treeId" }], isError: true });

        // Load tree metadata and index in parallel
        const [treeSnap, indexSnap] = await Promise.all([
          getTreeRef(uid, treeId).once("value"),
          getTreeIndexRef(uid, treeId).once("value"),
        ]);

        const tree = treeSnap.val();
        if (!tree) return withResponseSize({ content: [{ type: "text", text: `Tree not found: ${treeId}` }], isError: true });

        const indexData = indexSnap.val();
        const entries: any[] = indexData ? Object.values(indexData) : [];

        // Sort by hierarchy: root nodes first (parentId null), then by order
        entries.sort((a, b) => {
          // Root nodes first
          if (!a.parentId && b.parentId) return -1;
          if (a.parentId && !b.parentId) return 1;
          // Then by order within same parent
          if (a.parentId === b.parentId) return (a.order || 0) - (b.order || 0);
          return 0;
        });

        const result = {
          tree: {
            id: tree.id,
            name: tree.name,
            description: tree.description || null,
            tokenUsed: tree.tokenUsed || 0,
            tokenBudget: tree.tokenBudget || 150000,
            nodeCount: tree.nodeCount || 0,
            trustProfile: tree.trustProfile || emptyTrustProfile(),
            lastVerified: tree.lastVerified || null,
            freshnessPeriodDays: tree.freshnessPeriodDays || 90,
          },
          index: entries.map((e: any) => ({
            id: e.id,
            question: e.question,
            keyFinding: e.keyFinding,
            tokenCost: e.tokenCost || 0,
            trust: e.trust || "unverified",
            lastVerified: e.lastVerified || null,
            parentId: e.parentId || null,
            childIds: e.childIds || [],
            order: e.order || 0,
          })),
          nodeCount: entries.length,
        };

        const budgetRemaining = (tree.tokenBudget || 150000) - (tree.tokenUsed || 0);

        return withResponseSize(
          { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
          { _treeBudgetRemaining: budgetRemaining }
        );
      }

      return withResponseSize({ content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true });
    }
  );
}
