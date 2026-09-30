import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';
import type { JsonObject, JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * What a peer (another Pane Session holding a `scope: 'peer'` client record)
 * may do on this host. Everything not listed here is refused before the
 * command registry runs. See final-plan S3 and docs/SELF_HOSTED_REMOTE_DAEMON.md.
 */
export const PEER_ALLOWED_CHANNELS = [
  'runpane:panels:list',
  'runpane:panels:submit',
  'runpane:workspace:wait',
] as const;

export type PeerAllowedChannel = typeof PEER_ALLOWED_CHANNELS[number];

export const DEFAULT_PEER_SUBMIT_LIMIT = 10;
export const DEFAULT_PEER_SUBMIT_WINDOW_MS = 60_000;
const MAX_PEER_LABEL_LENGTH = 80;

/** The slice of a Session record the peer gate needs. */
export interface PeerSessionInfo {
  id: string;
  name: string;
  archived: boolean;
  internalSessionId: string;
  /** The Session's orchestrator panel: the terminal of its selected agent. */
  orchestratorPanelId: string;
}

export interface PeerDenial {
  ok: false;
  statusCode: number;
  code: string;
  message: string;
}

export interface PeerGrant {
  ok: true;
  args: JsonValue[];
  /** Filters a panels:list result down to what the peer may see. */
  panelFilter?: ReadonlySet<string>;
}

export type PeerDecision = PeerGrant | PeerDenial;

export function isPeerClient(client: Pick<RemoteDaemonClientRecord, 'scope'> | null | undefined): boolean {
  return client?.scope === 'peer';
}

export function isPeerAllowedChannel(channel: string): channel is PeerAllowedChannel {
  return (PEER_ALLOWED_CHANNELS as readonly string[]).includes(channel);
}

export function peerDenial(statusCode: number, code: string, message: string): PeerDenial {
  return { ok: false, statusCode, code, message };
}

/**
 * Decide a peer invoke. Pure: callers supply the peer record and the current
 * Sessions, and apply rate limits and idempotency namespacing themselves.
 */
export function authorizePeerInvoke(
  peer: Pick<RemoteDaemonClientRecord, 'id' | 'label' | 'allowedSessionIds'>,
  channel: string,
  args: readonly JsonValue[],
  sessions: readonly PeerSessionInfo[],
): PeerDecision {
  if (!isPeerAllowedChannel(channel)) {
    return peerDenial(403, 'ERR_PEER_CHANNEL_FORBIDDEN', `Peers may not call ${channel}.`);
  }

  const allowedIds = new Set(peer.allowedSessionIds ?? []);
  const allowedSessions = sessions.filter(session => allowedIds.has(session.id) && !session.archived);
  if (allowedSessions.length === 0) {
    return peerDenial(403, 'ERR_PEER_NOT_ALLOWLISTED', 'This peer is not on any Session allowlist on this host.');
  }

  const request = readRequestObject(args[0]);
  if (!request) {
    return peerDenial(400, 'ERR_PEER_BAD_REQUEST', `${channel} needs a request object.`);
  }

  switch (channel) {
    case 'runpane:panels:submit':
      return authorizeSubmit(peer, request, allowedSessions);
    case 'runpane:panels:list':
      return authorizePanelList(request, allowedSessions);
    case 'runpane:workspace:wait':
      return authorizeWorkspaceWait(peer, request, allowedSessions);
  }
}

function authorizeSubmit(
  peer: Pick<RemoteDaemonClientRecord, 'label'>,
  request: JsonObject,
  allowedSessions: readonly PeerSessionInfo[],
): PeerDecision {
  const panelId = typeof request.panelId === 'string' ? request.panelId.trim() : '';
  if (!allowedSessions.some(session => session.orchestratorPanelId === panelId)) {
    return peerDenial(
      403,
      'ERR_PEER_PANEL_FORBIDDEN',
      'Peers may submit only to the orchestrator panel of a Session that allowlists them.',
    );
  }
  if (typeof request.input !== 'string') {
    return peerDenial(400, 'ERR_PEER_BAD_REQUEST', 'Peer submit needs text input.');
  }

  return {
    ok: true,
    args: [{ ...request, panelId, input: framePeerMessage(peer.label, request.input) }],
  };
}

function authorizePanelList(request: JsonObject, allowedSessions: readonly PeerSessionInfo[]): PeerDecision {
  const selected = selectSession(request, allowedSessions);
  if (!selected.ok) return selected;
  const { session } = selected;
  return {
    ok: true,
    args: [{ paneId: session.internalSessionId }],
    panelFilter: new Set([session.orchestratorPanelId]),
  };
}

function authorizeWorkspaceWait(
  peer: Pick<RemoteDaemonClientRecord, 'id'>,
  request: JsonObject,
  allowedSessions: readonly PeerSessionInfo[],
): PeerDecision {
  if (request.paneIds !== undefined || request.excludePaneIds !== undefined || request.repo !== undefined) {
    return peerDenial(403, 'ERR_PEER_SCOPE_FORBIDDEN', 'Peers may wait on a whole allowlisted Session only.');
  }
  const selected = selectSession(request, allowedSessions);
  if (!selected.ok) return selected;

  const next: JsonObject = { ...request, session: selected.session.id };
  delete next.paneId;
  if (typeof request.as === 'string' && request.as.length > 0) {
    // Cursors are durable per name; a peer never shares one with local consumers.
    next.as = `peer.${peer.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}.${request.as}`.slice(0, 128);
  }
  return { ok: true, args: [next] };
}

function selectSession(
  request: JsonObject,
  allowedSessions: readonly PeerSessionInfo[],
): { ok: true; session: PeerSessionInfo } | PeerDenial {
  const selector = typeof request.session === 'string' && request.session.trim()
    ? request.session.trim()
    : typeof request.paneId === 'string' && request.paneId.trim()
      ? request.paneId.trim()
      : undefined;
  if (selector === undefined) {
    if (allowedSessions.length === 1) return { ok: true, session: allowedSessions[0] };
    return peerDenial(400, 'ERR_PEER_SESSION_REQUIRED', 'More than one Session allowlists this peer; name one with session.');
  }
  const session = allowedSessions.find(candidate => (
    candidate.id === selector || candidate.name === selector || candidate.internalSessionId === selector
  ));
  if (!session) {
    return peerDenial(403, 'ERR_PEER_NOT_ALLOWLISTED', 'That Session does not allowlist this peer.');
  }
  return { ok: true, session };
}

/**
 * The receiving agent sees who sent the text. Control characters are removed
 * so a peer's text cannot drive the terminal UI (Escape, Ctrl-C, cursor keys);
 * newlines and tabs stay.
 */
export function framePeerMessage(label: string, input: string): string {
  return `[peer message from ${sanitizePeerLabel(label)}] ${stripControlCharacters(input)}`;
}

export function sanitizePeerLabel(label: string): string {
  const cleaned = stripControlCharacters(label).replace(/[\r\n\t[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'unnamed peer').slice(0, MAX_PEER_LABEL_LENGTH);
}

export function stripControlCharacters(text: string): string {
  // C0 except tab/newline/CR, DEL, and C1. CRs are normalized later by submit.
  let result = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || (code >= 0x7f && code <= 0x9f);
    if (!isControl) result += character;
  }
  return result;
}

function readRequestObject(value: JsonValue | undefined): JsonObject | null {
  if (value === undefined || value === null) return {};
  return typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Sliding-window submit limit per peer record. */
export class PeerRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = DEFAULT_PEER_SUBMIT_LIMIT,
    private readonly windowMs = DEFAULT_PEER_SUBMIT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit and says whether it is within the limit. */
  tryAcquire(peerId: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(peerId) ?? []).filter(at => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(peerId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(peerId, recent);
    return true;
  }
}
