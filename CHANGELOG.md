# Command Center — Changelog

All notable changes to Command Center are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [8.13.1.5] — 2026-02-07

### Added
- **Project emoji picker** — categorized emoji grid in ProjectEditModal, same UX as app modal

## [8.13.1.4] — 2026-02-07

### Added
- **Extra docs scanning** in Claude Prep — scans repo root for additional .md/.txt files beyond the standard set and includes them in the package

## [8.13.1.3] — 2026-02-07

### Fixed
- Push Docs progress — clear visual states: green push button → amber pulsing during push → green completion banner → red error banner with retry

## [8.13.1.2] — 2026-02-07

### Fixed
- Push Docs UI flow — eliminated toggle confusion. Three-step progression: button → drop zone → staged files + push. Clear button replaced by Cancel link.

## [8.13.1.1] — 2026-02-07

### Added
- **Zip support for Push Docs** — drop a .zip package and all .md/.txt files are extracted automatically. Deduplicates by filename.

## [8.13.1.0] — 2026-02-07

### Added
- **Push Docs to Repo** — new feature in Claude Prep modal. Drop .md/.txt files, CC checks repo for existing SHAs, pushes via GitHub API with create/update support.

## [8.13.0.9] — 2026-02-07

### Fixed
- **App detection** — new dynamic pattern matching tier using configurable detection patterns from app config. Scores all apps by specificity (match count + pattern length) to pick best match. Fixes "Rungs Builder" detected as "Rungs" issue.
- Exposed `window.__CC_APPS` for detection function access outside React

## [8.13.0.8] — 2026-02-07

### Fixed
- Auto-generated detection patterns — replaced competing useEffect hooks with single `handleNameChange()` function to eliminate race condition

## [8.13.0.7] — 2026-02-07

### Added
- **Emoji picker** on AppEditModal — categorized grid with Tools, Games, Objects, Symbols, Combo sections
- **Auto-generated detection patterns** — title, kebab-case, camelCase, UPPER_CASE patterns generated as user types app name

## [8.13.0.6] — 2026-02-07

### Added
- **Projects promoted to main navigation** — 5 sections: Deploy → Projects → Monitor → Maintain → Configure
- Single-view sections (Projects) render as direct-click button, skip dropdown

### Fixed
- `availableRepos` prop missing from ProjectsTab invocation

## [8.13.0.5] — 2026-02-07

### Added
- **Repository Assignment dropdowns** — select from actual GitHub repos grouped as "Shared Repos" (with app usage labels) vs "Available Repos"
- Auto-derives repo patterns from selected repo
- Preview path display when repo + subPath set
- Toggle to "Manual entry" mode for advanced pattern editing

## [8.13.0.4] — 2026-02-07

### Added
- **Sub Path field** in AppEditModal — monospace input for specifying app subdirectory within shared repos

## [8.13.0] — 2025-02-07

### Added
- **Claude Prep feature** — 🤖 button on each app row in ProjectsTab to prepare context packages for Claude sessions
- **ClaudePrepModal component** — Progress modal that fetches source + docs from repo, generates session brief, builds downloadable zip
- **SESSION_BRIEF.md generation** — Auto-generated from CC data: versions, recent deploys, open issues, app config
- **Doc bootstrapping** — When docs don't exist in repo, generates skeleton CONTEXT.md, PROJECT_PLAN.md, CHANGELOG.md, RELEASE_NOTES.txt templates
- **Doc detection logic** — Standalone repos check root, consolidated repos check `{subPath}/docs/` then `{subPath}/` then root
- **CLAUDE_PREP_DOCS constant** — Standard doc filenames for the package convention
- Helper functions: `generateSessionBrief()`, `generateSkeletonContext()`, `generateSkeletonPlan()`, `generateSkeletonChangelog()`, `getDocsPath()`

### Changed
- `ProjectsTab` now receives `deployments` prop for session brief generation
- App row actions column now has 3 buttons: Claude Prep (🤖), Edit, Delete

