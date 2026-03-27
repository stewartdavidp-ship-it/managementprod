import express, { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initFirebase } from "./firebase.js";
import { createServer } from "./server.js";
import { initSkillCache } from "./skill-cache.js";
import { createOAuthRouter } from "./auth/oauth.js";
import { validateAccessToken, validateApiKey, triggerCleanup } from "./auth/store.js";
import { requestContext, setServerSentTotal, setInteractionTotal, setTurnDelta, getTurnDelta, setPendingMessages, setSignals, setInitiator, setInitiatorExplicit, setToolName, getSessionMeta, getPendingMessages as getCtxPendingMessages, setContextEstimateAbsolute, getContextEstimateAbsolute, type PendingMessagesInfo } from "./context.js";
import { computeSignals } from "./signal-computation.js";
import { parseSurface } from "./surfaces.js";
import { getActiveSessionId, getPendingServerSentAccumulation, getPendingInteractionAccumulation, incrementInteractionTotal, setInteractionAbsolute } from "./tools/sessions.js";
import { getSessionRef, getDocumentsRef, getDb } from "./firebase.js";
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

  // Check both metadata.to (document(send) format) and top-level to (legacy job notifications)
  const messages = msgs.map((m: any) => ({
    to: m.metadata?.to || m.to || "unknown",
    from: m.metadata?.from || m.from || "unknown",
    subject: m.subject || (m.content ? m.content.split("\n")[0].slice(0, 80) : "(no subject)"),
  }));

  const info: PendingMessagesInfo = {
    count: msgs.length,
    messages,
  };

  setPendingMessages(info);
}

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
// Tracks serverSentTotal and interactionTotal for compaction prediction
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
    // Lazy skill cache init — if not initialized at startup (e.g., no FIREBASE_UID env),
    // initialize on first authenticated request. Non-blocking after first call.
    if (firebaseUid) {
      try {
        await initSkillCache(firebaseUid);
      } catch {
        // Non-critical — will use compiled fallback
      }
    }

    // Extract initiator + turnDelta FIRST — needed for per-surface context loading below.
    // This is the "base handler" approach — parsed at middleware level, not per-tool.
    // The parameter is accepted by Zod via INITIATOR_PARAM on every tool.
    let surface: ReturnType<typeof parseSurface> = null;
    if (firebaseUid && !Array.isArray(req.body) && req.body?.method === "tools/call") {
      // Track tool name for context-aware warnings (e.g., turnDelta compliance)
      const toolNameRaw = req.body.params?.name;
      if (typeof toolNameRaw === "string") {
        setToolName(toolNameRaw);
      }

      const initiatorArg = req.body.params?.arguments?.initiator;
      surface = parseSurface(initiatorArg);
      if (surface) {
        setInitiator(surface);
        setInitiatorExplicit(true); // Explicitly provided — not inferred from createdBy

        // Track connected surfaces — fire-and-forget write for wizard real-time status.
        // Excludes "user" (admin surface, not a Claude connector).
        if (surface !== "user") {
          const now = new Date().toISOString();
          const updates: Record<string, unknown> = {
            [`command-center/${firebaseUid}/connectedSurfaces/${surface}/lastSeen`]: now,
          };
          // Chat and Cowork share the same Claude.ai connector —
          // if one works, the other does too.
          if (surface === "claude-chat") {
            updates[`command-center/${firebaseUid}/connectedSurfaces/claude-cowork/lastSeen`] = now;
          } else if (surface === "claude-cowork") {
            updates[`command-center/${firebaseUid}/connectedSurfaces/claude-chat/lastSeen`] = now;
          }
          getDb().ref().update(updates).catch(() => {});
        }
      }

      // Extract turnDelta or contextEstimate for context tracking.
      // turnDelta = delta (chars consumed since last call) → accumulate
      // contextEstimate = absolute (total context window usage) → replace, don't accumulate
      const rawArgs = req.body.params?.arguments;
      const turnDelta = rawArgs?.turnDelta;
      const contextEstimate = rawArgs?.contextEstimate;

      if (typeof turnDelta === "number" && turnDelta >= 0) {
        // Delta semantics: accumulate into interactionTotal
        setTurnDelta(turnDelta);
        if (turnDelta > 0 && surface) {
          incrementInteractionTotal(firebaseUid, turnDelta, surface).catch(() => {});
        }
      } else if (typeof contextEstimate === "number" && contextEstimate >= 0) {
        // Absolute semantics: store for override after Firebase load (step 2 below)
        setTurnDelta(contextEstimate); // For turnDelta compliance warning check
        setContextEstimateAbsolute(contextEstimate);
        // Do NOT call incrementInteractionTotal — contextEstimate is NOT a delta
      }
    }

    // Resolve active session once per request (heartbeat model)
    // Caches in AsyncLocalStorage — all tool calls in this batch reuse the result
    if (firebaseUid) {
      try {
        await ensureSession();  // No toolContext — mismatch detection handled by opt-in tools
      } catch (err) {
        // Non-critical — _session metadata will be omitted if this fails
        console.error("Session lifecycle error:", err);
      }

      // Load per-surface context totals from Firebase for _contextHealth.
      // Each surface (Chat, Code) gets independent tracking since each is a separate context window.
      // Data stored at session.contextBySurface/{surface}/{serverSent, interaction}.
      try {
        const activeSessionId = getActiveSessionId(firebaseUid);
        if (activeSessionId && surface) {
          const surfacePath = `contextBySurface/${surface}`;
          const serverSentSnap = await getSessionRef(firebaseUid, activeSessionId)
            .child(`${surfacePath}/serverSent`).once("value");
          const firebaseServerSent = serverSentSnap.val() || 0;
          const pendingServerSent = getPendingServerSentAccumulation(firebaseUid, surface);
          setServerSentTotal(firebaseServerSent + pendingServerSent);

          // For interactionTotal: contextEstimate (absolute) overrides accumulated value.
          // turnDelta (delta) uses the standard accumulated path.
          const absoluteEstimate = getContextEstimateAbsolute();
          if (absoluteEstimate !== undefined) {
            // contextEstimate is absolute — use it directly as interactionTotal.
            // Sync to Firebase so subsequent requests read the correct baseline.
            setInteractionTotal(absoluteEstimate);
            setInteractionAbsolute(firebaseUid, absoluteEstimate, surface).catch(() => {});
          } else {
            // turnDelta path — use accumulated total from Firebase + pending
            const interactionSnap = await getSessionRef(firebaseUid, activeSessionId)
              .child(`${surfacePath}/interaction`).once("value");
            const firebaseInteraction = interactionSnap.val() || 0;
            const pendingInteraction = getPendingInteractionAccumulation(firebaseUid, surface);
            setInteractionTotal(firebaseInteraction + pendingInteraction);
          }
        }
      } catch {
        // Non-critical — _contextHealth will be omitted if this fails
      }

      // Piggyback message notifications — check for pending messages once per request.
      // Result is cached in AsyncLocalStorage and injected into every tool response
      // via withResponseSize() in response-metadata.ts.
      try {
        await checkPendingMessages(firebaseUid);
      } catch {
        // Non-critical — _pendingMessages will be omitted if this fails
      }

      // Compute active signal codes once per request.
      // Uses initiator, session meta, and pending messages already loaded above.
      // Result is cached in AsyncLocalStorage and piggybacked on every tool response.
      try {
        const signals = await computeSignals({
          uid: firebaseUid,
          surface: parseSurface(
            !Array.isArray(req.body) ? req.body?.params?.arguments?.initiator : undefined
          ) || undefined,
          sessionMeta: getSessionMeta(),
          pendingMessages: getCtxPendingMessages(),
          turnDeltaProvided: getTurnDelta() !== undefined,
        });
        setSignals(signals.length > 0 ? signals : null);
      } catch {
        // Non-critical — _signals will be omitted if this fails
      }
    }

    // Create a NEW MCP server per request — the MCP SDK only supports one transport
    // per server instance. Concurrent requests (e.g., Claude.ai sending parallel tool
    // calls) would get "Already connected to a transport" with a singleton server.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
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
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
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

