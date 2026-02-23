// ═══════════════════════════════════════════════════════════════
// GitHub API Client — Contents API for auto-delivery pipeline
// Token is parameterized through the entire stack for multi-user support.
// Phase 1 callers always pass process.env.GITHUB_TOKEN.
// ═══════════════════════════════════════════════════════════════

const GITHUB_API = "https://api.github.com";
const COMMITTER = {
  name: "Command Center MCP",
  email: "noreply@cc-mcp.dev",
};

export interface GitHubCommitResult {
  sha: string;
  path: string;
  htmlUrl: string;
  commitSha: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** Check if GitHub token is configured (env var fallback) */
export function isGitHubConfigured(): boolean {
  return !!process.env.GITHUB_TOKEN;
}

/**
 * Resolve which repo to deliver a document to, based on doc type and app config.
 *
 * Routing rules:
 * - claude-md, spec → app's own repo (from appConfig.repos.prod)
 * - All other types → user's docs-repo (from profile.docsRepoName)
 * - Graceful fallback: if docs-repo not configured, fall back to app repo
 *
 * Returns: { repo: string, useSubPath: boolean } or null if no repo found
 */
export function resolveTargetRepo(
  docType: string,
  appRepos: Record<string, string> | null,
  docsRepoName: string | null
): { repo: string; useSubPath: boolean } | null {
  const appRepo = appRepos?.prod || null;
  const isAppScoped = docType === "claude-md" || docType === "spec";

  // project-instructions goes to the app's repo at root (no subPath)
  if (docType === "project-instructions") {
    if (appRepo) return { repo: appRepo, useSubPath: false };
    return null;
  }

  if (isAppScoped) {
    // App-scoped docs go to the app's repo with subPath
    if (appRepo) return { repo: appRepo, useSubPath: true };
    return null; // No app repo configured
  }

  // Non-app-scoped docs (design, architecture, research, etc.) go to docs-repo WITHOUT subPath
  if (docsRepoName) return { repo: docsRepoName, useSubPath: false };

  // Graceful fallback: no docs-repo configured, fall back to app repo
  if (appRepo) return { repo: appRepo, useSubPath: true };

  return null; // No repo configured at all
}

/**
 * Resolve the final file path within a repo.
 *
 * Rules:
 * - subPath is prepended only if useSubPath is true
 * - targetPath leading slash is stripped
 *
 * Examples:
 *   ("CLAUDE.md", "my-app", true)   → "my-app/CLAUDE.md"
 *   ("CLAUDE.md", "my-app", false)  → "CLAUDE.md"
 *   ("specs/f.md", null, true)      → "specs/f.md"
 *   ("specs/f.md", "/my-app/", true)→ "my-app/specs/f.md"
 */
export function resolveFilePath(
  targetPath: string,
  subPath: string | null,
  useSubPath: boolean = true
): string {
  // Clean targetPath
  let cleanTarget = targetPath.replace(/^\/+/, "");

  // Clean and prepend subPath if applicable
  if (useSubPath && subPath && subPath.trim() !== "") {
    const cleanSub = subPath.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleanSub) {
      cleanTarget = `${cleanSub}/${cleanTarget}`;
    }
  }

  return cleanTarget;
}

/**
 * @deprecated Use resolveFilePath + resolveTargetRepo instead.
 * Kept for backward compatibility during Phase 1 migration.
 */
export function resolveTargetPath(
  _docType: string,
  targetPath: string,
  subPath: string | null
): string {
  return resolveFilePath(targetPath, subPath, true);
}

function getHeaders(token?: string): Record<string, string> {
  const t = token || process.env.GITHUB_TOKEN;
  if (!t) throw new Error("No GitHub token available");
  return {
    Authorization: `Bearer ${t}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/**
 * Get file SHA if it exists at the given path. Returns null on 404.
 */
export async function getFileSha(
  repo: string,
  path: string,
  branch: string = "main",
  token?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`;
  const resp = await fetch(url, { headers: getHeaders(token) });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text();
    throw new GitHubApiError(
      `Failed to get file ${path}: ${resp.status}`,
      resp.status,
      body
    );
  }

  const data = (await resp.json()) as { sha: string };
  return data.sha;
}

