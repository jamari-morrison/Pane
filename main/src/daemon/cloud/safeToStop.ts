import type { AgentState } from '../../../../shared/types/agentStatus';
import type {
  CloudDurableFlushResult,
  CloudSafeToStopBlocker,
  CloudSafeToStopFlushMode,
  CloudSafeToStopRequest,
  CloudSafeToStopResult,
} from '../../../../shared/types/cloudDaemon';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

/** A terminal that printed within this window is not idle. */
export const DEFAULT_RECENT_OUTPUT_MS = 2 * 60_000;
/** A user client that invoked within this window is still using the Session (final-plan P7). */
export const DEFAULT_CLIENT_WINDOW_MS = 15 * 60_000;
/** A watch loop re-issues its wait right after one returns; the gap between calls is still watching. */
export const WATCHER_GAP_GRACE_MS = 30_000;

export interface SafeToStopTerminal {
  panelId: string;
  paneId?: string;
  /** Detected agent state; undefined for plain shells. */
  agentState?: AgentState;
  lastOutputAt?: number;
}

export interface SafeToStopLock {
  name: string;
  ownerLabel?: string;
  paneId?: string;
  panelId?: string;
}

export interface SafeToStopWatcher {
  channel: string;
  inFlight: number;
  lastFinishedAt?: number;
}

export interface SafeToStopPendingPr {
  paneId: string;
  prNumber: number;
}

export interface SafeToStopUserClient {
  kind: 'events-stream' | 'recent-invoke';
  clientId: string | null;
  label: string | null;
  at: number;
}

/** Live daemon state the check reads. Every source excludes peers already. */
export interface SafeToStopSources {
  terminals(): SafeToStopTerminal[];
  locks(): SafeToStopLock[];
  watchers(): SafeToStopWatcher[];
  pendingPrChecks(): Promise<SafeToStopPendingPr[]>;
  userClients(since: number): SafeToStopUserClient[];
}

export interface SafeToStopDependencies {
  sources: SafeToStopSources;
  flush(): Promise<CloudDurableFlushResult>;
  version: string;
  now?: () => number;
}

const safeToStopRequestSchema = boundary.object({
  flush: boundary.optional(boundary.enumeration('if-safe', 'always', 'never')),
  recentOutputMs: boundary.optional(boundary.number),
  clientWindowMs: boundary.optional(boundary.number),
});

export function parseSafeToStopRequest(value: unknown): Required<CloudSafeToStopRequest> {
  const decoded = decodeBoundary(value ?? {}, safeToStopRequestSchema);
  return {
    flush: decoded.flush ?? 'if-safe',
    recentOutputMs: nonNegative(decoded.recentOutputMs, DEFAULT_RECENT_OUTPUT_MS, 'recentOutputMs'),
    clientWindowMs: nonNegative(decoded.clientWindowMs, DEFAULT_CLIENT_WINDOW_MS, 'clientWindowMs'),
  };
}

/** Every reason the daemon should not be stopped right now; empty means safe. */
export async function collectSafeToStopBlockers(
  sources: SafeToStopSources,
  request: Required<CloudSafeToStopRequest>,
  now: number,
): Promise<CloudSafeToStopBlocker[]> {
  const blockers: CloudSafeToStopBlocker[] = [];

  for (const terminal of sources.terminals()) {
    const where = { paneId: terminal.paneId, panelId: terminal.panelId };
    if (terminal.agentState === 'working') {
      blockers.push({ condition: 'agent-working', message: `Agent in panel ${terminal.panelId} is working`, ...where });
    }
    if (terminal.lastOutputAt !== undefined && now - terminal.lastOutputAt < request.recentOutputMs) {
      const seconds = Math.round((now - terminal.lastOutputAt) / 1000);
      blockers.push({
        condition: 'recent-terminal-output',
        message: `Panel ${terminal.panelId} printed output ${seconds}s ago`,
        ...where,
      });
    }
  }

  for (const lock of sources.locks()) {
    blockers.push({
      condition: 'lock-held',
      message: `Lock "${lock.name}" is held${lock.ownerLabel ? ` by ${lock.ownerLabel}` : ''}`,
      paneId: lock.paneId,
      panelId: lock.panelId,
    });
  }

  for (const watcher of sources.watchers()) {
    if (watcher.inFlight > 0) {
      blockers.push({ condition: 'watcher-active', message: `${watcher.inFlight} ${watcher.channel} call(s) waiting` });
    } else if (watcher.lastFinishedAt !== undefined && now - watcher.lastFinishedAt < WATCHER_GAP_GRACE_MS) {
      blockers.push({ condition: 'watcher-active', message: `A ${watcher.channel} call returned moments ago (watch loop)` });
    }
  }

  for (const pr of await sources.pendingPrChecks()) {
    blockers.push({ condition: 'pr-checks-pending', message: `PR #${pr.prNumber} has checks still running`, paneId: pr.paneId });
  }

  for (const client of sources.userClients(now - request.clientWindowMs)) {
    const who = client.label ?? client.clientId ?? 'an unpaired client';
    blockers.push({
      condition: 'user-client-attached',
      message: client.kind === 'events-stream'
        ? `${who} has an open event stream`
        : `${who} used the daemon ${Math.round((now - client.at) / 1000)}s ago`,
    });
  }

  return blockers.map(stripUndefined);
}

/**
 * Checks every stop condition and, per the flush mode, makes the daemon's state durable
 * before answering: boat's stop is a power-off after a disk snapshot, so anything still
 * in the page cache or the SQLite WAL at that point is lost (M0).
 */
export async function runSafeToStop(
  dependencies: SafeToStopDependencies,
  rawRequest: unknown,
): Promise<CloudSafeToStopResult> {
  const now = dependencies.now ?? Date.now;
  const request = parseSafeToStopRequest(rawRequest);
  const blockers = await collectSafeToStopBlockers(dependencies.sources, request, now());
  const safe = blockers.length === 0;
  const flush = shouldFlush(request.flush, safe) ? await dependencies.flush() : null;
  return {
    ok: true,
    safe,
    checkedAt: new Date(now()).toISOString(),
    version: dependencies.version,
    blockers,
    flush,
  };
}

function shouldFlush(mode: CloudSafeToStopFlushMode, safe: boolean): boolean {
  return mode === 'always' || (mode === 'if-safe' && safe);
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function stripUndefined(blocker: CloudSafeToStopBlocker): CloudSafeToStopBlocker {
  const result: CloudSafeToStopBlocker = { condition: blocker.condition, message: blocker.message };
  if (blocker.paneId !== undefined) result.paneId = blocker.paneId;
  if (blocker.panelId !== undefined) result.panelId = blocker.panelId;
  return result;
}
