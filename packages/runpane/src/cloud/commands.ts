import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { CloudArgs } from './args';
import { syncDesktopProfiles, type DesktopImportResult } from './desktop';
import { decodePairingCode } from './pairing';
import type { BootstrapPort, TailnetDevice, TailnetPort } from './ports';
import type { CloudProvider, CloudSandbox, CloudSize } from './provider';
import {
  DEFAULT_MAX_LIVE_SANDBOXES,
  DEFAULT_NAME_PREFIX,
  DEFAULT_PANE_SOURCE,
  findHost,
  type CloudCredentials,
  type CloudHostProfile,
  type CloudHostRecord,
  type CloudSettings,
  type CloudStore,
  type PaneSource,
} from './store';

/** Everything the cloud commands touch outside this module, so tests can swap in fakes. */
export interface CloudDeps {
  store: CloudStore;
  createProvider(credentials: CloudCredentials): CloudProvider;
  bootstrap: BootstrapPort;
  /** Reads a secret from a file path, or stdin for "-". The value is never echoed. */
  readSecretFile(path: string): Promise<string>;
  stdout(line: string): void;
  stderr(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  env: NodeJS.ProcessEnv;
  /** Desktop Pane data dir used when neither --desktop-dir nor $RUNPANE_CLOUD_DESKTOP_DIR is given. */
  defaultDesktopDir: string;
  /** Runs `runpane cloud coordinator ...` (owned by m4-coordinator). */
  runCoordinator?(argv: string[]): Promise<number>;
}

/**
 * The status vocabulary the coordinator's /cloud/wake also uses (iface-coordinator.md):
 * awake = running and /health answers; asleep = stopped; waking = starting or /health not up yet;
 * daemon-down = running but /health does not answer; lost = the provider no longer has it.
 */
export type CloudHostStatus = 'awake' | 'asleep' | 'waking' | 'stopping' | 'daemon-down' | 'lost';

const SANDBOX_READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 120_000;
const DEFAULT_WAKE_TIMEOUT_MS = 120_000;
const DEFAULT_NEW_HEALTH_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_500;
const STATUS_HEALTH_TIMEOUT_MS = 5_000;
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export async function runCloudCommand(args: CloudArgs, deps: CloudDeps): Promise<number> {
  switch (args.subcommand) {
    case 'setup': return runSetup(args, deps);
    case 'new': return runNew(args, deps);
    case 'list': return runList(args, deps);
    case 'status': return runStatus(args, deps);
    case 'stop': return runStop(args, deps);
    case 'wake': return runWake(args, deps);
    case 'destroy': return runDestroy(args, deps);
    case 'pair': return runPair(args, deps);
    case 'sync': return runSync(args, deps);
    case 'coordinator':
      if (!deps.runCoordinator) throw new Error('runpane cloud coordinator is not available in this build.');
      return deps.runCoordinator(args.passthrough);
  }
}

// ---------------------------------------------------------------- setup

async function runSetup(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const credentials = await deps.store.readCredentials();
  const settings = await deps.store.readSettings();
  const changed: string[] = [];

  if (args.boatKeyFile) {
    credentials.boat = { apiKey: await readRequiredSecret(deps, args.boatKeyFile, 'boat API key') };
    changed.push('boat API key');
  }
  if (args.tailscaleClientId || args.tailscaleSecretFile || args.tailscaleTailnet) {
    const clientId = args.tailscaleClientId ?? credentials.tailscale?.clientId;
    const clientSecret = args.tailscaleSecretFile
      ? await readRequiredSecret(deps, args.tailscaleSecretFile, 'Tailscale OAuth client secret')
      : credentials.tailscale?.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('The Tailscale OAuth client needs both --tailscale-client-id and --tailscale-secret-file.');
    }
    credentials.tailscale = { clientId, clientSecret };
    const tailnet = args.tailscaleTailnet ?? credentials.tailscale?.tailnet;
    if (tailnet) credentials.tailscale.tailnet = tailnet;
    changed.push('Tailscale OAuth client');
  }
  if (args.anthropicKeyFile) {
    credentials.anthropic = { apiKey: await readRequiredSecret(deps, args.anthropicKeyFile, 'Anthropic API key') };
    changed.push('Anthropic API key');
  }

