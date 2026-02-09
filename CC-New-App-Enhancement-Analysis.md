# New App Setup Enhancement: AI Project Kickstart System

## Analysis & Proposal for Command Center

---

## 1. What We Capture Today

### Step 1 Form Fields (SetupNewAppView)

| Field | Type | Current Use | Used in Prompt? |
|-------|------|------------|-----------------|
| `name` | text | Display name, repo naming, meta tags | ✅ Title, headings |
| `id` | text (auto) | gs-app-id, repo names, detection patterns | ✅ Meta tags, config |
| `description` | textarea | Repo description, seed HTML, prompt overview | ✅ 1 line in "Overview" |
| `icon` | emoji | CC UI, seed HTML heading | ❌ Not in prompt |
| `structure` | radio | prod-only vs test-prod | ✅ Deploy section |
| `appType` | select | public/internal/other | ❌ Barely used |
| `project` | select | CC project grouping | ❌ Not in prompt |
| `isPWA` | checkbox | SW/manifest/icons requirements | ✅ Deploy package list |
| `hasAdmin` | checkbox | Create admin subdirectory | ✅ Admin section |
| `adminSubPath` | text | Admin directory name | ✅ Admin path |
| `customDomain` | text | CNAME setup | ✅ Domain line |

### What Gets Generated

**Seed HTML** (`generateInitialHTML`): Bare placeholder page — dark background, centered title, description, version. Functional but generic. No framework, no structure, no real starting point.

**Claude Prompt** (`generateClaudePrompt`): ~80 lines covering identity meta tags, architecture bullet points, Firebase config block, deploy package structure, version management, and a generic 3-phase plan (Foundation → Polish → Launch). Ends with 5-line session continuity instructions.

**Skeleton Docs** (via Claude Prep, not setup wizard): CONTEXT.md, PROJECT_PLAN.md, CHANGELOG.md templates with TODO placeholders. Good structure but no content.

### The Gap

The current system captures **infrastructure metadata** (repos, structure, PWA, admin) but almost nothing about **what the app actually is**. The description field is a 2-line textarea that typically gets one sentence. The Claude prompt that comes out is technically correct but has no soul — it tells Claude the plumbing but not the purpose.

When you actually start a Claude session with a new app, you end up spending the first 10-15 minutes explaining what you want to build, what the UX should feel like, what data it needs, how users interact with it. That context should be captured upfront and baked into the generated artifacts.

---

## 2. Proposed Enhanced Fields

### New Fields for Step 1 (grouped into sections)

**Identity** (existing, no changes)
- Name, ID, Icon — same as today

**Purpose & Audience** (new section)

| Field | Type | Purpose |
|-------|------|---------|
| `description` | textarea (expanded) | 3-5 sentence description, not 1 line. Prompted: "Describe what this app does, who uses it, and what problem it solves." |
| `appCategory` | select | Game, Tool, Dashboard, Content Site, Admin Panel, API Client — drives template selection |
| `targetAudience` | text | "Game Shelf players", "Internal team", "Quotle.info visitors" — used in prompt context |
| `keyFeatures` | tag input (up to 5) | Short feature labels: "daily puzzle", "leaderboard", "share results" — seeds PROJECT_PLAN |

**Technical Blueprint** (new section)

| Field | Type | Purpose |
|-------|------|---------|
| `framework` | select | React via CDN, Vanilla JS, Preact — determines boilerplate |
| `dataStrategy` | multi-select | Firebase Auth, Firebase RTDB, localStorage, None — determines imports and config blocks |
| `firebasePaths` | tag input | Planned Firebase paths: `users/{uid}/appname`, `appname-public/daily` |
| `uiFramework` | select | Tailwind via CDN, Custom CSS, Minimal — determines style approach |
| `keyLibraries` | tag input | Specific CDN libraries needed: "JSZip", "Chart.js", "Tone.js" |

**Design Direction** (new section)

| Field | Type | Purpose |
|-------|------|---------|
| `colorScheme` | palette picker | Primary/accent colors, or preset themes (Game Shelf dark, clean light, etc.) |
| `layoutType` | select | Single page, Tabbed, Dashboard grid, Game board, Form wizard |
| `mobileFirst` | checkbox (default on) | Whether mobile is primary target |
| `referenceApps` | multi-select from CC apps | "Make it feel like Quotle" or "Similar layout to Game Shelf" — Claude gets those apps' CONTEXT.md patterns |

