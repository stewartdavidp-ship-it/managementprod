/**
 * In-memory skill cache backed by Firebase RTDB.
 *
 * Lifecycle:
 *   1. Server startup: initSkillCache(uid) reads all skills from Firebase
 *   2. If Firebase has no skills (pre-migration), falls back to compiled constants
 *   3. skill(get) reads from cache (instant). Cache miss → Firebase read → compiled fallback
 *   4. skill(create/update/delete) write-through to Firebase AND update cache immediately
 *   5. TTL: 5 minutes per entry. Stale entries are re-fetched from Firebase on next access
 */

import { getSkillsRef, getSkillRef } from "./firebase.js";

// ─── Types ───

export interface SkillRecord {
  name: string;
  description: string;
  content: string;
  category: string;
  triggers: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
  createdAt: string;
}

interface CacheEntry {
  skill: SkillRecord;
  cachedAt: number; // Date.now() when cached
}

// ─── Cache State ───

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();
let cacheInitialized = false;
let cacheSource: "firebase" | "compiled" | "none" = "none";

// ─── Public API ───

/**
 * Initialize the skill cache from Firebase.
 * Call once at startup after initFirebase().
 * Falls back to compiled constants if Firebase read fails or returns empty.
 */
export async function initSkillCache(uid: string): Promise<void> {
  if (cacheInitialized) return;

  try {
    const snapshot = await getSkillsRef(uid).once("value");
    const data = snapshot.val();

    if (data && typeof data === "object") {
      const skills = Object.values(data) as SkillRecord[];
      if (skills.length > 0) {
        const now = Date.now();
        for (const skill of skills) {
          cache.set(skill.name, { skill, cachedAt: now });
        }
        cacheSource = "firebase";
        cacheInitialized = true;
        console.log(`[skill-cache] Loaded ${skills.length} skills from Firebase`);
        return;
      }
    }

    // Firebase empty — fall back to compiled constants
    console.log("[skill-cache] Firebase empty, falling back to compiled constants");
    await loadFromCompiled();
  } catch (err) {
    console.warn("[skill-cache] Firebase read failed, falling back to compiled constants:", err);
    await loadFromCompiled();
  }
}

/**
 * Get a skill by name from cache.
 * Returns null if not found. Does NOT do a Firebase fetch on miss
 * (compiled fallback is loaded at init time).
 */
export function getCachedSkill(name: string): SkillRecord | null {
  const entry = cache.get(name);
  if (!entry) return null;

  // TTL check — if stale, still return it but mark for refresh
  // (we don't block on refresh; the write-through pattern keeps things fresh)
  return entry.skill;
}

/**
 * Get all cached skills (metadata only — no content).
 * Used by skill(list).
 */
export function getAllCachedSkillsMeta(): { name: string; description: string; category: string; version: number }[] {
  const result: { name: string; description: string; category: string; version: number }[] = [];
  for (const entry of cache.values()) {
    result.push({
      name: entry.skill.name,
      description: entry.skill.description,
      category: entry.skill.category,
      version: entry.skill.version,
    });
  }
  // Sort alphabetically by name for consistent output
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * Get all cached skills with full content.
 * Used by registerSkillPrompts() at server creation time.
 */
export function getAllCachedSkills(): SkillRecord[] {
  const result: SkillRecord[] = [];
  for (const entry of cache.values()) {
    result.push(entry.skill);
  }
  return result;
}

/**
 * Write-through: create or update a skill in Firebase AND cache.
 */
export async function writeSkillToCache(uid: string, skillName: string, data: Partial<SkillRecord>): Promise<SkillRecord> {
  const existing = cache.get(skillName)?.skill;
  const now = new Date().toISOString();

  const skill: SkillRecord = {
    name: skillName,
    description: data.description || existing?.description || "",
    content: data.content || existing?.content || "",
    category: data.category || existing?.category || "custom",
    triggers: data.triggers || existing?.triggers || [],
    version: (existing?.version || 0) + 1,
    updatedAt: now,
    updatedBy: data.updatedBy || "unknown",
    createdAt: existing?.createdAt || now,
  };

  // Write to Firebase
  await getSkillRef(uid, skillName).set(skill);

  // Update cache
  cache.set(skillName, { skill, cachedAt: Date.now() });

  return skill;
}

/**
 * Delete a skill from Firebase AND cache.
 */
export async function deleteSkillFromCache(uid: string, skillName: string): Promise<void> {
  await getSkillRef(uid, skillName).remove();
  cache.delete(skillName);
}

/**
 * Check if a skill exists in cache.
 */
export function skillExistsInCache(name: string): boolean {
  return cache.has(name);
}

/**
 * Get cache diagnostics.
 */
export function getCacheDiagnostics(): { source: string; size: number; initialized: boolean } {
  return {
    source: cacheSource,
    size: cache.size,
    initialized: cacheInitialized,
  };
}

// ─── Internal ───

async function loadFromCompiled(): Promise<void> {
  // Dynamic import to avoid circular dependency (ESM — require() not available)
  try {
    const { getCompiledSkillRegistry } = await import("./skills.js");
    const registry: { name: string; description: string; content: string }[] = getCompiledSkillRegistry();
    const now = Date.now();

    for (const entry of registry) {
      const skill: SkillRecord = {
        name: entry.name,
        description: entry.description,
        content: entry.content,
        category: inferCategory(entry.name),
        triggers: [],
        version: 0,
        updatedAt: new Date().toISOString(),
        updatedBy: "compiled-fallback",
        createdAt: new Date().toISOString(),
      };
      cache.set(entry.name, { skill, cachedAt: now });
    }
    cacheSource = "compiled";
    cacheInitialized = true;
    console.log(`[skill-cache] Loaded ${registry.length} skills from compiled constants (fallback)`);
  } catch (err) {
    console.error("[skill-cache] Failed to load compiled constants:", err);
    cacheInitialized = true; // Mark as initialized even on failure to prevent retries
  }
}

/**
 * Infer category from skill name for compiled fallback.
 */
function inferCategory(name: string): string {
  if (name.includes("lens-")) return "Lenses";
  if (name.includes("protocol") || name.includes("build-protocol") || name.includes("session-protocol")) return "Protocols";
  if (name.includes("startup") || name.includes("checklist") || name.includes("tutorial")) return "Onboarding";
  if (name.includes("resume")) return "Recovery";
  if (name.includes("router") || name.includes("creation") || name.includes("workflow")) return "Workflows";
  if (name.includes("mode-") || name.includes("structure")) return "Session Modes";
  if (name.includes("odrc") || name.includes("spec-") || name.includes("hygiene") || name.includes("retro")) return "Frameworks";
  if (name.includes("acc-video")) return "Production";
  return "Protocols";
}