/**
 * Create or update a file via the Contents API.
 * PUT /repos/{owner}/{repo}/contents/{path}
 */
export async function commitFile(
  repo: string,
  path: string,
  content: string,
  message: string,
  sha: string | null,
  branch: string = "main",
  token?: string
): Promise<GitHubCommitResult> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body: Record<string, any> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
    committer: COMMITTER,
  };
  if (sha) body.sha = sha;

  const resp = await fetch(url, {
    method: "PUT",
    headers: getHeaders(token),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const respBody = await resp.text();
    throw new GitHubApiError(
      `Failed to commit ${path}: ${resp.status}`,
      resp.status,
      respBody
    );
  }

  const data = (await resp.json()) as {
    content: { sha: string; path: string; html_url: string };
    commit: { sha: string };
  };

  return {
    sha: data.content.sha,
    path: data.content.path,
    htmlUrl: data.content.html_url,
    commitSha: data.commit.sha,
  };
}

/**
 * Get file content from a GitHub repo. Returns decoded UTF-8 text.
 * Returns null on 404.
 */
export interface FileContentResult {
  content: string;
  size: number; // File size in bytes from GitHub API
}

export async function getFileContent(
  repo: string,
  path: string,
  branch?: string,
  token?: string
): Promise<string | null>;
export async function getFileContent(
  repo: string,
  path: string,
  branch: string | undefined,
  token: string | undefined,
  withMeta: true
): Promise<FileContentResult | null>;
export async function getFileContent(
  repo: string,
  path: string,
  branch?: string,
  token?: string,
  withMeta?: boolean
): Promise<string | FileContentResult | null> {
  branch = branch || "main";
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`;
  const resp = await fetch(url, { headers: getHeaders(token) });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text();
    throw new GitHubApiError(
      `Failed to get file ${path}: ${resp.status}`,
      resp.status,
      body
    );
  }

  const data = (await resp.json()) as { content: string; encoding: string; size?: number };
  const decoded = data.encoding === "base64"
    ? Buffer.from(data.content, "base64").toString("utf-8")
    : data.content;

  if (withMeta) {
    return { content: decoded, size: data.size || decoded.length };
  }
  return decoded;
}

// ═══════════════════════════════════════════════════════════════
// Docs Repo Creation — Per-user documentation repository
// ═══════════════════════════════════════════════════════════════

export interface DocsRepoResult {
  repoPath: string;  // "username/cc-docs" or alternate name
  created: boolean;  // true if newly created, false if existing
  url: string;       // HTML URL of the repo
}

const CC_DOCS_MARKER = "<!-- cc-managed-docs-repo -->";

const CC_DOCS_README = `# Command Center Documentation
${CC_DOCS_MARKER}

This repository stores documentation generated through Command Center sessions.

## Structure
- \`{appId}/{type}/\` — App-scoped documents (designs, architecture, test plans)
- \`platform/\` — Cross-app documents (platform decisions, shared patterns)

## Managed by Command Center
Documents are delivered here automatically during session close.
Do not delete files manually — CC tracks document metadata in Firebase.
`;

const CANDIDATE_NAMES = ["cc-docs", "cc-documents", "cc-project-docs"];

/**
 * Get the authenticated GitHub user's username from the token.
 */
export async function getGitHubUsername(token?: string): Promise<string> {
  const resp = await fetch(`${GITHUB_API}/user`, { headers: getHeaders(token) });
  if (!resp.ok) {
    const body = await resp.text();
    throw new GitHubApiError("Failed to get GitHub user", resp.status, body);
  }
  const data = (await resp.json()) as { login: string };
  return data.login;
}

/**
 * Check if a repo exists and if it's a CC-managed docs repo.
 * Returns: { exists: true, isCcManaged: boolean, htmlUrl: string } or { exists: false }
 */
async function checkRepo(
  owner: string,
  name: string,
  token?: string
): Promise<{ exists: true; isCcManaged: boolean; htmlUrl: string } | { exists: false }> {
  const resp = await fetch(`${GITHUB_API}/repos/${owner}/${name}`, { headers: getHeaders(token) });
  if (resp.status === 404) return { exists: false };
  if (!resp.ok) {
    const body = await resp.text();
    throw new GitHubApiError(`Failed to check repo ${owner}/${name}`, resp.status, body);
  }
  const repoData = (await resp.json()) as { html_url: string };

  // Check for CC marker in README
  try {
    const readme = await getFileContent(`${owner}/${name}`, "README.md", "main", token);
    const isCcManaged = readme ? readme.includes(CC_DOCS_MARKER) : false;
    return { exists: true, isCcManaged, htmlUrl: repoData.html_url };
  } catch {
    return { exists: true, isCcManaged: false, htmlUrl: repoData.html_url };
  }
}

/**
 * Create a private docs repo for the user.
 */
async function createDocsRepo(name: string, token?: string): Promise<string> {
  const resp = await fetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    headers: getHeaders(token),
    body: JSON.stringify({
      name,
      description: "Command Center documentation repository — design artifacts, architecture docs, and session materials",
      private: true,
      auto_init: false, // We'll commit the README ourselves for the marker
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new GitHubApiError(`Failed to create repo ${name}`, resp.status, body);
  }

  const data = (await resp.json()) as { full_name: string; html_url: string };

  // Initialize with README containing CC marker
  await commitFile(
    data.full_name,
    "README.md",
    CC_DOCS_README,
    "Initialize CC documentation repository",
    null,
    "main",
    token
  );

  return data.html_url;
}

/**
 * Setup a docs repo for the user. Finds or creates a CC-managed docs repo.
 *
 * Strategy:
 * 1. For each candidate name (cc-docs, cc-documents, cc-project-docs):
 *    - If repo exists and is CC-managed → use it
 *    - If repo exists but is NOT CC-managed → skip (don't hijack)
 *    - If repo doesn't exist → create it
 * 2. If all candidate names are taken by non-CC repos → try cc-docs-{uid-short}
 */
export async function setupDocsRepo(
  uidShort: string,
  token?: string
): Promise<DocsRepoResult> {
  const username = await getGitHubUsername(token);

  for (const name of CANDIDATE_NAMES) {
    const check = await checkRepo(username, name, token);

    if (check.exists && check.isCcManaged) {
      // Found existing CC-managed repo
      return { repoPath: `${username}/${name}`, created: false, url: check.htmlUrl };
    }

    if (!check.exists) {
      // Name is available — create the repo
      const url = await createDocsRepo(name, token);
      return { repoPath: `${username}/${name}`, created: true, url };
    }

    // exists but not CC-managed — skip to next candidate
  }

  // All standard names taken — use UID-based fallback
  const fallbackName = `cc-docs-${uidShort}`;
  const fallbackCheck = await checkRepo(username, fallbackName, token);

  if (fallbackCheck.exists && fallbackCheck.isCcManaged) {
    return { repoPath: `${username}/${fallbackName}`, created: false, url: fallbackCheck.htmlUrl };
  }

  if (!fallbackCheck.exists) {
    const url = await createDocsRepo(fallbackName, token);
    return { repoPath: `${username}/${fallbackName}`, created: true, url };
  }

  throw new Error(`Cannot create docs repo: all candidate names (${[...CANDIDATE_NAMES, fallbackName].join(", ")}) are taken by non-CC repos under ${username}`);
}

/**
 * High-level: deliver a file to GitHub. Gets existing SHA, commits,
 * retries once on 409 conflict.
 */
export async function deliverToGitHub(
  repo: string,
  filePath: string,
  content: string,
  commitMessage: string,
  branch: string = "main",
  token?: string
): Promise<GitHubCommitResult> {
  let sha = await getFileSha(repo, filePath, branch, token);

  try {
    return await commitFile(repo, filePath, content, commitMessage, sha, branch, token);
  } catch (err) {
    if (err instanceof GitHubApiError && err.statusCode === 409) {
      // SHA conflict — retry once with fresh SHA
      sha = await getFileSha(repo, filePath, branch, token);
      return await commitFile(repo, filePath, content, commitMessage, sha, branch, token);
    }
    throw err;
  }
}
