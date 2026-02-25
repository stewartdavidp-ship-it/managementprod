import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDocumentsRef, getDocumentRef, getConfigRef, getProfileRef, getSessionRef, getDb } from "../firebase.js";
import { getCurrentUid, setSuppressPiggyback } from "../context.js";
import { SURFACES, INITIATOR_PARAM, resolveInitiator } from "../surfaces.js";
import { isGitHubConfigured, resolveTargetPath, resolveTargetRepo, resolveFilePath, deliverToGitHub, setupDocsRepo } from "../github.js";
import { withResponseSize } from "../response-metadata.js";

// ─── Lifespan / TTL ───────────────────────────────────────────────
// Documents have a lifespan that determines cleanup behavior:
//   ephemeral  — delete from Firebase immediately after delivery/ack
//   short      — 7 day TTL (lazy-delete at list time)
//   standard   — 30 day TTL (lazy-delete at list time)
//   permanent  — no auto-delete
type Lifespan = "ephemeral" | "short" | "standard" | "permanent";

const LIFESPAN_DEFAULTS: Record<string, Lifespan> = {
  "message":       "ephemeral",
  "spec":          "short",
  "architecture":  "short",
  "test-plan":     "short",
  "design":        "short",
  "claude-md":          "permanent",
  "project-instructions":    "permanent",
};

const TTL_MS: Record<string, number> = {
  "short":    7 * 24 * 60 * 60 * 1000,   // 7 days
  "standard": 30 * 24 * 60 * 60 * 1000,  // 30 days
};

function getDefaultLifespan(docType: string): Lifespan {
  return LIFESPAN_DEFAULTS[docType] || "standard";
}

function isExpired(doc: any): boolean {
  if (!doc.lifespan || doc.lifespan === "permanent" || doc.lifespan === "ephemeral") return false;
  const ttl = TTL_MS[doc.lifespan];
  if (!ttl) return false;
  const created = new Date(doc.createdAt).getTime();
  return Date.now() - created > ttl;
}