  const nextSettings: CloudSettings = { ...settings };
  if (args.golden) nextSettings.goldenSnapshot = args.golden;
  if (args.noGolden) delete nextSettings.goldenSnapshot;
  if (args.size) nextSettings.size = args.size;
  if (args.namePrefix) nextSettings.namePrefix = args.namePrefix;
  if (args.maxLive) nextSettings.maxLiveSandboxes = args.maxLive;
  if (args.coordinator !== undefined) nextSettings.coordinator = { enabled: args.coordinator };
  const paneSource = paneSourceFromArgs(args);
  if (paneSource) nextSettings.paneSource = paneSource;

  const checks: Record<string, string> = {};
  if (!args.noVerify) {
    if (credentials.boat) {
      const me = await deps.createProvider(credentials).verifyCredentials();
      checks.boat = `ok (${me.account})`;
    }
    if (credentials.tailscale) {
      await deps.bootstrap.createTailnet(credentials.tailscale).findDevicesByHostname('runpane-cloud-setup-check');
      checks.tailscale = 'ok';
    }
  }

  await deps.store.writeCredentials(credentials);
  await deps.store.writeSettings(nextSettings);

  const summary = {
    ok: true,
    dir: deps.store.dir,
    changed,
    configured: {
      boat: Boolean(credentials.boat),
      tailscale: Boolean(credentials.tailscale),
      anthropic: Boolean(credentials.anthropic),
    },
    checks,
    settings: nextSettings,
  };
  if (args.json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    deps.stdout(`runpane cloud: saved to ${deps.store.dir} (files are 0600; keys stay on this machine).`);
    deps.stdout(`  boat API key:            ${summary.configured.boat ? 'set' : 'missing'}${checks.boat ? ` - ${checks.boat}` : ''}`);
    deps.stdout(`  Tailscale OAuth client:  ${summary.configured.tailscale ? 'set' : 'missing'}${checks.tailscale ? ` - ${checks.tailscale}` : ''}`);
    deps.stdout(`  Anthropic API key:       ${summary.configured.anthropic ? 'set' : 'not set (optional)'}`);
    deps.stdout(`  golden snapshot:         ${nextSettings.goldenSnapshot ?? 'none (plain image; bootstrap installs everything)'}`);
    if (!summary.configured.boat || !summary.configured.tailscale) {
      deps.stdout('Next: runpane cloud setup --boat-key-file <path|-> --tailscale-client-id <id> --tailscale-secret-file <path|->');
    } else {
      deps.stdout('Next: runpane cloud new --label "My Session" --yes');
    }
  }
  return 0;
}

async function readRequiredSecret(deps: CloudDeps, file: string, what: string): Promise<string> {
  const value = (await deps.readSecretFile(file)).trim();
  if (!value) throw new Error(`The ${what} file is empty.`);
  return value;
}

function paneSourceFromArgs(args: CloudArgs): PaneSource | undefined {
  if (args.paneDebUrl) return { kind: 'deb-url', url: args.paneDebUrl };
  if (args.paneNpmSpec) return { kind: 'runpane-npm', spec: args.paneNpmSpec };
  if (args.panePreinstalled) return { kind: 'preinstalled' };
  return undefined;
}

// ---------------------------------------------------------------- new

