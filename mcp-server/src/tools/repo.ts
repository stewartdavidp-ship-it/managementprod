import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getFileContent, isGitHubConfigured } from "../github.js";
import { withResponseSize } from "../response-metadata.js";
import { INITIATOR_PARAM, resolveInitiator } from "../surfaces.js";

/**
 * repo_file — Read-only tool to fetch a file from a GitHub repo.
 *
 * Primary use case: fetch ARCHITECTURE.md or other reference docs
 * from the main branch so sessions always have the latest version.
 *
 * Supports section-based reads for large markdown files:
 *   - section="## Deploy Commands" → returns just that section
 *   - section="__index__" → returns a table of contents with heading sizes
 *
 * Billing impact: ZERO. Uses free GitHub Contents API (5,000 req/hr).
 * One call per session = negligible.
 */
export function registerRepoTools(server: McpServer): void {
  server.tool(
    "repo_file",
    `Fetch a file from a GitHub repo. Read-only. Returns the file content as UTF-8 text.
Use this to load reference documents (e.g. ARCHITECTURE.md) from the latest committed version.
Returns null content if the file doesn't exist. Requires GITHUB_TOKEN to be configured.

Section reads (for markdown files):
- Pass section="## Heading Name" to return only that section (heading + content until next same-level heading)
- Pass section="__index__" to get a table of contents with estimated sizes for each section
- Omit section to get the full file`,
    {
      ...INITIATOR_PARAM,
      repo: z.string().describe("GitHub repo in owner/name format (e.g. 'stewartdavidp-ship-it/command-center')"),
      path: z.string().describe("File path within the repo (e.g. 'ARCHITECTURE.md')"),
      branch: z.string().optional().describe("Branch name (default: 'main')"),
      section: z.string().optional().describe("Markdown section heading to extract (e.g. '## Deploy Commands'), or '__index__' for table of contents with sizes"),
    },
    async ({ initiator, repo, path, branch, section }) => {
      resolveInitiator({ initiator });
      if (!isGitHubConfigured()) {
        return withResponseSize({
          content: [{ type: "text", text: "GitHub is not configured. Set GITHUB_TOKEN environment variable." }],
          isError: true,
        });
      }

      try {
        const result = await getFileContent(repo, path, branch || "main", undefined, true);

        if (result === null) {
          return withResponseSize({
            content: [{ type: "text", text: `File not found: ${path} in ${repo} (branch: ${branch || "main"})` }],
            isError: true,
          });
        }

        const { content: fileContent, size: fileSize } = result;

        // Section-based reads for markdown files
        if (section) {
          if (section === "__index__") {
            const index = buildMarkdownIndex(fileContent);
            return withResponseSize(
              { content: [{ type: "text", text: JSON.stringify(index, null, 2) }] },
              { _fileSize: fileSize }
            );
          }

          const extracted = extractSection(fileContent, section);
          if (extracted === null) {
            return withResponseSize(
              { content: [{ type: "text", text: `Section not found: "${section}" in ${path}` }], isError: true },
              { _fileSize: fileSize }
            );
          }

          return withResponseSize(
            { content: [{ type: "text", text: extracted }] },
            { _fileSize: fileSize }
          );
        }

        // Full file read
        return withResponseSize(
          { content: [{ type: "text", text: fileContent }] },
          { _fileSize: fileSize }
        );
      } catch (err: any) {
        return withResponseSize({
          content: [{ type: "text", text: `Failed to fetch ${path}: ${err.message}` }],
          isError: true,
        });
      }
    }
  );
}


// ═══════════════════════════════════════════════════════════════
// Markdown Section Parser
// ═══════════════════════════════════════════════════════════════

interface MarkdownSection {
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  estimatedSize: number;
}

/**
 * Build an index of markdown headings with line ranges and estimated sizes.
 * Respects code blocks — headings inside fenced code blocks are ignored.
 */
function buildMarkdownIndex(content: string): { sections: MarkdownSection[]; totalSize: number } {
  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];
  let inCodeBlock = false;

  // First pass: find all headings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      sections.push({
        heading: headingMatch[0].trim(),
        level: headingMatch[1].length,
        startLine: i + 1, // 1-indexed
        endLine: 0, // filled in second pass
        estimatedSize: 0,
      });
    }
  }

  // Second pass: compute end lines and sizes
  for (let i = 0; i < sections.length; i++) {
    const nextStart = i + 1 < sections.length ? sections[i + 1].startLine - 1 : lines.length;
    sections[i].endLine = nextStart;

    // Estimated size: character count of lines in this section
    let size = 0;
    for (let j = sections[i].startLine - 1; j < nextStart; j++) {
      size += lines[j].length + 1; // +1 for newline
    }
    sections[i].estimatedSize = size;
  }

  return { sections, totalSize: content.length };
}

/**
 * Extract a section from markdown content by heading.
 * Matches the full heading line (e.g., "## Deploy Commands").
 * Returns content from the heading through to the next heading at the same or higher level.
 * Respects code blocks.
 */
function extractSection(content: string, sectionHeading: string): string | null {
  const lines = content.split("\n");
  let inCodeBlock = false;
  let sectionStart = -1;
  let sectionLevel = 0;

  // Normalize the search heading
  const normalizedSearch = sectionHeading.trim().toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (sectionStart >= 0) continue; // inside our section, keep going
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (!headingMatch) continue;

    const level = headingMatch[1].length;
    const fullHeading = headingMatch[0].trim().toLowerCase();

    if (sectionStart === -1) {
      // Looking for our target section
      if (fullHeading === normalizedSearch || headingMatch[2].trim().toLowerCase() === normalizedSearch.replace(/^#+\s*/, "")) {
        sectionStart = i;
        sectionLevel = level;
      }
    } else {
      // We're inside our section — check if this heading ends it
      if (level <= sectionLevel) {
        // Found next heading at same or higher level — section ends here
        return lines.slice(sectionStart, i).join("\n").trimEnd();
      }
    }
  }

  if (sectionStart >= 0) {
    // Section extends to end of file
    return lines.slice(sectionStart).join("\n").trimEnd();
  }

  return null;
}
