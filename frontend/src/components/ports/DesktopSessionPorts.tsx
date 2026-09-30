import { useMemo } from 'react';
import type { RemotePaneConnectionState } from '../../../../shared/types/remoteDaemon';
import { useSessionPorts } from '../../hooks/useSessionPorts';
import type { SessionPortsTransport } from '../../services/sessionPortsSync';
import { SessionPortsChips } from './SessionPortsChips';

const noop = () => {};

/** Session ports of the daemon this desktop is connected to (local or the active remote host). */
function createDesktopSessionPortsTransport(): SessionPortsTransport {
  const api = window.electronAPI;
  return {
    invoke: (channel, args) => api.invoke(channel, ...args),
    onChanged: listener => api.events.onSessionPortsChanged?.(listener) ?? noop,
    onReconnected: listener => {
      let last: Pick<RemotePaneConnectionState, 'status' | 'activeProfileId'> | null = null;
      const unsubscribeState = api.remoteDaemon.onConnectionStateChanged(state => {
        const reconnected = state.status === 'connected' || state.status === 'local';
        const changed = last === null || last.status !== state.status || last.activeProfileId !== state.activeProfileId;
        last = { status: state.status, activeProfileId: state.activeProfileId };
        if (reconnected && changed) listener();
      });
      const unsubscribeResync = api.events.onRemoteDaemonResyncRequested(listener);
      return () => {
        unsubscribeState();
        unsubscribeResync();
      };
    },
  };
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const result = await window.electronAPI.openExternal(url);
  if (!result.success) throw new Error(result.error ?? `Could not open ${url}`);
}

export function DesktopSessionPorts({ variant = 'row', className }: { variant?: 'row' | 'inline'; className?: string }) {
  const transport = useMemo(createDesktopSessionPortsTransport, []);
  const { snapshot, open, close } = useSessionPorts(transport);
  if (!snapshot) return null;
  return (
    <SessionPortsChips
      snapshot={snapshot}
      onOpenUrl={openInDefaultBrowser}
      onPublish={open}
      onClose={close}
      variant={variant}
      className={className}
    />
  );
}