async function runNew(args: CloudArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) {
    throw new Error('runpane cloud new creates a billed cloud sandbox. Rerun with --yes to confirm.');
  }
  const { credentials, provider, tailnetCredentials } = await loadCloud(deps);
  const settings = await deps.store.readSettings();
  const namePrefix = args.namePrefix ?? settings.namePrefix ?? DEFAULT_NAME_PREFIX;
  const size: CloudSize = args.size ?? settings.size ?? 'default';
  const fromSnapshot = args.noGolden ? undefined : args.fromSnapshot ?? settings.goldenSnapshot;
  // A golden image already carries the Pane .deb (m2-dist); a plain image needs it installed.
  const paneSource = paneSourceFromArgs(args) ?? settings.paneSource
    ?? (fromSnapshot ? { kind: 'preinstalled' } : DEFAULT_PANE_SOURCE);
  const maxLive = settings.maxLiveSandboxes ?? DEFAULT_MAX_LIVE_SANDBOXES;
  const progress = (line: string) => (args.json ? deps.stderr(line) : deps.stdout(line));

  const records = await deps.store.listHosts();
  const live = await countLiveSandboxes(provider, records, namePrefix);
  if (live >= maxLive) {
    throw new Error(`Runaway guard: ${live} cloud sandboxes are already live (limit ${maxLive}). Stop or destroy one first, or raise it with runpane cloud setup --max-live <n>.`);
  }

  const sessionId = randomSessionId();
  const hostname = deps.bootstrap.cloudHostname(sessionId, namePrefix);
  const label = args.label ?? hostname;
  const started = deps.now();
  const timings: Record<string, number> = {};

  if (credentials.anthropic) {
    deps.stderr('runpane cloud: note: the saved Anthropic API key is not copied into the sandbox yet; sign agents in inside the Session.');
  }
  progress(`runpane cloud: creating ${size} sandbox ${hostname}${fromSnapshot ? ` from ${fromSnapshot}` : ''}...`);
  const sandbox = await provider.create({
    name: hostname,
    size,
    fromSnapshot,
    idempotencyKey: `runpane-cloud-new-${sessionId}`,
  });
  timings.createMs = deps.now() - started;

  // Record the host before provisioning, so a failure part-way still leaves something `destroy` can find.
  const record: CloudHostRecord = {
    version: 1,
    profile: {
      id: `cloud-${sessionId}`,
      label,
      baseUrl: '',
      token: '',
      transport: 'http+sse',
      cloud: { provider: provider.name, sandboxId: sandbox.id, sessionId, nodeId: '', hostname, version: 1 },
    },
    meta: {
      createdAt: new Date(started).toISOString(),
      size,
      namePrefix,
      magicDnsName: '',
      pairingPath: deps.store.pairingPath(hostname),
      paneSource,
    },
  };
  if (args.repo) {
    record.meta.repo = { url: args.repo };
    if (args.ref) record.meta.repo.ref = args.ref;
  }
  await deps.store.writeHost(record);

  try {
    await waitForSandbox(provider, sandbox.id, 'running', SANDBOX_READY_TIMEOUT_MS, deps);
    timings.readyMs = deps.now() - started;
    progress(`runpane cloud: sandbox ${sandbox.id} is up; joining the tailnet and installing the Pane daemon...`);

    const coordinatorEnabled = settings.coordinator?.enabled === true;
    const outcome = await deps.bootstrap.provision(provider.handle(sandbox.id), {
      sessionId,
      label,
      hostname,
      paneSource,
      repo: record.meta.repo,
      pairingOutputPath: record.meta.pairingPath,
      extraClients: coordinatorEnabled
        ? [{ label: 'runpane-cloud-coordinator', outputPath: deps.store.coordinatorPairingPath(hostname) }]
        : undefined,
      healthTimeoutMs: args.timeoutMs ?? DEFAULT_NEW_HEALTH_TIMEOUT_MS,
      onStep: (step) => progress(`  - ${step}`),
    }, tailnetCredentials);
    timings.provisionedMs = deps.now() - started;

    const pairing = decodePairingCode(await deps.store.readPairing(hostname));
    record.profile = {
      ...record.profile,
      baseUrl: pairing.baseUrl,
      token: pairing.token,
      cloud: { ...record.profile.cloud, nodeId: outcome.nodeId },
    };
    if (pairing.tunnel?.kind === 'tailscale') {
      record.profile.tunnel = { kind: 'tailscale', selected: true };
      if (pairing.tunnel.note) record.profile.tunnel.note = pairing.tunnel.note;
    }
    record.meta.magicDnsName = outcome.magicDnsName;
    if (outcome.daemonVersion) record.meta.daemonVersion = outcome.daemonVersion;
    if (coordinatorEnabled) record.meta.coordinatorPairingPath = deps.store.coordinatorPairingPath(hostname);
    await deps.store.writeHost(record);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (args.keepOnFailure) {
      deps.stderr(`runpane cloud: setup of ${hostname} failed; kept sandbox ${sandbox.id} for debugging (--keep-on-failure). Remove it with: runpane cloud destroy ${hostname} --yes`);
    } else {
      deps.stderr(`runpane cloud: setup of ${hostname} failed; removing its tailnet device and sandbox ${sandbox.id}...`);
      try {
        await destroyHost(record, provider, deps.bootstrap.createTailnet(tailnetCredentials), deps);
        await deps.store.removeHost(hostname);
      } catch (cleanupError) {
        deps.stderr(`runpane cloud: cleanup failed too: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Run runpane cloud destroy ${hostname} --yes.`);
      }
    }
    throw new Error(`runpane cloud new failed: ${reason}`);
  }

  const desktop = await importIntoDesktop(args, deps, [record.profile]);
  timings.totalMs = deps.now() - started;

  if (args.json) {
    deps.stdout(JSON.stringify({
      ok: true,
      host: hostSummary(record),
      pairingPath: record.meta.pairingPath,
      desktop: desktopSummary(desktop),
      timings,
    }, null, 2));
  } else {
    deps.stdout(`runpane cloud: ${hostname} is ready at ${record.profile.baseUrl} (${Math.round(timings.totalMs / 1000)} s).`);
    deps.stdout(`  sandbox: ${sandbox.id}   tailnet node: ${record.profile.cloud.nodeId}`);
    deps.stdout(`  pairing code saved to ${record.meta.pairingPath} (0600; not printed).`);
    printDesktopOutcome(deps, desktop, hostname);
    deps.stdout(`  phone: run \`runpane cloud pair ${hostname}\` and paste the code into https://runpane.com/app/.`);
  }
  return 0;
}

