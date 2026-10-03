import type { CloudSandboxView } from '../../../shared/types/cloudSandboxes';

interface CloudSandboxBadge {
  label: string;
  variant: 'default' | 'success' | 'info' | 'error' | 'warning';
}

export function getCloudSandboxBadge(sandbox: CloudSandboxView): CloudSandboxBadge {
  if (sandbox.stateUnknown) return { label: 'Checking', variant: 'default' };
  if (sandbox.pending === 'starting') return { label: 'Starting', variant: 'info' };
  if (sandbox.pending === 'stopping') return { label: 'Stopping', variant: 'info' };
  if (sandbox.pending === 'removing') return { label: 'Removing', variant: 'warning' };
  if (sandbox.pending === 'updating') return { label: 'Updating', variant: 'info' };
  if (sandbox.state === 'starting') return { label: 'Starting', variant: 'info' };
  if (sandbox.state === 'stopping') return { label: 'Stopping', variant: 'info' };
  if (sandbox.state === 'running') return { label: 'Running', variant: 'success' };
  if (sandbox.state === 'stopped') return { label: 'Stopped', variant: 'default' };
  if (sandbox.state === 'creating') return { label: 'Creating', variant: 'info' };
  return { label: 'Error', variant: 'error' };
}

const STEP_LABELS = new Map<string, string>([
  ['sandbox', 'Creating the sandbox'],
  ['tailnet', 'Joining your tailnet'],
  ['install', 'Installing Pane'],
  ['pairing', 'Pairing with this app'],
  ['health', 'Waiting for Pane to start'],
  ['saved-host', 'Saving the host'],
]);

/** A provisioning step's name as a sentence; unknown steps show as reported. */
export function getCloudStepLabel(step: string): string {
  return STEP_LABELS.get(step) ?? step;
}

/**
 * "running for 5h" from the sandbox's last start; null when unknown. A start after `now` (a clock that
 * ticks each minute, or a little skew) counts as just started.
 */
export function formatCloudUptime(startedAt: string | undefined, now: number): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  const minutes = Math.floor(Math.max(now - started, 0) / 60_000);
  if (minutes < 60) return `running for ${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `running for ${hours}h`;
  return `running for ${Math.floor(hours / 24)}d`;
}

export type CloudSandboxRowAction = 'retry' | 'dismiss' | 'start' | 'terminal' | 'stop' | 'update' | 'remove';

/** The buttons a row offers, in display order. A row with work in flight offers none. */
export function getCloudSandboxActions(sandbox: CloudSandboxView): CloudSandboxRowAction[] {
  if (sandbox.pending || sandbox.stateUnknown || sandbox.state === 'creating' || sandbox.state === 'starting' || sandbox.state === 'stopping') return [];
  const actions: CloudSandboxRowAction[] = sandbox.failedAction ? ['retry', 'dismiss'] : [];
  // A failed create has no sandbox yet: Retry or Dismiss are all it can do.
  if (!sandbox.hostname) return actions;
  if (sandbox.state === 'stopped') actions.push('start');
  if (sandbox.state === 'running') {
    if (sandbox.updateAvailable) actions.push('update');
    // The host terminal needs the saved host to connect to.
    if (sandbox.profileId) actions.push('terminal');
    actions.push('stop');
  }
  actions.push('remove');
  return actions;
}

export interface CloudHostSwitcherEntry {
  /** Replaces the profile's address under its name. */
  description: string;
  /** connect: the usual switch. start: start the sandbox, then connect. wait: nothing to do yet. */
  action: 'connect' | 'start' | 'wait';
}

/** How the host switcher shows a saved host that is a cloud sandbox; null keeps the normal row. */
export function getCloudHostSwitcherEntry(sandbox: CloudSandboxView | undefined): CloudHostSwitcherEntry | null {
  if (!sandbox) return null;
  if (sandbox.stateUnknown) return { description: 'Checking cloud sandbox…', action: 'wait' };
  if (sandbox.pending === 'starting' || sandbox.state === 'starting') return { description: 'Starting cloud sandbox…', action: 'wait' };
  if (sandbox.pending === 'stopping' || sandbox.state === 'stopping') return { description: 'Stopping cloud sandbox…', action: 'wait' };
  if (sandbox.pending === 'removing') return { description: 'Removing cloud sandbox…', action: 'wait' };
  if (sandbox.pending === 'updating') return { description: 'Updating Pane…', action: 'wait' };
  if (sandbox.failedAction === 'start') return { description: `Start failed: ${sandbox.error ?? 'unknown error'} · Select to retry`, action: 'start' };
  if (sandbox.state === 'stopped') return { description: 'Stopped · Select to start', action: 'start' };
  if (sandbox.state === 'creating') return { description: 'Creating cloud sandbox…', action: 'wait' };
  return null;
}
