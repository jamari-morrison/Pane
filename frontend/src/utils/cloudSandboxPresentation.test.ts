import { describe, expect, it } from 'vitest';
import type { CloudSandboxView } from '../../../shared/types/cloudSandboxes';
import {
  formatCloudUptime,
  getCloudHostSwitcherEntry,
  getCloudSandboxActions,
  getCloudSandboxBadge,
  getCloudStepLabel,
} from './cloudSandboxPresentation';

function sandbox(overrides: Partial<CloudSandboxView> = {}): CloudSandboxView {
  return {
    id: 'rp-alpha',
    label: 'alpha',
    hostname: 'rp-alpha',
    profileId: 'profile-alpha',
    state: 'running',
    size: 'default',
    ...overrides,
  };
}

describe('getCloudSandboxBadge', () => {
  it('names the provider state, or the action in flight', () => {
    expect(getCloudSandboxBadge(sandbox())).toEqual({ label: 'Running', variant: 'success' });
    expect(getCloudSandboxBadge(sandbox({ state: 'stopped' }))).toEqual({ label: 'Stopped', variant: 'default' });
    expect(getCloudSandboxBadge(sandbox({ state: 'creating' }))).toEqual({ label: 'Creating', variant: 'info' });
    expect(getCloudSandboxBadge(sandbox({ state: 'error' }))).toEqual({ label: 'Error', variant: 'error' });
    expect(getCloudSandboxBadge(sandbox({ state: 'stopped', pending: 'starting' }))).toEqual({ label: 'Starting', variant: 'info' });
    expect(getCloudSandboxBadge(sandbox({ state: 'stopping' }))).toEqual({ label: 'Stopping', variant: 'info' });
  });
});

describe('getCloudStepLabel', () => {
  it('describes known steps and passes unknown ones through', () => {
    expect(getCloudStepLabel('tailnet')).toBe('Joining your tailnet');
    expect(getCloudStepLabel('future-step')).toBe('future-step');
  });
});

describe('formatCloudUptime', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');

  it('rounds to minutes, hours, then days', () => {
    expect(formatCloudUptime('2026-10-01T11:59:50.000Z', now)).toBe('running for 1m');
    expect(formatCloudUptime('2026-10-01T11:15:00.000Z', now)).toBe('running for 45m');
    expect(formatCloudUptime('2026-10-01T07:00:00.000Z', now)).toBe('running for 5h');
    expect(formatCloudUptime('2026-09-28T12:00:00.000Z', now)).toBe('running for 3d');
  });

  it('shows nothing for a missing or invalid start time', () => {
    expect(formatCloudUptime(undefined, now)).toBeNull();
    expect(formatCloudUptime('yesterday', now)).toBeNull();
  });

  it('counts a start after the last clock tick as just started', () => {
    expect(formatCloudUptime('2026-10-01T12:00:30.000Z', now)).toBe('running for 1m');
  });
});

describe('getCloudSandboxActions', () => {
  it('offers Stop and Remove while running, and Update Pane first when versions differ', () => {
    expect(getCloudSandboxActions(sandbox())).toEqual(['stop', 'remove']);
    expect(getCloudSandboxActions(sandbox({ updateAvailable: true }))).toEqual(['update', 'stop', 'remove']);
  });

  it('offers Start and Remove while stopped', () => {
    expect(getCloudSandboxActions(sandbox({ state: 'stopped' }))).toEqual(['start', 'remove']);
  });

  it('offers nothing while work is in flight', () => {
    expect(getCloudSandboxActions(sandbox({ pending: 'stopping' }))).toEqual([]);
    expect(getCloudSandboxActions(sandbox({ state: 'starting' }))).toEqual([]);
    expect(getCloudSandboxActions(sandbox({ id: 'create:alpha', hostname: undefined, state: 'creating' }))).toEqual([]);
  });

  it('offers Retry and Dismiss after a failure, and only those for a failed create', () => {
    expect(getCloudSandboxActions(sandbox({ id: 'create:alpha', hostname: undefined, state: 'error', failedAction: 'create', error: 'quota' })))
      .toEqual(['retry', 'dismiss']);
    expect(getCloudSandboxActions(sandbox({ state: 'stopped', failedAction: 'start', error: 'timeout' })))
      .toEqual(['retry', 'dismiss', 'start', 'remove']);
  });

  it('still lets an errored sandbox be removed', () => {
    expect(getCloudSandboxActions(sandbox({ state: 'error', error: 'provider says error' }))).toEqual(['remove']);
  });
});

describe('getCloudHostSwitcherEntry', () => {
  it('keeps the normal row for ordinary hosts and running sandboxes', () => {
    expect(getCloudHostSwitcherEntry(undefined)).toBeNull();
    expect(getCloudHostSwitcherEntry(sandbox())).toBeNull();
  });

  it('turns a stopped sandbox into a Start action', () => {
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'stopped' }))).toEqual({
      description: 'Stopped · Select to start',
      action: 'start',
    });
  });

  it('waits while the sandbox starts and offers a retry when the start failed', () => {
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'stopped', pending: 'starting' }))?.action).toBe('wait');
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'starting' }))?.action).toBe('wait');
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'stopped', failedAction: 'start', error: 'resume timed out' }))).toEqual({
      description: 'Start failed: resume timed out · Select to retry',
      action: 'start',
    });
  });
});
