import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withResponseSize } from "../response-metadata.js";
import { INITIATOR_PARAM, resolveInitiator } from "../surfaces.js";
import {
  getSurfaceConfig,
  getAllSurfaces,
  writeSurfaceConfig,
  updateSurfaceConfig,
  deleteSurfaceConfig,
  type SurfaceConfig,
} from "../surface-registry.js";

const VALID_STATUSES = ["production", "beta", "planned", "unsupported"] as const;
const VALID_MCP_CONNECTIONS = ["native", "extension", "none"] as const;
const VALID_SKILL_GRADES = ["full", "basic", "none"] as const;

/**
 * Registers the `surface_registry` tool — CRUD for surface configurations.
 * Surfaces are system-wide (not per-user) and stored at
 * command-center/system/surfaceRegistry/{surfaceId}.
 */
export function registerSurfaceRegistryTools(server: McpServer): void {
  server.tool(
    "surface_registry",
    `Surface registry tool. Manage registered AI surfaces (Claude Code, Claude Chat, etc.) and their capabilities.

Actions:
  - "list": List all registered surfaces with summary info (id, displayName, engine, surfaceType, status).
  - "get": Get full config for a specific surface. Requires surfaceId.
  - "create": Register a new surface. Requires surfaceId, displayName, engine, surfaceType. Optional: status, launchUrl, mcpConnection, capabilities (JSON string), contextWindow (JSON string), bootstrapSkill, skillGrade.
  - "update": Update surface fields. Requires surfaceId. Optional: displayName, engine, surfaceType, status, launchUrl, mcpConnection, capabilities (JSON string), contextWindow (JSON string), bootstrapSkill, skillGrade.
  - "delete": Remove a surface (test cleanup only). Requires surfaceId.`,
    {
      ...INITIATOR_PARAM,
      action: z.enum(["list", "get", "create", "update", "delete"]).describe(
        "Action: list (all surfaces), get (specific surface), create (new surface), update (modify surface), or delete (remove surface)"
      ),
      surfaceId: z.string().optional().describe(
        "Surface identifier (e.g., 'claude-code', 'cursor-claude'). Required for get/create/update/delete."
      ),
      displayName: z.string().optional().describe(
        "Human-readable display name (e.g., 'Claude Code'). Required for create."
      ),
      engine: z.string().optional().describe(
        "AI engine (e.g., 'claude', 'gemini', 'gpt', 'grok'). Required for create."
      ),
      surfaceType: z.string().optional().describe(
        "Surface category (e.g., 'ide', 'chat', 'browser', 'office', 'admin'). Required for create."
      ),
      status: z.enum(VALID_STATUSES).optional().describe(
        "Surface status: production, beta, planned, or unsupported."
      ),
      launchUrl: z.string().optional().describe(
        "Launch URL for smart-launch (e.g., 'https://claude.ai'). Use 'none' to clear."
      ),
      mcpConnection: z.enum(VALID_MCP_CONNECTIONS).optional().describe(
        "MCP connection type: native, extension, or none."
      ),
      capabilities: z.string().optional().describe(
        "JSON string of capabilities: {fileSystem, terminal, browser, messaging, skillRouting} (all boolean)."
      ),
      contextWindow: z.string().optional().describe(
        "JSON string of context window config: {ceiling: number, toolBudget: number}."
      ),
      bootstrapSkill: z.string().optional().describe(
        "Skill name loaded at bootstrap (e.g., 'cc-bootstrap-instructions-code'). Use 'none' to clear."
      ),
      skillGrade: z.enum(VALID_SKILL_GRADES).optional().describe(
        "Skill complexity this surface handles: full, basic, or none."
      ),
    },
    async (args) => {
      resolveInitiator(args);
      const { action, surfaceId } = args;

      // ─── LIST ───
      if (action === "list") {
        const surfaces = await getAllSurfaces();
        const summary = Array.from(surfaces.values()).map((s) => ({
          id: s.id,
          displayName: s.displayName,
          engine: s.engine,
          surfaceType: s.surfaceType,
          status: s.status,
          mcpConnection: s.mcpConnection,
          skillGrade: s.skillGrade,
        }));

        return withResponseSize({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: summary.length,
              surfaces: summary,
            }, null, 2),
          }],
        });
      }

      // ─── GET ───
      if (action === "get") {
        if (!surfaceId) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: surfaceId is required for action='get'" }],
            isError: true,
          });
        }

        const config = await getSurfaceConfig(surfaceId);
        if (!config) {
          return withResponseSize({
            content: [{ type: "text" as const, text: `Error: surface '${surfaceId}' not found in registry` }],
            isError: true,
          });
        }

        return withResponseSize({
          content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }],
        });
      }

      // ─── CREATE ───
      if (action === "create") {
        if (!surfaceId) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: surfaceId is required for action='create'" }],
            isError: true,
          });
        }
        if (!args.displayName) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: displayName is required for action='create'" }],
            isError: true,
          });
        }
        if (!args.engine) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: engine is required for action='create'" }],
            isError: true,
          });
        }
        if (!args.surfaceType) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: surfaceType is required for action='create'" }],
            isError: true,
          });
        }

        // Check if already exists
        const existing = await getSurfaceConfig(surfaceId);
        if (existing) {
          return withResponseSize({
            content: [{ type: "text" as const, text: `Error: surface '${surfaceId}' already exists. Use action='update' to modify it.` }],
            isError: true,
          });
        }

        // Parse optional JSON fields
        let capabilities = {
          fileSystem: false,
          terminal: false,
          browser: false,
          messaging: false,
          skillRouting: false,
        };
        if (args.capabilities) {
          try {
            capabilities = { ...capabilities, ...JSON.parse(args.capabilities) };
          } catch {
            return withResponseSize({
              content: [{ type: "text" as const, text: "Error: capabilities must be a valid JSON string" }],
              isError: true,
            });
          }
        }

        let contextWindow = { ceiling: 200000, toolBudget: 30000 };
        if (args.contextWindow) {
          try {
            contextWindow = { ...contextWindow, ...JSON.parse(args.contextWindow) };
          } catch {
            return withResponseSize({
              content: [{ type: "text" as const, text: "Error: contextWindow must be a valid JSON string" }],
              isError: true,
            });
          }
        }

        const now = new Date().toISOString();
        const config: SurfaceConfig = {
          id: surfaceId,
          displayName: args.displayName,
          engine: args.engine,
          surfaceType: args.surfaceType,
          status: args.status || "beta",
          launchUrl: args.launchUrl === "none" ? null : (args.launchUrl || null),
          mcpConnection: args.mcpConnection || "none",
          capabilities,
          contextWindow,
          bootstrapSkill: args.bootstrapSkill === "none" ? null : (args.bootstrapSkill || null),
          skillGrade: args.skillGrade || "none",
          createdAt: now,
          updatedAt: now,
        };

        await writeSurfaceConfig(config);

        return withResponseSize({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              created: surfaceId,
              displayName: config.displayName,
              engine: config.engine,
              surfaceType: config.surfaceType,
              status: config.status,
              createdAt: config.createdAt,
            }, null, 2),
          }],
        });
      }

      // ─── UPDATE ───
      if (action === "update") {
        if (!surfaceId) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: surfaceId is required for action='update'" }],
            isError: true,
          });
        }

        const existing = await getSurfaceConfig(surfaceId);
        if (!existing) {
          return withResponseSize({
            content: [{ type: "text" as const, text: `Error: surface '${surfaceId}' not found. Use action='create' to add it.` }],
            isError: true,
          });
        }

        // Build updates object from provided fields
        const updates: Record<string, any> = {};
        if (args.displayName !== undefined) updates.displayName = args.displayName;
        if (args.engine !== undefined) updates.engine = args.engine;
        if (args.surfaceType !== undefined) updates.surfaceType = args.surfaceType;
        if (args.status !== undefined) updates.status = args.status;
        if (args.mcpConnection !== undefined) updates.mcpConnection = args.mcpConnection;
        if (args.skillGrade !== undefined) updates.skillGrade = args.skillGrade;

        if (args.launchUrl !== undefined) {
          updates.launchUrl = args.launchUrl === "none" ? null : args.launchUrl;
        }
        if (args.bootstrapSkill !== undefined) {
          updates.bootstrapSkill = args.bootstrapSkill === "none" ? null : args.bootstrapSkill;
        }

        if (args.capabilities) {
          try {
            updates.capabilities = { ...existing.capabilities, ...JSON.parse(args.capabilities) };
          } catch {
            return withResponseSize({
              content: [{ type: "text" as const, text: "Error: capabilities must be a valid JSON string" }],
              isError: true,
            });
          }
        }

        if (args.contextWindow) {
          try {
            updates.contextWindow = { ...existing.contextWindow, ...JSON.parse(args.contextWindow) };
          } catch {
            return withResponseSize({
              content: [{ type: "text" as const, text: "Error: contextWindow must be a valid JSON string" }],
              isError: true,
            });
          }
        }

        const updated = await updateSurfaceConfig(surfaceId, updates);

        return withResponseSize({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              updated: surfaceId,
              fields: Object.keys(updates),
              updatedAt: updated?.updatedAt,
            }, null, 2),
          }],
        });
      }

      // ─── DELETE ───
      if (action === "delete") {
        if (!surfaceId) {
          return withResponseSize({
            content: [{ type: "text" as const, text: "Error: surfaceId is required for action='delete'" }],
            isError: true,
          });
        }

        const deleted = await deleteSurfaceConfig(surfaceId);
        if (!deleted) {
          return withResponseSize({
            content: [{ type: "text" as const, text: `Error: surface '${surfaceId}' not found` }],
            isError: true,
          });
        }

        return withResponseSize({
          content: [{ type: "text" as const, text: JSON.stringify({ deleted: surfaceId }) }],
        });
      }

      return withResponseSize({
        content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
        isError: true,
      });
    }
  );
}
