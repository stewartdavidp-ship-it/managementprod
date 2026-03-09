import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFeedbackReportsRef, getFeedbackReportRef } from "../firebase.js";
import { INITIATOR_PARAM, resolveInitiator } from "../surfaces.js";
import { withResponseSize } from "../response-metadata.js";

const FEEDBACK_STATUSES = [
  "open",
  "triaged",
  "in_progress",
  "resolved",
] as const;
const FEEDBACK_TYPES = ["bug", "enhancement", "question", "suggestion"] as const;
const FEEDBACK_SEVERITIES = ["low", "medium", "high"] as const;
const FEEDBACK_SOURCES = ["internal", "public"] as const;

export function registerFeedbackReportTools(server: McpServer): void {
  server.tool(
    "feedbackReports",
    `Feedback report triage tool. Actions:
  - "list": List reports. Optional filters: appId, source (internal/public), status (default: open), type, severity, limit (default 20).
  - "ack": Mark a report as triaged. Requires: reportId.
  - "update": Update status and/or jobId on a report. Requires: reportId. Optional: status, jobId.`,
    {
      ...INITIATOR_PARAM,
      action: z.enum(["list", "ack", "update"]),
      reportId: z
        .string()
        .optional()
        .describe("Report ID (required for ack/update)"),
      appId: z
        .string()
        .optional()
        .describe("Filter by app ID (optional for list)"),
      source: z
        .enum(FEEDBACK_SOURCES)
        .optional()
        .describe("Filter by source: internal or public"),
      status: z
        .enum([...FEEDBACK_STATUSES, "all"])
        .optional()
        .describe(
          "Filter by status (default: open for list). For update: new status."
        ),
      type: z
        .enum(FEEDBACK_TYPES)
        .optional()
        .describe("Filter by type: bug, enhancement, question, suggestion"),
      severity: z
        .enum(FEEDBACK_SEVERITIES)
        .optional()
        .describe("Filter by severity: low, medium, high"),
      jobId: z
        .string()
        .optional()
        .describe("Job ID to link (for update action)"),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({
      initiator,
      action,
      reportId,
      appId,
      source,
      status,
      type,
      severity,
      jobId,
      limit,
    }) => {
      resolveInitiator({ initiator });

      // ── LIST ──
      if (action === "list") {
        const ref = getFeedbackReportsRef();
        const snapshot = await ref
          .orderByChild("createdAt")
          .limitToLast(200)
          .once("value");
        const raw = snapshot.val() || {};

        let items: any[] = Object.entries(raw).map(([id, val]: [string, any]) => ({
          id,
          ...val,
        }));

        // Sort newest first
        items.sort(
          (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
        );

        // Apply filters
        const filterStatus = status || "open";
        if (filterStatus !== "all") {
          items = items.filter((r) => r.status === filterStatus);
        }
        if (appId) {
          items = items.filter((r) => r.appId === appId);
        }
        if (source) {
          items = items.filter((r) => r.source === source);
        }
        if (type) {
          items = items.filter((r) => r.type === type);
        }
        if (severity) {
          items = items.filter((r) => r.severity === severity);
        }

        const total = items.length;
        items = items.slice(0, limit);

        return withResponseSize({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ items, total, limit }, null, 2),
            },
          ],
        });
      }

      // ── ACK ──
      if (action === "ack") {
        if (!reportId) {
          return withResponseSize({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "reportId is required for ack" },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        }

        const ref = getFeedbackReportRef(reportId);
        const snapshot = await ref.once("value");
        if (!snapshot.exists()) {
          return withResponseSize({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: `Report ${reportId} not found` },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        }

        await ref.update({
          status: "triaged",
          updatedAt: new Date().toISOString(),
        });

        const updated = (await ref.once("value")).val();
        return withResponseSize({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { id: reportId, ...updated },
                null,
                2
              ),
            },
          ],
        });
      }

      // ── UPDATE ──
      if (action === "update") {
        if (!reportId) {
          return withResponseSize({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "reportId is required for update" },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        }

        const ref = getFeedbackReportRef(reportId);
        const snapshot = await ref.once("value");
        if (!snapshot.exists()) {
          return withResponseSize({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: `Report ${reportId} not found` },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        }

        const updates: Record<string, any> = {
          updatedAt: new Date().toISOString(),
        };
        if (status && status !== "all") updates.status = status;
        if (jobId !== undefined) updates.jobId = jobId;

        await ref.update(updates);

        const updated = (await ref.once("value")).val();
        return withResponseSize({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { id: reportId, ...updated },
                null,
                2
              ),
            },
          ],
        });
      }

      return withResponseSize({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { error: `Unknown action: ${action}` },
              null,
              2
            ),
          },
        ],
        isError: true,
      });
    }
  );
}
