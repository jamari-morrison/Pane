import { useMemo } from 'react';
import { SESSION_PORTS_CHANGED_EVENT } from '../../../../shared/types/sessionPorts';
import { SessionPortsChips } from '../../components/ports/SessionPortsChips';
import { useSessionPorts } from '../../hooks/useSessionPorts';
import type { SessionPortsTransport } from '../../services/sessionPortsSync';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

function createRemoteSessionPortsTransport(adapter: RemoteRuntimeAdapter): SessionPortsTransport {
  return {
    invoke: (channel, args) => adapter.invoke<JsonValue>(channel, args),
    onChanged: listener => adapter.onEvent(event => {
      if (event.channel === SESSION_PORTS_CHANGED_EVENT) listener(decodeOptionalBoundary(event.args[0], boundary.json));
    }),
    onReconnected: listener => {
      let wasConnected = adapter.getStatus().status === 'connected';
      return adapter.onStatus(state => {
        const connected = state.status === 'connected';
        if (connected && !wasConnected) listener();
        wasConnected = connected;
      });
    },
  };
}

// A new tab, never this one: the PWA must keep its connection.
function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Session ports of the connected host, for the web client (Remote Pane PWA). */
export function RemoteSessionPorts({ adapter }: { adapter: RemoteRuntimeAdapter | null }) {
  const transport = useMemo(() => (adapter ? createRemoteSessionPortsTransport(adapter) : null), [adapter]);
  const { snapshot, open, close } = useSessionPorts(transport);
  if (!snapshot) return null;
  return <SessionPortsChips snapshot={snapshot} onOpenUrl={openInNewTab} onPublish={open} onClose={close} />;
}