async function countLiveSandboxes(provider: CloudProvider, records: readonly CloudHostRecord[], namePrefix: string): Promise<number> {
  const managedIds = new Set(records.map((record) => record.profile.cloud.sandboxId));
  const sandboxes = await provider.list();
  return sandboxes.filter((sandbox) =>
    (managedIds.has(sandbox.id) || sandbox.name.startsWith(`${namePrefix}-`))
    && sandbox.state !== 'stopped'
    && sandbox.state !== 'gone').length;
}

export function randomSessionId(): string {
  const bytes = randomBytes(10);
  let id = '';
  for (const byte of bytes) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  return id;
}

// ---------------------------------------------------------------- list / status

async function runList(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const { provider } = await loadCloud(deps);
  const records = await deps.store.listHosts();
  const sandboxes = await provider.list();
  const byId = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
  const rows = records.map((record) => {
    const sandbox = byId.get(record.profile.cloud.sandboxId);
    return {
      ...hostSummary(record),
      state: sandbox?.state ?? 'gone',
      providerState: sandbox?.providerState ?? 'not_found',
      size: sandbox?.size ?? record.meta.size,
    };
  });
  const known = new Set(records.map((record) => record.profile.cloud.sandboxId));
  const settings = await deps.store.readSettings();
  const prefixes = new Set([settings.namePrefix ?? DEFAULT_NAME_PREFIX, ...records.map((record) => record.meta.namePrefix)]);
  const unmanaged = sandboxes
    .filter((sandbox) => !known.has(sandbox.id) && [...prefixes].some((prefix) => sandbox.name.startsWith(`${prefix}-`)))
    .map((sandbox) => ({ sandboxId: sandbox.id, name: sandbox.name, state: sandbox.state }));

  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, hosts: rows, unmanaged }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    deps.stdout('No cloud hosts. Create one with: runpane cloud new --label "My Session" --yes');
  } else {
    deps.stdout(formatTable(['HOST', 'LABEL', 'STATE', 'SIZE', 'SANDBOX', 'URL'],
      rows.map((row) => [row.hostname, row.label, row.state, row.size, row.sandboxId, row.baseUrl || '-'])));
  }
  if (unmanaged.length > 0) {
    deps.stdout('');
    deps.stdout(`Sandboxes that look like cloud hosts but are not in ${deps.store.dir}:`);
    for (const sandbox of unmanaged) deps.stdout(`  ${sandbox.sandboxId} ${sandbox.name} (${sandbox.state})`);
  }
  return 0;
}

