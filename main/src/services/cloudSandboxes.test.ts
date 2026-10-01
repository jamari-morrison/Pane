import { describe, expect, it, vi } from 'vitest';
import type { CloudSandboxesSnapshot } from '../../../shared/types/cloudSandboxes';
import type { CloudProgressListener, CloudSandboxInfo } from '../../../packages/runpane/src/cloud/api';
import {
  CloudSandboxManager,
  CloudSandboxesUnavailableError,
  getCloudErrorMessage,
  resolvePaneReleaseDeb,
  type CloudSandboxLibrary,
} from './cloudSandboxes';

function summary(overrides: Partial<CloudSandboxInfo> = {}): CloudSandboxInfo {
  return {
    hostname: 'rp-alpha',
    label: 'alpha',
    profileId: 'profile-alpha',
    sessionId: 'session-alpha',
    sandboxId: 'sbx-alpha',
    state: 'running',
    providerState: 'running',
    baseUrl: 'https://rp-alpha.tail1234.ts.net',
    transport: 'https',
    size: 'default',
    createdAt: '2026-10-01T09:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const CONFIGURED = { boat: { configured: true, org: { id: 'team_test', name: 'test' } }, tailscale: { configured: true }, claude: { configured: false }, ready: true };

function createLibrary(overrides: Partial<CloudSandboxLibrary> = {}): CloudSandboxLibrary {
  return {
    getCredentialsStatus: vi.fn(async () => CONFIGURED),
    setup: vi.fn(async () => ({ ...CONFIGURED, claude: { configured: true } })),
    create: vi.fn(async () => summary()),
    list: vi.fn(async () => []),
    stop: vi.fn(async () => summary({ state: 'stopped', startedAt: undefined })),
    start: vi.fn(async () => summary()),
    update: vi.fn(async () => summary()),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createManager(library: CloudSandboxLibrary | Error, options: {
  appVersion?: string;
  readDaemonVersion?: (profileId: string) => Promise<string | undefined>;
} = {}) {
  const snapshots: CloudSandboxesSnapshot[] = [];
  const resolvePaneDeb = vi.fn(async (version: string) => ({
    debUrl: `https://example.test/Pane-${version}-linux-amd64.deb`,
    sha256: 'a'.repeat(64),
  }));
  const manager = new CloudSandboxManager({
    loadLibrary: () => library instanceof Error ? Promise.reject(library) : Promise.resolve(library),
    onChange: (snapshot) => snapshots.push(snapshot),
    appVersion: options.appVersion ?? '2.4.146',
    readDaemonVersion: options.readDaemonVersion ?? (async () => '2.4.146'),
    resolvePaneDeb,
  });
  return { manager, snapshots, resolvePaneDeb };
}

describe('CloudSandboxManager', () => {
  it('reports the library as unavailable without offering actions', async () => {
    const { manager } = createManager(new CloudSandboxesUnavailableError());

    const snapshot = await manager.refresh();

    expect(snapshot).toMatchObject({ available: false, sandboxes: [], loadError: undefined });
    await expect(manager.create({ name: 'alpha', size: 'default' })).rejects.toThrow('not available');
  });

  it('lists sandboxes with credential status and only booleans for credentials', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary(), summary({ hostname: 'rp-beta', label: 'beta', state: 'stopped' })]) });
    const { manager } = createManager(library);

    const snapshot = await manager.refresh();

    expect(snapshot.available).toBe(true);
    expect(snapshot.credentials).toEqual({ boat: true, tailscale: true, claude: false, boatOrg: 'test' });
    expect(snapshot.sandboxes.map((row) => [row.id, row.state, row.startedAt])).toEqual([
      ['rp-alpha', 'running', '2026-10-01T10:00:00.000Z'],
      ['rp-beta', 'stopped', undefined],
    ]);
  });

  it('keeps the last rows and shows the error when listing fails', async () => {
    const list = vi.fn<CloudSandboxLibrary['list']>().mockResolvedValueOnce([summary()]).mockRejectedValueOnce(new Error('boat.dev is unreachable'));
    const { manager } = createManager(createLibrary({ list }));
    await manager.refresh();

    const snapshot = await manager.refresh();

    expect(snapshot.loadError).toBe('boat.dev is unreachable');
    expect(snapshot.sandboxes).toHaveLength(1);
  });

  it('streams provisioning steps on a creating row, then lists the new sandbox', async () => {
    let report: CloudProgressListener | undefined;
    let finish: ((value: CloudSandboxInfo) => void) | undefined;
    const library = createLibrary({
      create: vi.fn((_options, onProgress) => {
        report = onProgress;
        return new Promise<CloudSandboxInfo>((resolve) => { finish = resolve; });
      }),
    });
    const { manager, snapshots } = createManager(library);

    const created = manager.create({ name: 'alpha', size: 'small' });
    await vi.waitFor(() => expect(report).toBeDefined());
    expect(library.create).toHaveBeenCalledWith({ label: 'alpha', size: 'small' }, expect.any(Function));
    report?.({ step: 'sandbox', message: 'Creating the boat sandbox' });
    report?.({ step: 'tailnet', message: 'Joining your tailnet' });
    report?.({ step: 'install', message: 'Installing Pane' });

    expect(snapshots.at(-1)?.sandboxes).toEqual([expect.objectContaining({
      id: 'create:alpha',
      state: 'creating',
      size: 'small',
      steps: [
        { step: 'sandbox', state: 'done', message: 'Creating the boat sandbox' },
        { step: 'tailnet', state: 'done', message: 'Joining your tailnet' },
        { step: 'install', state: 'start', message: 'Installing Pane' },
      ],
    })]);
    report?.({ step: 'done', message: 'Ready' });
    expect(snapshots.at(-1)?.sandboxes[0]?.steps?.every((step) => step.state === 'done')).toBe(true);

    finish?.(summary({ size: 'small' }));
    const snapshot = await created;
    expect(snapshot.sandboxes.map((row) => [row.id, row.state])).toEqual([['rp-alpha', 'running']]);
  });

  it('keeps a failed create on its row and retries the same request', async () => {
    const create = vi.fn<CloudSandboxLibrary['create']>()
      .mockRejectedValueOnce(new Error('tailnet: the auth key was refused'))
      .mockResolvedValueOnce(summary());
    const { manager } = createManager(createLibrary({ create }));

    const failed = await manager.create({ name: 'alpha', size: 'default' });
    expect(failed.sandboxes).toEqual([expect.objectContaining({
      id: 'create:alpha',
      state: 'error',
      error: 'tailnet: the auth key was refused',
      failedAction: 'create',
    })]);

    const retried = await manager.retry('create:alpha');

    expect(create).toHaveBeenLastCalledWith({ label: 'alpha', size: 'default' }, expect.anything());
    expect(retried.sandboxes.map((row) => row.id)).toEqual(['rp-alpha']);
  });

  it('drops a failed create row on dismiss', async () => {
    const { manager } = createManager(createLibrary({ create: vi.fn(async () => { throw new Error('quota'); }) }));
    await manager.create({ name: 'alpha', size: 'default' });

    expect(manager.dismiss('create:alpha').sandboxes).toEqual([]);
  });

  it('refuses a second sandbox with an existing name', async () => {
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary()]) }));
    await manager.refresh();

    await expect(manager.create({ name: 'alpha', size: 'default' })).rejects.toThrow('already exists');
  });

  it('marks a row pending while it stops, then shows the stopped state', async () => {
    let finish: ((value: CloudSandboxInfo) => void) | undefined;
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      stop: vi.fn(() => new Promise<CloudSandboxInfo>((resolve) => { finish = resolve; })),
    });
    const { manager, snapshots } = createManager(library);
    await manager.refresh();

    const stopped = manager.stop('rp-alpha');
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]?.pending).toBe('stopping'));
    await expect(manager.start('rp-alpha')).rejects.toThrow('busy');

    finish?.(summary({ state: 'stopped' }));
    const snapshot = await stopped;
    expect(snapshot.sandboxes[0]).toMatchObject({ state: 'stopped', pending: undefined, startedAt: undefined });
  });

  it('keeps a failed start on its row and retries it', async () => {
    const start = vi.fn<CloudSandboxLibrary['start']>()
      .mockRejectedValueOnce(new Error('boat resume timed out'))
      .mockResolvedValueOnce(summary());
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary({ state: 'stopped' })]), start }));
    await manager.refresh();

    const failed = await manager.start('rp-alpha');
    expect(failed.sandboxes[0]).toMatchObject({ state: 'stopped', error: 'boat resume timed out', failedAction: 'start' });

    const retried = await manager.retry('rp-alpha');
    expect(start).toHaveBeenCalledTimes(2);
    expect(retried.sandboxes[0]).toMatchObject({ state: 'running', error: undefined });
  });

  it('removes a row once the library removed the sandbox', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager } = createManager(library);
    await manager.refresh();

    const snapshot = await manager.remove('rp-alpha');

    expect(library.remove).toHaveBeenCalledWith('rp-alpha');
    expect(snapshot.sandboxes).toEqual([]);
  });

  it('offers Update Pane when the daemon reports another version and installs this app\'s', async () => {
    const readDaemonVersion = vi.fn<(profileId: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce('2.4.140')
      .mockResolvedValue('2.4.146');
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager, snapshots, resolvePaneDeb } = createManager(library, { readDaemonVersion });
    await manager.refresh();
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({
      daemonVersion: '2.4.140',
      updateAvailable: true,
    }));
    expect(readDaemonVersion).toHaveBeenCalledWith('profile-alpha');

    await manager.update('rp-alpha');

    expect(resolvePaneDeb).toHaveBeenCalledWith('2.4.146');
    expect(library.update).toHaveBeenCalledWith('rp-alpha', {
      debUrl: 'https://example.test/Pane-2.4.146-linux-amd64.deb',
      sha256: 'a'.repeat(64),
    });
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({
      daemonVersion: '2.4.146',
      updateAvailable: false,
    }));
  });

  it('does not read versions from stopped sandboxes or treat an unreachable daemon as an error', async () => {
    const readDaemonVersion = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const library = createLibrary({ list: vi.fn(async () => [summary(), summary({ hostname: 'rp-beta', profileId: 'profile-beta', state: 'stopped' })]) });
    const { manager } = createManager(library, { readDaemonVersion });

    await manager.refresh();
    await vi.waitFor(() => expect(readDaemonVersion).toHaveBeenCalledTimes(1));

    expect(readDaemonVersion).toHaveBeenCalledWith('profile-alpha');
    expect(manager.getSnapshot().sandboxes.every((row) => !row.error && !row.updateAvailable)).toBe(true);
  });
});

