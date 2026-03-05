import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCachedSkill, getAllCachedSkillsMeta, writeSkillToCache, deleteSkillFromCache, skillExistsInCache, getCacheDiagnostics } from "../skill-cache.js";
import { getCurrentUid } from "../context.js";
import { withResponseSize } from "../response-metadata.js";
import { INITIATOR_PARAM, resolveInitiator } from "../surfaces.js";
import { findCandidates, formatDidYouMean } from "../fuzzy-match.js";

const CONTENT_MAX_CHARS = 50_000;

const KNOWN_CATEGORIES = [
  "Protocols", "Frameworks", "Lenses", "Onboarding", "Recovery",
  "Workflows", "Session Modes", "Production", "custom",
];

/**
 * Registers the `skill` tool — allows any MCP client to retrieve, create,
 * update, or delete CC skill prompt content.
 *
 * Storage: Firebase RTDB → in-memory cache → compiled constant fallback.
 */
export function registerSkillTools(server: McpServer): void {
  server.tool(
    "skill",
    `Retrieve a CC skill/protocol by name. Returns the full skill prompt content. Call with action='list' to see available skills, or action='get' with a skillName to retrieve one.

Actions:
  - "list": List all skills with metadata (name, description, category, version). No content returned.
  - "get": Get full skill content by name. Requires skillName.
  - "create": Create a new skill. Requires skillName, name, description, content. Optional: category, triggers.
  - "update": Update an existing skill. Requires skillName. Optional: name, description, content, category, triggers.
  - "delete": Delete a skill. Requires skillName. Use for test cleanup or admin removal.`,
    {
      ...INITIATOR_PARAM,
      action: z.enum(["list", "get", "create", "update", "delete"]).describe("'list' to see all skills, 'get' to retrieve a specific skill, 'create'/'update'/'delete' to manage skills"),
      skillName: z.string().optional().describe("The skill name (e.g., 'cc-session-protocol'). Required for get/create/update/delete."),
      name: z.string().optional().describe("Display name for the skill (required for create, optional for update)"),
      description: z.string().optional().describe("Trigger description for router matching (required for create, optional for update)"),
      content: z.string().optional().describe("Full skill markdown content (required for create, optional for update). Max 50K chars."),
      category: z.string().optional().describe("Skill category (e.g., 'Protocols', 'Lenses', 'Onboarding'). Optional for create/update."),
      triggers: z.array(z.string()).optional().describe("Router trigger patterns for future programmatic matching. Optional for create/update."),
    },
    async ({ initiator, action, skillName, name: displayName, description, content, category, triggers }) => {
      resolveInitiator({ initiator });
      const uid = getCurrentUid();

      // ─── LIST ───
      if (action === "list") {
        const skills = getAllCachedSkillsMeta();
        const diagnostics = getCacheDiagnostics();
        return withResponseSize({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: skills.length,
              source: diagnostics.source,
              skills: skills.map(s => ({ name: s.name, description: s.description, category: s.category, version: s.version })),
              usage: "Call skill with action='get' and skillName='<name>' to retrieve the full prompt content.",
            }, null, 2),
          }],
        });
      }

      // ─── GET ───
      if (action === "get") {
        if (!skillName) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: skillName is required for action='get'" }],
            isError: true,
          });
        }

        const skill = getCachedSkill(skillName);
        if (!skill) {
          const allSkills = getAllCachedSkillsMeta();
          const entries = allSkills.map(s => ({ id: s.name, label: s.description || undefined }));
          const candidates = findCandidates(skillName!, entries);
          const did_you_mean = formatDidYouMean(candidates);
          const errorObj: any = { error: `Unknown skill: ${skillName}` };
          if (did_you_mean) errorObj.did_you_mean = did_you_mean;
          return withResponseSize({
            content: [{ type: "text" as const, text: JSON.stringify(errorObj, null, 2) }],
            isError: true,
          });
        }

        return withResponseSize({
          content: [{ type: "text" as const, text: skill.content }],
        });
      }

      // ─── CREATE ───
      if (action === "create") {
        if (!skillName) {
          return withResponseSize({ content: [{ type: "text" as const, text: "Error: skillName is required for action='create'" }], isError: true });
        }
        if (!displayName) {
          return withResponseSize({ content: [{ type: "text" as const, text: "Error: name is required for action='create'" }], isError: true });
        }
        if (!description) {
          return withResponseSize({ content: [{ type: "text" as const, text: "Error: description is required for action='create'" }], isError: true });
        }
        if (!content) {
          return withResponseSize({ content: [{ type: "text" as const, text: "Error: content is required for action='create'" }], isError: true });
        }
        if (content.length > CONTENT_MAX_CHARS) {
          return withResponseSize({ content: [{ type: "text" as const, text: `Error: content exceeds ${CONTENT_MAX_CHARS} char limit (got ${content.length})` }], isError: true });
        }
        if (skillExistsInCache(skillName)) {
          return withResponseSize({ content: [{ type: "text" as const, text: `Error: skill '${skillName}' already exists. Use action='update' to modify it.` }], isError: true });
        }

        const skill = await writeSkillToCache(uid, skillName, {
          name: displayName,
          description,
          content,
          category: category || "custom",
          triggers: triggers || [],
          updatedBy: initiator || "unknown",
        });

        return withResponseSize({
          content: [{ type: "text" as const, text: JSON.stringify({
            created: skillName,
            version: skill.version,
            category: skill.category,
            contentLength: skill.content.length,
            createdAt: skill.createdAt,
          }, null, 2) }],
        });
      }

      // ─── UPDATE ───
      if (action === "update") {
        if (!skillName) {
          return withResponseSize({ content: [{ type: "text" as const, text: "Error: skillName is required for action='update'" }], isError: true });
        }
        if (!skillExistsInCache(skillName)) {
          return withResponseSize({ content: [{ type: "text" as const, text: `Error: skill '${skillName}' not found. Use action='create' to add it.` }], isError: true });
        }
        if (content && content.length > CONTENT_MAX_CHARS) {
          return withResponseSize({ content: [{ type: "text" as const, text: `Error: content exceeds ${CONTENT_MAX_CHARS} char limit (got ${content.length})` }], isError: true });
        }

        const updateData: any = { updatedBy: initiator || "unknown" };
        if (displayName !== undefined) updateData.name = displayName;
        if (description !== undefined) updateData.description = description;
        if (content !== undefined) updateData.content = content;
        if (category !== undefined) updateData.category = category;
        if (triggers !== undefined) updateData.triggers = triggers;

        const skill = await writeSkillToCache(uid, skillName, updateData);

        return withResponseSize({
          content: [{ type: "text" as const, text: JSON.stringify({
            updated: skillName,
            version: skill.version,
            category: skill.category,
            contentLength: skill.content.length,
            updatedAt: skill.updatedAt,
          }, null, 2) }],
        });
      }

      // ─── DELETE ───
      if (action === "delete") {
        if (!skillName) {
          return withResponseSize({ content: [{ type: "text" as const, text: "Error: skillName is required for action='delete'" }], isError: true });
        }
        if (!skillExistsInCache(skillName)) {
          return withResponseSize({ content: [{ type: "text" as const, text: `Error: skill '${skillName}' not found` }], isError: true });
        }

        await deleteSkillFromCache(uid, skillName);

        return withResponseSize({
          content: [{ type: "text" as const, text: JSON.stringify({ deleted: skillName }) }],
        });
      }

      return withResponseSize({ content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true });
    }
  );
}