---

## [8.12.0] — 2025-02-07

### Added
- **Projects as stored data** — Projects promoted from hardcoded `DEFAULT_PROJECTS` constant to first-class objects in `cc_config_v3.projects`
- **ProjectEditModal component** — Create, edit, and delete projects with name, icon, color theme picker (7 options), description, and sort order
- **ConfigManager project CRUD** — `addProject()`, `updateProject()`, `removeProject()`, `getProjectAppCount()`
- **New Project button** in ProjectsTab header
- **Edit project button** (✏️) on each project card header
- Delete confirmation with app reassignment warning

### Changed
- `_standalone` project concept replaced with `other` (catch-all, non-deletable)
- `getProjectsWithApps()` now accepts `projects` parameter from config
- `DashboardView` now receives `config` prop for project-aware filtering
- `AppEditModal` and `SetupNewAppView` project dropdowns read from `config.projects` instead of constant
- Project active/hidden state now stored in `config.projects[id].state` instead of separate `cc_projectStates` localStorage key
- `DEFAULT_PROJECTS` renamed to `SEED_PROJECTS` (used only during initial migration)

### Migration
- First load auto-seeds `config.projects` from `SEED_PROJECTS`
- Migrates `app.project: '_standalone'` → `'other'` in all app definitions
- Migrates `cc_projectStates` localStorage into `config.projects[id].state`

---

## [8.11.0] — 2025-02-07

### Added
- **FirebaseFunctionsDashboard component** — Cloud Functions overview (Phase 3)
  - Summary cards: active/total functions, 24h error count, last deploy time, last refresh
  - Functions table with name, status badge (ACTIVE/green, DEPLOY_IN_PROGRESS/amber, other/red), runtime, memory, error count, last deploy
  - Health ping: sends POST to each function's HTTPS endpoint, reports status code and response time
  - Ping All button to sequentially test every function
  - Error counts fetched from Cloud Logging API (severity>=ERROR, last 24 hours, grouped by function)
- **FirebaseLogViewer component** — Cloud Logging search and filter (Phase 3)
  - Filter by severity level (All/Debug/Info/Warning/Error/Critical)
  - Filter by function name (auto-populated from returned log entries)
  - Free-text search within log payloads
  - Configurable page size (25/50/100/200 entries)
  - Auto-refresh toggle with 30-second interval
  - Severity summary bar with clickable counts to quick-filter
  - Color-coded log entries: timestamp, severity badge, function name (clickable), and message
  - Supports textPayload and jsonPayload formats
  - Error entries highlighted with red background tint

### Changed
- **FirebaseView** now has 4 tabs: 🗄️ Data Browser | 🔒 Rules | ⚡ Functions | 📋 Logs
- Version bumped to 8.11.0

---

## [8.10.0] — 2025-02-07

### Added
- **FirebaseRulesManager component** — Security rules viewer, editor, and deployer (Phase 2)
  - Fetch and display current RTDB rules as formatted JSON with size/line stats
  - Inline editor with Tab key support, real-time JSON validation, Format/prettify button
  - Deploy rules with confirmation dialog (warns about overwrite, shows path count)
  - Automatic pre-deploy snapshot of current rules
  - Manual snapshot button to save current state on demand
  - Rules history stored in localStorage (`cc_rulesHistory`, last 20 snapshots)
  - Snapshot viewer with raw JSON or line-by-line diff against current rules
  - Restore any snapshot to editor (still requires explicit Deploy to push)
  - Delete individual snapshots
  - Requires service account configured in Settings (shows setup prompt if missing)

### Changed
- **FirebaseView** refactored to tabbed layout with two tabs: 🗄️ Data Browser | 🔒 Rules
- **FirebaseDataBrowser** — extracted from original FirebaseView (all functionality preserved)
- Version bumped to 8.10.0

---

## [8.9.0] — 2025-02-07

