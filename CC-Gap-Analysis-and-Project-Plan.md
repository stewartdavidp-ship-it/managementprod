# Command Center: Gap Analysis & Project Plan

## Architecture As-Is

### Codebase Profile
- **Single file:** index.html, 18,577 lines (~330K tokens)
- **Framework:** React 18 via CDN (no build step, no JSX transform)
- **Components:** 64 functions/components, 220 useState hooks
- **Largest components:** App (2,907 lines), SetupNewAppView (1,185), DashboardView (1,136)
- **Data persistence:** localStorage (13 keys) + Firebase RTDB sync
- **External APIs:** GitHub (file CRUD, Pages, tags), Firebase (Auth, RTDB, Functions), Anthropic (hints), Stripe

### Current Architecture Pattern
```
┌──────────────────────────────────────────────────────┐
│  App() — 2,907 lines                                 │
│  ├── 25+ useState hooks (global state)               │
│  ├── Deploy logic (handleDeploy, handlePromote, etc) │
│  ├── Firebase sync (FirebaseConfigSync)              │
│  ├── Health checks                                   │
│  └── All routing (17 views via switch)               │
├──────────────────────────────────────────────────────┤
│  Views (routed by `view` state)                      │
│  ├── DashboardView (1,136 lines, 22 props)           │
│  ├── ProjectsTab (411 lines)                         │
│  ├── SmartDeployView (478 lines)                     │
│  ├── HistoryView (71 lines — thin)                   │
│  ├── SessionLogView (625 lines)                      │
│  ├── IssuesView (809 lines)                          │
│  ├── ConfigView (465 lines)                          │
│  ├── ArchiveView (845 lines)                         │
│  ├── SetupNewAppView (1,185 lines)                   │
│  ├── Firebase views (4 sub-views, ~1,500 lines)      │
│  ├── CleanupView (932 lines)                         │
│  └── 6 other views                                   │
├──────────────────────────────────────────────────────┤
│  Modals                                              │
│  ├── ClaudePrepModal (559 lines)                     │
│  ├── AppEditModal (376 lines)                        │
│  ├── ProjectEditModal (625 lines)                    │
│  └── 6 other modals                                  │
├──────────────────────────────────────────────────────┤
│  Utilities                                           │
│  ├── ConfigManager (config CRUD)                     │
│  ├── FirebaseConfigSync (bidirectional sync)         │
│  ├── GitHubAPI wrapper                               │
│  ├── Version utilities (parse, compare, extract)     │
│  ├── Generators (session brief, skeleton docs)       │
│  └── Config drift detection                          │
└──────────────────────────────────────────────────────┘
```

### Architectural Concerns for the Evolution

**1. App() is a God Component**
The root App() component (2,907 lines) owns all deploy logic, all state management, all routing, and all data synchronization. Every new feature adds props, state, and logic to this component. DashboardView already takes 22 props. This won't scale for the orchestrator features.

**2. No Data Layer Abstraction**
State is managed directly with useState hooks and persisted ad-hoc to localStorage and Firebase. There's no service layer, no data access pattern, no shared state management. Components access localStorage directly and push to Firebase via the global FirebaseConfigSync object.

**Impact:** Adding Work Items, Sessions, Token Registry, and Engine Profiles means adding 4+ new Firebase collections, 8+ new useState hooks in App(), and threading those through as props to multiple views. The current pattern makes this fragile.

**3. Session Brief Generator Is Static**
`generateSessionBrief()` is a 52-line function that produces a fixed-format markdown string. It doesn't know about work items, session types, token budgets, or engine recommendations. Transforming this into the orchestrator's session planning engine requires a fundamentally different approach — it becomes a multi-step generator with inputs from multiple data sources.

**4. Setup Wizard and Claude Prep Are Disconnected**
The Setup Wizard creates repos and generates a prompt. Claude Prep fetches files and generates a package. They share almost no code or data structures. The enhanced setup should flow directly into Claude Prep, but today they're independent features with different data models.