interface HostStatusReport {
  host: ReturnType<typeof hostSummary>;
  status: CloudHostStatus;
  sandbox: { state: string; providerState: string; size?: string };
  tailnet: { devices: TailnetDevice[]; sameNode: boolean | null };
  health: { ok: boolean; status?: number; version?: string } | null;
}

async function runStatus(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const { provider, tailnet } = await loadCloudWithTailnet(deps);
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const report = await hostStatus(record, provider, tailnet, deps);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, ...report }, null, 2));
  } else {
    deps.stdout(`${record.profile.cloud.hostname}: ${report.status}`);
    deps.stdout(`  sandbox ${record.profile.cloud.sandboxId}: ${report.sandbox.providerState}${report.sandbox.size ? ` (${report.sandbox.size})` : ''}`);
    const device = report.tailnet.devices[0];
    deps.stdout(`  tailnet: ${device ? describeDevice(device) : 'no device'}${report.tailnet.sameNode === false ? ' (node id changed!)' : ''}`);
    deps.stdout(`  daemon: ${report.health ? `${report.health.ok ? 'healthy' : `not answering${report.health.status ? ` (HTTP ${report.health.status})` : ''}`}${report.health.version ? `, version ${report.health.version}` : ''}` : 'not checked (sandbox not running)'}`);
    deps.stdout(`  url: ${record.profile.baseUrl || '-'}`);
  }
  return report.status === 'lost' ? 1 : 0;
}

function describeDevice(device: TailnetDevice): string {
  const parts = [device.name ?? device.hostname, device.nodeId];
  if (device.online !== undefined) parts.push(device.online ? 'online' : 'offline');
  if (device.lastSeen) parts.push(`last seen ${device.lastSeen}`);
  return parts.join(', ');
}

async function hostStatus(record: CloudHostRecord, provider: CloudProvider, tailnet: TailnetPort, deps: CloudDeps): Promise<HostStatusReport> {
  const sandbox = await provider.get(record.profile.cloud.sandboxId);
  const devices = await tailnet.findDevicesByHostname(record.profile.cloud.hostname);
  const sameNode = record.profile.cloud.nodeId
    ? devices.some((device) => device.nodeId === record.profile.cloud.nodeId)
    : null;
  let health: HostStatusReport['health'] = null;
  let status: CloudHostStatus;
  if (sandbox.state === 'gone' || sandbox.state === 'error') {
    status = 'lost';
  } else if (sandbox.state === 'stopped') {
    status = 'asleep';
  } else if (sandbox.state === 'stopping') {
    status = 'stopping';
  } else if (sandbox.state === 'starting') {
    status = 'waking';
  } else {
    const result = record.profile.baseUrl
      ? await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, { timeoutMs: STATUS_HEALTH_TIMEOUT_MS, intervalMs: 1_000 })
      : { ok: false, elapsedMs: 0 };
    health = { ok: result.ok, status: result.status, version: result.version };
    status = result.ok ? 'awake' : 'daemon-down';
  }
  return {
    host: hostSummary(record),
    status,
    sandbox: { state: sandbox.state, providerState: sandbox.providerState, size: sandbox.size },
    tailnet: { devices, sameNode },
    health,
  };
}

// ---------------------------------------------------------------- stop / wake

