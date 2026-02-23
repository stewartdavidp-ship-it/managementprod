# Project Instructions v1.0

## Context Budget Tracking

Track context budget every turn. Format: `📊 Budget: [est total] / [zone] / [headroom]`

- **Threshold:** 624K compaction
- **Zones:** Green <360K, Yellow 360-480K, Red 480-580K, Imminent 580K+

### What to Count

Every source of context consumption must be tracked. The running total is the sum of ALL of these:

| Source | How to Estimate | Notes |
|--------|----------------|-------|
| **System overhead** | ~85K fixed | System prompt, project instructions, tool definitions, memory. Revalidate if tools are added/removed. |
| **MCP tool responses** | Sum `_responseSize` from every tool call | Most reliable number — server reports it |
| **Web search results** | ~10K per search call | Varies by result count; 10 results × ~1K each |
| **Web fetch results** | Use `text_content_token_limit` if set, otherwise estimate ~3-5K per fetch | Can be large — always set token limit |
| **Conversation history** | Sum of all user messages + all assistant responses | This is the compounding cost — every prior turn replays |
| **Past chat search results** | ~3-5K per conversation_search call | Content from retrieved chat snippets |
| **Image search results** | ~1K per call | Metadata only, not image bytes |

### Formula

```
est_total = system_overhead 
          + Σ(mcp _responseSize) 
          + Σ(web_search × 10K) 
          + Σ(web_fetch content) 
          + Σ(user_message_length) 
          + Σ(assistant_output_length)
          + Σ(past_chat_search × 4K)
```

### Estimation Shortcuts

- **Assistant output**: estimate ~1.5K per short response, ~3K per medium, ~5K+ per long response with code/specs
- **User messages**: typically small (~0.1-0.5K each), but uploads can be large
- **Web searches are expensive**: 3 searches ≈ 30K of context. Always factor these in.
- **MCP _responseSize is authoritative**: trust these numbers over estimates for tool calls

### Server Metadata

Read `_contextHealth.used` and `_contextHealth.ceiling` from tool responses when available — these are the authoritative numbers from the server and override estimates.

### Compaction Survival

Write the running budget total to memory every ~5 turns using `memory_user_edits`. Format: `"CC budget: [est total]K / [zone]. Session: [sessionId]"`. After compaction, read memory to recover the last known budget and resume tracking. Remove the budget entry from memory when the session closes.

### Baseline Reference

Tool total ~53K after standard startup (MCP only). Full startup with system overhead: ~138K. This leaves ~486K for actual work before compaction at 624K.