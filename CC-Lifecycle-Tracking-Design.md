# Project Lifecycle Tracking — Design Document

## The Idea

Right now, CC tracks **what happened** (deploy history, session log) and **what exists** (versions, repos, issues). What it doesn't track is **what's planned** — the backlog of work items that define where each app is headed and what comes next.

Claude Prep currently says: "Here's everything about Game Shelf. Good luck."

With lifecycle tracking, Claude Prep would say: "Game Shelf is in Beta. Here are the 2 remaining backlog items blocking Production. Today's session: implement sound effects for tile placement. Here's the acceptance criteria, the relevant architecture context, and the files you'll need to touch."

The difference is between a general briefing and a targeted work order.

---

## Data Model

### Backlog Items

A new entity in Firebase alongside issues, stored at `command-center/{uid}/backlog/{itemId}`:

```javascript
{
    id: 'BL-042',
    appId: 'game-shelf',          // Which app this belongs to
    title: 'Sound effects for tile interactions',
    description: 'Add subtle audio feedback for tile place, remove, swap, and invalid move. Use Tone.js or Web Audio API. Must have mute toggle that persists in localStorage.',
    
    // Classification
    type: 'feature',              // feature | bugfix | enhancement | chore | research
    priority: 'core',             // core (MVP) | nice-to-have | out-of-scope
    phase: 'beta',                // prototype | alpha | beta | production
    
    // Status lifecycle
    status: 'ready',              // idea | ready | in-progress | review | done | deferred
    
    // Sizing & effort  
    effort: 'session',            // quick (<1hr) | session (1 session) | multi-session | epic
    
    // Acceptance criteria — what "done" looks like
    criteria: [
        'Tile place sound on valid placement',
        'Error sound on invalid move',
        'Mute toggle in header, persists in localStorage',
        'No audio autoplay on page load (browser policy compliant)'
    ],
    
    // Context for Claude — what to read, what to know
    context: {
        filesAffected: ['index.html'],        // Which files Claude should focus on
        sections: ['AudioManager', 'GameBoard component'],  // Where in the code
        dependencies: ['Tone.js via CDN'],    // Libraries needed
        notes: 'Check how Quotle handles TTS for audio pattern reference. Game Shelf uses React so this should be a useEffect hook or dedicated AudioManager function.',
        relatedItems: ['BL-038'],             // Other backlog items this depends on or relates to
    },
    
    // Tracking
    createdAt: '2026-02-01T...',
    createdBy: 'manual',
    startedAt: null,               // When status moved to in-progress
    completedAt: null,             // When status moved to done
    completedInVersion: null,      // e.g., '2.4.0'
    sessionId: null,               // Which Claude session worked on this
    
    // Tags for filtering
    tags: ['audio', 'ux', 'polish']
}
```

### App Maturity State

Extend the existing app definition in config with lifecycle metadata:

```javascript
// Inside config.apps[appId], add:
lifecycle: {
    maturityTarget: 'production',   // What we're building toward
    currentMaturity: 'beta',        // Where we are now
    maturityCriteria: {
        prototype: { met: true, date: '2025-06-15' },
        alpha:     { met: true, date: '2025-09-01' },
        beta:      { met: true, date: '2026-01-10' },
        production: { 
            met: false, 
            criteria: [
                { text: 'All beta criteria met', done: true },
                { text: 'Edge cases handled gracefully', done: true },
                { text: 'Performance optimized', done: false },
                { text: 'Error boundaries / recovery', done: true },
                { text: 'Accessibility pass', done: false },
                { text: 'Deployment pipeline tested', done: true },
            ]
        }
    },
    problemStatement: 'Players want a central hub to track daily puzzle games...',
    targetAudience: 'Casual puzzle game players, mobile-first',
    userGoal: 'See all daily puzzle results in one place, compete with friends'
}
```

This stores the enhanced setup wizard data permanently with the app, and tracks maturity progression over time.

---

