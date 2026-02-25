import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import {
  getDb,
  getOAuthClientRef,
  getOAuthClientsRef,
  getTokenIndexRef,
  getTokenIndexEntryRef,
  getAuditLogRef,
  getUserTokensRef,
  getUserTokenRef,
} from "../firebase.js";

// ─── Types ────────────────────────────────────────────────────

// Stored in Firebase (no plaintext secrets)
export interface StoredOAuthClient {
  client_id: string;
  client_secret_hash: string; // SHA-256
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: number;
  last_used_at: number;
}

// Returned during registration (plaintext secret, returned once, never stored)
export interface OAuthClientRegistration {
  client_id: string;
  client_secret: string; // Plaintext — returned once
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

// Auth codes — ephemeral, in-memory only (10-minute TTL, one-time use)
export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  firebase_uid: string;
  expires_at: number;
}

// System-wide token index entry (for O(1) lookup by hash)
export interface TokenIndexEntry {
  uid: string;
  clientId: string;
  expiresAt: number;
}

// Per-user token record (for revocation and audit)
export interface StoredAccessToken {
  tokenHash: string;
  clientId: string;
  expiresAt: number;
  createdAt: string;
  revokedAt: string | null;
}

// Audit log
export type AuditEvent =
  | "client_registered"
  | "auth_code_created"
  | "token_issued"
  | "token_validated"
  | "token_validation_failed"
  | "token_expired"
  | "token_revoked"
  | "tokens_revoked_all"
  | "client_secret_mismatch"
  | "api_key_validated"
  | "api_key_validation_failed";

export interface AuditLogEntry {
  event: AuditEvent;
  uid: string | null;
  clientId: string | null;
  tokenHash: string | null; // First 16 chars only
  ip: string | null;
  success: boolean;
  detail: string | null;
  timestamp: string;
}

// ─── Cache Layer ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry<{ uid: string; clientId: string }>>();
const TOKEN_CACHE_TTL = 60_000; // 60 seconds
const TOKEN_CACHE_MAX = 500;