async function runStop(args: CloudArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) throw new Error('runpane cloud stop powers the sandbox off. Rerun with --yes to confirm.');
  const { provider } = await loadCloud(deps);
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { sandboxId, hostname } = record.profile.cloud;
  const started = deps.now();
  const sandbox = await provider.get(sandboxId);
  if (sandbox.state === 'gone') throw new Error(`${hostname}: the provider no longer has sandbox ${sandboxId}.`);
  if (sandbox.state === 'stopped') {
    report(args, deps, { ok: true, host: hostname, status: 'asleep', alreadyStopped: true }, `${hostname} is already asleep.`);
    return 0;
  }

  // boat's stop is a hard power-off about 1 s after a live snapshot, with no SIGTERM (M0), so flush
  // the page cache first. m2's safe-to-stop API will replace this with a real checkpoint.
  let flushed = false;
  const timings: Record<string, number> = {};
  if (!args.force && sandbox.state === 'running') {
    try {
      const result = await provider.handle(sandboxId).runScript('sync; sleep 0.2; sync', { timeoutSeconds: 30 });
      flushed = result.exitCode === 0;
    } catch (error) {
      deps.stderr(`runpane cloud: could not flush ${hostname} before stopping (${error instanceof Error ? error.message : String(error)}); stopping anyway.`);
    }
    timings.flushMs = deps.now() - started;
  }
  await provider.stop(sandboxId);
  timings.stopAcceptedMs = deps.now() - started;
  let final: CloudSandbox | undefined;
  if (!args.noWait) final = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS, deps);
  const elapsedMs = deps.now() - started;
  report(
    args,
    deps,
    { ok: true, host: hostname, status: final ? 'asleep' : 'stopping', flushed, timings: { ...timings, totalMs: elapsedMs } },
    final ? `${hostname} is asleep (${(elapsedMs / 1000).toFixed(1)} s). Wake it with: runpane cloud wake ${hostname}` : `${hostname} is stopping.`,
  );
  return 0;
}

async function runWake(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const { provider, tailnet } = await loadCloudWithTailnet(deps);
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const { sandboxId, hostname } = record.profile.cloud;
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
  const started = deps.now();
  const timings: Record<string, number> = {};

  let sandbox = await provider.get(sandboxId);
  if (sandbox.state === 'gone' || sandbox.state === 'error') {
    throw new Error(`${hostname} is lost: the provider reports ${sandbox.providerState} for ${sandboxId}.`);
  }
  if (sandbox.state === 'stopping') sandbox = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS, deps);
  const resumed = sandbox.state === 'stopped';
  if (resumed) {
    if (!args.json) deps.stdout(`runpane cloud: waking ${hostname}...`);
    await provider.resume(sandboxId, args.size ? { size: args.size } : undefined);
    timings.resumeCallMs = deps.now() - started;
  }
  await waitForSandbox(provider, sandboxId, 'running', Math.max(timeoutMs - (deps.now() - started), 1_000), deps);
  timings.runningMs = deps.now() - started;
  if (!record.profile.baseUrl) throw new Error(`${hostname} has no daemon address yet; its setup never finished. Destroy it and create a new one.`);
  const health = await deps.bootstrap.waitForDaemonHealth(record.profile.baseUrl, {
    timeoutMs: Math.max(timeoutMs - (deps.now() - started), 1_000),
    intervalMs: 500,
  });
  timings.healthMs = deps.now() - started;
  const devices = await tailnet.findDevicesByHostname(hostname);
  const sameNode = devices.some((device) => device.nodeId === record.profile.cloud.nodeId);
  const summary = {
    ok: health.ok,
    host: hostname,
    status: (health.ok ? 'awake' : 'daemon-down') satisfies CloudHostStatus,
    resumed,
    baseUrl: record.profile.baseUrl,
    sameTailnetNode: sameNode,
    nodeIds: devices.map((device) => device.nodeId),
    version: health.version ?? null,
    timings,
  };
  report(
    args,
    deps,
    summary,
    health.ok
      ? `${hostname} is awake at ${record.profile.baseUrl} (${(timings.healthMs / 1000).toFixed(1)} s${sameNode ? ', same tailnet node' : ', TAILNET NODE CHANGED'}).`
      : `${hostname} is running but its daemon did not answer /health within ${Math.round(timeoutMs / 1000)} s.`,
  );
  return health.ok ? 0 : 1;
}