**5. File Size Is Already a Problem**
At 18,577 lines, the file itself is ~330K tokens — exceeding Claude's standard 200K context window. Adding the orchestrator features (token analyzer, engine registry, session types, recommendation engine, backlog view, maturity tracking) could add 3,000-5,000 lines. This makes it harder to work on CC using Claude, which is deeply ironic.

---

## Gap Analysis: Feature by Feature

### TIER 1: Foundation — Must build first, everything depends on these

#### Gap 1.1: Data Layer Refactoring
| What exists | What's needed | Why it matters |
|------------|---------------|----------------|
| 25+ useState hooks in App() | Service module pattern with clear data access | Every new feature adds state to App(). At 5-6 new data collections, this becomes unmanageable |
| Ad-hoc localStorage + Firebase push | Consistent create/read/update/delete pattern per entity | Work Items, Sessions, Token Registry all need CRUD. Current pattern would mean 50+ new lines of boilerplate per entity |
| Props drilled 3-4 levels deep | Context or service-based data access | DashboardView takes 22 props. Adding backlog data, token data, engine data multiplies this |

**Recommendation:** Create a `DataService` pattern — a set of namespaced objects (like the existing `FirebaseConfigSync` pattern) that encapsulate CRUD for each entity type. Not a full rewrite — extract and consolidate.

```javascript
// Pattern to follow (already exists for config sync):
const WorkItemService = {
    list(appId) { /* read from Firebase */ },
    get(itemId) { /* read single */ },
    create(item) { /* write to Firebase + localStorage */ },
    update(itemId, changes) { /* partial update */ },
    updateStatus(itemId, newStatus) { /* status transition with timestamps */ },
    getByMilestone(appId, milestone) { /* filtered query */ },
    getInProgress(appId) { /* status filter */ },
};
```

This pattern keeps the single-file architecture (no build step needed) while making data access clean and testable.

**Effort:** 2 sessions. Session 1: Extract existing data access into service objects (config, deploys, issues, session log). Session 2: Add new services (work items, token registry, sessions, engine profiles).

---

#### Gap 1.2: App Lifecycle Metadata
| What exists | What's needed |
|------------|---------------|
| `app.appType` (public/internal/other) | `app.lifecycle.category` (game/tool/dashboard/content/admin) |
| `app.description` (1-2 lines) | `app.lifecycle.problemStatement`, `targetAudience`, `userGoal`, `successMetric` |
| No maturity concept | `app.lifecycle.currentMaturity`, `maturityTarget`, milestone criteria |
| No tech stack tracking | `app.lifecycle.stack` (framework, styling, data, libraries) |

**Impact on existing code:** ConfigManager.updateApp() needs to handle nested lifecycle objects. AppEditModal needs new tabs or sections. Dashboard needs maturity badges. None of this breaks existing functionality — it's additive.

**Effort:** 1 session. Extend ConfigManager, add lifecycle fields to AppEditModal, add maturity badge to dashboard cards.

---

### TIER 2: Core Orchestrator — The features that create the new value

#### Gap 2.1: Token Analyzer
| What exists | What's needed |
|------------|---------------|
| Claude Prep fetches files and measures byte size | Token estimation for every file in the package |
| Package manifest shows "file | size KB | source" | Token count per file, total, and budget visualization |
| No awareness of model context limits | Engine-aware budget check: "Package is X tokens, model supports Y" |
| No recommendations | "This file is too large. Recommendations: section extraction, summarize, use extended context" |

**Implementation approach:**
1. Add heuristic estimator (instant, ~10 lines of code, no dependencies)
2. Integrate into Claude Prep's file manifest (show tokens alongside KB)
3. Add budget bar visualization after package is built
4. Add recommendations when over budget

**Dependencies:** Engine Registry (Gap 2.2) for knowing model limits.

**Effort:** 1 session for basic token counting + budget visualization. 1 additional session for recommendations.

---

#### Gap 2.2: AI Engine Registry
| What exists | What's needed |
|------------|---------------|
| No concept of AI engines | Engine data model: name, provider, context window, costs, strengths, features |
| No cost awareness | Per-engine cost calculation based on token count |
| Single implicit engine (Claude via conversation) | Multi-engine support with comparison and recommendation |

