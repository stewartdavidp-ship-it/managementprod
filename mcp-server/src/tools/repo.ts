import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFileContent, isGitHubConfigured } from "../github.js";

/**
 * repo_file — Read-only tool to fetch a file from a GitHub repo.
 *
 * Primary use case: fetch ARCHITECTURE.md or other reference docs
 * from the main branch so sessions always have the latest version.
 *
 * Billing impact: ZERO. Uses free GitHub Contents API (5,000 req/hr).
 * One call per session = negligible.
 */
export function registerRepoTools(server: McpServer): void {
  server.tool(
    "repo_file",
    `Fetch a file from a GitHub repo. Read-only. Returns the file content as UTF-8 text.
Use this to load reference documents (e.g. ARCHITECTURE.md) from the latest committed version.
Returns null content if the file doesn't exist. Requires GITHUB_TOKEN to be configured.`,
    {
      repo: z.string().describe("GitHub repo in owner/name format (e.g. 'stewartdavidp-ship-it/command-center')"),
      path: z.string().describe("File path within the repo (e.g. 'ARCHITECTURE.md')"),
      branch: z.string().optional().describe("Branch name (default: 'main')"),
    },
    async ({ repo, path, branch }) => {
      if (!isGitHubConfigured()) {
        return {
          content: [{ type: "text", text: "GitHub is not configured. Set GITHUB_TOKEN environment variable." }],
          isError: true,
        };
      }

      try {
        const content = await getFileContent(repo, path, branch || "main");

        if (content === null) {
          return {
            content: [{ type: "text", text: `File not found: ${path} in ${repo} (branch: ${branch || "main"})` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: content }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Failed to fetch ${path}: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