const clientCache = new Map<string, CacheEntry<StoredOAuthClient>>();
const CLIENT_CACHE_TTL = 300_000; // 5 minutes
const CLIENT_CACHE_MAX = 100;

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttl: number,
  maxSize: number
): void {
  if (cache.size >= maxSize) {
    // Evict oldest entry (first inserted — Map preserves insertion order)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

// ─── In-Memory Auth Codes (ephemeral) ─────────────────────────

const authCodes = new Map<string, AuthCode>();

function cleanupAuthCodes(): void {
  const now = Date.now();
  for (const [key, ac] of authCodes) {
    if (ac.expires_at < now) authCodes.delete(key);
  }
}

// ─── Hashing ──────────────────────────────────────────────────

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Truncate hash for audit logs (first 16 chars — enough for correlation, not reconstruction)
function auditHash(fullHash: string): string {
  return fullHash.slice(0, 16);
}

// ─── Audit Logging (fire-and-forget) ──────────────────────────

let auditWriteCount = 0;
const AUDIT_CLEANUP_THRESHOLD = 1000;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function writeAuditLog(entry: Omit<AuditLogEntry, "timestamp">): void {
  const logEntry: AuditLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget — do not block request processing
  getAuditLogRef()
    .push(logEntry)
    .catch((err: Error) => console.error("Audit log write failed:", err));

  // Lazy cleanup: after N writes, sweep old entries
  auditWriteCount++;
  if (auditWriteCount >= AUDIT_CLEANUP_THRESHOLD) {
    auditWriteCount = 0;
    cleanupAuditLog().catch((err: Error) =>
      console.error("Audit log cleanup failed:", err)
    );
  }
}

async function cleanupAuditLog(): Promise<void> {
  const cutoff = new Date(Date.now() - AUDIT_RETENTION_MS).toISOString();
  const snapshot = await getAuditLogRef()
    .orderByChild("timestamp")
    .endAt(cutoff)
    .limitToFirst(100)
    .once("value");

  const data = snapshot.val();
  if (!data) return;

  const updates: Record<string, null> = {};
  for (const key of Object.keys(data)) {
    updates[key] = null;
  }
  await getAuditLogRef().update(updates);
}

// ─── Client Registration (Firebase-backed) ────────────────────

const MAX_CLIENTS = 100;

export async function registerClient(registration: {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}): Promise<OAuthClientRegistration> {
  cleanupAuthCodes();

  const clientId = uuidv4();
  const clientSecret = uuidv4();
  const clientSecretHash = hashToken(clientSecret);

  const stored: StoredOAuthClient = {
    client_id: clientId,
    client_secret_hash: clientSecretHash,
    client_name: registration.client_name || "Unknown Client",
    redirect_uris: registration.redirect_uris || [],
    grant_types: registration.grant_types || ["authorization_code"],
    response_types: registration.response_types || ["code"],
    token_endpoint_auth_method:
      registration.token_endpoint_auth_method || "client_secret_post",
    created_at: Date.now(),
    last_used_at: Date.now(),
  };

  await getOAuthClientRef(clientId).set(stored);

  // Cache the client
  cacheSet(clientCache, clientId, stored, CLIENT_CACHE_TTL, CLIENT_CACHE_MAX);

  writeAuditLog({
    event: "client_registered",
    uid: null,
    clientId,
    tokenHash: null,
    ip: null,
    success: true,
    detail: stored.client_name,
  });

  // Evict oldest clients if over limit (fire-and-forget)
  cleanupOldClients().catch((err: Error) =>
    console.error("Client cleanup failed:", err)
  );

  return {
    client_id: clientId,
    client_secret: clientSecret, // Plaintext — returned once, never stored
    client_name: stored.client_name,
    redirect_uris: stored.redirect_uris,
    grant_types: stored.grant_types,
    response_types: stored.response_types,
    token_endpoint_auth_method: stored.token_endpoint_auth_method,
  };
}

export async function getClient(
  clientId: string
): Promise<StoredOAuthClient | undefined> {
  // Check cache first
  const cached = cacheGet(clientCache, clientId);
  if (cached) return cached;

  // Firebase fallback
  try {
    const snapshot = await getOAuthClientRef(clientId).once("value");
    const data = snapshot.val();
    if (!data) return undefined;

    const client = data as StoredOAuthClient;
    cacheSet(clientCache, clientId, client, CLIENT_CACHE_TTL, CLIENT_CACHE_MAX);
    return client;
  } catch (err) {
    console.error("Client lookup error:", err);
    return undefined;
  }
}

export async function validateClientSecret(
  clientId: string,
  clientSecret: string,
  ip?: string | null
): Promise<boolean> {
  const client = await getClient(clientId);
  if (!client) return false;

  const incomingHash = hashToken(clientSecret);
  if (incomingHash === client.client_secret_hash) {
    return true;
  }

  writeAuditLog({
    event: "client_secret_mismatch",
    uid: null,
    clientId,
    tokenHash: null,
    ip: ip || null,
    success: false,
    detail: null,
  });
  return false;
}

async function cleanupOldClients(): Promise<void> {
  const snapshot = await getOAuthClientsRef()
    .orderByChild("created_at")
    .once("value");
  const data = snapshot.val();
  if (!data) return;

  const entries = Object.entries(data as Record<string, StoredOAuthClient>);
  if (entries.length <= MAX_CLIENTS) return;

  // Sort oldest first, remove excess
  entries.sort((a, b) => a[1].created_at - b[1].created_at);
  const toRemove = entries.slice(0, entries.length - MAX_CLIENTS);

  const updates: Record<string, null> = {};
  for (const [key] of toRemove) {
    updates[key] = null;
    clientCache.delete(key);
  }
  await getOAuthClientsRef().update(updates);
}

// ─── Auth Codes (in-memory, ephemeral) ────────────────────────

export function createAuthCode(
  clientId: string,
  redirectUri: string,
  firebaseUid: string,
  codeChallenge?: string,
  codeChallengeMethod?: string
): string {
  const code = uuidv4();
  authCodes.set(code, {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    firebase_uid: firebaseUid,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  writeAuditLog({
    event: "auth_code_created",
    uid: firebaseUid,
    clientId,
    tokenHash: null,
    ip: null,
    success: true,
    detail: null,
  });

  return code;
}

export function consumeAuthCode(code: string): AuthCode | undefined {
  const authCode = authCodes.get(code);
  if (!authCode) return undefined;
  if (authCode.expires_at < Date.now()) {
    authCodes.delete(code);
    return undefined;
  }
  authCodes.delete(code); // One-time use
  return authCode;
}

// ─── Access Tokens (Firebase-backed) ──────────────────────────

export async function createAccessToken(
  clientId: string,
  firebaseUid: string,
  ip?: string | null
): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  const plaintextToken = uuidv4();
  const tokenHash = hashToken(plaintextToken);
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const now = new Date().toISOString();

  // Atomic multi-path write: system index + per-user record
  const indexEntry: TokenIndexEntry = {
    uid: firebaseUid,
    clientId,
    expiresAt,
  };

  const userToken: StoredAccessToken = {
    tokenHash,
    clientId,
    expiresAt,
    createdAt: now,
    revokedAt: null,
  };

  const db = getDb();
  await db.ref().update({
    [`command-center/system/oauth/tokenIndex/${tokenHash}`]: indexEntry,
    [`command-center/${firebaseUid}/oauth/tokens/${tokenHash}`]: userToken,
  });

  // Update client last_used_at (fire-and-forget)
  getOAuthClientRef(clientId)
    .child("last_used_at")
    .set(Date.now())
    .catch(() => {});

  // Cache the token for fast validation
  cacheSet(
    tokenCache,
    tokenHash,
    { uid: firebaseUid, clientId },
    TOKEN_CACHE_TTL,
    TOKEN_CACHE_MAX
  );

  writeAuditLog({
    event: "token_issued",
    uid: firebaseUid,
    clientId,
    tokenHash: auditHash(tokenHash),
    ip: ip || null,
    success: true,
    detail: null,
  });

  return {
    access_token: plaintextToken, // Plaintext — returned once, never stored
    token_type: "Bearer",
    expires_in: 86400,
  };
}

export async function validateAccessToken(
  token: string,
  ip?: string | null
): Promise<{ uid: string; clientId: string } | undefined> {
  const tokenHash = hashToken(token);

  // Check cache first
  const cached = cacheGet(tokenCache, tokenHash);
  if (cached) return cached;

  // Firebase fallback
  try {
    const snapshot = await getTokenIndexEntryRef(tokenHash).once("value");
    const data = snapshot.val() as TokenIndexEntry | null;

    if (!data) {
      writeAuditLog({
        event: "token_validation_failed",
        uid: null,
        clientId: null,
        tokenHash: auditHash(tokenHash),
        ip: ip || null,
        success: false,
        detail: "not_found",
      });
      return undefined;
    }

    // Check expiry
    if (data.expiresAt < Date.now()) {
      // Lazy-delete expired token
      lazyDeleteToken(tokenHash, data.uid).catch(() => {});

      writeAuditLog({
        event: "token_expired",
        uid: data.uid,
        clientId: data.clientId,
        tokenHash: auditHash(tokenHash),
        ip: ip || null,
        success: false,
        detail: null,
      });
      return undefined;
    }

    const result = { uid: data.uid, clientId: data.clientId };

    // Populate cache
    cacheSet(tokenCache, tokenHash, result, TOKEN_CACHE_TTL, TOKEN_CACHE_MAX);

    return result;
  } catch (err) {
    console.error("Token validation error:", err);
    return undefined;
  }
}

// ─── Token Revocation ─────────────────────────────────────────

export async function revokeToken(
  tokenHash: string,
  uid: string
): Promise<void> {
  const db = getDb();

  // Delete from system index, mark revoked in per-user record
  await db.ref().update({
    [`command-center/system/oauth/tokenIndex/${tokenHash}`]: null,
    [`command-center/${uid}/oauth/tokens/${tokenHash}/revokedAt`]:
      new Date().toISOString(),
  });

  // Evict from cache
  tokenCache.delete(tokenHash);

  writeAuditLog({
    event: "token_revoked",
    uid,
    clientId: null,
    tokenHash: auditHash(tokenHash),
    ip: null,
    success: true,
    detail: null,
  });
}

export async function revokeAllUserTokens(uid: string): Promise<number> {
  const snapshot = await getUserTokensRef(uid).once("value");
  const data = snapshot.val() as Record<string, StoredAccessToken> | null;
  if (!data) return 0;

  const now = new Date().toISOString();
  const updates: Record<string, any> = {};
  let count = 0;

  for (const [hash, token] of Object.entries(data)) {
    if (token.revokedAt) continue; // Already revoked
    // Delete from system index
    updates[`command-center/system/oauth/tokenIndex/${hash}`] = null;
    // Mark revoked in per-user record
    updates[`command-center/${uid}/oauth/tokens/${hash}/revokedAt`] = now;
    // Evict from cache
    tokenCache.delete(hash);
    count++;
  }

  if (count > 0) {
    await getDb().ref().update(updates);
  }

  writeAuditLog({
    event: "tokens_revoked_all",
    uid,
    clientId: null,
    tokenHash: null,
    ip: null,
    success: true,
    detail: `${count} tokens revoked`,
  });

  return count;
}

// ─── Token Cleanup ────────────────────────────────────────────

let lastCleanupTime = 0;
const CLEANUP_INTERVAL = 60_000; // At most once per 60 seconds

async function lazyDeleteToken(
  tokenHash: string,
  uid: string
): Promise<void> {
  const db = getDb();
  await db.ref().update({
    [`command-center/system/oauth/tokenIndex/${tokenHash}`]: null,
    [`command-center/${uid}/oauth/tokens/${tokenHash}`]: null,
  });
}

export async function cleanupExpiredTokens(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupTime < CLEANUP_INTERVAL) return;
  lastCleanupTime = now;

  try {
    const snapshot = await getTokenIndexRef()
      .orderByChild("expiresAt")
      .endAt(now)
      .limitToFirst(50)
      .once("value");

    const data = snapshot.val() as Record<string, TokenIndexEntry> | null;
    if (!data) return;

    const updates: Record<string, null> = {};
    for (const [hash, entry] of Object.entries(data)) {
      updates[`command-center/system/oauth/tokenIndex/${hash}`] = null;
      updates[`command-center/${entry.uid}/oauth/tokens/${hash}`] = null;
      tokenCache.delete(hash);
    }

    await getDb().ref().update(updates);
  } catch (err) {
    console.error("Token cleanup error:", err);
  }
}

// Trigger periodic cleanup (called from high-traffic paths)
export function triggerCleanup(): void {
  cleanupAuthCodes();
  // Fire-and-forget async cleanup
  cleanupExpiredTokens().catch((err: Error) =>
    console.error("Cleanup error:", err)
  );
}

// ─── API Key Validation (unchanged logic, added audit) ────────

export async function validateApiKey(
  token: string,
  ip?: string | null
): Promise<{ uid: string } | null> {
  const match = token.match(/^cc_([^_]+)_(.+)$/);
  if (!match) return null;

  const uid = match[1];
  if (!uid || uid.length < 10) return null;

  try {
    const db = getDb();
    const snapshot = await db
      .ref(`command-center/${uid}/apiKeyHash`)
      .once("value");
    const storedHash = snapshot.val();

    if (!storedHash) {
      writeAuditLog({
        event: "api_key_validation_failed",
        uid,
        clientId: null,
        tokenHash: null,
        ip: ip || null,
        success: false,
        detail: "no_hash_stored",
      });
      return null;
    }

    const incomingHash = hashToken(token);
    if (incomingHash !== storedHash) {
      writeAuditLog({
        event: "api_key_validation_failed",
        uid,
        clientId: null,
        tokenHash: null,
        ip: ip || null,
        success: false,
        detail: "hash_mismatch",
      });
      return null;
    }

    writeAuditLog({
      event: "api_key_validated",
      uid,
      clientId: null,
      tokenHash: null,
      ip: ip || null,
      success: true,
      detail: null,
    });

    return { uid };
  } catch (err) {
    console.error("API key validation error:", err);
    return null;
  }
}