## How It Shows Up in CC

### 1. Dashboard — Maturity Badges

Each app on the dashboard gets a maturity indicator:

```
🎮 Game Shelf          v2.3.1  test ✓  prod ✓
   🔧 Beta → 🚀 Prod   ████████░░ 4/6 criteria  │  2 backlog items
   
🏷️ LabelKeeper        v1.8.0  prod ✓
   🔬 Alpha → 🔧 Beta  ██████░░░░ 3/5 criteria  │  5 backlog items

📦 Teacher Assist      v0.2.0  test ✓
   🧪 Proto → 🔬 Alpha ████░░░░░░ 2/5 criteria  │  8 backlog items
```

Clicking the maturity badge shows the criteria checklist. Clicking the backlog count opens the backlog filtered to that app.

### 2. Backlog View — New Top-Level Navigation

A new view alongside Dashboard, Projects, Monitor, Settings:

```
📋 Backlog
├── Filter: [All Apps ▾] [All Phases ▾] [All Status ▾] [All Types ▾]
│
├── 🎮 Game Shelf (Beta → Production)
│   ├── ⭐ BL-042  Sound effects for tile interactions    [session]  ready
│   └── ⭐ BL-045  Accessibility pass — keyboard nav      [multi]    ready
│
├── 🏷️ LabelKeeper (Alpha → Beta)
│   ├── ⭐ BL-031  Multi-sheet inventory                  [multi]    in-progress
│   ├── ⭐ BL-033  OCR import from photo                  [session]  ready
│   ├── 💎 BL-034  Label templates library                [session]  ready
│   ├── 💎 BL-036  Cloud sync (Firebase)                  [multi]    idea
│   └── 🚫 BL-037  Print to physical printer (deferred)   [epic]     deferred
│
└── [+ New Backlog Item]
```

Legend: ⭐ = core (MVP), 💎 = nice-to-have, 🚫 = out-of-scope/deferred

Each item expands inline to show description, criteria, context, and a **"Start Session"** button.

### 3. Backlog Item Detail — Session Launcher

When you expand a backlog item:

```
┌─────────────────────────────────────────────────┐
│ BL-042: Sound effects for tile interactions     │
│ 🎮 Game Shelf  │  ⭐ Core  │  🔧 Beta  │  1 session │
├─────────────────────────────────────────────────┤
│                                                 │
│ Add subtle audio feedback for tile place,       │
│ remove, swap, and invalid move.                 │
│                                                 │
│ ✅ Acceptance Criteria                           │
│ ☐ Tile place sound on valid placement           │
│ ☐ Error sound on invalid move                   │
│ ☐ Mute toggle in header, persists localStorage  │
│ ☐ No audio autoplay on page load                │
│                                                 │
│ 📎 Context                                       │
│ Files: index.html                               │
│ Sections: AudioManager, GameBoard component     │
│ Libraries: Tone.js via CDN                      │
│ Notes: Check how Quotle handles TTS for pattern │
│ Related: BL-038 (volume/mute system)            │
│                                                 │
│ ┌──────────────────────────────────────────┐    │
│ │  🤖 Start Claude Session for BL-042     │    │
│ │                                          │    │
│ │  This will:                              │    │
│ │  • Generate Claude Prep package          │    │
│ │  • Include targeted session prompt       │    │
│ │  • Mark BL-042 as "in-progress"         │    │
│ │  • Track session start time              │    │
│ └──────────────────────────────────────────┘    │
│                                                 │
│ [Mark Ready] [Defer] [Edit] [Delete]            │
└─────────────────────────────────────────────────┘
```

### 4. Targeted Claude Prep — The Key Innovation

When you click **"Start Claude Session for BL-042"**, Claude Prep generates the standard package PLUS a targeted session prompt appended to SESSION_BRIEF.md:

