import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCloudSandboxes, type CloudBootstrap, type CloudProgress } from './api';
import type { DaemonHealthResult } from './bootstrap/health';
import type { ProvisionResult, RepairResult } from './bootstrap/provision';
import type { CloudProvider, CloudSandbox, CreateSandboxRequest, ListedBoatOrg } from './provider';
import type { CloudHostProfile, PaneSource } from './store';
import type { TailscaleApi, TailscaleDevice } from './tailscale';

const FQDN = 'rp-test.tail1234.ts.net';
const SECRETS = ['boat-key-SECRET', 'ts-client-SECRET', 'claude-token-SECRET', 'paired-token-SECRET'];

/** An in-memory boat: sandboxes start, stop and resume instantly; calls are logged. */
function fakeProvider(orgs: ListedBoatOrg[] = [{ id: 'team_test', name: 'test', active: false }]) {
  const sandboxes = new Map<string, CloudSandbox>();
  const calls: string[] = [];
  const creates: CreateSandboxRequest[] = [];
  const keys: Array<{ apiKey: string; org?: string }> = [];
  const factory = (apiKey: string, org?: string): CloudProvider => {
    keys.push({ apiKey, org });
    const set = (id: string, state: CloudSandbox['state'], providerState: string) => {
      const current = sandboxes.get(id);
      if (current) sandboxes.set(id, { ...current, state, providerState });
    };
    return {
      name: 'boat',
      verifyCredentials: async () => ({ account: 'me@example.com' }),
      listOrgs: async () => orgs,
      async create(request) {
        creates.push(request);
        calls.push('create');
        const id = `bx_${sandboxes.size + 1}`;
        const created: CloudSandbox = { id, name: request.name, state: 'running', providerState: 'idle', size: request.size, org: { id: 'team_test', name: 'test' } };
        sandboxes.set(id, created);
        return { ...created, state: 'starting', providerState: 'provisioning' };
      },
      get: async (id) => sandboxes.get(id) ?? { id, name: '', state: 'gone', providerState: 'not_found' },
      list: async () => [...sandboxes.values()],
      rename: async () => undefined,
      async stop(id) {
        calls.push(`stop ${id}`);
        set(id, 'stopped', 'archived');
      },
      async resume(id) {
        calls.push(`resume ${id}`);
        set(id, 'running', 'idle');
      },
      async destroy(id) {
        calls.push(`destroy ${id}`);
        sandboxes.delete(id);
      },
      handle: (id) => ({
        id,
        writeFile: async () => undefined,
        async runScript(script) {
          calls.push(`run ${id} ${script}`);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    };
  };
  return { factory, sandboxes, calls, creates, keys };
}

function fakeTailnet() {
  const devices: TailscaleDevice[] = [];
  const api: TailscaleApi = {
    mintAuthKey: async () => ({ id: 'k', key: 'tskey-fake-SECRET' }),
    listDevices: async () => devices,
    findDevicesByHostname: async (hostname) => devices.filter((device) => device.hostname === hostname),
    async deleteDevice(nodeId) {
      const index = devices.findIndex((device) => device.nodeId === nodeId);
      if (index !== -1) devices.splice(index, 1);
      return index !== -1;
    },
  };
  return { api, devices };
}

interface BootstrapScript {
  provisionError?: Error;
  /** Answers for successive waitForHealth calls (default: healthy). */
  health?: boolean[];
  repair?: RepairResult;
}

function fakeBootstrap(tailnet: ReturnType<typeof fakeTailnet>, script: BootstrapScript = {}) {
  const agentEnvs: Array<string | undefined> = [];
  const paneSources: PaneSource[] = [];
  const repairs: string[] = [];
  const updates: string[] = [];
  const health = [...(script.health ?? [])];
  const bootstrap: CloudBootstrap = {
    async provision(_sandbox, options): Promise<ProvisionResult> {
      agentEnvs.push(options.agentEnv);
      paneSources.push(options.paneSource);
      tailnet.devices.push({ nodeId: 'n1', id: '1', hostname: options.hostname, name: FQDN, addresses: [], tags: ['tag:rp-session'] });
      if (script.provisionError) throw script.provisionError;
      options.onStep?.({ step: 'install-pane', state: 'start' });
      return {
        nodeId: 'n1', hostname: options.hostname, magicDnsName: `${options.hostname}.tail1234.ts.net`, tailscaleIps: [], tags: ['tag:rp-session'], runSsh: false,
        pairing: { v: 1, label: options.label, baseUrl: `https://${options.hostname}.tail1234.ts.net`, token: 'paired-token-SECRET', transport: 'http+sse', tunnel: { kind: 'tailscale', selected: true } },
        transport: 'https',
        daemonVersion: '2.4.146',
        health: { ok: true, elapsedMs: 1, version: '2.4.146' },
        deletedStaleNodeIds: [],
      };
    },
    async repair(_sandbox, options) {
      repairs.push(options.hostname);
      return script.repair ?? { reenrolled: false, backendState: 'Running', serveApplied: true };
    },
    async update(_sandbox, pane) {
      updates.push(pane.debUrl);
      return { version: '2.4.147' };
    },
    async waitForHealth(): Promise<DaemonHealthResult> {
      const ok = health.length > 0 ? health.shift() === true : true;
      return { ok, elapsedMs: 1, version: ok ? '2.4.146' : undefined };
    },
  };
  return { bootstrap, agentEnvs, paneSources, repairs, updates };
}

function harness(script: BootstrapScript = {}, env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cloud-'));
  const provider = fakeProvider();
  const tailnet = fakeTailnet();
  const boot = fakeBootstrap(tailnet, script);
  const saved = new Map<string, CloudHostProfile>();
  const progress: CloudProgress[] = [];
  const cloud = createCloudSandboxes({
    dir,
    createProvider: provider.factory,
    createTailscale: () => tailnet.api,
    bootstrap: boot.bootstrap,
    savedHosts: {
      upsert: async (profile) => {
        saved.set(profile.cloud.sessionId, profile);
      },
      remove: async (sessionId) => {
        saved.delete(sessionId);
      },
    },
    sleep: async () => undefined,
    env,
  });
  const onProgress = (update: CloudProgress) => progress.push(update);
  return { dir, cloud, provider, tailnet, boot, saved, progress, onProgress };
}

async function withCredentials(h: ReturnType<typeof harness>) {
  await h.cloud.setup({ boatApiKey: SECRETS[0], boatOrg: 'test', tailscaleClientId: 'client-id', tailscaleClientSecret: SECRETS[1], claudeToken: SECRETS[2] });
}

function readTree(dir: string): string {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

test('setup saves the credentials 0600, resolves the wallet, and its status never carries a secret', async () => {
  const h = harness();
  assert.deepEqual(await h.cloud.getCredentialsStatus(), {
    boat: { configured: false }, tailscale: { configured: false }, claude: { configured: false }, ready: false,
  });
  await withCredentials(h);
  const status = await h.cloud.getCredentialsStatus();
  assert.deepEqual(status, {
    boat: { configured: true, org: { id: 'team_test', name: 'test' } }, tailscale: { configured: true }, claude: { configured: true }, ready: true,
  });
  assert.equal(fs.statSync(path.join(h.dir, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.dir).mode & 0o777, 0o700);
  // Empty fields keep what is saved.
  await h.cloud.setup({ boatApiKey: '', tailscaleClientSecret: ' ' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'credentials.json'), 'utf8')).boat.apiKey, SECRETS[0]);
});

test('setup refuses half a Tailscale OAuth client and an unknown wallet', async () => {
  const h = harness();
  await assert.rejects(h.cloud.setup({ tailscaleClientId: 'client-id' }), /needs both its client id and its secret/u);
  await assert.rejects(h.cloud.setup({ boatApiKey: SECRETS[0], boatOrg: 'nope' }), /No boat wallet "nope". Yours: test \(team_test\)/u);
  assert.equal(fs.existsSync(path.join(h.dir, 'credentials.json')), false);
});

test('create provisions in the saved wallet, signs agents in, saves the host and reports progress without secrets', async () => {
  const h = harness();
  await withCredentials(h);
  const info = await h.cloud.create({ label: 'My sandbox' }, h.onProgress);

  assert.equal(info.state, 'running');
  assert.equal(info.label, 'My sandbox');
  assert.match(info.hostname, /^rp-[a-z0-9]{8}$/u);
  assert.equal(info.baseUrl, `https://${info.hostname}.tail1234.ts.net`);
  assert.equal(info.transport, 'https');
  assert.deepEqual(info.health, { ok: true, version: '2.4.146' });
  assert.ok(info.startedAt);
  assert.equal(info.daemonVersion, '2.4.146');
  assert.equal(h.provider.creates[0].org, 'team_test');
  assert.deepEqual(h.boot.paneSources, [{ kind: 'runpane-npm', spec: 'runpane@latest' }]);
  assert.match(h.provider.creates[0].idempotencyKey, /^runpane-cloud-new-/u);
  assert.deepEqual(h.boot.agentEnvs, [`CLAUDE_CODE_OAUTH_TOKEN=${SECRETS[2]}\n`]);

  const saved = h.saved.get(info.sessionId);
  assert.equal(saved?.token, 'paired-token-SECRET');
  assert.deepEqual(saved?.cloud, { provider: 'boat', sandboxId: info.sandboxId, sessionId: info.sessionId, nodeId: 'n1', hostname: info.hostname, version: 1 });
  assert.equal(fs.statSync(path.join(h.dir, 'hosts', `${info.hostname}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(h.progress.map((update) => update.step), ['sandbox', 'tailnet', 'install', 'saved-host', 'done']);
  const visible = JSON.stringify([info, h.progress]);
  for (const secret of SECRETS) assert.ok(!visible.includes(secret), 'no secret in results or progress');
});

test('a failed create removes the sandbox, its tailnet device and its record', async () => {
  const h = harness({ provisionError: new Error('cloud bootstrap step "install-pane" failed: apt-get exited 100') });
  await withCredentials(h);
  await assert.rejects(h.cloud.create({}, h.onProgress), /Creating rp-[a-z0-9]{8} failed: cloud bootstrap step "install-pane" failed/u);
  assert.equal(h.provider.sandboxes.size, 0);
  assert.equal(h.tailnet.devices.length, 0);
  assert.deepEqual(await h.cloud.list(), []);
  assert.equal(h.saved.size, 0);
});

test('stop flushes then stops; start resumes and waits for the daemon', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sandboxId } = await h.cloud.create();

  const stopped = await h.cloud.stop(hostname, h.onProgress);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(h.provider.calls.slice(-2), [`run ${sandboxId} sync; sleep 0.2; sync`, `stop ${sandboxId}`]);
  assert.equal((await h.cloud.stop(hostname)).state, 'stopped', 'stopping a stopped sandbox is a no-op');
  assert.equal((await h.cloud.list())[0].state, 'stopped');
  assert.equal(h.provider.keys.at(-1)?.org, 'team_test', 'list is scoped to the wallet the sandbox bills');

  const started = await h.cloud.start(hostname, h.onProgress);
  assert.equal(started.state, 'running');
  assert.deepEqual(started.health, { ok: true, version: '2.4.146' });
  assert.equal(h.provider.calls.at(-1), `resume ${sandboxId}`);
  assert.deepEqual(h.boot.repairs, [], 'a healthy start needs no repair');
});

test('start repairs a node that came back logged out, under the same name, and updates the saved host', async () => {
  const h = harness({
    health: [false, true],
    repair: { reenrolled: true, previousBackendState: 'NeedsLogin', deletedNodeIds: ['n1'], nodeId: 'n2', hostname: 'x', magicDnsName: FQDN, tailscaleIps: [], tags: [], runSsh: false },
  });
  await withCredentials(h);
  const { hostname, sessionId, baseUrl } = await h.cloud.create();
  await h.cloud.stop(hostname);
  const started = await h.cloud.start(hostname, h.onProgress);

  assert.deepEqual(h.boot.repairs, [hostname]);
  assert.equal(started.baseUrl, baseUrl, 'same address after a re-enrol');
  assert.deepEqual(h.saved.get(sessionId)?.cloud.nodeId, 'n2');
  assert.equal(h.saved.get(sessionId)?.cloud.version, 2);
  assert.ok(h.progress.some((update) => update.step === 'repair'));
});

test('start fails when the daemon never answers, even after the repair', async () => {
  const h = harness({ health: [false, false] });
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  await h.cloud.stop(hostname);
  await assert.rejects(h.cloud.start(hostname), /its Pane daemon did not answer/u);
});

test('update installs a pinned .deb only on a running sandbox', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  const pane = { debUrl: 'https://example.com/pane_2.4.147_amd64.deb', sha256: 'c'.repeat(64) };
  const updated = await h.cloud.update(hostname, pane, h.onProgress);
  assert.deepEqual(h.boot.updates, [pane.debUrl]);
  assert.equal(updated.daemonVersion, '2.4.146', 'the version the daemon reports wins over the package\'s');
  assert.equal(updated.health?.ok, true);
  await h.cloud.stop(hostname);
  await assert.rejects(h.cloud.update(hostname, pane), /is stopped; start it before updating Pane/u);
});

test('remove deletes the tailnet device, the sandbox, the saved host and the record', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname, sessionId } = await h.cloud.create();
  await h.cloud.stop(hostname);
  await h.cloud.remove(hostname, h.onProgress);
  assert.equal(h.tailnet.devices.length, 0);
  assert.equal(h.provider.sandboxes.size, 0);
  assert.equal(h.saved.has(sessionId), false);
  assert.deepEqual(await h.cloud.list(), []);
  await assert.rejects(h.cloud.status(hostname), /No cloud sandbox matches/u);
});

test('host records hold the paired token but never a provider or Tailscale secret', async () => {
  const h = harness();
  await withCredentials(h);
  const { hostname } = await h.cloud.create();
  const record = fs.readFileSync(path.join(h.dir, 'hosts', `${hostname}.json`), 'utf8');
  for (const secret of SECRETS.slice(0, 3)) assert.ok(!record.includes(secret));
  // Only credentials.json holds those.
  const others = readTree(path.join(h.dir, 'hosts')) + fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8');
  for (const secret of SECRETS.slice(0, 3)) assert.ok(!others.includes(secret));
});

test('the environment can pin the Pane .deb (with its sha256) and the name prefix for new sandboxes', async () => {
  const h = harness({}, {
    RUNPANE_CLOUD_PANE_DEB_URL: 'https://example.com/pane_cs.deb', RUNPANE_CLOUD_PANE_DEB_SHA256: 'd'.repeat(64), RUNPANE_CLOUD_NAME_PREFIX: 'rp-loop-cs',
  });
  await withCredentials(h);
  const info = await h.cloud.create();
  assert.match(info.hostname, /^rp-loop-cs-[a-z0-9]{8}$/u);
  assert.deepEqual(h.boot.paneSources, [{ kind: 'deb-url', url: 'https://example.com/pane_cs.deb', sha256: 'd'.repeat(64) }]);

  const unpinned = harness({}, { RUNPANE_CLOUD_PANE_DEB_URL: 'https://example.com/pane_cs.deb' });
  await withCredentials(unpinned);
  await assert.rejects(unpinned.cloud.create(), /RUNPANE_CLOUD_PANE_DEB_URL needs RUNPANE_CLOUD_PANE_DEB_SHA256/u);
  assert.equal(unpinned.provider.creates.length, 0, 'refused before anything is billed');
});
