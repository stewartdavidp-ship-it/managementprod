# Command Center — Architecture

> **Last updated:** 2026-02-25 (v8.72.0)
>
> **Companion document:** For MCP server architecture, see `mcp-server/architecture/SYSTEM-CONTEXT.md` (Rev 27).

---

## Index

| Section | Description | ~Size |
|---------|-------------|-------|
| Quick Reference | File paths, deploy commands, safety rules | 2.2K |
| Overview | What CC is, tech stack summary, data/decision layer principle | 0.8K |
| Ecosystem Map | Cloud Run, Firebase, GitHub, auth model | 2.7K |
| Component Hierarchy | React component tree, navigation tabs | 1.1K |
| Firebase Realtime Listeners | Active/suspended listeners, limits, costs | 1.8K |
| Data Flow | Browser↔Firebase↔MCP↔Functions data paths | 2.8K |
| ODRC Concept Lifecycle | State machine, transitions, operations, history chain | 2.0K |
| Knowledge Tree System | Evidence Engine: forests, trees, nodes, concept pointers | 2.5K |
| Idea Health System | Staleness matrix, triage flags, health computation integration | 1.5K |
| Cost Architecture | Firebase billing, guardrails, incident history | 1.5K |
| CC Cloud Functions | domainProxy, documentCleanup, Game Shelf note | 0.7K |
| Repositories | GitHub repos (public/private) | 0.4K |
| Styling | Tailwind, dark theme, no build system | 0.2K |
| Known Issues | Open bugs and accepted limitations | 0.5K |
| Architecture Backlog | Open/resolved tech debt and security items | 3.0K |
| Disaster Recovery | Service recovery, env vars, backup strategy | 1.7K |

**Usage:** Load this index only (~600 chars) via `repo_file(section="## Index")`, then load specific sections as needed via `repo_file(section="## Section Name")`.

---

## Quick Reference

**Read this first.** Everything a new session needs to start working.

| Item | Value |
|------|-------|
| **CC app** | `/Users/davidstewart/Downloads/command-center/index.html` (single-file, v8.72.0) |
| **MCP server** | `/Users/davidstewart/Downloads/command-center/mcp-server/src/` |
| **Firebase Functions** | `/Users/davidstewart/Downloads/firebase-functions/functions/index.js` |
| **Firebase Rules** | `/Users/davidstewart/Downloads/firebase-functions/database.rules.json` |
| **GH Pages site** | `/Users/davidstewart/Downloads/command-center-test/` → `stewartdavidp-ship-it.github.io/command-center-test/` |
| **Firebase project** | `word-boxing` |
| **Firebase UID** | `oUt4ba0dYVRBfPREqoJ1yIsJKjr1` |
| **MCP server (prod)** | `https://cc-mcp-server-300155036194.us-central1.run.app` |
| **MCP server (test)** | `https://cc-mcp-server-test-300155036194.us-central1.run.app` |

### Deploy Commands

```bash
# CC browser app → GitHub Pages
cp index.html ../command-center-test/ && cd ../command-center-test && git add index.html && git commit -m "v8.x.x" && git push

# MCP server → Cloud Run (test by default, --prod for production)
cd mcp-server && bash deploy.sh          # deploys to cc-mcp-server-test
cd mcp-server && bash deploy.sh --prod   # deploys to cc-mcp-server (confirmation required)

# Firebase Functions (CC only — MUST target specific functions, Game Shelf deployed separately)
cd /Users/davidstewart/Downloads/firebase-functions && firebase deploy --only functions:domainProxy,functions:documentCleanup --project word-boxing

# Firebase RTDB Rules
cd /Users/davidstewart/Downloads/firebase-functions && firebase deploy --only database --project word-boxing
```

### Safety Rules (Do Not Violate)

1. **All `.on('value')` listeners MUST use `limitToLast(N)`** — unbounded listeners caused a $17/day billing crisis in Feb 2026
2. **Never create polling scripts for `document(receive)`** — use MCP tools instead. See SYSTEM-CONTEXT.md Section 17.
3. **`domainProxy` requires Firebase Auth token** — all 3 call sites in index.html pass Bearer token via `Authorization` header
4. **Deploy Firebase Functions with `--only functions:NAME`** — bare `--only functions` will try to delete 22 Game Shelf functions
5. **MCP server deploys go to test first** — `bash deploy.sh` defaults to test. Only promote to prod (`bash deploy.sh --prod`) after verifying on test.