```markdown
# Session Brief — Game Shelf
Generated by Command Center on 2/10/2026, 9:15:22 AM

## Current Status
| Environment | Version | Last Deploy |
|-------------|---------|-------------|
| Test        | 2.3.1   | 2/9/2026    |
| Prod        | 2.3.0   | 2/7/2026    |

## Lifecycle
- **Maturity:** 🔧 Beta → 🚀 Production (4/6 criteria met)
- **Remaining for Production:** Performance optimization, Accessibility pass
- **Open Backlog:** 2 items (BL-042, BL-045)

## Session Target: BL-042
### Sound effects for tile interactions

**Goal:** Add subtle audio feedback for tile place, remove, swap, and 
invalid move. Use Tone.js or Web Audio API. Must have mute toggle that 
persists in localStorage.

**Acceptance Criteria:**
- [ ] Tile place sound on valid placement
- [ ] Error sound on invalid move  
- [ ] Mute toggle in header, persists in localStorage
- [ ] No audio autoplay on page load (browser policy compliant)

**Where to work:**
- Files: index.html
- Sections: AudioManager, GameBoard component
- New dependency: Tone.js via CDN

**Context:** Check how Quotle handles TTS for audio pattern reference. 
Game Shelf uses React so this should be a useEffect hook or dedicated 
AudioManager function.

**Related:** BL-038 (volume/mute system) — already completed in v2.2.0

**Maturity note:** This is a Beta-level feature. Build to Beta quality 
(feature complete, basic error handling, mobile responsive). Do NOT 
over-engineer with production-level audio optimization.

## Recent Deploys (Last 5)
| Date | Version | Target | Notes |
|------|---------|--------|-------|
| ...  | ...     | ...    | ...   |
```

Compare this to today's SESSION_BRIEF.md which just shows versions and deploys. The targeted version tells Claude exactly what to build, where to build it, what "done" looks like, and what quality level to hit. 

### 5. Session Close — Closing the Loop

When a deploy arrives for an app that has an "in-progress" backlog item, CC prompts:

```
🎉 Deploy detected: Game Shelf v2.4.0 → test

BL-042 (Sound effects) is currently in-progress.
Does this deploy complete BL-042?

[Yes — Mark Done] [Partially — Keep In Progress] [No — Different work]
```

If "Yes":
- BL-042 status → done
- completedAt → now
- completedInVersion → 2.4.0
- Maturity criteria auto-checked if relevant
- Backlog count decrements on dashboard

---

## How Backlog Items Get Created

### Path 1: Enhanced Setup Wizard (new apps)
The wizard's "Core Features" tags become backlog items automatically:
- Each core feature → `priority: 'core'`, `phase` based on maturity target
- Each nice-to-have → `priority: 'nice-to-have'`, `phase: 'beta'` or later
- Each out-of-scope → `priority: 'out-of-scope'`, `status: 'deferred'`

### Path 2: Manual Creation (existing apps)
The Backlog view has a "+ New Item" form. Quick-add for title + app + priority, expand for full detail.

### Path 3: During Claude Sessions
Claude can suggest backlog items as part of its session output. SESSION_BRIEF.md could include:
```
## Suggested Backlog Items
If Claude identifies work that should be tracked separately (bugs found, 
follow-up features, tech debt), list them here in this format:

BACKLOG: [title] | [type: feature/bugfix/chore] | [effort: quick/session/multi] | [description]
```
CC could parse these from RELEASE_NOTES.txt on deploy and offer to create them.

### Path 4: From Issues
The existing issue tracker already captures bugs. An "Promote to Backlog" action on an issue would create a backlog item with type: 'bugfix' and link back to the issue.

### Path 5: Import from PROJECT_PLAN.md
For existing apps, a one-time import could parse PROJECT_PLAN.md's "Planned Features" sections and create backlog items from the checkbox lists. Not perfect, but a fast bootstrap.

---

## Integration with Existing CC Features

### Claude Prep Enhancement
```
Current:  🤖 button → fetch source + docs → generate brief → zip
Enhanced: 🤖 button → (optional) select backlog item → fetch + docs → 
          generate TARGETED brief → zip
```

