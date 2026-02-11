# Command Center — Changelog

## [8.44.0] — 2026-02-10

### Added
- **DependencyAlertService** — Firebase service for dependency alert lifecycle (pending → updated/no_impact) with full CRUD, session/stream filtering, and getNextId
- **triggerAlerts()** — Orchestrated auto-remediation: detects dependencies on changed interface → creates work items in dependent streams → creates alert records → marks dependencies as 'changed' → logs to activity feed
- **Interface change detection in Post-Session Review** — Step 1 shows checklist of provided interfaces with dependents; user checks what changed, describes the change, and triggers alerts
- **Prompt chaining in SessionBriefGenerator** — dependency_update work items inject "Dependency Changes — Context from Source Session" section into session briefs with change description, affected interfaces, and source session notes
- **Pending alerts on stream cards** — Amber badge showing pending dependency updates count with change details
- **Pending Alerts summary stat** — WorkStreamsView summary row shows alert count when > 0
- **handleResolveAlert()** — Resolve alerts as 'updated' (verifies dependency) or 'no_impact' (dismisses)
- **globalDependencyAlerts** state — App component state with Firebase listener for `command-center/{uid}/dependencyAlerts`

### Changed
- PostSessionReviewModal receives streams, interfaces, dependencies, dependencyAlerts props
- SessionLogView passes stream/dependency props to PostSessionReviewModal
- WorkStreamsView accepts and uses globalDependencyAlerts prop
- Summary stats grid dynamically shows 5 columns when alerts pending

## [8.43.0] — 2026-02-10

### Added
- **WorkStreamService** — Firebase CRUD for work streams (Phase 5.2)
- **StreamInterfaceService** — Stream-provided interface contracts (Phase 5.4 foundation)
- **DependencyService** — Cross-stream dependency declarations (Phase 5.4 foundation)
- **WorkStreamsView** — Stream board view with cards, completion bars, items, interfaces, dependencies
- **StreamEditModal** — Create/edit streams with full metadata
- **Unified Work Item Model** — streamId field on work items (Phase 5.3)
- **BacklogView stream grouping** — group by stream, stream badges
- **ClaudePrepModal stream filter** — filter work items by stream
- **SessionBriefGenerator stream context** — stream details in briefs
- **Phase 5.1 decoupling** — skills recommendations now project-aware
- **Extensible categories** — getAllCategories() merges built-in + custom

## [8.42.0] — 2026-02-10

### Added
- Release Coordination View (Phase 4.4)
- Release Test Checklist (Phase 4.5)
- Per-app readiness assessment with go/no-go summary
- Auto-generated test checklists from work items and acceptance criteria

## [8.41.0] — 2026-02-10

### Added
- Product Health dashboard (Phase 4.1)
- Smart Quick Actions alignment (Phase 4.2)
- Progressive Disclosure (Phase 4.3)
- Pipeline Health panel
- Recent Activity feed in sidebar

## [8.40.0] — 2026-02-10

### Added
- Work Item Lifecycle Automation (Phase 3.3)
- Review status between in-progress and done
- Stale item detection badges
- Idea → Ready auto-suggest on criteria addition

## [8.39.0] — 2026-02-10

### Added
- Post-Session Review Flow (Phase 3.1)
- Activity Logging via ActivityLogService (Phase 3.4)
- Session pipeline: Prep → Review → Deploy

## [8.38.0] — 2026-02-10

### Changed
- PM-First Language rewrite (Phase 2) — all scoping questions, labels, outcome statements

## [8.37.0] — 2026-02-10

### Removed
- Scoping Step 4 (Standards checkboxes) — auto-assembled silently
- Session wizard Step 3 merged into Step 2

### Added
- Quick Build bypass for 0 work items
- "Your Name" field in Settings

## [8.36.5] — 2026-02-10

### Added
- StorageManager with priority-based localStorage cleanup

## [8.36.3] — 2026-02-10

### Fixed
- Version downgrade protection covers all deploy types

## [8.36.0] — 2026-02-10

### Added
- Unified Package Validation Engine

### Removed
- validateDocPackage, extraction-time showAlerts, deploy-time confirms, VersionWarningModal trigger