---

## Overview

Command Center (CC) is an **AI ideation rigor platform** — a structured system for turning vague ideas into well-formed, buildable specifications before code is written. It manages ODRC concepts (OPENs, DECISIONs, RULEs, CONSTRAINTs), ideation sessions, build jobs, and inter-agent messaging between Claude Chat and Claude Code.

CC is a single-file React application deployed via GitHub Pages. It uses React 18 via CDN, Tailwind CSS via CDN, and Firebase Realtime Database for persistence.

### Design Principle: Data Layer / Decision Layer

CC is the data and persistence layer. Claude is the reasoning and decision layer. The MCP server is the interface between them.

- **CC (MCP server + Firebase)** persists, indexes, queries, and serves structured data. It enforces schema validation, computes deterministic signals (staleness, scope creep), and manages lifecycle state machines. It does not make reasoning decisions about what to build, how to design, or whether a concept is good.
- **Claude (Chat + Code)** reasons, decides, creates, and reviews. Chat does ideation and specification. Code does implementation. Both operate through MCP tools — they read structured state, make decisions, and write results back.
- **The boundary:** if it requires judgment, it's Claude's job. If it requires persistence or computation, it's CC's job. This prevents reasoning logic from creeping into the MCP server and data management from creeping into skills.

---

## Ecosystem Map

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          CC Ecosystem                                    │
│                                                                          │
│  ┌─────────────┐    Firebase RTDB     ┌──────────────────────┐          │
│  │  CC Browser  │◄──────────────────►│  word-boxing          │          │
│  │  App (SPA)   │   push listeners    │  default-rtdb         │          │
│  │  GitHub Pages│                     │                       │          │
│  └─────────────┘                     │  command-center/{uid}/ │          │
│                                       └──────────┬───────────┘          │
│  ┌─────────────┐    MCP over HTTP            │                          │
│  │ Claude Chat  │◄───────────────►┌──────────┴───────────┐             │
│  │ (claude.ai)  │  OAuth 2.1      │  CC MCP Server       │             │
│  └─────────────┘                  │  (Cloud Run)         │             │
│                                    │  13 tools, 30 skills │             │
│  ┌─────────────┐    MCP over HTTP │                      │──► GitHub   │
│  │ Claude Code  │◄───────────────►│  Express + MCP SDK   │    Contents │
│  │ (CLI)        │  CC API Key     └──────────────────────┘    API      │
│  └─────────────┘                                                        │
│                                                                          │
│  ┌──────────────────────────────────────────┐                           │
│  │  Firebase Cloud Functions (word-boxing)    │                           │
│  │  CC: domainProxy, documentCleanup         │                           │
│  │  Game Shelf: 22 functions (separate repo) │                           │
│  └──────────────────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────────────────┘
```

| Service | Where It Runs | Purpose |
|---------|--------------|---------|
| CC Browser App | GitHub Pages | UI for ODRC management, jobs, sessions, settings |
| CC MCP Server (prod) | Cloud Run (`cc-mcp-server`, `us-central1`) | Tools + skills for all users |
| CC MCP Server (test) | Cloud Run (`cc-mcp-server-test`, `us-central1`) | Validates MCP changes before prod promotion |
| Firebase Cloud Functions | GCP (`word-boxing`) | CC: DNS proxy + doc cleanup. Game Shelf: 22 functions (separate codebase) |
| Firebase RTDB | GCP (`word-boxing`) | All persistent data under `command-center/{uid}/` |

### Authentication Model

| Client | Auth Method | Flow |
|--------|------------|------|
| CC Browser App | Firebase Auth (Google Sign-In) | Client-side popup → Firebase UID |
| Claude.ai (Chat) | OAuth 2.1 with PKCE | `/register` → `/authorize` → Google Sign-In or CC API Key → `/token` |
| Claude Code (CLI) | CC API Key | `cc_{uid}_{secret}` validated against SHA-256 hash in Firebase RTDB |
| domainProxy | Firebase ID Token | CC browser passes Bearer token in `Authorization` header |

**OAuth token persistence:** OAuth tokens are stored in Firebase RTDB under `command-center/oauth-tokens/` with SHA-256 hashed keys. Tokens survive Cloud Run cold starts and redeployments — Claude.ai users no longer need to reconnect after prod deploys.

---

## Component Hierarchy

```
<CommandCenter>                          Root — state, Firebase auth, nav
├── <ProjectsDrillDown>                  Projects with Ideas tab drill-down
│   ├── Project cards (expandable)       Apps, ideas, lifecycle metadata
│   │   └── App rows                     Structure, repos, versions
│   ├── <AppsView>                       App detail with Ideas tab
│   │   └── <IdeasView>                  Idea management per app
│   ├── <AppEditModal>                   Edit app definitions
│   ├── <ProjectEditModal>              Create/edit/delete projects
│   └── <DomainsView>                   Domain management (GoDaddy/Porkbun)
├── <JobsView>                          Build job list + detail
│   └── "Load older jobs" button         On-demand fetch via .once()
├── <SessionsView>                      Ideation session list + detail
├── <SetupNewAppView>                   4-step new app wizard
└── <SettingsView>                      Token, Firebase admin, preferences
```

**Navigation tabs:** Projects | Jobs | Sessions | Settings

---

## Firebase Realtime Listeners

### Active Listeners (v8.71.4+)

These are persistent `.on('value')` subscriptions set up once at auth time. Each listener re-downloads its entire query result set whenever any child in the query window changes.

| Collection | Limit | Order By | Object Size | Max Download | Service |
|-----------|-------|----------|-------------|-------------|---------|
| Jobs | `limitToLast(10)` | `createdAt` | 10-100KB | ~1MB | `JobService.listen()` |
| Sessions | `limitToLast(15)` | `createdAt` | ~3KB | ~45KB | `SessionService.listen()` |
| Concepts | `limitToLast(50)` | `updatedAt` | ~0.5KB | ~25KB | `ConceptManager.listen()` |
| Ideas | `limitToLast(20)` | `updatedAt` | ~0.5KB | ~10KB | `IdeaManager.listen()` |

**On-demand loading:** `JobService.loadBefore(uid, oldestCreatedAt, limit)` fetches older jobs via `.once()` reads when the user clicks "Load older jobs".

### Suspended Listeners

| Listener | Reason |
|----------|--------|
| Activity | No data, zero cost |
| Team / TeamMembership | Single-user, no data |
| WorkItems | Feature lightly used |
| Streams | Feature inactive |
| Orphan Commits | 5.2MB/13K records, expensive to listen |
| Documents | Managed via MCP tools only (v8.71.0) |

---

## Data Flow

```
┌──────────────────────────────────────────────────────┐
│              Firebase RTDB (word-boxing)               │
│          command-center/{uid}/                         │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐ │
│  │ concepts │ │  ideas   │ │  jobs   │ │ sessions │ │
│  │ (ODRC)   │ │          │ │         │ │          │ │
│  └────┬─────┘ └────┬─────┘ └────┬────┘ └────┬─────┘ │
│       │            │            │            │        │
│  ┌────┴────┐  ┌────┴────┐  documents  ┌───────────┐ │
│  │appIdeas │  │  config │  claudeMd   │ knowledge │ │
│  └─────────┘  └─────────┘  prefs      │ forests/  │ │
│                             apiKeyHash │ trees/    │ │
│                             profile    │ nodes/    │ │
│                                        └───────────┘ │
└─────────────────────┬────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
    CC Browser    MCP Server    Cloud Functions
    (listeners)   (reads/writes) (triggers/scheduled)
    4 active      13 tools       domainProxy, documentCleanup
                  30 skills
