import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionPortOpenRequest, SessionPortsSnapshot } from '../../../shared/types/sessionPorts';
import {
  createSessionPortsSync,
  type SessionPortsState,
  type SessionPortsSync,
  type SessionPortsTransport,
} from '../services/sessionPortsSync';

interface SessionPortsController {
  /** The newest list, kept through a failed re-read; null until the first one. */
  snapshot: SessionPortsSnapshot | null;
  state: SessionPortsState;
  open(request: SessionPortOpenRequest): Promise<void>;
  close(target: number | string): Promise<void>;
}

/** Subscribes to one daemon's Session ports for as long as `transport` is stable. */
export function useSessionPorts(transport: SessionPortsTransport | null): SessionPortsController {
  const [state, setState] = useState<SessionPortsState>({ status: 'loading' });
  const [snapshot, setSnapshot] = useState<SessionPortsSnapshot | null>(null);
  const syncRef = useRef<SessionPortsSync | null>(null);

  useEffect(() => {
    setSnapshot(null);
    if (!transport) {
      setState({ status: 'unsupported' });
      return;
    }
    const sync = createSessionPortsSync(transport, next => {
      setState(next);
      if (next.status === 'ready') setSnapshot(next.snapshot);
      if (next.status === 'unsupported') setSnapshot(null);
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [transport]);

  const open = useCallback(async (request: SessionPortOpenRequest) => {
    await syncRef.current?.open(request);
  }, []);
  const close = useCallback(async (target: number | string) => {
    await syncRef.current?.close(target);
  }, []);

  return { snapshot, state, open, close };
}