describe('CloudSandboxManager library mapping', () => {
  it('saves credentials through setup and keeps only set/not-set and the wallet name', async () => {
    const library = createLibrary();
    const { manager } = createManager(library);

    const snapshot = await manager.updateCredentials({
      boatApiKey: 'synthetic-key',
      boatOrg: 'test',
      tailscale: { clientId: 'synthetic-id', clientSecret: 'synthetic-secret' },
    });

    expect(library.setup).toHaveBeenCalledWith({
      boatApiKey: 'synthetic-key',
      boatOrg: 'test',
      tailscaleClientId: 'synthetic-id',
      tailscaleClientSecret: 'synthetic-secret',
      claudeToken: undefined,
    });
    expect(snapshot.credentials).toEqual({ boat: true, tailscale: true, claude: true, boatOrg: 'test' });
    expect(JSON.stringify(snapshot)).not.toContain('synthetic');
  });

  it('shows a sandbox the provider no longer has as an error that can be removed', async () => {
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary({ state: 'gone', providerState: 'gone' })]) }));

    const snapshot = await manager.refresh();

    expect(snapshot.sandboxes[0]).toMatchObject({ state: 'error', error: 'boat.dev no longer has this sandbox.' });
  });

  it('falls back to the version the library installed when the daemon cannot be asked', async () => {
    const { manager } = createManager(
      createLibrary({ list: vi.fn(async () => [summary({ daemonVersion: '2.4.140' })]) }),
      { readDaemonVersion: async () => undefined },
    );

    const snapshot = await manager.refresh();

    expect(snapshot.sandboxes[0]).toMatchObject({ daemonVersion: '2.4.140', updateAvailable: true });
  });
});