### Added
- **FirebaseAdmin class** — Google OAuth2 service account token management
  - Stores service account JSON key in localStorage (`cc_firebase_sa`)
  - JWT signing using Web Crypto API (RS256 / RSASSA-PKCS1-v1_5)
  - Exchanges signed JWT for Google OAuth2 access token via `oauth2.googleapis.com/token`
  - Token caching with 55-minute refresh window (Google tokens last 1 hour)
  - Admin API: `getRules()` / `putRules()` — RTDB security rules via REST
  - Admin API: `listFunctions()` — Cloud Functions status via `cloudfunctions.googleapis.com/v1`
  - Admin API: `getLogs()` — Cloud Logging entries via `logging.googleapis.com/v2`
  - `testConnection()` — 3-point validation (token exchange, rules access, functions API)
- **FirebaseAdminSettings component** — UI in Settings view
  - Paste/save/clear service account JSON key with validation
  - Status display: email, project, key ID, token state (active/expired/not requested)
  - Test Connection button with detailed pass/fail results
  - Refresh Token on demand
  - Info panel listing what admin access enables
- **Global `firebaseAdmin` instance** — available to all components

### Changed
- Settings view now has 4 sections: GitHub Token, Firebase Admin, Options, Reset
- Version bumped to 8.9.0

### Documented (design decisions from session discussion, not yet implemented)
- **Priority 1: Projects as stored data** — Promote `DEFAULT_PROJECTS` from hardcoded constant to `cc_config_v3.projects` with ConfigManager migration, plus Create/Edit/Delete Project modal
- **Priority 2: App creation consolidation** — Merge Setup New App wizard into Projects view, remove standalone nav entry, pre-fill project on "Add App"
- **Priority 3: Firebase-per-app metadata** — New `firebasePaths` field on app definitions linking apps to their Firebase RTDB paths
- **Firebase capabilities gap analysis** — Documented current vs missing FirebaseView features and Claude environment access constraints

---

## [8.8.0] — 2025-02-07

### Added
- **Project layer** — Apps grouped under project umbrellas (Game Shelf, Quotle.info, LabelKeeper, Super Bowl, Standalone)
- **Projects view** — Standalone view (Configure → Projects) with project attributes and app table
- **Dashboard project cards** — Collapsible, color-coded borders, auto-expand on active deploy
- **Timestamp tracking** — `createdAt` and `updatedAt` on all app definitions
- **SB Squares app** — New app under Super Bowl project (🏈)

### Changed
- Dashboard grouping from Public/Internal/Other to project-based
- Configure nav: replaced "Apps" with "Projects"

### Removed
- Old Apps view — replaced by Projects view
- Public/Internal/Other app sections in Dashboard

---

## [8.7.7] — 2025-02-07

### Added
- **Setup New App wizard** — 4-step process (Configure → Setup New App)
- **Quotle.info app** — Landing page at quote-info repo root
- **Quotle.info Admin app** — Database manager at quote-info/admin

---

## [8.7.6] — 2025-02-06

### Notes
- Starting version for this development session

---

## Version History Summary

| Version | Date | Highlight |
|---------|------|-----------|
| 8.11.0 | 2025-02-07 | Functions Dashboard & Log Viewer (Phase 3) — status, health ping, error monitoring, log search |
| 8.10.0 | 2025-02-07 | Firebase Security Rules Manager (Phase 2) — view, edit, deploy, history, rollback |
| 8.9.0 | 2025-02-07 | Firebase admin token management, service account JWT/OAuth2 |
| 8.8.0 | 2025-02-07 | Project layer, standalone Projects view, timestamp tracking |
| 8.7.7 | 2025-02-07 | Setup New App wizard, quotle.info apps |
| 8.7.6 | 2025-02-06 | Session starting point |
| 8.7.x | prior | Firebase monitoring, beta program, issue tracking |
| 8.3.x | prior | App categories, Smart Deploy |
| 8.0.x | prior | ConfigManager v3, multi-environment support |