**Implementation approach:**
1. Static engine definitions in CC config (not Firebase — reference data)
2. Engine comparison view in Settings
3. Default engine selector
4. Engine recommendation logic (context size → eligible engines → best match)

**Dependencies:** None. This is standalone reference data.

**Effort:** 1 session. Static data + comparison UI + selector.

---

#### Gap 2.3: Work Items + Backlog
| What exists | What's needed |
|------------|---------------|
| Issues (bugs only, reactive) | Work Items (planned work, proactive) with type, priority, milestone, acceptance criteria |
| PROJECT_PLAN.md checkbox lists (unstructured text) | Structured backlog in Firebase with status tracking and session linking |
| No concept of "what to build next" | Prioritized backlog view per app, filtered by milestone and status |
| Issues can be linked to versions | Work items linked to milestones, sessions, and deploys |

**Implementation approach:**
1. WorkItemService (Firebase CRUD)
2. BacklogView (new top-level navigation view)
3. Work Item detail/edit modal
4. Status transitions with timestamps
5. Issue → Work Item promotion action

**Dependencies:** Data Layer (Gap 1.1), App Lifecycle (Gap 1.2) for milestone association.

**Effort:** 2-3 sessions. Session 1: Data model + CRUD + basic list view. Session 2: Detail view + edit modal + status flow. Session 3: Milestone grouping + issue promotion + filters.

---

#### Gap 2.4: Session Types + Prompt Templates
| What exists | What's needed |
|------------|---------------|
| `generateSessionBrief()` — fixed 52-line markdown template | Session-type-aware generator with role frame, scope rules, delivery requirements |
| No concept of session types | 8 session types (Build, Design, Fix, Test, Research, Review, Polish, Document) with different context strategies |
| Claude prompt in Setup Wizard — generic 80-line template | CLAUDE_INSTRUCTIONS.md — permanent, scope-aware, maturity-constrained |
| No prompt templates | Prompt template library per session type |

**Implementation approach:**
1. Session type enum and definitions
2. Rewrite `generateSessionBrief()` to accept session type and work item
3. Template library (stored as config, editable)
4. Auto-suggest session type from work item type

**Dependencies:** Work Items (Gap 2.3) for work-item-aware prompts.

**Effort:** 1-2 sessions. Session 1: Session types + rewrite generator. Session 2: Template library + auto-suggest.

---

#### Gap 2.5: Enhanced Claude Prep
| What exists | What's needed |
|------------|---------------|
| ClaudePrepModal: fetch files → generate brief → zip | Multi-step flow: select work item → choose session type → review token budget → generate targeted package |
| One-click auto-start | Pre-step: "What are you working on?" (work item selector or general session) |
| Fixed file set (source + docs + brief) | Session-type-dependent file set (Design sessions skip full source, Fix sessions include issue details) |
| No token awareness | Budget visualization before download |
| Generic brief | Targeted brief with work item context, acceptance criteria, maturity constraints |

**Implementation approach:**
This is a significant rework of ClaudePrepModal. The current 559-line modal becomes a multi-step wizard:
1. Step 1: Work item selection (or "general session")
2. Step 2: Session type (auto-suggested, overridable)
3. Step 3: Engine selection + token budget preview
4. Step 4: Package generation + download

**Dependencies:** Work Items (2.3), Session Types (2.4), Token Analyzer (2.1), Engine Registry (2.2). This is the integration point — it ties everything together.

**Effort:** 2-3 sessions. This is the crown jewel feature.

---

### TIER 3: Feedback Loop — Close the cycle

#### Gap 3.1: Session Tracking
| What exists | What's needed |
|------------|---------------|
| Session log (CC activity within the tool) | Session entity tracking Claude interactions: prep generated → deploy received |
| No link between Claude Prep and resulting deploy | Session record connecting prep timestamp → work items → deploy → outcome |
| No velocity data | Metrics: sessions per week, session-to-deploy time, work items per session |

**Implementation approach:**
1. SessionService (Firebase CRUD)
2. Create session record when Claude Prep generates a package
3. Link session to deploy when result arrives (auto-detect via in-progress work items)
4. Session history view (could be tab on existing SessionLogView)

