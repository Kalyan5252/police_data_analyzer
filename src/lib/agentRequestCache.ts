import { InvestigationTurnResult } from '@/lib/agentOrchestrator';

const DEFAULT_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 200;

type CacheEntry = {
  value: InvestigationTurnResult;
  expiresAt: number;
};

const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<InvestigationTurnResult>>();

function pruneExpired(now: number) {
  for (const [key, entry] of responseCache.entries()) {
    if (entry.expiresAt <= now) {
      responseCache.delete(key);
    }
  }
}

function ensureBounded() {
  if (responseCache.size <= MAX_CACHE_ENTRIES) return;
  const over = responseCache.size - MAX_CACHE_ENTRIES;
  let removed = 0;
  for (const key of responseCache.keys()) {
    responseCache.delete(key);
    removed += 1;
    if (removed >= over) break;
  }
}

export function buildAgentCacheKey(parts: {
  caseId: string;
  includeGraph: boolean;
  message: string;
  contextFingerprint: string;
}): string {
  return [
    parts.caseId || 'no-case',
    parts.includeGraph ? 'graph:1' : 'graph:0',
    `q:${parts.message}`,
    `ctx:${parts.contextFingerprint}`,
  ].join('|');
}

export function getCachedAgentResult(
  key: string,
  now = Date.now(),
): InvestigationTurnResult | null {
  pruneExpired(now);
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

export function setCachedAgentResult(
  key: string,
  value: InvestigationTurnResult,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): void {
  const expiresAt = now + Math.max(1_000, ttlMs);
  responseCache.set(key, { value, expiresAt });
  ensureBounded();
}

export async function getOrCreateAgentResult(
  key: string,
  create: () => Promise<InvestigationTurnResult>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ result: InvestigationTurnResult; fromCache: boolean }> {
  const cached = getCachedAgentResult(key);
  if (cached) return { result: cached, fromCache: true };

  const pending = inFlight.get(key);
  if (pending) {
    const joined = await pending;
    return { result: joined, fromCache: true };
  }

  const promise = create();
  inFlight.set(key, promise);
  try {
    const result = await promise;
    setCachedAgentResult(key, result, ttlMs);
    return { result, fromCache: false };
  } finally {
    inFlight.delete(key);
  }
}