**Infrastructure** (existing fields, reorganized)
- Structure, PWA, Admin, Custom Domain — same as today

---

## 3. Enhanced Generated Artifacts

### A. Seed HTML: Functional Landing Page (not placeholder)

Instead of the current 20-line placeholder, generate a real starting point based on captured fields:

**For a Game (React, Firebase, Tailwind):**
- Full HTML shell with React 18 + Tailwind CDN imports
- Firebase SDK initialized with config
- Firebase Auth sign-in flow (if selected)
- App shell with header (icon + name + version), main content area, footer
- Dark mode styling with selected color scheme
- Mobile-responsive meta viewport and base responsive classes
- Proper meta tags (version, gs-app-id, description, OG tags)
- Service worker registration (if PWA)
- A `CC_SEED_MANIFEST` comment block for drift detection
- Placeholder component structure matching the selected layout type

**For a Tool (Vanilla JS, localStorage):**
- Clean HTML with selected UI framework
- localStorage helper functions
- Basic CRUD scaffolding
- Print-friendly CSS if relevant

The seed should be **runnable immediately** — open in a browser and see a real app shell, not "Coming soon."

### B. Enhanced Claude Prompt → System Instructions

Transform the current flat prompt into a structured **system instruction document** that serves as the project's permanent AI briefing. This becomes the project's `CLAUDE_INSTRUCTIONS.md` — a new standard doc in the package.

**Structure:**

```
# {App Name} — AI Development Instructions

## Project Identity
{Rich description, audience, category, key features}

## Technical Stack
- Framework: {React via CDN / Vanilla JS}
- Styling: {Tailwind via CDN / Custom CSS}
- Data: {Firebase RTDB at paths X, Y / localStorage}
- Libraries: {specific CDN libs}
- Architecture: Single-file HTML, all inline

## Design System
- Colors: {primary, accent, background}
- Layout: {type}
- Mobile-first: {yes/no}
- Dark mode: {standard approach}
- Reference: {similar apps in ecosystem}

## Building Blocks Required
{Auto-generated based on selections}
- [ ] Firebase Auth (Google sign-in)
- [ ] Firebase RTDB read/write at {paths}
- [ ] Daily puzzle reset logic (midnight UTC)
- [ ] Share results (clipboard + native share API)
- [ ] Responsive game board layout
- [ ] Score/streak tracking in localStorage

## Command Center Integration
### Required Meta Tags
<meta name="version" content="X.Y.Z">
<meta name="gs-app-id" content="{id}">

### Deploy Package
{files list based on PWA/structure selection}

### Version Management
Bump patch for fixes, minor for features, major for breaking.
Use semver. CC reads version from meta tag.

## Session Protocol

### Starting a Session
1. Read CONTEXT.md first (current state, architecture, conventions)
2. Read PROJECT_PLAN.md (what's done, what's next)
3. Check SESSION_BRIEF.md (versions, recent deploys, open issues)
4. Understand the current codebase before making changes

### During Development
- All CSS and JS must be inline in the HTML file
- Test changes work on mobile viewport (375px)
- Maintain consistent naming conventions established in CONTEXT.md
- Log significant decisions in code comments

### Ending a Session — REQUIRED Deliverables
Every session MUST produce a project package containing:

1. **Updated source files** — index.html (+ sw.js, manifest.json if PWA)
   - Version meta tag MUST be incremented
   - All changes inline in single file

2. **Updated CHANGELOG.md** — append new version entry
   Format: ## [X.Y.Z] - YYYY-MM-DD
   Sections: Added / Changed / Fixed / Removed

3. **Updated RELEASE_NOTES.txt** — human-readable summary

4. **Updated CONTEXT.md** — if architecture, schemas, or conventions changed

5. **Updated PROJECT_PLAN.md** — move completed items, update In Progress

6. **Project package zip** — {app}-project-v{X.X.X}.zip with all above files

### Package Convention
{app}-project-v{X.X.X}.zip
└── {app}/
    ├── index.html
    ├── CONTEXT.md
    ├── PROJECT_PLAN.md
    ├── CHANGELOG.md
    ├── RELEASE_NOTES.txt
    └── [sw.js, manifest.json if PWA]
```

### C. Pre-Populated Project Docs (not skeletons)

The skeleton generators currently output TODO placeholders. With the enhanced fields, they can generate **real first drafts**:

**CONTEXT.md** — pre-filled with actual architecture details, data schema stubs based on Firebase paths, key components based on layout type, deployment details, and conventions based on framework choice.