**Dependencies:** Work Items (2.3), Enhanced Claude Prep (2.5).

**Effort:** 1-2 sessions.

---

#### Gap 3.2: Deploy Close-the-Loop
| What exists | What's needed |
|------------|---------------|
| Deploy detects app and version, commits to repo | After deploy, check for in-progress work items and ask "Does this complete WI-042?" |
| Deploy history has version, target, timestamp | Deploy history includes work items completed, release notes, session reference |
| No post-deploy work item updates | Auto-update work item status, milestone progress, session completion |

**Implementation approach:**
1. In `handleDeploy()`, after successful deploy, query in-progress work items for this app
2. Show completion dialog: "This deploy may complete WI-042. Mark done?"
3. If yes: update work item, update milestone criteria, link deploy record
4. Pull release notes from package (RELEASE_NOTES.txt) into deploy record

**Dependencies:** Work Items (2.3), Session Tracking (3.1).

**Effort:** 1 session. Mostly integration into existing deploy flow.

---

#### Gap 3.3: Cost Tracking + Analytics
| What exists | What's needed |
|------------|---------------|
| No cost data | Estimated cost per session (based on package tokens × engine pricing) |
| No analytics dashboard | Portfolio-level metrics: sessions, deploys, work items completed, cost, velocity |
| Deploy history shows individual deploys | Aggregated views: by app, by time period, by session type |

**Dependencies:** Token Analyzer (2.1), Engine Registry (2.2), Session Tracking (3.1).

**Effort:** 1-2 sessions.

---

### TIER 4: Environment Optimization — Help configure external tools

#### Gap 4.1: Claude Project Setup Guide
| What exists | What's needed |
|------------|---------------|
| No awareness of Claude Projects/Skills | Generate per-app Project setup guide (what files to put in Project Knowledge, what instructions to set) |
| CLAUDE_INSTRUCTIONS.md generated by setup wizard | Identify which docs are "persistent" (change rarely → Project Knowledge) vs "session" (change often → upload each time) |

**Effort:** 1 session. Mostly generation logic + UI.

---

## Rearchitecture Decision

### The Question
Do we need to rearchitect CC before adding orchestrator features, or can we extend incrementally?

### The Answer: Targeted Refactoring, Not Rewrite

A full rewrite would take 10+ sessions and produce zero new value until complete. Instead, we do targeted refactoring as the first phase:

1. **Extract Data Services** (2 sessions) — Pull data access out of App() into service objects. This is the only structural change needed. Everything else builds on top.

2. **Keep single-file architecture** — The single HTML file approach is a feature, not a bug. It keeps deployment simple, aligns with the Game Shelf ecosystem pattern, and avoids build tooling. At ~22,000 lines post-evolution, it's large but manageable because components are well-isolated.

3. **Keep React via CDN** — No build step needed. The current pattern of function components with hooks works well. Adding new views follows the established pattern.

4. **Extend ConfigManager** — The app definition gets a `lifecycle` nested object. ConfigManager already handles schema migrations. This is a minor version bump, not a rearchitect.

5. **Add Firebase collections** — New data (work items, sessions, token registry) goes in new Firebase paths alongside existing ones. FirebaseConfigSync pattern extends naturally.

### What Changes Structurally

| Area | Current | After Refactoring |
|------|---------|-------------------|
| App() state | 25+ useState hooks, all in one component | Core state stays, new data accessed via services |
| Data access | Inline localStorage.getItem + Firebase ref | Service objects (WorkItemService, SessionService, etc.) |
| Props drilling | DashboardView gets 22 props | New views access services directly, reducing prop chains |
| ClaudePrepModal | 559-line single-step modal | Multi-step wizard (ClaudeSessionWizard), ~800-1000 lines |
| generateSessionBrief | 52-line fixed template | SessionBriefGenerator module with templates, ~200 lines |
| SetupNewAppView | 1,185-line 4-step wizard | Extended to 5 steps, generates CLAUDE_INSTRUCTIONS.md + work items |
| Navigation | 17 views | 18-19 views (+Backlog, possibly +Analytics) |

---

## Project Plan

### Phase 0: Foundation (2-3 sessions)
> Structural changes that make everything else cleaner.

