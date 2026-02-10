# Project Scoping Flow — Design Document

> How Command Center captures project intent and translates it into structured requirements, work items, and AI instructions.

---

## The Problem

When starting a new app or feature set, the first Claude session wastes 10-15 minutes establishing context: what the app does, who it's for, what the V1 scope is, what patterns to follow. The setup wizard captures infrastructure metadata (repos, PWA, admin paths) but almost nothing about purpose, features, or standards.

Meanwhile, every app in the ecosystem ends up building the same baseline patterns: dark/light mode, toast notifications, responsive layout, hamburger menu, meta tags. These are rebuilt from scratch each time because there's no mechanism to communicate "start with these standards" to a Claude session.

## The Solution

A **scoping flow** that captures project intent through targeted, category-driven questions and produces:
1. **Structured scope data** stored on the app definition
2. **Backlog items** auto-generated from features
3. **A standards profile** describing the v0.7 baseline
4. **CLAUDE_INSTRUCTIONS.md** that travels with every Claude Prep package

The flow works entirely without AI. AI enrichment is available as an optional accelerator when an Anthropic API key is configured.

---

## Flow: Capture → Clarify → Enrich → Generate

### Step 1: Describe (Capture)

**Fields:**
- `description` (textarea, 3-5 sentences): "What does this app do? Who is it for? What problem does it solve?"
- `category` (select): game | tool | dashboard | content | admin

**If launched from Setup Wizard:** App name, icon, and project are already populated from Step 1 (Define).

**If launched from Backlog View** (scoping enhancements for existing app): App is pre-selected.

---

### Step 2: Clarify (Category-Driven Questions)

Each category has a tailored question set. Questions are toggles, selects, or short inputs — not open-ended. Answers drive feature pre-population and starting standards selection.

#### Game Questions

| Question | Type | Default | Drives |
|----------|------|---------|--------|
| Daily puzzle/reset mechanic? | toggle | on | Daily reset logic, streak tracking, puzzle number |
| Difficulty modes? | select: none / easy-hard / multiple | easy-hard | Mode selector in menu, separate stats |
| Scoring system? | select: none / points / tries / time | points | Score display, personal best tracking |
| Share results? | toggle | on | Share button, navigator.share pattern, share text builder |
| Multiplayer or social features? | toggle | off | Firebase auth, friend system, battle infrastructure |
| Streaks? | toggle | on | Streak counter, daily check, localStorage persistence |
| Achievements? | toggle | off | Achievement definitions, unlock tracking, notification |
| Sound effects? | toggle | off | Audio manager, mute toggle in settings |
| Tutorial/onboarding? | toggle | on | Welcome modal, guided walkthrough, replay from menu |

#### Tool Questions

| Question | Type | Default | Drives |
|----------|------|---------|--------|
| Data persistence? | select: none / localStorage / Firebase | localStorage | Storage helpers, data migration strategy |
| Primary data type? | text: e.g. "label sheets", "expense records" | — | CRUD scaffolding context, data model hints |
| Import/export? | toggle | on | File input, export function, format handling |
| Print support? | toggle | off | Print CSS, print preview, page break handling |
| Multi-item management? | toggle | on | List view, item cards, select/bulk actions |
| Search/filter? | toggle | on | Search input, filter controls |
| Undo/redo? | toggle | off | State history, undo stack |
| Settings persistence? | toggle | on | Settings object in localStorage, settings UI |
| Keyboard shortcuts? | toggle | off | Keyboard event listeners, shortcut reference |

#### Dashboard Questions

| Question | Type | Default | Drives |
|----------|------|---------|--------|
| Data sources? | multi-select: Firebase / API / localStorage / manual | Firebase | Data fetching pattern, refresh strategy |
| Layout? | select: cards / table / mixed | cards | Grid vs table CSS, component structure |
| Auto-refresh? | toggle | on | Refresh interval, last-updated display |
| Filtering? | toggle | on | Filter controls, query params |
| Date range selector? | toggle | on | Date picker, time-scoped queries |
| Export data? | toggle | off | CSV/JSON export function |
| Real-time updates? | toggle | off | Firebase listeners, live indicators |

#### Content Questions

| Question | Type | Default | Drives |
|----------|------|---------|--------|
| Static or dynamic? | select: static / dynamic | static | Build vs runtime content strategy |
| Content source? | select: hardcoded / Firebase / API / CMS | hardcoded | Data loading pattern |
| SEO needed? | toggle | off | Meta tags, semantic HTML, OG tags |
| Media types? | multi-select: text / images / video / audio | text | Media handling, CDN considerations |
| Navigation pattern? | select: single-page / multi-section / paginated | single-page | Nav structure, scroll behavior |