```

### Browser → Firebase
- **Auth:** Firebase Auth (Google Sign-In) → UID
- **Read:** 4 persistent listeners (bounded by `limitToLast`)
- **Write:** App config updates, preferences only — all ODRC/job/session writes go through MCP server
- **On-demand reads:** `JobService.loadBefore()` for historical jobs

### MCP Server → Firebase
- **Read:** Per-tool `.once()` reads with query filters (no full collection reads)
- **Write:** ODRC concepts, ideas, sessions, jobs, documents, claudeMd, preferences, knowledge (forests/trees/nodes), OAuth tokens
- **Per-surface context tracking:** Each surface (claude-code, claude-chat, etc.) gets independent `_contextHealth` zone/used via `surfaces.ts` registry
- **Context budget tracking:** Surfaces report `contextEstimate` on every tool call. Server compares against its own floor and returns `surfaceEstimate`, `estimatedZone`, `driftDetected`, `serverFloor` in `_contextHealth`
- **Piggyback notifications:** Pending messages for the calling surface are injected into every tool response as `_pendingMessages`
- **Idea health computation:** On `session.complete`, computes health for the active idea (staleness, scope creep, empty primary, completion candidates). Full-app scan via `idea(triage)`. See [Idea Health System](#idea-health-system)
- **External integration refs:** Concepts, ideas, and jobs support optional `externalRefs[]` arrays for linking to Jira, Linear, etc. Ideas also support `externalProjectKey`
- **Test/Prod split:** Both environments share same Firebase RTDB — same data, different code versions
- **Express body limit:** 10MB (raised from 1MB to support large document pushes)

### Cloud Functions → Firebase
- **domainProxy:** Authenticated CORS proxy for Porkbun/GoDaddy APIs (requires Firebase ID token)
- **documentCleanup:** Daily 4am ET scheduled purge of delivered/failed docs older than 7 days

---

## ODRC Concept Lifecycle

ODRC (OPEN, DECISION, RULE, CONSTRAINT) is the concept system that structures ideation output. Each concept type has a distinct role:

- **OPEN** — An unresolved question or uncertainty
- **DECISION** — A chosen direction that answers an OPEN
- **RULE** — A durable pattern that emerged from multiple decisions
- **CONSTRAINT** — An external reality that bounds what's possible

### Concept States

| State | Meaning |
|-------|---------|
| `active` | Current and in effect |
| `superseded` | Replaced by newer content (same type) |
| `resolved` | Answered or no longer relevant (typically OPENs) |
| `transitioned` | Evolved into a different type |
| `built` | Implemented in code (DECISIONs only) |

### Type Transitions

Valid type changes follow a directed state machine:

```
OPEN → DECISION          (question answered)
OPEN → RULE              (question resolved into durable pattern)
OPEN → CONSTRAINT        (question revealed external reality)
DECISION → RULE          (decision hardened into pattern)
CONSTRAINT → DECISION    (external reality changed, now a choice)
CONSTRAINT → RULE        (external reality internalized as pattern)
RULE → OPEN              (destabilized, needs rethinking)
```

### Operations

| Operation | Effect |
|-----------|--------|
| `create` | New concept in `active` state, linked to origin idea |
| `transition` | Changes type. Old concept marked `transitioned`, new concept created with new type. History chain via `transitionedTo` pointer |
| `supersede` | Replaces content, same type. Old concept marked `superseded`. History chain via `supersededBy` pointer |
| `resolve` | Marks an OPEN as done (question answered or no longer relevant) |
| `mark_built` | Marks a DECISION as implemented in code. Only valid for active DECISIONs |

### History Chain

When a concept is superseded or transitioned, the original retains pointers to its successor (`supersededBy` / `transitionedTo`). This preserves decision archaeology — you can trace how a concept evolved across ideas and phases.

### MCP Tools

| Tool | Relevant Actions |
|------|-----------------|
| `concept` | create, update, transition, supersede, resolve, mark_built, migrate, add/remove_knowledge_ref, check_evidence_drift |
| `list_concepts` | Filter by idea, app, type, status. `grouped=true` returns by-type breakdown |
| `get_active_concepts` | Current truth: all active concepts across all ideas for an app |

---

## Knowledge Tree System

The Evidence Engine stores curated research findings in a three-level hierarchy under `command-center/{uid}/knowledge/`. This system is MCP-only (no browser listeners).

```
knowledge/
├── forests/{forestId}          Domain groupings (e.g., "Firebase", "React")
│   ├── name, description, tags
│   ├── treeIds[]               References to member trees
│   └── summary, summaryGeneratedAt  Cached flat routing table
├── trees/{treeId}              Topic-level containers
│   ├── name, description, tokenBudget, tokenUsed
│   ├── trustProfile            {authoritative, credible, unverified, questionable}
│   ├── searchHistory[]         [{query, nodeIdsProduced, searchedAt}]
│   ├── gaps[]                  [{question, priority, discoveredAt, status}]
│   └── index/{nodeId}          Cheap routing entries (always loaded with tree)
│       ├── question, keyFinding, tokenCost, trust, tags[]
│       ├── parentId, childIds[], order
│       └── contradictedBy[]    Node IDs that contradict this node (denormalized)
└── nodes/{nodeId}              Expensive content records (loaded on demand)
    ├── treeId, content, tokenCount
    ├── sources[]               [{url, document, credibility, discoveryQuery?}]
    ├── consensusNotes
    └── crossRefs[]             [{nodeId, treeId, relationship, addedAt}]