**PROJECT_PLAN.md** — Mission statement from description, Phase 1 features from keyFeatures tags, architecture decisions pre-filled from technical selections, open questions auto-generated from ambiguous selections.

**CHANGELOG.md** — v0.1.0 entry with "Initial app shell with {framework}, {data strategy}, {layout type}" instead of generic placeholder.

---

## 4. Workflow: How It All Connects

```
CURRENT WORKFLOW:
Setup Wizard → bare placeholder → generic prompt → manual explanation to Claude

ENHANCED WORKFLOW:
Setup Wizard (rich capture) 
    → Functional seed HTML (runnable app shell)
    → CLAUDE_INSTRUCTIONS.md (permanent AI briefing)
    → Pre-filled CONTEXT.md, PROJECT_PLAN.md, CHANGELOG.md
    → All committed to repo via GitHub API
    → Claude Prep packages everything
    → First Claude session starts with FULL context
    → Claude reads instructions, sees the app shell, knows exactly what to build
    → Session ends → package delivered → next session picks up seamlessly
```

### The First Session Experience (Before vs After)

**Before:**
> "I'm building a daily word puzzle game. It should use React and Firebase. 
> Dark mode. Mobile first. Here's my placeholder HTML..."
> [10 minutes of back-and-forth establishing context]

**After:**
> [Upload project package]
> "Continue with Phase 1 features from the project plan."
> [Claude reads CLAUDE_INSTRUCTIONS.md, sees the React/Firebase/Tailwind 
> app shell, sees the 5 key features, knows the data paths, starts building]

---

## 5. Implementation Plan

### Phase 1: Enhanced Capture (1-2 sessions)
- Expand Step 1 form with new field sections (Purpose, Technical, Design)
- Add `appCategory` select with category-specific defaults
- Add tag inputs for keyFeatures, firebasePaths, keyLibraries
- Add `referenceApps` multi-select from existing CC apps
- Keep backward compatible — new fields optional, existing apps unaffected

### Phase 2: Smart Generation (2-3 sessions)  
- Rewrite `generateInitialHTML()` with category-aware templates
- Build `generateClaudeInstructions()` — the new system instruction doc
- Enhance skeleton generators to use new fields for real content
- Auto-generate "Building Blocks Required" checklist from selections
- Template library: game, tool, dashboard, content site

### Phase 3: Integration (1 session)
- Add CLAUDE_INSTRUCTIONS.md to CLAUDE_PREP_DOCS list
- Claude Prep includes it in packages
- Setup wizard commits all generated docs to repo (not just seed HTML)
- SESSION_BRIEF.md references the instructions doc

### New Standard Doc Set (after enhancement)
```
{app}-project-v{X.X.X}.zip
└── {app}/
    ├── index.html                ← Functional app shell (not placeholder)
    ├── CLAUDE_INSTRUCTIONS.md    ← NEW: Permanent AI briefing
    ├── CONTEXT.md                ← Pre-filled (not skeleton)
    ├── PROJECT_PLAN.md           ← Pre-filled (not skeleton)
    ├── CHANGELOG.md              ← Real v0.1.0 entry
    ├── RELEASE_NOTES.txt         ← v0.1.0 notes
    ├── SESSION_BRIEF.md          ← Auto-generated by CC
    └── [sw.js, manifest.json]    ← If PWA
```

---

## 6. Key Decisions Needed

1. **CLAUDE_INSTRUCTIONS.md vs enhanced CONTEXT.md?** 
   The instructions could live as a section in CONTEXT.md instead of a separate file. Separate file is cleaner but adds to the doc count. Recommendation: Separate file — it has a different audience (AI) and update cadence (rarely changes after creation).

2. **How rich should the seed HTML be?**
   Range: current placeholder → app shell → near-functional prototype. Recommendation: App shell with real structure but no business logic. Claude builds the features; the shell gives it a canvas.

3. **Reference apps — how deep?**
   When you select "similar to Quotle," should the prompt include Quotle's full CONTEXT.md or just key patterns? Recommendation: Extract patterns (framework, data model shape, UI approach) not full docs. Keep the prompt focused.

4. **Should this replace SetupNewAppView or enhance it?**
   This could be a v2 of the wizard or a new flow entirely. Recommendation: Enhance the existing wizard. Add steps or sections to Step 1, upgrade the generators. Same 4-step flow, richer input, richer output.
