import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initFirebase } from "./firebase.js";
import { createServer } from "./server.js";
import { createOAuthRouter } from "./auth/oauth.js";
import { validateAccessToken, validateApiKey, triggerCleanup } from "./auth/store.js";
import { requestContext, setContextEstimate, setContextPerSurface, setSurfaceContextEstimate, setPendingMessages, type PendingMessagesInfo } from "./context.js";
import { getActiveSessionId, getPendingContextAccumulation, getPendingContextPerSurface } from "./tools/sessions.js";
import { getSessionRef, getDocumentsRef } from "./firebase.js";
import { ensureSession } from "./session-lifecycle.js";

// Initialize Firebase before anything else
initFirebase();

const PORT = parseInt(process.env.PORT || "8080");

// SAFETY: Block SKIP_AUTH in production — prevents accidental auth bypass on Cloud Run
if (process.env.K_SERVICE && process.env.SKIP_AUTH === "true") {
  console.error("🛑 FATAL: SKIP_AUTH=true is set in a Cloud Run environment. This would bypass all authentication. Exiting.");
  process.exit(1);
}

// BASE_URL is REQUIRED for production — OAuth metadata endpoints use it.
// Cloud Run does not expose the service URL as an env var, so it must be set explicitly.
// Without it, OAuth endpoints return localhost URLs and Claude.ai cannot authenticate.
if (!process.env.BASE_URL && process.env.K_SERVICE) {
  console.error(
    "⚠️  CRITICAL: BASE_URL env var is not set! OAuth will not work.\n" +
    "   Claude.ai will see localhost URLs in OAuth metadata and cannot authenticate.\n" +
    "   Set BASE_URL to the Cloud Run service URL in your deploy command:\n" +
    "   --set-env-vars=\"BASE_URL=https://<service>-<project-number>.<region>.run.app\"\n" +
    "   See deploy.sh for the correct command."
  );
}

// Warn if FIREBASE_WEB_API_KEY is missing in production — Google Sign-In will silently fail
if (!process.env.FIREBASE_WEB_API_KEY && process.env.K_SERVICE) {
  console.error("⚠️  WARNING: FIREBASE_WEB_API_KEY env var is not set. Google Sign-In on the OAuth page will not work.");
}

const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Check for pending messages and cache in request context for piggyback notifications.
// Called once per HTTP request — all tool calls in a batch share the result.
async function checkPendingMessages(uid: string): Promise<void> {
  const snapshot = await getDocumentsRef(uid)
    .orderByChild("status")
    .equalTo("pending")
    .limitToLast(20)
    .once("value");

  const data = snapshot.val();
  if (!data) {
    setPendingMessages(null);
    return;
  }

  const msgs = Object.values(data as Record<string, any>)
    .filter((d: any) => d.type === "message");

  if (msgs.length === 0) {
    setPendingMessages(null);
    return;
  }

  // Sort oldest first for consistent ordering
  msgs.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const messages = msgs.map((m: any) => ({
    to: m.metadata?.to || "unknown",
    from: m.metadata?.from || "unknown",
    subject: m.subject || (m.content ? m.content.split("\n")[0].slice(0, 80) : "(no subject)"),
  }));

  const info: PendingMessagesInfo = {
    count: msgs.length,
    messages,
  };

  setPendingMessages(info);
}

// Create MCP server
const mcpServer = createServer();

// Create Express app
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// CORS — allow Claude.ai origins
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    "https://claude.ai",
    "https://claude.com",
    "https://www.claude.ai",
    "https://www.claude.com",
  ];

  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id"
  );
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Mount OAuth routes
const oauthRouter = createOAuthRouter(BASE_URL);
app.use(oauthRouter);

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "cc-mcp-server",
    version: "1.0.0",
    environment: process.env.BASE_URL?.includes("-test-") ? "test" : "prod",
    description: "Command Center MCP Server — ODRC concept management for Claude.ai",
    status: "ok",
  });
});

// Auth middleware — extracts Firebase UID from bearer token and stores in request
// Supports two token types:
//   1. CC API keys (cc_{uid}_{secret}) — persistent, stored in Firebase RTDB, for Claude Code
//   2. OAuth access tokens (UUID) — persistent, stored in Firebase RTDB with SHA-256 hashing, for Claude.ai Chat
async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Dev mode: use FIREBASE_UID env var
  if (process.env.NODE_ENV === "development" || process.env.SKIP_AUTH === "true") {
    const uid = process.env.FIREBASE_UID;
    if (uid) {
      (req as any).firebaseUid = uid;
    }
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "unauthorized",
      error_description: "Bearer token required",
    });
    return;
  }

  const token = authHeader.slice(7);
  const ip = req.ip || (req.headers["x-forwarded-for"] as string) || null;

  // Trigger periodic cleanup of expired tokens/auth codes (fire-and-forget)
  triggerCleanup();

  // CC API key path — persistent keys stored in Firebase RTDB (survives cold starts)
  if (token.startsWith("cc_")) {
    try {
      const apiKeyResult = await validateApiKey(token, ip);
      if (apiKeyResult) {
        (req as any).firebaseUid = apiKeyResult.uid;
        next();
        return;
      }
    } catch (err) {
      console.error("API key validation error:", err);
    }
    res.status(401).json({
      error: "invalid_token",
      error_description: "API key invalid or not found",
    });
    return;
  }

  // OAuth token path — Firebase RTDB with SHA-256 hashing + in-memory cache
  const validToken = await validateAccessToken(token, ip);
  if (!validToken) {
    res.status(401).json({
      error: "invalid_token",
      error_description: "Token expired or invalid. Reconnect this MCP server in Settings.",
    });
    return;
  }

  // Attach the user's Firebase UID to the request
  (req as any).firebaseUid = validToken.uid;
  next();
}

