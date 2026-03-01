// ═══════════════════════════════════════════════════════════════
// Surface Registry — Firebase-backed surface configuration
// ═══════════════════════════════════════════════════════════════
// Replaces hardcoded SURFACES enum with a queryable, extensible
// registry. Phase 1: data model, cache, CRUD. Wiring into
// bootstrap, signals, and context health happens incrementally.
// ═══════════════════════════════════════════════════════════════

import { getSystemRef } from "./firebase.js";

// ─── Types ───

export interface SurfaceCapabilities {
  fileSystem: boolean;
  terminal: boolean;
  browser: boolean;
  messaging: boolean;
  skillRouting: boolean;
}

export interface SurfaceContextWindow {
  ceiling: number;
  toolBudget: number;
}

export interface SurfaceConfig {
  id: string;
  displayName: string;
  engine: string;
  surfaceType: string;
  status: "production" | "beta" | "planned" | "unsupported";
  launchUrl: string | null;
  mcpConnection: "native" | "extension" | "none";
  capabilities: SurfaceCapabilities;
  contextWindow: SurfaceContextWindow;
  bootstrapSkill: string | null;
  skillGrade: "full" | "basic" | "none";
  createdAt: string;
  updatedAt: string;
}

// ─── In-memory cache ───

let cache: Map<string, SurfaceConfig> | null = null;
let cacheLoading: Promise<void> | null = null;

/**
 * Load the full surface registry from Firebase into memory.
 * Safe to call multiple times — deduplicates concurrent loads.
 */
async function loadSurfaceRegistry(): Promise<void> {
  const snap = await getSystemRef().child("surfaceRegistry").once("value");
  const data = snap.val() as Record<string, SurfaceConfig> | null;
  cache = new Map();
  if (data) {
    for (const [id, config] of Object.entries(data)) {
      cache.set(id, { ...config, id });
    }
  }
}

/**
 * Ensure cache is loaded. Lazy-initializes on first call.
 * Deduplicates concurrent callers via shared promise.
 */
async function ensureCache(): Promise<Map<string, SurfaceConfig>> {
  if (cache) return cache;
  if (!cacheLoading) {
    cacheLoading = loadSurfaceRegistry().finally(() => {
      cacheLoading = null;
    });
  }
  await cacheLoading;
  return cache!;
}

// ─── Public API ───

/**
 * Get config for a single surface. Returns null if not registered.
 */
export async function getSurfaceConfig(surfaceId: string): Promise<SurfaceConfig | null> {
  const registry = await ensureCache();
  return registry.get(surfaceId) || null;
}

/**
 * Get all registered surfaces as a map.
 */
export async function getAllSurfaces(): Promise<Map<string, SurfaceConfig>> {
  return ensureCache();
}

/**
 * Check if a surface ID exists in the registry (cache only, no Firebase call if loaded).
 */
export function isInRegistryCache(surfaceId: string): boolean {
  if (!cache) return false;
  return cache.has(surfaceId);
}

/**
 * Write a surface config to Firebase and update cache.
 */
export async function writeSurfaceConfig(config: SurfaceConfig): Promise<void> {
  await getSystemRef().child(`surfaceRegistry/${config.id}`).set(config);
  const registry = await ensureCache();
  registry.set(config.id, config);
}

/**
 * Update specific fields on a surface config.
 */
export async function updateSurfaceConfig(
  surfaceId: string,
  updates: Partial<Omit<SurfaceConfig, "id" | "createdAt">>
): Promise<SurfaceConfig | null> {
  const registry = await ensureCache();
  const existing = registry.get(surfaceId);
  if (!existing) return null;

  const merged: SurfaceConfig = {
    ...existing,
    ...updates,
    // Deep-merge capabilities and contextWindow
    capabilities: {
      ...existing.capabilities,
      ...(updates.capabilities || {}),
    },
    contextWindow: {
      ...existing.contextWindow,
      ...(updates.contextWindow || {}),
    },
    id: surfaceId, // never overwrite id
    createdAt: existing.createdAt, // never overwrite createdAt
    updatedAt: new Date().toISOString(),
  };

  await getSystemRef().child(`surfaceRegistry/${surfaceId}`).set(merged);
  registry.set(surfaceId, merged);
  return merged;
}

/**
 * Delete a surface from the registry (test cleanup only).
 */
export async function deleteSurfaceConfig(surfaceId: string): Promise<boolean> {
  const registry = await ensureCache();
  if (!registry.has(surfaceId)) return false;
  await getSystemRef().child(`surfaceRegistry/${surfaceId}`).remove();
  registry.delete(surfaceId);
  return true;
}

/**
 * Force cache reload from Firebase.
 */
export async function invalidateCache(): Promise<void> {
  cache = null;
  cacheLoading = null;
  await ensureCache();
}