// Initialize skill cache from Firebase before accepting requests
const STARTUP_UID = process.env.FIREBASE_UID;
if (STARTUP_UID) {
  initSkillCache(STARTUP_UID)
    .then(() => {
      app.listen(PORT, () => {
        console.log(`CC MCP Server listening on :${PORT}`);
        console.log(`Base URL: ${BASE_URL}`);
        console.log(`MCP endpoint: ${BASE_URL}/mcp`);
        console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
        console.log(`Auth: ${process.env.SKIP_AUTH === "true" || process.env.NODE_ENV === "development" ? "DISABLED (dev mode)" : "OAuth 2.1"}`);
        console.log(`GitHub delivery: ${process.env.GITHUB_TOKEN ? "ENABLED" : "DISABLED (no GITHUB_TOKEN)"}`);
      });
    })
    .catch((err) => {
      console.error("[startup] Skill cache init failed, starting without cache:", err);
      app.listen(PORT, () => {
        console.log(`CC MCP Server listening on :${PORT} (skill cache unavailable)`);
      });
    });
} else {
  console.warn("[startup] No FIREBASE_UID — skill cache not initialized (will use compiled fallback)");
  app.listen(PORT, () => {
    console.log(`CC MCP Server listening on :${PORT}`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`MCP endpoint: ${BASE_URL}/mcp`);
    console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
    console.log(`Auth: ${process.env.SKIP_AUTH === "true" || process.env.NODE_ENV === "development" ? "DISABLED (dev mode)" : "OAuth 2.1"}`);
    console.log(`GitHub delivery: ${process.env.GITHUB_TOKEN ? "ENABLED" : "DISABLED (no GITHUB_TOKEN)"}`);
  });
}