// MCP endpoint — Streamable HTTP (stateless)
// Wraps the handler in AsyncLocalStorage so tools can access the UID
// Also intercepts response to auto-increment contextEstimate on active sessions
app.post("/mcp", authMiddleware, async (req: Request, res: Response) => {
  const firebaseUid = (req as any).firebaseUid;

  // Context estimation moved to withResponseSize() in response-metadata.ts
  // Previously intercepted res.write/res.end to count HTTP bytes, but that
  // included MCP protocol overhead (initialize, tools/list, JSON-RPC framing,
  // SSE framing) which inflated the estimate ~20x vs actual tool content.
  // Now we count only tool result content chars — a much better proxy for
  // what actually enters the LLM context window.

  // Run the MCP handler within the user's context
  requestContext.run({ firebaseUid }, async () => {
    // Load contextEstimate from Firebase once per request for _contextHealth
    // Uses active session cache + pending accumulation for accurate reading
    if (firebaseUid) {
      try {
        const activeSessionId = getActiveSessionId(firebaseUid);
        if (activeSessionId) {
          // Load global + per-surface context estimates in parallel (no latency increase)
          const [globalSnap, perSurfaceSnap] = await Promise.all([
            getSessionRef(firebaseUid, activeSessionId).child("contextEstimate").once("value"),
            getSessionRef(firebaseUid, activeSessionId).child("contextPerSurface").once("value"),
          ]);
          const firebaseGlobal = globalSnap.val() || 0;
          const firebasePerSurface: Record<string, number> = perSurfaceSnap.val() || {};

          const pendingAccum = getPendingContextAccumulation(firebaseUid);
          setContextEstimate(firebaseGlobal + pendingAccum);

          // Merge Firebase per-surface with pending per-surface accumulations
          const pendingPerSurface = getPendingContextPerSurface(firebaseUid);
          const mergedPerSurface: Record<string, number> = { ...firebasePerSurface };
          for (const [surface, pending] of Object.entries(pendingPerSurface)) {
            mergedPerSurface[surface] = (mergedPerSurface[surface] || 0) + pending;
          }
          setContextPerSurface(mergedPerSurface);
        }
      } catch {
        // Non-critical — _contextHealth will be omitted if this fails
      }

      // Resolve active session once per request (heartbeat model)
      // Caches in AsyncLocalStorage — all tool calls in this batch reuse the result
      try {
        await ensureSession();  // No toolContext — mismatch detection handled by opt-in tools
      } catch (err) {
        // Non-critical — _session metadata will be omitted if this fails
        console.error("Session lifecycle error:", err);
      }

      // Extract surface-reported contextEstimate from tool call arguments (if present).
      // This is the "base handler" approach — parsed at middleware level, not per-tool.
      // The parameter is accepted by Zod via INITIATOR_PARAM on every tool.
      if (!Array.isArray(req.body) && req.body?.method === "tools/call") {
        const ce = req.body.params?.arguments?.contextEstimate;
        if (typeof ce === "number" && ce >= 0) {
          setSurfaceContextEstimate(ce);

          // Persist to session record (fire-and-forget)
          const activeSessionId2 = getActiveSessionId(firebaseUid);
          if (activeSessionId2) {
            getSessionRef(firebaseUid, activeSessionId2)
              .update({ lastContextEstimate: ce })
              .catch(() => {});
          }
        }
      }

      // Piggyback message notifications — check for pending messages once per request.
      // Result is cached in AsyncLocalStorage and injected into every tool response
      // via withResponseSize() in response-metadata.ts.
      try {
        await checkPendingMessages(firebaseUid);
      } catch {
        // Non-critical — _pendingMessages will be omitted if this fails
      }
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });
});

// GET /mcp — required for SSE transport fallback
app.get("/mcp", authMiddleware, async (req: Request, res: Response) => {
  const firebaseUid = (req as any).firebaseUid;

  requestContext.run({ firebaseUid }, async () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP GET error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });
});

// DELETE /mcp — session cleanup (no-op for stateless)
app.delete("/mcp", (_req: Request, res: Response) => {
  res.sendStatus(200);
});

// HEAD /mcp — capability check
app.head("/mcp", (_req: Request, res: Response) => {
  res.header("MCP-Protocol-Version", "2025-06-18");
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`CC MCP Server listening on :${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`MCP endpoint: ${BASE_URL}/mcp`);
  console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`Auth: ${process.env.SKIP_AUTH === "true" || process.env.NODE_ENV === "development" ? "DISABLED (dev mode)" : "OAuth 2.1"}`);
  console.log(`GitHub delivery: ${process.env.GITHUB_TOKEN ? "ENABLED" : "DISABLED (no GITHUB_TOKEN)"}`);
});