#### Admin Questions

| Question | Type | Default | Drives |
|----------|------|---------|--------|
| Auth required? | toggle | on | Firebase auth, login gate, session management |
| Role-based access? | toggle | off | Role checking, UI permission gating |
| CRUD operations? | toggle | on | Data tables, edit modals, delete confirmation |
| Audit logging? | toggle | off | Action log, timestamp tracking |
| Bulk operations? | toggle | on | Multi-select, batch actions |
| Data visualization? | toggle | off | Charts, summary cards |

---

### Step 3: Features & Priorities (Enrich)

Pre-populated from category + question answers, editable by the developer.

**V1 Features** (core — must ship):
- Auto-generated from toggled-on category answers
- Example for a Game with daily reset + scoring + sharing:
  - "Daily puzzle generation with midnight UTC reset"
  - "Points-based scoring system with personal best tracking"
  - "Share results with emoji grid (navigator.share → clipboard fallback)"
  - "Easy/Hard difficulty modes with separate stats"
  - "Streak tracking with daily play detection"
- Developer can add, remove, reorder, edit descriptions

**Future Features** (V2+ — inform architecture, don't build yet):
- Developer manually adds ideas
- Optional: "Suggest more" button (requires API key) asks AI to suggest based on description + category + V1 scope

**Key Decisions** (resolve before or during Session 1):
- Auto-generated from ambiguous or missing selections
- Example: "Firebase paths: define data structure before building CRUD"
- Developer can add custom decisions

**Each feature has:**
```javascript
{
    title: "Share results with emoji grid",
    description: "Navigator.share with clipboard fallback, generates share text with emoji representation of results",
    priority: "core",       // core | nice-to-have | out-of-scope
    effort: "session",      // quick | session | multi-session
}
```

---

### Step 4: Starting Standards Review

Auto-assembled from selections. Displayed as a checklist the developer can review and toggle.

#### Universal (always on, can be turned off):

- [ ] CSS variables for all colors — `:root` and `[data-theme="dark"]` pattern
- [ ] Dark mode default with light mode toggle
- [ ] Theme persistence in localStorage
- [ ] Mobile-first responsive design
- [ ] Safe area support for notched devices
- [ ] Toast notification system (replaces native alert/confirm/prompt)
- [ ] Custom confirm dialog
- [ ] Hamburger menu (☰) with settings panel
- [ ] `<meta name="version">` and `<meta name="gs-app-id">` tags
- [ ] Version display in settings/footer
- [ ] Loading spinner for async operations
- [ ] Empty state pattern (icon + message + action)

#### Category-driven (pre-selected based on answers):

**From Game answers:**
- [ ] Daily reset at midnight UTC
- [ ] Streak tracking with localStorage persistence
- [ ] Share results (navigator.share → clipboard fallback)
- [ ] Difficulty mode selector in settings
- [ ] Stats tracking object in localStorage
- [ ] Celebration effects on special achievements
- [ ] Tutorial: welcome modal → guided steps → replay from menu

**From Tool answers:**
- [ ] Tab navigation pattern
- [ ] Settings persistence (single localStorage key with JSON object)
- [ ] Import/export functions
- [ ] Print-friendly CSS

**From Firebase answers:**
- [ ] Firebase Auth: Google sign-in flow with auth state listener
- [ ] Firebase RTDB: read/write helpers at specified paths
- [ ] Connection status indicator

**From PWA selection:**
- [ ] Service worker with cache-first strategy
- [ ] PWA manifest with icons and theme color
- [ ] App install prompt detection

---

## Output: Scope Data Model

Stored at `app.lifecycle.scope`:

```javascript
{
    description: "A daily word puzzle where players uncover a hidden quote...",
    category: "game",
    categoryAnswers: {
        dailyReset: true,
        difficultyModes: "easy-hard",
        scoringSystem: "points",
        shareResults: true,
        multiplayer: false,
        streaks: true,
        achievements: false,
        soundEffects: false,
        tutorial: true
    },
    v1Features: [
        { title: "Daily puzzle generation", description: "...", priority: "core", effort: "session" },
        { title: "Points-based scoring", description: "...", priority: "core", effort: "quick" },
        // ...
    ],
    futureFeatures: [
        { title: "Multiplayer battles", description: "..." },
        // ...
    ],
    keyDecisions: [
        { title: "Quote source", description: "Public domain quotes? API? Curated list?", resolved: false },
        // ...
    ],
    startingStandards: [
        "css-variables", "dark-light-toggle", "theme-persistence",
        "mobile-first", "safe-areas", "toast-system", "confirm-dialog",
        "hamburger-menu", "meta-tags", "version-display", "loading-spinner",
        "empty-states", "daily-reset", "streak-tracking", "share-results",
        "difficulty-modes", "stats-tracking", "tutorial-onboarding"
    ],
    scopedAt: "2026-02-10T...",
    source: "manual"
}
```

---

## CLAUDE_INSTRUCTIONS.md Generation

The scope data feeds `generateClaudeInstructions(app, config)`, which produces a document structured as requirement statements — not code, not prose, but specifications that any Claude session can execute against.

**Key principle:** Describe what to build, not how to build it. "Toast notification system that replaces native alert(), uses CSS variables, animates from bottom, auto-dismisses after 3 seconds" is 20 words that produce the same result as 50 lines of template code.

The document structure:

```markdown
# {App Name} — AI Development Instructions

## Project Identity
{From scope.description + scope.category}
- Category: {Game/Tool/etc}
- Audience: {From description}

## V1 Scope
### Must Build (Core)
{Each v1Feature with priority: core, as a requirement statement}

### Nice to Have (If Time)
{Each v1Feature with priority: nice-to-have}

### Out of Scope (Do NOT Build)
{Each v1Feature with priority: out-of-scope, plus futureFeatures}
{Explicitly listing what NOT to build prevents scope creep}

## Starting Standards
{Each startingStandard rendered as a requirement statement}

### Theme & Display
- Dark mode is the default. Support light mode toggle using data-theme attribute on <html>
- All colors via CSS variables in :root and [data-theme="dark"]. Never hardcode color values.
- Persist theme preference in localStorage under key {appId}Theme

### Layout & Responsiveness
- Mobile-first design. Base styles target 375px viewport.
- Minimum 44px touch targets for all interactive elements
- Support safe areas for notched devices using env(safe-area-inset-*)

### User Feedback
- Toast notification system for all user messages. No native alert(), confirm(), or prompt().
- Toasts: positioned bottom-center, auto-dismiss after 3s, support success/error/warning types
- Custom confirm dialog for destructive actions (returns Promise)

### Navigation
- Hamburger menu (☰) in top-right with slide-out or modal settings panel
- Settings panel includes: theme toggle, version display, {category-specific settings}

### {Category-specific sections}
{Rendered from categoryAnswers}

## Key Decisions to Resolve
{Each unresolved keyDecision — these need answers before or during Session 1}

## Architecture Constraints
- Single-file HTML application, all CSS and JS inline
- No build step, no bundler, no framework dependency (unless React via CDN selected)
- {Firebase config block if Firebase selected}
- {PWA requirements if PWA selected}

## Command Center Integration
### Required Meta Tags
<meta name="version" content="X.Y.Z">
<meta name="gs-app-id" content="{appId}">

### Version Management
Semver: bump patch for fixes, minor for features, major for breaking changes.

### Deploy Package
{File list based on PWA/structure selection}

## Session Protocol
{Standard from CLAUDE-PREP-STANDARD}
```

---

## Where the Scoping Modal Is Accessible

1. **Setup New App Wizard** — Step 2 (between Define and Check Repos)
2. **Backlog View** — "Scope Work" button on any app (for scoping enhancements to existing apps)
3. **App Edit Modal** — "Edit Scope" in lifecycle section (modify existing scope)

When launched from Setup Wizard, the output feeds directly into artifact generation.
When launched from Backlog View, the output creates work items for an existing app.
When launched from App Edit Modal, it updates the scope without regenerating artifacts.

---

## AI Enrichment (Optional)

When an Anthropic API key is configured in Settings, two optional AI-assisted features become available:

1. **Feature Suggestions** — In Step 3, a "Suggest more features" button sends the description + category + existing features to Claude Sonnet and gets back 3-5 additional feature ideas. Developer reviews and selectively adds them.

2. **Description Polish** — In Step 1, after typing a rough description, an "Improve" button sends it to Claude for a clearer, more complete version. Developer reviews and accepts or edits.

Both features work as progressive enhancement. The full scoping flow works without them.

---

## Migration for Existing Apps

Existing apps don't have scope data. Options:
- **Ignore** — Existing apps continue working without scope. Claude Prep packages them normally.
- **Retroactive scope** — Use the "Scope Work" action from Backlog View to create scope for existing apps. This is useful for apps actively being developed.
- **No migration needed** — Scope is optional. Apps without scope just don't get CLAUDE_INSTRUCTIONS.md in their packages.
