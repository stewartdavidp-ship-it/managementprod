# AI Project Setup: Competitive Landscape & What Makes CC Different

## What Exists Today

There are three categories of tools that touch what we're building. None of them do what we're proposing.

---

## Category 1: AI App Builders (Bolt, Lovable, v0, Replit)

**What they do:** You type "build me a SaaS dashboard" and get a working app in 60 seconds. These are prompt-to-app generators — they skip the thinking and go straight to code.

**What they capture at project start:** Almost nothing. A single text prompt. No structured intake, no problem definition, no scope boundaries, no maturity targets. You describe what you want and the AI generates it immediately.

**What goes wrong:**
- The "technical cliff" — beautiful UI gets generated but there's no backend, no auth, no data persistence. Lovable and Bolt literally require you to manually configure Supabase after the fact.
- Scope creep is the business model. Every additional prompt burns tokens. Complex apps can cost $1,000+ in token consumption just fixing the issues created by the lack of upfront definition.
- No session continuity. If you hit context limits (which happens frequently), the AI loses track of everything. The Medium article on Cursor put it well: "Once you hit that limit, the AI loses track of previous changes and discussions."
- No concept of "done." There's no maturity target, no MVP definition. You just keep prompting until you run out of credits or patience.

**What we can learn:** The instant gratification of prompt-to-app is compelling. But the pain point — "What looked like a finished product was actually a frontend mockup with no foundation" — is exactly what our structured approach prevents.

---

## Category 2: AI Coding Assistants (Cursor, Copilot, Claude Code, Windsurf)

**What they do:** These live inside your IDE and help you write code. They're pair programmers, not project managers.

**How they handle project context:**

**Cursor** is the most relevant comparison. It has a `.cursor/rules` directory where you put project-specific instructions that guide the AI. There's a growing community (awesome-cursorrules on GitHub) of shared rule templates for different tech stacks. Cursor also supports PRD (Product Requirements Document) files — you put a PRD.md in your repo and the AI can reference it.

The best practice workflow documented by experienced Cursor users looks like this:
1. Generate a PRD file first (using AI to draft it)
2. Set project rules for tech stack and coding conventions
3. Break implementation into logical tasks
4. Execute tasks one at a time with the PRD as reference