**Session 0.1: Data Service Layer**
- Extract existing data access into service objects:
  - `ConfigService` (wraps ConfigManager + Firebase sync)
  - `DeployService` (deploy history CRUD)
  - `IssueService` (existing issues CRUD)
  - `SessionLogService` (existing session log)
- Wire existing views to use services instead of direct state
- No new features — pure refactoring, zero behavior change
- **Test:** All existing functionality works identically

**Session 0.2: New Data Services + App Lifecycle**
- Add new service objects:
  - `WorkItemService` (new Firebase collection)
  - `SessionService` (new Firebase collection)
  - `TokenRegistryService` (new, localStorage + Firebase)
  - `EngineRegistryService` (new, static config + user overrides)
- Extend ConfigManager for `app.lifecycle` fields
- Add lifecycle fields to AppEditModal
- **Test:** Can create/edit lifecycle metadata on apps, new Firebase paths work

**Session 0.3: Engine Registry + Token Estimator**
- Implement `estimateTokens()` heuristic function
- Create AI engine data model with current models (Claude Sonnet 4.5, Haiku 4.5, Opus 4.5, GPT-4.1, Gemini 2.5 Pro)
- Add engine comparison view to Settings
- Integrate token estimation into Claude Prep (show per-file token counts in manifest)
- **Test:** Claude Prep shows token counts, engine comparison displays correctly

### Phase 1: Backlog + Milestones (2-3 sessions)
> The work tracking system that drives targeted sessions.

**Session 1.1: BacklogView + Work Item CRUD**
- New top-level navigation: Backlog
- BacklogView: list work items grouped by app, filtered by milestone/status/type
- Work Item create/edit modal with all fields
- Status transitions: idea → ready → in-progress → done → deferred
- **Test:** Can create, edit, filter, and transition work items

**Session 1.2: Milestones + Dashboard Integration**
- Milestone data model inside app.lifecycle
- Milestone criteria checklist (editable per app)
- Maturity badges on Dashboard app cards
- Work items grouped by milestone in BacklogView
- Quick maturity setup for existing apps (bulk assign current maturity)
- **Test:** Dashboard shows maturity badges, milestones display in backlog

**Session 1.3: Issue → Work Item Promotion + Backlog Polish**
- "Promote to Work Item" action on issues (pre-fills from issue data)
- Work item tags, search, sorting
- Backlog summary on dashboard (total items, by status)
- PROJECT_PLAN.md import (parse unchecked items → work items)
- **Test:** Can promote an issue, import from PROJECT_PLAN.md, dashboard shows backlog summary

### Phase 2: Session Orchestrator (3-4 sessions)
> The AI-aware session planning and targeting system.

**Session 2.1: Session Types + Prompt Templates**
- Session type definitions (Build, Design, Fix, Test, Research, Review, Polish, Document)
- Prompt template library (one per session type)
- Rewrite `generateSessionBrief()` → `SessionBriefGenerator` module
- Session-type-aware brief generation with role frame, scope rules, delivery requirements
- **Test:** Generate session briefs for each type, verify templates are correct

**Session 2.2: Enhanced Claude Prep — Session Wizard**
- Transform ClaudePrepModal into multi-step ClaudeSessionWizard:
  - Step 1: Select work item (or "general session")
  - Step 2: Session type (auto-suggested from work item, overridable)
  - Step 3: Token budget preview with engine recommendation
  - Step 4: Generate package + download
- Work item context injected into SESSION_BRIEF.md (files, sections, dependencies, acceptance criteria)
- Maturity constraints in prompt ("Build to Beta quality, do NOT over-engineer")
- **Test:** Full wizard flow, targeted brief includes work item details, token budget shows correctly

**Session 2.3: Context Budget Advisor**
- Token budget visualization (bar chart of context allocation)
- Over-budget warnings with specific recommendations:
  - "Switch to 1M context"
  - "Use architecture summary instead of full source"
  - "Include only relevant sections for this work item"
  - "Skip CHANGELOG.md (low value for this session type)"
