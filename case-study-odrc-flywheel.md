# Case Study: From Simple Question to System Architecture in 30 Minutes

## How the ODRC Flywheel Turned a Research Review into a Platform Strategy

---

### The Setup

A developer sits down with Claude Code to review some research. The question is simple: *"What did you find about AI engines we can target via the MCP server?"*

There's a knowledge tree with findings on Cursor, Windsurf, ChatGPT, Gemini, Grok, and others. Transport compatibility, auth models, tool limits — all mapped. A straightforward research debrief.

That's not what happened.

---

### Shape: The First Question Opens a Door

The research showed which platforms could technically connect. But the developer pushed past the compatibility matrix and asked the question the research hadn't considered:

> *"While they may support MCP, how do they support skills as designed for Claude? Would we need to rewrite skills per engine?"*

This is **shaping** — taking a known answer (these platforms support MCP) and forming a new question around it. The research said "Cursor can connect." The developer asked "but can it actually *work*?"

The answer was nuanced. CC skills are plain markdown — any LLM can load them. But the *orchestration layer* (routers, bootstrap, self-directed skill loading) assumes Claude-grade instruction following. The skill content is portable. The skill system is not.

**Captured:** A DECISION that core skill content is engine-agnostic, plus CONSTRAINTs about engine fidelity and self-directed routing limitations.

---

### Challenge: "Why Not Just..."

With the portability question answered, the developer challenged the proposed architecture:

> *"Today we do claude-code, claude-chat, etc. Why not just do cursor-claude to distinguish the two levels?"*

This single observation collapsed two parameters (surface and engine) into one. The existing naming convention already encoded both dimensions — `claude-code` was always `{brand}-{surface}`, with the engine implied. For non-Claude surfaces, the engine is no longer implied, so it becomes explicit: `cursor-claude`, `cursor-gemini`, `windsurf-claude`.

One param. Two dimensions. No schema change. The server can prefix-match for surface routing, suffix-match for engine-grade decisions, or exact-match for precise variants.

**Captured:** A DECISION on the compound naming convention, plus a 4-level skill resolution cascade (exact variant, surface variant, engine-class variant, base).

---

### Capture: The Surface Registry Emerges

The naming convention decision triggered a bigger question: if tools need to adapt their behavior per surface, where does that configuration live? Hardcoded if/else branches? A new parameter?

The developer proposed a data-driven approach:

> *"Should we create a surface object in which we track key attributes about what a surface can do and cannot do?"*

A surface registry in Firebase. Each surface+engine combination gets an object: capabilities, limits, auth requirements, skill grade, bootstrap skill name, task affinities. Tools read the registry instead of branching on initiator values. New surfaces are added via Firebase, not code deploys. Unknown surfaces degrade gracefully to safe defaults.

This single concept resolved an OPEN question (how to handle unknown initiator values) and created the architectural foundation for everything that followed.

**Captured:** 2 DECISIONs (registry architecture, registry replaces enum), 1 CONSTRAINT (reads must be cheap), 1 OPEN resolved.

---

### Refine: Three Layers of Intelligence

With the registry in place, the conversation refined outward. The developer saw each new implication and pushed further:

**Task routing:** The registry knows what each surface can do. Why not use that to recommend the right surface for each task? Static affinities (declared capabilities) plus observed affinities (learned from actual job completions). Over time, crowd-sourced performance data refines the recommendations.

**User subscriptions:** The registry knows what's *possible*. But what's *available to this user*? Adding subscription tracking means CC only recommends surfaces the user can actually access. No suggesting ChatGPT MCP to someone on the free plan.

**Usage intelligence:** Aggregate job data per user per surface. Surface insights: "You complete builds 30% faster in Cursor than Claude Code." "You're paying for Windsurf Pro but haven't used it in 3 weeks."

Each refinement built on the previous capture. The surface registry DECISION enabled the task routing DECISION, which enabled the user profile DECISION. The OPENs at each layer (How to structure affinity categories? How to capture subscription data? What insights to surface?) mark exactly where the next session should pick up.

---

### The Scorecard

What started as "review the research" produced in a single 30-minute session:

| ODRC Type | Count | Examples |
|-----------|-------|---------|
| **DECISIONs** | 9 | Compound naming, skill cascade, surface registry, task routing, user profiles |
| **CONSTRAINTs** | 7 | Engine fidelity limits, tool caps, context windows, plan pricing, caching requirements |
| **OPENs** | 9 | Affinity taxonomy, subscription capture, insight guardrails, bootstrap design |
| **RULEs** | 1 | The flywheel itself: shape, challenge, capture, refine |

Plus a new Idea object ("Multi-Engine Surface Expansion") linked to its parent ("Leverage Claude Ecosystem"), with every concept traceable to its origin.

---

### Why This Matters

Without structured capture, this conversation is a chat transcript. Useful once, forgotten by the next session. The insights about surface registries and task routing live only in the developer's head — or worse, in a document nobody reads.

With ODRC, every insight is a first-class object:
- **DECISIONs** tell the next session what's been decided and why
- **CONSTRAINTs** prevent the next session from proposing something impossible
- **OPENs** tell the next session exactly where to start
- **RULEs** ensure the next session doesn't violate what's been learned

The conversation doesn't end when the context window closes. It picks up — on any surface, with any AI engine — exactly where it left off.

That's the flywheel: **shape, challenge, capture, refine**. And then do it again.