// ---------------------------------------------------------------- destroy

async function runDestroy(args: CloudArgs, deps: CloudDeps): Promise<number> {
  if (!args.yes) {
    throw new Error('runpane cloud destroy permanently deletes the sandbox, its disk and its tailnet device. Rerun with --yes to confirm.');
  }
  const { provider, tailnet } = await loadCloudWithTailnet(deps);
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const result = await destroyHost(record, provider, tailnet, deps);
  const desktop = await importIntoDesktop(args, deps, [], [record.profile.cloud.sessionId]);
  await deps.store.removeHost(record.profile.cloud.hostname);
  report(
    args,
    deps,
    { ok: true, host: record.profile.cloud.hostname, ...result, desktop: desktopSummary(desktop) },
    `${record.profile.cloud.hostname} destroyed: tailnet device${result.deletedNodeIds.length === 1 ? '' : 's'} ${result.deletedNodeIds.join(', ') || '(none)'} deleted, sandbox ${record.profile.cloud.sandboxId} ${result.sandbox}.`,
  );
  return 0;
}

/** Tailnet device first, then the sandbox (a live node would otherwise linger as an orphan). */
async function destroyHost(record: CloudHostRecord, provider: CloudProvider, tailnet: TailnetPort, _deps: CloudDeps) {
  const { hostname, nodeId, sandboxId } = record.profile.cloud;
  const nodeIds = new Set<string>();
  if (nodeId) nodeIds.add(nodeId);
  for (const device of await tailnet.findDevicesByHostname(hostname)) nodeIds.add(device.nodeId);
  const deletedNodeIds: string[] = [];
  for (const id of nodeIds) {
    await tailnet.deleteDevice(id);
    deletedNodeIds.push(id);
  }
  await provider.destroy(sandboxId);
  const after = await provider.get(sandboxId);
  const remaining = await tailnet.findDevicesByHostname(hostname);
  if (remaining.length > 0) {
    throw new Error(`Tailnet devices for ${hostname} are still listed after delete: ${remaining.map((device) => device.nodeId).join(', ')}.`);
  }
  return { deletedNodeIds, sandbox: after.state === 'gone' ? 'deleted' : `deleting (${after.providerState})` };
}

// ---------------------------------------------------------------- pair / sync

async function runPair(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const record = findHost(await deps.store.listHosts(), requiredHost(args));
  const code = await deps.store.readPairing(record.profile.cloud.hostname);
  decodePairingCode(code);
  if (args.json) {
    deps.stdout(JSON.stringify({ ok: true, host: record.profile.cloud.hostname, code }, null, 2));
  } else {
    deps.stderr('This code grants full control of the cloud Session. Paste it only into your own Pane app or https://runpane.com/app/.');
    deps.stdout(code);
  }
  return 0;
}

async function runSync(args: CloudArgs, deps: CloudDeps): Promise<number> {
  const records = (await deps.store.listHosts()).filter((record) => record.profile.baseUrl && record.profile.token);
  const desktop = await syncDesktopProfiles({
    desktopDir: args.desktopDir ?? deps.env.RUNPANE_CLOUD_DESKTOP_DIR ?? deps.defaultDesktopDir,
    upsert: records.map((record) => record.profile),
  });
  report(
    args,
    deps,
    { ok: true, desktop: desktopSummary(desktop) },
    `Synced ${records.length} cloud host${records.length === 1 ? '' : 's'} into ${desktop.configPath} (added ${desktop.added.length}, updated ${desktop.updated.length}).`,
  );
  return 0;
}

// ---------------------------------------------------------------- shared helpers