The Claude Prep modal gets a pre-step: "What are you working on this session?"
- Option A: Select a specific backlog item (targeted prompt)
- Option B: General session (current behavior, no targeting)
- Option C: Multiple items (bundle 2-3 related items)

### Deploy Integration
On deploy, CC checks for in-progress backlog items and offers to close them.
Deploy history entries get a `backlogItems` field linking which items were addressed.

### Dashboard Integration
The maturity badge + backlog count gives a project health view at a glance.
Project-level rollup: "Game Shelf project: 3 apps, 2 in Beta, 1 in Alpha, 7 total backlog items."

### Session Log Integration
Session log entries get a `backlogItem` field. This creates the velocity data:
- When was BL-042 created?
- When did the session start?
- When was it deployed?
- How long from "ready" to "done"?

---

## What This Enables

### The Targeted Development Loop
```
1. Open CC → see Game Shelf is Beta with 2 items remaining
2. Click BL-042 → read criteria, understand scope
3. Click "Start Claude Session" → Claude Prep runs with targeted prompt
4. Download zip → upload to Claude → Claude knows EXACTLY what to build
5. Build → test → export package
6. Drag to CC → deploy to test → CC asks "Does this complete BL-042?"
7. "Yes" → BL-042 done, maturity progress updates
8. Game Shelf: 1 backlog item remaining for Production
```

### Project Status at a Glance
You can look at CC and immediately know:
- Which apps are in what state
- What's blocking each app from reaching the next maturity level
- What's ready to be worked on next
- How fast work is getting done (velocity)

### AI Session Efficiency
Instead of spending 10 minutes at the start of each Claude session explaining what to build, the backlog item gives Claude:
- Exactly what to build (title + description)
- What "done" means (acceptance criteria)
- Where to look (files, sections, dependencies)
- What quality level to hit (maturity phase)
- What NOT to build (maturity boundaries)

This is the difference between "help me with Game Shelf" and "implement BL-042, here are the 4 acceptance criteria, it affects the AudioManager and GameBoard component, use Tone.js, build to Beta quality."

---

## Implementation Roadmap

### Phase 1: Backlog Data Model + Basic UI (2 sessions)
**Session 1:** Firebase schema, CRUD operations, Backlog view with list/filter
**Session 2:** Backlog item detail view, inline expand, create/edit/delete flow

### Phase 2: Claude Prep Integration (1-2 sessions)
**Session 3:** "Start Session" button, targeted SESSION_BRIEF.md generation, backlog item selection in Claude Prep modal
**Session 4:** Deploy close-the-loop (detect in-progress items, offer completion)

### Phase 3: Maturity Tracking (1-2 sessions)
**Session 5:** App lifecycle metadata in config, maturity badges on dashboard, criteria checklist
**Session 6:** Enhanced Setup Wizard → auto-create backlog items from features, set maturity target

### Phase 4: Velocity & Insights (1 session)
**Session 7:** Session-to-deploy timing, backlog velocity metrics, project-level rollup

---

## Data Migration for Existing Apps

Existing apps don't have lifecycle data or backlog items. Migration approach:

1. **Maturity assignment (manual, one-time):** Quick UI to set current maturity for each app. Most are obvious: Game Shelf = Beta, Command Center = Production, Teacher Assist = Prototype.

2. **Backlog bootstrap from PROJECT_PLAN.md:** Parse the "Planned Features" sections. Each unchecked `- [ ]` line becomes a backlog item in "idea" or "ready" status. Won't be perfect but gets 80% of items created.

3. **Problem statement backfill:** Optional. For apps that went through the old setup wizard, the description field is sparse. Could add the enhanced fields (problem, audience, goal) retroactively in the app config.

The migration doesn't have to be complete on day one. The system works incrementally — any app with a backlog item and maturity level gets the enhanced experience, apps without it get the current experience unchanged.