**Claude Code** (Anthropic's own tool) uses a similar pattern — CLAUDE.md files in the repo that provide project context. Engineers at Anthropic report that ~90% of Claude Code's own code is written by Claude Code.

**What they don't do:**
- No structured questionnaire at project inception. You write the PRD yourself (or prompt the AI to draft one, which is circular).
- No maturity levels. No concept of "build to alpha quality, not production."
- No scope boundaries. No "out of scope" definitions that prevent feature creep.
- No session protocol. No standardized "here's what you must deliver at the end of every session."
- No deployment pipeline integration. They're code tools, not CI/CD managers.

**What we can learn:** The `.cursorrules` / `CLAUDE.md` pattern validates that persistent project instructions for AI dramatically improve output quality. Our CLAUDE_INSTRUCTIONS.md is the same concept, but generated from structured intake rather than hand-written.

---

## Category 3: Traditional Project Scaffolding (create-react-app, Yeoman, etc.)

**What they do:** Generate project boilerplate from templates. Ask a few questions (TypeScript? Testing framework? CSS preprocessor?) and output a directory structure.

**What they capture:** Purely technical decisions. Framework, build tool, linting config. Zero product thinking.

**What we can learn:** The interactive questionnaire pattern (select from options → get customized output) is proven UX. But these tools stop at the file system. They don't think about the development lifecycle.

---

## Category 4: What Smart People Are Doing Manually

Addy Osmani (Chrome team lead at Google) published his LLM coding workflow for 2026. The key insight: "Planning first forces you and the AI onto the same page and prevents wasted cycles. It's a step many people are tempted to skip, but experienced LLM developers now treat a robust spec/plan as the cornerstone of the workflow."

His workflow:
1. Write a detailed spec/PRD
2. Use a reasoning model to generate a project plan (break into tasks)
3. Iterate on the plan before writing any code
4. Execute tasks in small, contained chunks
5. Feed the AI all relevant context (code, constraints, pitfalls)

He calls it "doing waterfall in 15 minutes" — rapid structured planning that makes coding smoother.

The Cursor community has converged on a similar pattern. One well-documented approach uses a 4-file structure:
- `architecture.mermaid` — system diagram
- `technical.md` — specs and patterns
- `tasks.md` — broken-down development tasks
- `status.md` — progress tracking

**What we can learn:** The experts have independently arrived at the same conclusion — structured upfront planning with AI produces dramatically better results than "just start prompting." But they're all doing this manually, every time, for every project.

---

## What Nobody Is Doing

Here's the gap in the market that our enhanced setup wizard fills:

| Capability | Bolt/Lovable/v0 | Cursor/Claude Code | CC Enhanced Setup |
|---|---|---|---|
| **Structured problem definition** | ❌ Free-text prompt | ❌ Manual PRD | ✅ Guided questionnaire |
| **Explicit scope boundaries** | ❌ | ❌ | ✅ Core / Nice-to-have / Out of scope |
| **Maturity targets** | ❌ | ❌ | ✅ Prototype → Alpha → Beta → Prod |
| **Session protocol** | ❌ | Partial (CLAUDE.md) | ✅ Required deliverables, version rules |
| **Deployment pipeline** | Basic (one-click) | ❌ | ✅ CC integration (deploy, version, track) |
| **Cross-session continuity** | ❌ Context lost | Partial (file-based) | ✅ Package system (zip in, zip out) |
| **Category-aware defaults** | ❌ | ❌ | ✅ Game vs Tool vs Dashboard presets |
| **Anti-scope-creep mechanism** | ❌ Token burn | ❌ | ✅ "Does this help the user do X?" |
| **Generated AI instructions** | ❌ | Hand-written .cursorrules | ✅ Auto-generated from intake |

**The key differentiator: Nobody is connecting the intake questionnaire to the AI instruction document to the deployment pipeline in a single integrated flow.**

Cursor users write their own PRDs. Bolt users have no PRD at all. Neither has a concept of maturity levels. Neither enforces session deliverables. Neither connects back to a deployment system that tracks versions and manages releases.

---

## How Our Approach Differs — The Philosophy

### Everyone else: "What do you want to build?"
### Our approach: "What problem are you solving, for whom, and what does done look like?"

The AI app builders optimize for **speed to first render**. Get pixels on screen as fast as possible. This creates what one developer called the "technical cliff" — beautiful demos that can't actually ship.

The Cursor/Claude Code ecosystem optimizes for **code quality within a session**. Good rules produce good code. But there's no lifecycle management — no concept of what happens across 10 sessions of iterative development.

Our enhanced setup optimizes for **project clarity across the entire development lifecycle**. The intake questionnaire forces decisions that would otherwise be made implicitly (and often inconsistently) across multiple AI sessions. The maturity targets prevent over-engineering. The scope boundaries prevent feature creep. The session protocol ensures every session produces deployable, documented, versioned output.

### The Tree Metaphor in Practice

**Bolt/Lovable approach:** "Build me a dashboard with sidebar, stats cards, and a chart." → AI generates leaves (UI components) with no trunk (architecture) or branches (feature boundaries). Adding auth later means retrofitting a foundation under an existing structure.

**Cursor approach:** Developer writes a PRD, creates rules, builds systematically. Better, but the quality of the outcome depends entirely on the developer's ability to write a good PRD. Most people skip this step.

**CC approach:** The wizard asks "what's the problem, who's the user, what's core vs. nice-to-have, what maturity level?" → Generates the trunk (CLAUDE_INSTRUCTIONS.md with scope, maturity, stack) → Generates the branch structure (PROJECT_PLAN.md with phased features) → Generates a starting point for growth (seed HTML with real architecture). The tree is defined before any leaves are added.

---

## Recommendation

What we're building doesn't exist anywhere else. The closest analog is what expert developers do manually with Cursor + hand-written PRDs + custom rules — but we're automating and standardizing that process, connecting it to a deployment pipeline, and adding concepts (maturity levels, scope boundaries, session protocol) that even the experts don't formalize.

This is worth building. It's a genuine innovation in how humans interact with AI for software development.