- Section extraction logic (parse HTML for component/function boundaries)
- Architecture summary generator (extract key patterns without full code)
- **Test:** Recommendations appear when package exceeds model limits, section extraction produces correct code excerpts

**Session 2.4: Session Tracking + Deploy Close-the-Loop**
- Session entity created when Claude Prep generates package
- In handleDeploy(), detect in-progress work items → offer completion
- Deploy record enriched with work items completed, session reference
- Release notes auto-extracted from package (RELEASE_NOTES.txt)
- Session history view
- **Test:** Deploy triggers completion dialog, work item status updates, session linked to deploy

### Phase 3: Enhanced Setup Wizard (2 sessions)
> First impressions matter — the setup wizard generates everything the orchestrator needs.

**Session 3.1: Expanded Intake**
- New Step 2: Problem & Users (problem statement, audience, goal, success metric)
- New Step 3: Features & Scope (core/nice-to-have/out-of-scope tags, maturity target)
- Enhanced Step 4: Technical decisions (framework, styling, data, pre-filled from category)
- **Test:** Wizard captures all enhanced fields

**Session 3.2: Smart Generation**
- Generate CLAUDE_INSTRUCTIONS.md (permanent AI briefing document)
- Generate functional seed HTML (category-aware templates)
- Auto-create work items from core features list
- Auto-set milestone criteria from maturity target
- Auto-deploy seed to test environment
- **Test:** New app has CLAUDE_INSTRUCTIONS.md, work items in backlog, functional seed deployed

### Phase 4: Analytics + Optimization (2 sessions)
> Visibility into the development process.

**Session 4.1: Cost Tracking + Portfolio View**
- Per-session cost estimation (package tokens × engine pricing)
- Cumulative cost tracking by app, session type, time period
- Portfolio dashboard: total apps, maturity distribution, backlog summary, velocity
- **Test:** Cost estimates appear in session wizard, portfolio view aggregates correctly

**Session 4.2: Claude Project Setup Guide + Environment Recommendations**
- Per-app guide for optimal Claude Project configuration
- Identify persistent docs (Project Knowledge) vs session docs (upload each time)
- Token savings calculator ("Using a Project saves ~10K tokens per session")
- Platform feature recommendations per session type
- **Test:** Generated setup guide is accurate and actionable

---

## Summary

| Phase | Sessions | New Value Delivered |
|-------|----------|-------------------|
| Phase 0: Foundation | 2-3 | Data services, engine registry, token counting in Claude Prep |
| Phase 1: Backlog | 2-3 | Work items, milestones, maturity tracking on dashboard |
| Phase 2: Orchestrator | 3-4 | Session wizard, targeted prompts, token budget advisor, deploy close-loop |
| Phase 3: Setup Wizard | 2 | Enhanced intake, CLAUDE_INSTRUCTIONS.md, auto-generated backlog |
| Phase 4: Analytics | 2 | Cost tracking, portfolio view, environment optimization guides |
| **Total** | **11-14** | **CC as AI Development Orchestrator** |

### Sequencing Rationale
- Phase 0 first: structural foundation prevents technical debt from compounding
- Phase 1 before Phase 2: work items must exist before we can target sessions at them
- Phase 2 is the highest-value phase: this is where CC becomes genuinely different
- Phase 3 after Phase 2: the setup wizard generates artifacts consumed by the orchestrator
- Phase 4 last: analytics are retrospective and can wait until there's data to analyze

### Risk Mitigation
- Each phase delivers standalone value — if we stop after Phase 1, we still have useful backlog tracking
- Each session produces a deployable version — no multi-session refactors that leave CC in a broken state
- Foundation refactoring (Phase 0) is pure extraction, not rewrite — existing tests pass, existing behavior unchanged
- File size grows ~3,000-5,000 lines (to ~22,000) — large but within the single-file architecture's workable range

### What We're NOT Doing
- Full rewrite to a build-tool-based architecture (not needed, single file works)
- Multi-file component splitting (adds build complexity, breaks deploy simplicity)
- External database (Firebase RTDB is sufficient for this data volume)
- Real-time AI API integration from CC (CC orchestrates, the AI session happens elsewhere)
- Multi-user collaboration (CC is a single-developer tool)