describe('getCloudErrorMessage', () => {
  it('redacts token-shaped strings that reach an error message', () => {
    // Built at runtime so the repository's secret scanners never see a key-shaped literal.
    const key = ['tskey', 'auth', 'k'.repeat(20)].join('-');
    const opaque = 'Z'.repeat(40);

    const message = getCloudErrorMessage(new Error(`join failed with ${key} and ${opaque}`), 'fallback');

    expect(message).toBe('join failed with [redacted] and [redacted]');
  });

  it('keeps hostnames and sandbox ids readable', () => {
    expect(getCloudErrorMessage(new Error('rp-alpha (sbx-0a1b2c3d-4e5f) is stopped'), 'fallback'))
      .toBe('rp-alpha (sbx-0a1b2c3d-4e5f) is stopped');
  });
});

describe('resolvePaneReleaseDeb', () => {
  it('reads the amd64 .deb checksum from the release SHA256SUMS', async () => {
    const hash = 'B'.repeat(64);
    const fetchText = vi.fn(async () => [
      `${'c'.repeat(64)}  Pane-2.4.146-linux-arm64.deb`,
      `${hash} *Pane-2.4.146-linux-amd64.deb`,
    ].join('\n'));

    await expect(resolvePaneReleaseDeb('2.4.146', fetchText)).resolves.toEqual({
      debUrl: 'https://github.com/greenfield-inc/Pane/releases/download/v2.4.146/Pane-2.4.146-linux-amd64.deb',
      sha256: 'b'.repeat(64),
    });
    expect(fetchText).toHaveBeenCalledWith('https://github.com/greenfield-inc/Pane/releases/download/v2.4.146/SHA256SUMS.txt');
  });

  it('refuses a release without a checksum for the .deb', async () => {
    await expect(resolvePaneReleaseDeb('2.4.146', async () => 'nothing here'))
      .rejects.toThrow('no published checksum');
  });
});