export function registerDocumentTools(server: McpServer): void {

  // document — Document queue tool (hold and forward) + messaging
  server.tool(
    "document",
    `Document queue tool. Firebase is hold-and-forward — documents land with metadata and routing info, consumers pick them up and write to local paths. Also supports inter-agent messaging.

Lifecycle: Documents have a lifespan (ephemeral|short|standard|permanent). Ephemeral docs are deleted after delivery/ack. Short (7d) and standard (30d) docs are lazy-deleted at list time. Messages default to ephemeral. Specs default to short. CLAUDE.md defaults to permanent.

Actions:
  - "push": Queue a document. Requires: type, appId, content, targetPath. Optional: metadata (JSON string), createdBy, lifespan, autoDeliver.
  - "list": List documents. Optional filters: appId, type, status (default: "pending"). Expired TTL docs are auto-purged. Returns newest first.
  - "get": Get a document by ID. Requires: docId.
  - "get-latest": Get the most recent document of a given type, regardless of status. Requires: type. Optional: appId. Useful for permanent docs like project-instructions that may be pending or delivered.
  - "update": Update a pending document before delivery. Requires: docId. Optional: content, metadata (JSON string), targetPath. Only allowed on pending-status documents.
  - "deliver": Mark delivered and delete ephemeral docs from Firebase. Requires: docId. Optional: deliveredBy.
  - "deliver-to-github": Commit to GitHub repo, then delete from Firebase on success. Requires: docId.
  - "fail": Mark as failed. Requires: docId, reason.
  - "send": Send a message (ephemeral by default). Requires: content, createdBy (sender surface). Optional: to, subject, metadata. Subject auto-generated from first line if omitted. Valid surfaces: ${SURFACES.join(", ")}.
  - "receive": Check for new messages. Requires: to (your surface name). Optional: summary (boolean). Set summary=true to get envelopes only (docId, from, subject, contentSize) — then use document(get) to read full content for specific messages. Valid surfaces: ${SURFACES.join(", ")}.
  - "ack": Acknowledge and delete message from Firebase. Requires: docId.
  - "purge": Delete all delivered/failed docs older than 24h. Returns count deleted.
  - "delete": Delete a document by ID. Requires: docId. Use for test cleanup only.`,
    {
      ...INITIATOR_PARAM,
      action: z.enum(["push", "list", "get", "get-latest", "update", "deliver", "deliver-to-github", "fail", "send", "receive", "ack", "purge", "delete"]).describe("Action to perform"),
      docId: z.string().optional().describe("Document ID (required for get/deliver/fail/ack)"),
      type: z.string().optional().describe("Document type: claude-md, spec, architecture, test-plan, design, or custom (required for push, optional filter for list)"),
      appId: z.string().optional().describe("App ID (required for push, optional filter for list)"),
      content: z.string().optional().describe("Document body (required for push/send)"),
      targetPath: z.string().optional().describe("Where to write in repo: 'CLAUDE.md', 'specs/feature-x.md', etc. (required for push)"),
      metadata: z.string().optional().describe("JSON string of type-specific metadata (optional for push/send)"),
      status: z.string().optional().describe("Filter for list: pending, delivered, failed, all (default: pending)"),
      createdBy: z.string().optional().describe(`Who created/sender surface (required for send). Valid: ${SURFACES.join(", ")}`),
      deliveredBy: z.string().optional().describe(`Who consumed. Valid: ${SURFACES.join(", ")}`),
      reason: z.string().optional().describe("Failure reason (required for fail)"),
      to: z.string().optional().describe(`Message recipient (required for send/receive). Valid: ${SURFACES.join(", ")}`),
      autoDeliver: z.boolean().optional().describe("For 'push': if true, auto-deliver to GitHub (default: false)"),
      sessionId: z.string().optional().describe("For 'push': link document to session's pendingFlush map for delivery on session close"),
      lifespan: z.enum(["ephemeral", "short", "standard", "permanent"]).optional().describe("Document lifespan. Defaults: messages=ephemeral, specs=short (7d), claude-md=permanent, other=standard (30d)."),
      limit: z.number().int().optional().describe("Max results to return for list action (default: 20)"),
      offset: z.number().int().optional().describe("Number of items to skip for pagination (default: 0)"),
      subject: z.string().optional().describe("Short subject line for messages (~80 chars). Auto-generated from first line of content if omitted. For 'send' action."),
      summary: z.boolean().optional().describe("For 'receive': if true, return envelopes only (docId, from, subject, contentSize, createdAt) instead of full content. Use document(get) to read full messages."),
    },
    async ({ initiator, action, docId, type, appId, content, targetPath, metadata, status, createdBy, deliveredBy, reason, to, autoDeliver, sessionId, lifespan, limit, offset, subject, summary }) => {
      resolveInitiator({ initiator, createdBy });
      const uid = getCurrentUid();

      // ─── PUSH ───
      if (action === "push") {
        if (!type) return withResponseSize({ content: [{ type: "text", text: "action 'push' requires type" }], isError: true });
        if (!appId) return withResponseSize({ content: [{ type: "text", text: "action 'push' requires appId" }], isError: true });
        if (!content) return withResponseSize({ content: [{ type: "text", text: "action 'push' requires content" }], isError: true });
        if (!targetPath) return withResponseSize({ content: [{ type: "text", text: "action 'push' requires targetPath" }], isError: true });

        let parsedMetadata: Record<string, any> = {};
        if (metadata) {
          try {
            parsedMetadata = JSON.parse(metadata);
          } catch {
            return withResponseSize({ content: [{ type: "text", text: "metadata must be a valid JSON string" }], isError: true });
          }
        }

        const effectiveLifespan = lifespan || getDefaultLifespan(type);
        const ref = getDocumentsRef(uid).push();
        const docId_push = ref.key!;
        const now = new Date().toISOString();
        const doc = {
          id: docId_push,
          type,
          appId,
          content,
          metadata: parsedMetadata,
          routing: {
            targetPath,
            action: "write",
          },
          lifespan: effectiveLifespan,
          status: "pending",
          createdAt: now,
          createdBy: createdBy || "claude-chat",
          deliveredAt: null,
          deliveredBy: null,
          sessionId: sessionId || null,
        };

        // If sessionId provided, atomically write doc + pendingFlush entry via multi-path update
        if (sessionId) {
          const updates: Record<string, any> = {};
          updates[`command-center/${uid}/documents/${docId_push}`] = doc;
          updates[`command-center/${uid}/sessions/${sessionId}/pendingFlush/${docId_push}`] = true;
          await getDb().ref().update(updates);
        } else {
          await ref.set(doc);
        }

        // Set projectInstructionsDirty=true on ALL user profiles when project instructions are published.
        // This triggers the forced update gate for each user on their next cold start.
        if (type === "project-instructions") {
          try {
            // Get all user UIDs via Firebase REST shallow query (avoids downloading all user data).
            // Admin SDK doesn't support shallow reads natively, so we use the REST API.
            const admin = (await import("firebase-admin")).default;
            const credential = admin.app().options.credential;
            const tokenResult = credential ? await credential.getAccessToken() : null;
            const accessToken = tokenResult?.access_token;

            const databaseURL = process.env.FIREBASE_DATABASE_URL || "https://word-boxing-default-rtdb.firebaseio.com";

            let userIds: string[] = [];
            if (accessToken) {
              const resp = await fetch(`${databaseURL}/command-center.json?shallow=true`, {
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (resp.ok) {
                const keys = await resp.json();
                userIds = Object.keys(keys || {}).filter(k => k !== "system");
              }
            }

            // Multi-path update: set dirty flag on every user's profile in one write
            if (userIds.length > 0) {
              const updates: Record<string, any> = {};
              const now = new Date().toISOString();
              for (const userId of userIds) {
                updates[`command-center/${userId}/profile/projectInstructionsDirty`] = true;
                updates[`command-center/${userId}/profile/updatedAt`] = now;
              }
              await getDb().ref().update(updates);
            }
          } catch {
            // Non-critical — dirty flag failure doesn't block push
          }
        }

        // Auto-deliver to GitHub if requested
        if (autoDeliver && isGitHubConfigured()) {
          try {
            const configSnap = await getConfigRef(uid).once("value");
            const config = configSnap.val();
            const appConfig = config?.apps?.[appId];

            if (appConfig?.repos?.prod) {
              const routing = resolveTargetRepo(type!, appConfig.repos || null, null);
              const resolvedPath = resolveFilePath(targetPath!, appConfig.subPath || null, routing?.useSubPath ?? true);
              const commitMsg = `docs(${appConfig.name || appId}): update ${type} via CC MCP [${new Date().toISOString()}]`;
              const result = await deliverToGitHub(appConfig.repos.prod, resolvedPath, content!, commitMsg);

              const deliveredNow = new Date().toISOString();

              // Ephemeral: delete from Firebase after successful delivery
              if (effectiveLifespan === "ephemeral") {
                await ref.remove();
              } else {
                await ref.update({
                  status: "delivered",
                  deliveredAt: deliveredNow,
                  deliveredBy: "mcp-github",
                  "metadata/githubCommit": { sha: result.commitSha, url: result.htmlUrl, path: result.path },
                });
              }

              return withResponseSize({ content: [{ type: "text", text: JSON.stringify({
                ...doc,
                status: "delivered",
                deliveredAt: deliveredNow,
                deliveredBy: "mcp-github",
                metadata: { ...doc.metadata, githubCommit: { sha: result.commitSha, url: result.htmlUrl, path: result.path } },
                _deleted: effectiveLifespan === "ephemeral" ? true : undefined,
              }, null, 2) }] });
            }
          } catch (err: any) {
            const failedNow = new Date().toISOString();
            await ref.update({
              status: "failed",
              deliveredAt: failedNow,
              deliveredBy: "mcp-github",
              failureReason: err.message,
            });
            return withResponseSize({ content: [{ type: "text", text: JSON.stringify({
              ...doc,
              status: "failed",
              deliveredAt: failedNow,
              failureReason: err.message,
              _note: "Auto-delivery to GitHub failed. Document is in queue for manual retry.",
            }, null, 2) }] });
          }
        }

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] });
      }

      // ─── LIST ───
      if (action === "list") {
        // v8.71.4: Use server-side query when filtering by status (default: pending)
        // This avoids downloading the entire collection — a major bandwidth cost driver.
        const statusFilter = status || "pending";
        const ref = getDocumentsRef(uid);
        const query = statusFilter !== "all"
          ? ref.orderByChild("status").equalTo(statusFilter)
          : ref;
        const snapshot = await query.once("value");
        const data = snapshot.val();
        if (!data) return withResponseSize({ content: [{ type: "text", text: JSON.stringify([], null, 2) }] });

        let docs: any[] = Object.values(data);

        // Lazy-delete: find and remove expired TTL documents
        const expiredIds: string[] = [];
        docs = docs.filter((d) => {
          if (isExpired(d)) {
            expiredIds.push(d.id);
            return false;
          }
          return true;
        });
        // Delete expired docs from Firebase in background (don't await)
        for (const expId of expiredIds) {
          getDocumentRef(uid, expId).remove().catch(() => {});
        }

        if (appId) docs = docs.filter((d) => d.appId === appId);
        if (type) docs = docs.filter((d) => d.type === type);
        // Status already filtered server-side via Firebase query above

        // Newest first
        docs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const total = docs.length;
        const skip = offset && offset > 0 ? offset : 0;
        const take = limit && limit > 0 ? limit : 20;
        docs = docs.slice(skip, skip + take);

        // Lean response: summary fields only. Use get for full record.
        const lean = docs.map((d) => ({
          id: d.id,
          type: d.type,
          appId: d.appId,
          status: d.status,
          targetPath: d.routing?.targetPath || d.targetPath || null,
          createdBy: d.createdBy,
          lifespan: d.lifespan,
          to: d.to,
          from: d.from,
          createdAt: d.createdAt,
          deliveredAt: d.deliveredAt,
        }));

        const result: any = { items: lean, total, offset: skip, limit: take };
        if (expiredIds.length > 0) result._purged = expiredIds.length;

        const avgItemSize = lean.length > 0
          ? Math.round(lean.reduce((sum: number, item: any) => sum + JSON.stringify(item).length, 0) / lean.length)
          : 0;

        return withResponseSize(
          { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
          { _estimatedItemSize: avgItemSize }
        );
      }

      // ─── GET ───
      if (action === "get") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'get' requires docId" }], isError: true });

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        const doc = snapshot.val();

        if (!doc) return withResponseSize({ content: [{ type: "text", text: `Document not found: ${docId}` }], isError: true });
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] });
      }

      // ─── GET-LATEST ───
      // Returns the most recent document of a given type, regardless of status.
      // Useful for permanent docs (project-instructions, claude-md) that persist after delivery.
      if (action === "get-latest") {
        if (!type) return withResponseSize({ content: [{ type: "text", text: "action 'get-latest' requires type" }], isError: true });

        const snapshot = await getDocumentsRef(uid)
          .orderByChild("type")
          .equalTo(type)
          .limitToLast(10)
          .once("value");
        const data = snapshot.val();
        if (!data) return withResponseSize({ content: [{ type: "text", text: `No documents found with type: ${type}` }], isError: true });

        let docs: any[] = Object.values(data);
        if (appId) docs = docs.filter((d) => d.appId === appId);

        // Sort newest first and return the most recent
        docs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const latest = docs[0];
        if (!latest) return withResponseSize({ content: [{ type: "text", text: `No documents found with type: ${type}` }], isError: true });

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(latest, null, 2) }] });
      }

      // ─── UPDATE ───
      if (action === "update") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'update' requires docId" }], isError: true });

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        const doc = snapshot.val();

        if (!doc) return withResponseSize({ content: [{ type: "text", text: `Document not found: ${docId}` }], isError: true });
        if (doc.status !== "pending") {
          return withResponseSize({ content: [{ type: "text", text: `Cannot update document with status '${doc.status}' (must be pending)` }], isError: true });
        }

        const updates: Record<string, any> = {};
        if (content !== undefined) updates.content = content;
        if (targetPath !== undefined) updates["routing/targetPath"] = targetPath;
        if (metadata !== undefined) {
          try {
            const parsed = JSON.parse(metadata);
            updates.metadata = { ...(doc.metadata || {}), ...parsed };
          } catch {
            return withResponseSize({ content: [{ type: "text", text: "metadata must be a valid JSON string" }], isError: true });
          }
        }

        if (Object.keys(updates).length === 0) {
          return withResponseSize({ content: [{ type: "text", text: "No fields to update. Provide content, metadata, or targetPath." }], isError: true });
        }

        await ref.update(updates);

        const updatedSnap = await ref.once("value");
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(updatedSnap.val(), null, 2) }] });
      }

      // ─── DELIVER ───
      if (action === "deliver") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'deliver' requires docId" }], isError: true });

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        const doc = snapshot.val();

        if (!doc) return withResponseSize({ content: [{ type: "text", text: `Document not found: ${docId}` }], isError: true });
        if (doc.status !== "pending") {
          return withResponseSize({ content: [{ type: "text", text: `Cannot deliver document with status '${doc.status}' (must be pending)` }], isError: true });
        }

        const now = new Date().toISOString();
        const effectiveLifespan = doc.lifespan || getDefaultLifespan(doc.type || "");

        // Ephemeral: delete from Firebase after delivery
        if (effectiveLifespan === "ephemeral") {
          await ref.remove();
          return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ ...doc, status: "delivered", deliveredAt: now, deliveredBy: deliveredBy || "claude-code", _deleted: true }, null, 2) }] });
        }

        await ref.update({
          status: "delivered",
          deliveredAt: now,
          deliveredBy: deliveredBy || "claude-code",
        });

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ ...doc, status: "delivered", deliveredAt: now, deliveredBy: deliveredBy || "claude-code" }, null, 2) }] });
      }

      // ─── FAIL ───
      if (action === "fail") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'fail' requires docId" }], isError: true });
        if (!reason) return withResponseSize({ content: [{ type: "text", text: "action 'fail' requires reason" }], isError: true });

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        const doc = snapshot.val();

        if (!doc) return withResponseSize({ content: [{ type: "text", text: `Document not found: ${docId}` }], isError: true });
        if (doc.status !== "pending") {
          return withResponseSize({ content: [{ type: "text", text: `Cannot fail document with status '${doc.status}' (must be pending)` }], isError: true });
        }

        const now = new Date().toISOString();
        await ref.update({
          status: "failed",
          deliveredAt: now,
          deliveredBy: deliveredBy || "claude-code",
          failureReason: reason,
        });

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ ...doc, status: "failed", deliveredAt: now, failureReason: reason }, null, 2) }] });
      }

      // ─── DELIVER TO GITHUB ───
      if (action === "deliver-to-github") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'deliver-to-github' requires docId" }], isError: true });

        if (!isGitHubConfigured()) {
          return withResponseSize({ content: [{ type: "text", text: "GitHub delivery not configured. Set GITHUB_TOKEN environment variable." }], isError: true });
        }

        const token = process.env.GITHUB_TOKEN!;

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        const doc = snapshot.val();

        if (!doc) return withResponseSize({ content: [{ type: "text", text: `Document not found: ${docId}` }], isError: true });
        if (doc.status !== "pending") {
          return withResponseSize({ content: [{ type: "text", text: `Cannot deliver document with status '${doc.status}' (must be pending)` }], isError: true });
        }

        // Look up app config for repo info
        const configSnap = await getConfigRef(uid).once("value");
        const config = configSnap.val();
        const appConfig = config?.apps?.[doc.appId];

        // Look up user profile for docs-repo
        const profileSnap = await getProfileRef(uid).once("value");
        const profile = profileSnap.val();
        const docsRepoName = profile?.docsRepoName || null;

        // Type-based routing: resolve target repo and whether to use subPath
        const appRepos = appConfig?.repos || null;
        let routing = resolveTargetRepo(doc.type, appRepos, docsRepoName);

        // Lazy docs-repo creation: if routing fails for non-app-scoped docs,
        // auto-create the docs repo and retry routing
        const isAppScoped = doc.type === "claude-md" || doc.type === "spec" || doc.type === "project-instructions";
        if (!routing && !isAppScoped && !docsRepoName) {
          try {
            const uidShort = uid.substring(0, 8);
            const docsResult = await setupDocsRepo(uidShort, token);

            // Store docsRepoPath on user profile
            await getProfileRef(uid).update({ docsRepoPath: docsResult.repoPath });

            // Retry routing with the new docs repo
            routing = resolveTargetRepo(doc.type, appRepos, docsResult.repoPath);
          } catch (setupErr: any) {
            return withResponseSize({ content: [{ type: "text" as const, text: `Auto-setup of docs repo failed: ${setupErr.message}. You can retry or set up manually via app(action="setup-docs-repo").` }], isError: true });
          }
        }

        if (!routing) {
          return withResponseSize({ content: [{ type: "text" as const, text: `No repo configured for delivery. App '${doc.appId}' needs repos.prod set, or configure profile.docsRepoPath for non-app-scoped docs.` }], isError: true });
        }

        const docTargetPath = doc.routing?.targetPath || "CLAUDE.md";
        const filePath = resolveFilePath(docTargetPath, appConfig?.subPath || null, routing.useSubPath);
        const commitMsg = `docs(${appConfig?.name || doc.appId}): update ${doc.type} via CC MCP [${new Date().toISOString()}]`;

        try {
          const result = await deliverToGitHub(routing.repo, filePath, doc.content, commitMsg, "main", token);
          const now = new Date().toISOString();

          // Permanent docs (project-instructions, claude-md) stay in Firebase after GitHub delivery
          // so downstream consumers (e.g. wizard, dirty flag flow) can still read them.
          // All other types are deleted from Firebase after successful delivery.
          const docLifespan = doc.lifespan || getDefaultLifespan(doc.type || "");
          if (docLifespan === "permanent") {
            await ref.update({
              status: "delivered",
              deliveredAt: now,
              deliveredBy: "mcp-github",
              "metadata/githubCommit": { sha: result.commitSha, url: result.htmlUrl, path: result.path },
            });
          } else {
            await ref.remove();
          }

          return withResponseSize({ content: [{ type: "text", text: JSON.stringify({
            status: "delivered",
            repo: routing.repo,
            path: result.path,
            commitSha: result.commitSha,
            htmlUrl: result.htmlUrl,
            _deleted: docLifespan !== "permanent",
          }, null, 2) }] });
        } catch (err: any) {
          const now = new Date().toISOString();
          await ref.update({
            status: "failed",
            deliveredAt: now,
            deliveredBy: "mcp-github",
            failureReason: err.message,
          });
          return withResponseSize({ content: [{ type: "text", text: `GitHub delivery failed: ${err.message}` }], isError: true });
        }
      }

      // ─── SEND (Message) ───
      if (action === "send") {
        if (!content) return withResponseSize({ content: [{ type: "text", text: "action 'send' requires content" }], isError: true });
        if (!to) return withResponseSize({ content: [{ type: "text", text: "action 'send' requires 'to' (recipient surface)" }], isError: true });

        const recipient = to;
        const sender = createdBy || "claude-chat";

        let parsedMetadata: Record<string, any> = {};
        if (metadata) {
          try {
            parsedMetadata = JSON.parse(metadata);
          } catch {
            return withResponseSize({ content: [{ type: "text", text: "metadata must be a valid JSON string" }], isError: true });
          }
        }

        const effectiveSubject = subject || content.split("\n")[0].slice(0, 80);
        const effectiveLifespan = lifespan || "ephemeral";
        const ref = getDocumentsRef(uid).push();
        const now = new Date().toISOString();
        const msg = {
          id: ref.key,
          type: "message",
          appId: appId || null,
          subject: effectiveSubject,
          content,
          metadata: {
            ...parsedMetadata,
            from: sender,
            to: recipient,
          },
          routing: {
            targetPath: null,
            action: "message",
          },
          lifespan: effectiveLifespan,
          status: "pending",
          createdAt: now,
          createdBy: sender,
          deliveredAt: null,
          deliveredBy: null,
        };
        await ref.set(msg);
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(msg, null, 2) }] });
      }

      // ─── RECEIVE (Messages) ───
      if (action === "receive") {
        if (!to) return withResponseSize({ content: [{ type: "text", text: "action 'receive' requires 'to' (your surface name)" }], isError: true });
        setSuppressPiggyback(true); // Avoid redundant _pendingMessages in response
        const recipient = to;

        // v8.71.4: Server-side filter on status=pending to avoid downloading entire collection.
        // Was the #1 Firebase cost driver when polled frequently (~1MB per read).
        const snapshot = await getDocumentsRef(uid)
          .orderByChild("status")
          .equalTo("pending")
          .once("value");
        const data = snapshot.val();
        if (!data) return withResponseSize({ content: [{ type: "text", text: JSON.stringify([], null, 2) }] });

        let msgs: any[] = Object.values(data);
        msgs = msgs.filter((d) =>
          d.type === "message" &&
          d.metadata?.to === recipient
        );

        // Oldest first (chronological order for reading)
        msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        // Summary mode: return envelopes only (saves tokens)
        if (summary) {
          const envelopes = msgs.map((m: any) => ({
            docId: m.id,
            from: m.metadata?.from || "unknown",
            to: m.metadata?.to || "unknown",
            subject: m.subject || m.content?.split("\n")[0]?.slice(0, 80) || "(no subject)",
            contentSize: m.content?.length || 0,
            createdAt: m.createdAt,
          }));
          return withResponseSize({ content: [{ type: "text", text: JSON.stringify(envelopes, null, 2) }] });
        }

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(msgs, null, 2) }] });
      }

      // ─── ACK (Acknowledge Message) ───
      if (action === "ack") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'ack' requires docId" }], isError: true });

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        const doc = snapshot.val();

        if (!doc) return withResponseSize({ content: [{ type: "text", text: `Message not found: ${docId}` }], isError: true });
        if (doc.type !== "message") return withResponseSize({ content: [{ type: "text", text: `Document ${docId} is not a message (type: ${doc.type})` }], isError: true });
        if (doc.status !== "pending") return withResponseSize({ content: [{ type: "text", text: `Message already acknowledged (status: ${doc.status})` }], isError: true });

        const now = new Date().toISOString();
        const ackResult = { ...doc, status: "delivered", deliveredAt: now, deliveredBy: doc.metadata?.to || "unknown" };

        // Messages are ephemeral by default — delete from Firebase after ack (per RULE)
        const effectiveLifespan = doc.lifespan || "ephemeral";
        if (effectiveLifespan === "ephemeral") {
          await ref.remove();
          return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ ...ackResult, _deleted: true }, null, 2) }] });
        }

        await ref.update({
          status: "delivered",
          deliveredAt: now,
          deliveredBy: doc.metadata?.to || "unknown",
        });

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify(ackResult, null, 2) }] });
      }

      // ─── PURGE ───
      if (action === "purge") {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
        let purged = 0;

        // v8.71.4: Query delivered and failed separately to avoid full collection read
        for (const purgeStatus of ["delivered", "failed"]) {
          const snapshot = await getDocumentsRef(uid)
            .orderByChild("status")
            .equalTo(purgeStatus)
            .once("value");
          const data = snapshot.val();
          if (!data) continue;

          for (const d of Object.values(data) as any[]) {
            if (d.createdAt && new Date(d.createdAt).getTime() < cutoff && d.id) {
              await getDocumentRef(uid, d.id).remove();
              purged++;
            }
          }
        }

        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ purged, cutoff: new Date(cutoff).toISOString() }, null, 2) }] });
      }

      // ─── DELETE ───
      if (action === "delete") {
        if (!docId) return withResponseSize({ content: [{ type: "text", text: "action 'delete' requires docId" }], isError: true });

        const ref = getDocumentRef(uid, docId);
        const snapshot = await ref.once("value");
        if (!snapshot.val()) return withResponseSize({ content: [{ type: "text", text: `Document not found: ${docId}` }], isError: true });

        await ref.remove();
        return withResponseSize({ content: [{ type: "text", text: JSON.stringify({ deleted: docId }) }] });
      }

      return withResponseSize({ content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true });
    }
  );
}