```

**Key design constraint:** Firebase RTDB has no server-side field projection. The index/content split MUST be at the Firebase path level — `trees/{treeId}/index/` vs `nodes/{nodeId}/` — so loading a tree index never pulls node content.

### Concept ↔ Knowledge Pointers

Concepts carry lightweight `knowledgeRefs` arrays linking to knowledge nodes:

```
concepts/{conceptId}/
├── knowledgeRefs[]             [{nodeId, treeId, treeName, relationship, addedAt}]
├── knowledgeRefCount           Integer (denormalized for summary views)
```

Relationship types: `supports`, `informs`, `constrains`, `contradicts`.

### MCP Tools

| Tool | Actions | Purpose |
|------|---------|---------|
| `knowledge_tree` | 15 actions | Forest CRUD, tree CRUD, get_index, add_search, search_tags, summaries |
| `knowledge_node` | 9 actions | Node CRUD, load, load_batch, move, add/remove_cross_ref, bulk_verify |
| `concept` | +3 actions | add/remove_knowledge_ref, check_evidence_drift |

### Health Advisory (in get_index)

When `get_index` is called, a `healthAdvisory` block is conditionally included if any issues exist:
- **Stale nodes** — nodes past the tree's `freshnessPeriodDays` threshold
- **Contradictions** — nodes with non-empty `contradictedBy[]` index entries
- **Open gaps** — unresolved gaps from the tree's `gaps[]` array

### Evidence Drift Detection

`concept(check_evidence_drift)` compares each knowledge ref's `addedAt` timestamp against the referenced node's `updatedAt`. `get_active_concepts(includeDriftCheck=true)` runs this check in bulk across all concepts with knowledge refs.

---

## Idea Health System

Server-side health computation evaluates idea staleness, scope creep, and completion readiness. Implemented in `mcp-server/src/idea-health.ts` as pure functions (callers provide data).

### Idea Classification Fields

Ideas carry classification metadata for automated management:

| Field | Values | Purpose |
|-------|--------|---------|
| `ideaType` | `primary` / `auxiliary` / `placeholder` | Importance tier — drives staleness thresholds |
| `intention` | `new` / `add` / `fix` | What kind of work — drives urgency |
| `primaryOutput` | `code` / `presentation` / `spreadsheet` / `document` / `analysis` | Output type — analysis gets 1.5x staleness multiplier |
| `initiative` | freeform string | Cross-idea grouping label |

### Staleness Threshold Matrix

Health alerts are counter-based (sessions without activity), not time-based. Each idea stores `sessionCountAtLastHealth`; delta = total completed app sessions − stored count.

| ideaType | intention | Threshold (sessions) | Severity |
|----------|-----------|---------------------|----------|
| placeholder | * | 2 | high |
| auxiliary | fix | 3 | high |
| auxiliary | add/new | 5 | medium |
| primary | fix | 0 (flags as mistyped) | high |
| primary | add | 8 | medium |
| primary | new | 12 | low |

Additional checks: scope creep (placeholder with 3+ concepts, auxiliary with 10+ concepts), empty primary (0 concepts after 3+ sessions), completion candidates (all jobs completed).

### Integration Points

- **`session.complete`** — Fire-and-forget: computes health for `activeIdeaId` only. Writes `alerts[]`, `alertCount`, `sessionCountAtLastHealth` to idea. Updates app `triageNeeded`/`triageAlertCount` if alerts found. Never blocks session completion.
- **`idea(triage)`** — Full-app scan: evaluates all active ideas, atomic multi-path write, returns ideas sorted by severity.
- **`idea(list, hasAlerts=true)`** — Filter to ideas with active alerts.
- **App record** — `triageNeeded` (boolean), `triageAlertCount` (number), `lastTriageAt` (timestamp) visible in `app(get)` and `app(list)`.

---

## Cost Architecture

Firebase RTDB charges ~$1/GB for bandwidth. The primary cost driver is listener re-downloads: every write to a watched path triggers all listeners on that path to re-download their entire query result set.

### Cost Guardrails

1. **Listener limits:** All `.on('value')` listeners use `limitToLast(N)` to bound per-trigger download size
2. **Server-side query filtering:** MCP server uses `orderByChild().equalTo()` — no full-collection reads
3. **Firebase indexes:** `.indexOn` rules on all queried fields. Without indexes, Firebase downloads the entire collection and filters client-side.
4. **Write debouncing:** `contextEstimate` batched over 30-second windows
5. **No background polling:** Claude Code must never create persistent scripts to poll `document(receive)`

### Historical Incident (Feb 2026)

Three zombie bash scripts from orphaned Claude Code sessions polled `document(receive)` every 10 seconds, downloading ~1MB per call. Combined: ~17MB/min = ~$17/day. Fixed by killing scripts, adding server-side status filtering, and documenting anti-polling rules in MCP skills.

---

## CC Cloud Functions

Source: `stewartdavidp-ship-it/firebase-functions` (private repo).

| Function | Trigger | Purpose | Note |
|----------|---------|---------|------|
| `domainProxy` | HTTPS onRequest | CORS proxy for Porkbun/GoDaddy DNS APIs | Auth required (Firebase ID token), restricted CORS origins |
| `documentCleanup` | Scheduled (4am ET daily) | Purge delivered/failed documents older than 7 days | Per-user error handling |

Game Shelf functions (22 functions) are deployed from a separate codebase at `/Developer/gameshelf-functions/`. They share the `word-boxing` Firebase project but are not in the `firebase-functions` repo.

---

## Repositories

| Repo | Visibility | Content |
|------|-----------|---------|
| `stewartdavidp-ship-it/command-center` | Public | CC app, MCP server source, ARCHITECTURE.md, CLAUDE.md |
| `stewartdavidp-ship-it/command-center-test` | Public | GitHub Pages deploy target |
| `stewartdavidp-ship-it/firebase-functions` | **Private** | domainProxy, documentCleanup, database.rules.json |

---

## Styling

- **Tailwind CSS** via CDN (utility classes only, no build)
- **Dark theme** — bg-slate-900 base, slate-700/800 cards
- **No build system** — all inline in single HTML file

---

## Known Issues

| # | Issue | Status |
|---|-------|--------|
| 1 | Sessions have no "Load More" — only 15 most recent visible in browser | Open |
| 2 | ~~MCP server cold starts lose OAuth tokens~~ | **Resolved** (2026-02-25) — tokens now persist in Firebase RTDB |
| 3 | CLAUDE.md generator can produce duplicates across ideas | Open |
| 4 | Shared Firebase project `word-boxing` hosts CC + Game Shelf | Accepted |

---

## Architecture Backlog

### Open Items

| ID | Item | Severity | Notes |
|----|------|----------|-------|
| SEC-2 | **`Math.random()` for API key secret** — Not cryptographically secure. | Low | Acceptable single-user. Upgrade to `crypto.randomBytes()` if multi-user. |
| SEC-5 | **`teamMembership` write rule template** — Allows any auth user to write under any `$uid`. Not deployed. | Low | Fix template before deploying team features. |
| PERF-1 | **`documentCleanup` full tree read** — Downloads ~787KB daily. | Low | Optimize if CC data grows past 10MB. |
| PERF-3 | **Jobs collection is heaviest listener** — 60KB per trigger at current size. | Low | Monitor. Reduce limit if job payloads grow. |
| PERF-4 | **No Firebase budget alerts** — Blaze plan has no spending caps. | Medium | Enable Cloud Billing Budget API, set $25/month alert. |
| PERF-5 | **Firebase Functions SDK upgrade needed** — `firebase-functions@4.9.0`, Node.js 20 deprecates 2026-04-30. | Medium | Upgrade to v5.x + nodejs22 before April 2026. |
| DEBT-4 | **Second CC user** (`ptYPWbTDlCPvrKTq2NmWWHuEvkv1`) — Test account? Clean up if unneeded. | Low | |
| ~~DEBT-5~~ | ~~CC line count documentation stale~~ | ~~Low~~ | **Resolved** (2026-02-25) — updated to ~16,959 lines |
| DEBT-12 | **Firebase SA JSON in Downloads folder** — Should move to secure location. | Medium | User action required. |
| DEBT-13 | **Game Shelf functions not in firebase-functions repo** — 22 functions in separate codebase. | Low | Consider consolidating. |

### Resolved (2026-02-25)

| ID | Resolution |
|----|-----------|
| SEC-1 | OAuth tokens now persist in Firebase RTDB with SHA-256 hashed keys. Cold starts no longer wipe tokens. |

<details>
<summary>Click to expand resolved items from v8.71.5 and v8.71.6 security hardening (2026-02-20)</summary>

| ID | Resolution |
|----|-----------|
| DEBT-1 | v8.71.5 pushed to GitHub Pages |
| DEBT-2 | `domainProxy.js` dead code deleted |
| DEBT-3 | `firebase-rules-updated.json` deleted. Canonical: `firebase-functions/database.rules.json` |
| DEBT-6 | 17 debug scripts removed from git, added to `.gitignore` |
| DEBT-7 | Legacy `domainProxy.js` deletion committed |
| DEBT-8 | `activityLog` → `activity` rules index mismatch fixed |
| DEBT-9 | `debug-sessions` paths restricted to admin UID |
| DEBT-10 | OAuth clients Map bounded (max 100, auto-cleanup) |
| DEBT-11 | SA email redacted from browser console.log |
| SEC-3 | SKIP_AUTH production guard added (process exits on Cloud Run) |
| PERF-2 | Firebase rules version-controlled in `database.rules.json` |
| Known-2 | domainProxy authenticated (Firebase ID token + restricted CORS) |
| Known-3 | `documentCleanup` scheduled Cloud Function added (daily 4am ET) |

</details>

---

## Disaster Recovery

All source code is in GitHub. Updated 2026-02-25.

### Deployed Services

| Service | Platform | Recovery Path |
|---------|----------|---------------|
| CC browser app | GitHub Pages | Push to `command-center-test` repo |
| MCP server (prod) | Cloud Run (`cc-mcp-server`) | `cd mcp-server && bash deploy.sh --prod` |
| MCP server (test) | Cloud Run (`cc-mcp-server-test`) | `cd mcp-server && bash deploy.sh` |
| Cloud Functions | Firebase | See deploy commands in Quick Reference |
| RTDB rules | Firebase | See deploy commands in Quick Reference |

### Data

| Data | Location | Backup |
|------|----------|--------|
| Firebase RTDB | `word-boxing` project | Firebase automatic daily backups (Blaze plan) |
| Cloud Run images | Google Artifact Registry | Retained per GCP policy |

### Environment Variables (Cloud Run)

Required for MCP server rebuild (both test and prod):
- `FIREBASE_PROJECT_ID` — `word-boxing`
- `FIREBASE_WEB_API_KEY` — Firebase Web API key (from Firebase console → Project Settings)
- `GITHUB_TOKEN` — GitHub PAT for repo operations
- `BASE_URL` — prod: `https://cc-mcp-server-300155036194.us-central1.run.app` / test: `https://cc-mcp-server-test-300155036194.us-central1.run.app`
- `ENVIRONMENT` — `prod` or `test` (shown in health check response)

### Not Version-Controlled (Accepted)

- Firebase service account key (Cloud Run mounted secret)
- Cloud Run service config (min/max instances, memory, CPU)
- Firebase budget alerts (PERF-4 — not yet configured)
