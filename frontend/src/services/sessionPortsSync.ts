import {
  SESSION_PORTS_CLOSE_CHANNEL,
  SESSION_PORTS_LIST_CHANNEL,
  SESSION_PORTS_OPEN_CHANNEL,
  decodeSessionPortsSnapshot,
  type SessionPortOpenRequest,
  type SessionPortsSnapshot,
} from '../../../shared/types/sessionPorts';
import type { JsonObject, JsonValue } from '../../../shared/validation/boundaryDecoder';

/**
 * What the Ports row needs from a host: the desktop (preload IPC to the
 * connected daemon) and the web client (HTTP+SSE) each provide one.
 */
export interface SessionPortsTransport {
  invoke(channel: string, args: JsonValue[]): Promise<JsonValue | undefined>;
  /** `runpane:ports:changed` from the daemon; the payload may carry the new list. */
  onChanged(listener: (payload: JsonValue | undefined) => void): () => void;
  /** The connection to the daemon came back (or switched hosts). */
  onReconnected(listener: () => void): () => void;
}

export type SessionPortsState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: SessionPortsSnapshot }
  /** The daemon has no ports channels (older build or no cloud Session): hide the row. */
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export interface SessionPortsSync {
  refresh(): Promise<void>;
  open(request: SessionPortOpenRequest): Promise<void>;
  close(target: number | string): Promise<void>;
  dispose(): void;
}

interface SessionPortsSyncOptions {
  /** Backstop poll while mounted; events and reconnects do the real work. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 30_000;
const UNSUPPORTED_ERROR = /No Pane daemon command registered|not daemon-owned|unknown (channel|command)/i;

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The daemon refused to replace an existing tailnet serve entry without confirmation. */
export function isSessionPortConflict(cause: unknown): boolean {
  return /ERR_PORTS_CONFLICT|--yes|already (served|in use|taken)|conflict/i.test(errorMessage(cause));
}

function isFailedIpcResponse<Value>(value: Value): string | null {
  if (value instanceof Object && 'success' in value && value.success === false) {
    return 'error' in value && value.error ? String(value.error) : 'Request failed';
  }
  return null;
}

async function invokeChecked(transport: SessionPortsTransport, channel: string, args: JsonValue[]): Promise<JsonValue | undefined> {
  const result = await transport.invoke(channel, args);
  const failure = isFailedIpcResponse(result);
  if (failure !== null) throw new Error(failure);
  return result;
}

/**
 * Keeps one daemon's Session ports current: a baseline read, then a re-read on
 * every change event, reconnect and backstop tick. Only the newest read may
 * publish, so a slow response never overwrites a newer change.
 */
export function createSessionPortsSync(
  transport: SessionPortsTransport,
  onState: (state: SessionPortsState) => void,
  options: SessionPortsSyncOptions = {},
): SessionPortsSync {
  let disposed = false;
  let generation = 0;
  let unsupported = false;

  const publish = (state: SessionPortsState) => {
    if (!disposed) onState(state);
  };

  const refresh = async () => {
    const current = ++generation;
    try {
      const result = await invokeChecked(transport, SESSION_PORTS_LIST_CHANNEL, []);
      if (disposed || current !== generation) return;
      const snapshot = decodeSessionPortsSnapshot(result);
      unsupported = false;
      publish(snapshot ? { status: 'ready', snapshot } : { status: 'error', message: 'Unexpected ports list from the daemon' });
    } catch (error) {
      if (disposed || current !== generation) return;
      unsupported = UNSUPPORTED_ERROR.test(errorMessage(error));
      publish(unsupported ? { status: 'unsupported' } : { status: 'error', message: errorMessage(error) });
    }
  };

  const unsubscribeChanged = transport.onChanged(payload => {
    const snapshot = decodeSessionPortsSnapshot(payload);
    if (snapshot) {
      // A pushed list is the newest truth: supersede any read in flight.
      generation += 1;
      unsupported = false;
      publish({ status: 'ready', snapshot });
      return;
    }
    void refresh();
  });
  const unsubscribeReconnected = transport.onReconnected(() => { void refresh(); });
  const timer = setInterval(() => {
    if (!unsupported) void refresh();
  }, options.pollMs ?? DEFAULT_POLL_MS);

  publish({ status: 'loading' });
  void refresh();

  return {
    refresh,
    async open(request) {
      const args: JsonObject = { port: request.port };
      if (request.name !== undefined) args.name = request.name;
      if (request.httpsPort !== undefined) args.httpsPort = request.httpsPort;
      if (request.yes === true) args.yes = true;
      await invokeChecked(transport, SESSION_PORTS_OPEN_CHANNEL, [args]);
      await refresh();
    },
    async close(target) {
      await invokeChecked(transport, SESSION_PORTS_CLOSE_CHANNEL, [{ target }]);
      await refresh();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      unsubscribeChanged();
      unsubscribeReconnected();
    },
  };
}