async function importIntoDesktop(
  args: CloudArgs,
  deps: CloudDeps,
  upsert: CloudHostProfile[],
  removeSessionIds: string[] = [],
): Promise<DesktopImportResult | { skipped: string }> {
  if (args.noImport) return { skipped: '--no-import' };
  const explicit = args.desktopDir ?? deps.env.RUNPANE_CLOUD_DESKTOP_DIR;
  const desktopDir = explicit || deps.defaultDesktopDir;
  if (!explicit) {
    // Only touch a desktop that exists; a machine without Pane desktop gets instructions instead.
    try {
      await fs.access(`${desktopDir}/config.json`);
    } catch {
      return { skipped: `no Pane desktop config at ${desktopDir}/config.json` };
    }
  }
  try {
    return await syncDesktopProfiles({ desktopDir, upsert, removeSessionIds });
  } catch (error) {
    return { skipped: `could not update ${desktopDir}/config.json: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function desktopSummary(desktop: DesktopImportResult | { skipped: string }) {
  return 'skipped' in desktop
    ? { imported: false, reason: desktop.skipped }
    : { imported: true, configPath: desktop.configPath, added: desktop.added, updated: desktop.updated, removed: desktop.removed };
}

function printDesktopOutcome(deps: CloudDeps, desktop: DesktopImportResult | { skipped: string }, hostname: string): void {
  if ('skipped' in desktop) {
    deps.stdout(`  desktop: not imported (${desktop.skipped}). On the machine with Pane desktop, run \`runpane cloud sync\`, or paste the code from \`runpane cloud pair ${hostname}\` into Settings > Remote Pane.`);
  } else {
    deps.stdout(`  desktop: saved as a remote host in ${desktop.configPath}; pick it in Pane's host switcher.`);
  }
}

function hostSummary(record: CloudHostRecord) {
  return {
    hostname: record.profile.cloud.hostname,
    label: record.profile.label,
    sessionId: record.profile.cloud.sessionId,
    sandboxId: record.profile.cloud.sandboxId,
    nodeId: record.profile.cloud.nodeId,
    baseUrl: record.profile.baseUrl,
    provider: record.profile.cloud.provider,
    createdAt: record.meta.createdAt,
  };
}

/** A command's `--json` result; every one carries `ok`. */
interface CloudJsonResult {
  ok: boolean;
}

function report<Result extends CloudJsonResult>(args: CloudArgs, deps: CloudDeps, json: Result, text: string): void {
  deps.stdout(args.json ? JSON.stringify(json, null, 2) : text);
}

function requiredHost(args: CloudArgs): string {
  if (!args.host) throw new Error(`runpane cloud ${args.subcommand} needs a host.`);
  return args.host;
}

async function loadCloud(deps: CloudDeps) {
  const credentials = await deps.store.readCredentials();
  if (!credentials.boat) throw new Error('No boat API key saved. Run: runpane cloud setup --boat-key-file <path|->');
  if (!credentials.tailscale) {
    throw new Error('No Tailscale OAuth client saved. Run: runpane cloud setup --tailscale-client-id <id> --tailscale-secret-file <path|->');
  }
  return { credentials, provider: deps.createProvider(credentials), tailnetCredentials: credentials.tailscale };
}

async function loadCloudWithTailnet(deps: CloudDeps) {
  const loaded = await loadCloud(deps);
  return { ...loaded, tailnet: deps.bootstrap.createTailnet(loaded.tailnetCredentials) };
}

async function waitForSandbox(
  provider: CloudProvider,
  sandboxId: string,
  wanted: 'running' | 'stopped',
  timeoutMs: number,
  deps: CloudDeps,
): Promise<CloudSandbox> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const sandbox = await provider.get(sandboxId);
    if (sandbox.state === wanted) return sandbox;
    if (sandbox.state === 'gone' || sandbox.state === 'error') {
      throw new Error(`Sandbox ${sandboxId} is ${sandbox.providerState}${sandbox.error ? `: ${sandbox.error}` : ''}.`);
    }
    if (deps.now() >= deadline) {
      throw new Error(`Sandbox ${sandboxId} did not reach ${wanted} within ${Math.round(timeoutMs / 1000)} s (still ${sandbox.providerState}).`);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  return [headers, ...rows]
    .map((row) => row.map((cell, column) => (cell ?? '').padEnd(widths[column])).join('  ').trimEnd())
    .join('\n');
}
