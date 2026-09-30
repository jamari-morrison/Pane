import { describe, expect, it, vi } from 'vitest';
import type { RemoteDaemonClientRecord, RemoteDaemonConnectedClient } from '../../../../shared/types/remoteDaemon';
import { createDefaultRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { AgentState } from '../../../../shared/types/agentStatus';
import { PaneCommandRegistry } from '../commandRegistry';
import { UserClientActivityTracker } from './clientActivity';
import { registerCloudDaemonHandlers, type CloudDaemonDependencies } from './cloudDaemon';
import { CloudDaemonHealthState } from './readiness';

const NOW = 50_000_000;

function panel(id: string, paneId: string, customState: Record<string, unknown>): ToolPanel {
  return {
    id,
    sessionId: paneId,
    type: 'terminal',
    title: id,
    state: { isActive: false, customState },
    metadata: { createdAt: '2026-09-29T00:00:00.000Z', lastActiveAt: '2026-09-29T00:00:00.000Z', position: 0 },
  };
}

function client(id: string, scope?: 'peer'): RemoteDaemonClientRecord {
  const record: RemoteDaemonClientRecord = { id, label: id, createdAt: '2026-09-29T00:00:00.000Z', tokenHash: `hash-${id}` };
  return scope ? Object.assign(record, { scope }) : record;
}

function setup(overrides: Partial<CloudDaemonDependencies> = {}) {
  const commandRegistry = new PaneCommandRegistry(() => NOW);
  const health = new CloudDaemonHealthState(() => NOW);
  health.setVersion('2.4.141', null);
  health.markDaemonReady();
  const clientActivity = new UserClientActivityTracker();
  const agentStates = new Map<string, AgentState>([['claude-1', 'idle']]);
  const running = new Set(['claude-1', 'shell-1']);
  const panels = [
    panel('claude-1', 'pane-1', { isCliPanel: true, agentType: 'claude' }),
    panel('codex-1', 'pane-1', { initialCommand: 'codex --yolo' }),
    panel('shell-1', 'pane-1', { initialCommand: 'bash' }),
  ];
  const config = createDefaultRemoteDaemonConfig();
  config.host.clients = [client('desktop'), client('peer-a', 'peer')];
  const connected: RemoteDaemonConnectedClient[] = [];
  const checkpointWal = vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 }));
  const dependencies: CloudDaemonDependencies = {
    commandRegistry,
    health,
    clientActivity,
    terminals: {
      getAllPanelIds: () => [...running],
      isTerminalInitialized: panelId => running.has(panelId),
      getAgentStatus: panelId => agentStates.get(panelId),
      getLastOutputAt: () => new Date(NOW - 10 * 60_000).toISOString(),
    },
    getPanel: panelId => panels.find(candidate => candidate.id === panelId),
    getPanelsForPane: paneId => panels.filter(candidate => candidate.sessionId === paneId),
    listPaneIds: () => ['pane-1'],
    listLocks: () => [],
    pendingPrChecks: async () => [],
    connectedClients: () => connected,
    remoteConfig: () => config,
    checkpointWal,
    paneDirectory: '/nonexistent-pane-dir',
    now: () => NOW,
    ...overrides,
  };
  registerCloudDaemonHandlers(dependencies);
  const safeToStop = (request: Record<string, unknown> = { flush: 'never' }) =>
    commandRegistry.invoke('runpane:cloud:safe-to-stop', [request]);
  return { commandRegistry, health, clientActivity, agentStates, running, connected, config, checkpointWal, safeToStop };
}

function stream(clientId: string | null, label: string): RemoteDaemonConnectedClient {
  return { id: '1', clientId, label, deviceLabel: null, remoteAddress: null, connectedAt: '', lastSeenAt: '' };
}

describe('registerCloudDaemonHandlers', () => {
  it('counts agent panels of live Panes for readiness, not shells', () => {
    const { health, agentStates } = setup();
    expect(health.readiness()).toMatchObject({
      state: 'ready',
      agents: { expected: 2, ready: 1, notRunning: 1 },
    });

    agentStates.delete('claude-1');
    expect(health.readiness()).toMatchObject({ state: 'starting', agents: { starting: 1 } });
  });

  it('is safe when idle and blocks on a working agent', async () => {
    const { safeToStop, agentStates } = setup();
    await expect(safeToStop()).resolves.toMatchObject({ safe: true, blockers: [] });

    agentStates.set('claude-1', 'working');
    await expect(safeToStop()).resolves.toMatchObject({ safe: false, blockers: [{ condition: 'agent-working' }] });
  });

  it('counts user event streams and recent user calls, never peers', async () => {
    const { safeToStop, connected, clientActivity, config } = setup();
    connected.push(stream('peer-a', 'peer-a'));
    clientActivity.recordInvoke({ record: config.host.clients[1], clientId: 'peer-a', label: 'peer-a', channel: 'runpane:panels:list', at: NOW });
    await expect(safeToStop()).resolves.toMatchObject({ safe: true });

    connected.push(stream('desktop', 'MacBook'));
    await expect(safeToStop()).resolves.toMatchObject({
      blockers: [{ condition: 'user-client-attached', message: 'MacBook has an open event stream' }],
    });

    connected.length = 0;
    clientActivity.recordInvoke({ record: config.host.clients[0], clientId: 'desktop', label: 'phone', channel: 'runpane:panes:list', at: NOW - 60_000 });
    await expect(safeToStop()).resolves.toMatchObject({
      blockers: [{ condition: 'user-client-attached', message: 'phone used the daemon 60s ago' }],
    });
    await expect(safeToStop({ flush: 'never', clientWindowMs: 30_000 })).resolves.toMatchObject({ safe: true });
  });

  it('never counts the coordinator\'s own cloud calls as user activity', async () => {
    const { safeToStop, clientActivity, config } = setup();
    clientActivity.recordInvoke({ record: config.host.clients[0], clientId: 'desktop', label: 'coord', channel: 'runpane:cloud:safe-to-stop', at: NOW });

    await expect(safeToStop()).resolves.toMatchObject({ safe: true });
  });

  it('treats a user or local wait as a watcher, but not a peer wait', async () => {
    const { safeToStop, commandRegistry } = setup();
    let release: () => void = () => {};
    commandRegistry.register('runpane:workspace:wait', () => new Promise<null>((resolve) => {
      release = () => resolve(null);
    }));

    const peerWait = commandRegistry.invoke('runpane:workspace:wait', [], { origin: 'remote-peer' });
    await expect(safeToStop()).resolves.toMatchObject({ safe: true });
    release();
    await peerWait;

    const localWait = commandRegistry.invoke('runpane:workspace:wait', [], { origin: 'local' });
    await expect(safeToStop()).resolves.toMatchObject({ blockers: [{ condition: 'watcher-active' }] });
    release();
    await localWait;
  });

  it('checkpoints the database when safe', async () => {
    const { safeToStop, checkpointWal } = setup();
    await safeToStop({});

    expect(checkpointWal).toHaveBeenCalledTimes(1);
  });
});
