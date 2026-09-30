import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CloudDeps } from '../commands';
import { encodePairingCode } from '../pairing';
import type { BootstrapPort, ProvisionRequest, TailnetDevice, TailnetPort } from '../ports';
import type { CloudProvider, CloudSandbox, CloudSize, CreateSandboxRequest, SandboxHandle } from '../provider';
import { createCloudStore } from '../store';

/**
 * In-memory fakes for the `runpane cloud` tests: a provider whose sandboxes move through states
 * on each poll, a tailnet, and a bootstrap that "joins" the tailnet and writes a pairing file.
 * Nothing here talks to the network.
 */

export interface FakeSandbox extends CloudSandbox {
  /** States still to pass through, one per `get` call, before `state` settles. */
  pending: CloudSandbox['state'][];
}

export interface FakeWorld {
  sandboxes: Map<string, FakeSandbox>;
  devices: TailnetDevice[];
  calls: string[];
  scripts: { sandboxId: string; script: string }[];
  healthy: Set<string>;
  failProvision?: string;
}

export function createFakeWorld(): FakeWorld {
  return { sandboxes: new Map(), devices: [], calls: [], scripts: [], healthy: new Set() };
}

export function createFakeProvider(world: FakeWorld): CloudProvider {
  let counter = 0;
  const createdByKey = new Map<string, string>();
  const need = (id: string): FakeSandbox => {
    const sandbox = world.sandboxes.get(id);
    if (!sandbox) throw new Error(`fake: no sandbox ${id}`);
    return sandbox;
  };
  const snapshot = (sandbox: FakeSandbox): CloudSandbox => ({
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    providerState: sandbox.state,
    size: sandbox.size,
  });
  const handle = (id: string): SandboxHandle => ({
    id,
    async runScript(script) {
      world.calls.push(`script ${id}`);
      world.scripts.push({ sandboxId: id, script });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async writeFile(filePath) {
      world.calls.push(`write ${id} ${filePath}`);
    },
  });
  return {
    name: 'boat',
    async verifyCredentials() {
      return { account: 'fake@example.test' };
    },
    async create(request: CreateSandboxRequest) {
      world.calls.push(`create ${request.name} ${request.size} ${request.fromSnapshot ?? '-'}`);
      const existing = createdByKey.get(request.idempotencyKey);
      if (existing) return snapshot(need(existing));
      counter += 1;
      const sandbox: FakeSandbox = {
        id: `bx_fake${String(counter).padStart(4, '0')}`,
        name: request.name,
        state: 'starting',
        providerState: 'provisioning',
        size: request.size,
        pending: ['starting'],
      };
      world.sandboxes.set(sandbox.id, sandbox);
      createdByKey.set(request.idempotencyKey, sandbox.id);
      return snapshot(sandbox);
    },
    async get(id) {
      const sandbox = world.sandboxes.get(id);
      if (!sandbox) return { id, name: '', state: 'gone', providerState: 'not_found' };
      const next = sandbox.pending.shift();
      if (next === undefined && sandbox.state === 'starting') sandbox.state = 'running';
      if (next === undefined && sandbox.state === 'stopping') sandbox.state = 'stopped';
      return snapshot(sandbox);
    },
    async list() {
      return [...world.sandboxes.values()].map(snapshot);
    },
    async rename(id, name) {
      need(id).name = name;
    },
    async stop(id) {
      world.calls.push(`stop ${id}`);
      const sandbox = need(id);
      sandbox.state = 'stopping';
      sandbox.pending = ['stopping'];
      for (const device of world.devices) if (device.hostname === sandbox.name) device.online = false;
    },
    async resume(id, options?: { size?: CloudSize }) {
      world.calls.push(`resume ${id}${options?.size ? ` ${options.size}` : ''}`);
      const sandbox = need(id);
      if (sandbox.state !== 'stopped') throw new Error('fake: resume of a sandbox that is not stopped');
      sandbox.state = 'starting';
      sandbox.pending = ['starting'];
      if (options?.size) sandbox.size = options.size;
      for (const device of world.devices) if (device.hostname === sandbox.name) device.online = true;
    },
    async destroy(id) {
      world.calls.push(`destroy ${id}`);
      world.sandboxes.delete(id);
    },
    handle,
  };
}

export function createFakeTailnet(world: FakeWorld): TailnetPort {
  return {
    async findDevicesByHostname(hostname) {
      return world.devices.filter((device) => device.hostname === hostname).map((device) => ({ ...device }));
    },
    async deleteDevice(nodeId) {
      world.calls.push(`tailnet-delete ${nodeId}`);
      world.devices = world.devices.filter((device) => device.nodeId !== nodeId);
    },
  };
}

export function createFakeBootstrap(world: FakeWorld): BootstrapPort {
  return {
    cloudHostname: (sessionId, prefix) => `${prefix}-${sessionId.slice(0, 8)}`,
    createTailnet: () => createFakeTailnet(world),
    async waitForDaemonHealth(baseUrl) {
      const host = new URL(baseUrl).hostname.split('.')[0];
      const sandbox = [...world.sandboxes.values()].find((candidate) => candidate.name === host);
      const ok = world.healthy.has(host) && sandbox?.state === 'running';
      return ok ? { ok, elapsedMs: 1, status: 200, version: '2.4.141' } : { ok, elapsedMs: 1 };
    },
    async provision(sandbox: SandboxHandle, request: ProvisionRequest) {
      world.calls.push(`provision ${sandbox.id} ${request.hostname}`);
      if (world.failProvision) throw new Error(world.failProvision);
      const nodeId = `n${request.hostname.replace(/-/g, '')}CNTRL`;
      const magicDnsName = `${request.hostname}.tailtest.ts.net`;
      world.devices.push({ nodeId, hostname: request.hostname, name: magicDnsName, online: true });
      world.healthy.add(request.hostname);
      const code = encodePairingCode({
        v: 1,
        label: request.label,
        baseUrl: `https://${magicDnsName}`,
        token: `secret-token-${request.sessionId}`,
        transport: 'http+sse',
        tunnel: { kind: 'tailscale', selected: true },
      });
      await fs.mkdir(path.dirname(request.pairingOutputPath), { recursive: true });
      await fs.writeFile(request.pairingOutputPath, `${code}\n`, { mode: 0o600 });
      return {
        hostname: request.hostname,
        magicDnsName,
        nodeId,
        baseUrl: `https://${magicDnsName}`,
        pairingPath: request.pairingOutputPath,
        daemonVersion: '2.4.141',
        timings: {},
      };
    },
  };
}

export interface TestHarness {
  deps: CloudDeps;
  world: FakeWorld;
  out: string[];
  err: string[];
  root: string;
  desktopDir: string;
}

export async function createTestHarness(): Promise<TestHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-cloud-test-'));
  const world = createFakeWorld();
  const out: string[] = [];
  const err: string[] = [];
  let clock = 1_000_000;
  const store = createCloudStore(path.join(root, 'cloud'));
  await store.writeCredentials({
    boat: { apiKey: 'boat-test-key' },
    tailscale: { clientId: 'client-id', clientSecret: 'client-secret' },
  });
  const deps: CloudDeps = {
    store,
    createProvider: () => createFakeProvider(world),
    bootstrap: createFakeBootstrap(world),
    readSecretFile: (file) => fs.readFile(file, 'utf8'),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    env: {},
    defaultDesktopDir: path.join(root, 'no-desktop-here'),
  };
  return { deps, world, out, err, root, desktopDir: path.join(root, 'desktop') };
}
