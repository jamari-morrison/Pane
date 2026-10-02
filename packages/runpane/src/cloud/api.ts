import { randomBytes } from 'node:crypto';
import { createBoatProvider } from './boat';
import {
  cloudHostname,
  provisionSandbox,
  repairSandboxTailnet,
  updateSandboxPane,
  type CloudTransportMode,
  type ProvisionStepName,
} from './bootstrap/provision';
import { waitForDaemonHealth, type DaemonHealthResult } from './bootstrap/health';
import { PERSONAL_ORG, type BoatOrg, type CloudProvider, type CloudSandbox, type CloudSandboxState, type CloudSize } from './provider';
import { createDesktopConfigHosts, type SavedRemoteHosts } from './savedHosts';
import {
  createCloudStore,
  DEFAULT_PANE_SOURCE,
  findHost,
  type CloudCredentials,
  type CloudHostRecord,
  type CloudStore,
  type PaneSource,
} from './store';
import { CLOUD_SESSION_TAG, createTailscaleApi, deletableNodeIds, deleteOwnedDevices, type TailscaleApi, type TailscaleOAuthCredentials } from './tailscale';

/**
 * Cloud sandboxes: Pane daemons on boat.dev sandboxes, joined to the user's tailnet and saved as remote hosts.
 * The desktop main process and `runpane cloud` both drive this API; neither ever sees a secret value in a result,
 * a progress message or an error.
 */
export interface CloudSandboxes {
  /** Merges the given credentials into the saved ones, checks them against boat and Tailscale, then saves them (0600). */
  setup(input: CloudCredentialsInput): Promise<CloudCredentialsStatus>;
  getCredentialsStatus(): Promise<CloudCredentialsStatus>;
  /** Creates a sandbox, provisions it and saves it as a remote host. A failed create removes what it made. */
  create(options?: CloudCreateOptions, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Every saved sandbox with its provider state (one provider call per wallet); no daemon health. */
  list(): Promise<CloudSandboxInfo[]>;
  /** One sandbox with its provider state and, when it runs, its daemon's /health. */
  status(host: string): Promise<CloudSandboxInfo>;
  /** Snapshots the sandbox and powers it off (a stopped sandbox costs nothing). Waits until it is stopped. */
  stop(host: string, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Resumes the sandbox, repairs its tailnet node or Serve config when a resume lost them, and waits for /health. */
  start(host: string, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Installs another Pane .deb (https and sha256 required) on a running sandbox and restarts its daemon. */
  update(host: string, pane: { debUrl: string; sha256: string }, onProgress?: CloudProgressListener): Promise<CloudSandboxInfo>;
  /** Deletes the sandbox, its tailnet device, its saved remote host and its local record. */
  remove(host: string, onProgress?: CloudProgressListener): Promise<void>;
}

/** Fields left undefined or empty keep what is saved. */
export interface CloudCredentialsInput {
  boatApiKey?: string;
  /** The boat wallet new sandboxes bill: an org id, its name or `personal`. */
  boatOrg?: string;
  tailscaleClientId?: string;
  tailscaleClientSecret?: string;
  /** Tailnet name; unset, the OAuth client's own tailnet. */
  tailnet?: string;
  /** A Claude subscription token (`claude setup-token`) that agents in every new sandbox sign in with. */
  claudeToken?: string;
}

export interface CloudCredentialsStatus {
  boat: { configured: boolean; org?: BoatOrg };
  tailscale: { configured: boolean };
  claude: { configured: boolean };
  /** boat and Tailscale are both configured: sandboxes can be created. */
  ready: boolean;
}

export interface CloudCreateOptions {
  label?: string;
  size?: CloudSize;
  /** The Pane to install; default the latest release through `runpane@latest`. */
  paneSource?: PaneSource;
  transport?: CloudTransportMode;
  /** The boat wallet to bill instead of the saved one (an org id, its name or `personal`). */
  boatOrg?: string;
  /** Keep the sandbox (and its record) when provisioning fails, for debugging. */
  keepOnFailure?: boolean;
  /** Prefix of the sandbox and tailnet host name (default `rp`): `<prefix>-<8 characters>`. */
  namePrefix?: string;
}

export type CloudProgressStep =
  | 'sandbox'
  | 'tailnet'
  | 'install'
  | 'pairing'
  | 'health'
  | 'saved-host'
  | 'stopping'
  | 'starting'
  | 'repair'
  | 'update'
  | 'removing'
  | 'done';

export interface CloudProgress {
  step: CloudProgressStep;
  /** User-facing and never secret. */
  message: string;
}

export type CloudProgressListener = (progress: CloudProgress) => void;

export interface CloudSandboxInfo {
  hostname: string;
  label: string;
  /** The saved remote host profile's id. */
  profileId: string;
  sessionId: string;
  sandboxId: string;
  state: CloudSandboxState;
  providerState: string;
  baseUrl: string;
  /** https: Tailscale Serve with a certificate; http: plain HTTP inside the tailnet (no certificate). */
  transport: 'https' | 'http';
  size?: CloudSize;
  createdAt: string;
  /** When this library last created or started the sandbox. */
  startedAt?: string;
  /** The Pane package version this library last installed (create or update); the daemon's /health does not report one. */
  daemonVersion?: string;
  org?: BoatOrg;
  health?: { ok: boolean; version?: string };
}

/** The outside world, swappable in tests. */
export interface CloudSandboxesOptions {
  /** Credentials and host records; default `$RUNPANE_CLOUD_DIR`, else `~/.config/runpane-cloud`. */
  dir?: string;
  /** The desktop's saved remote hosts; default the desktop's config.json on disk. */
  savedHosts?: SavedRemoteHosts;
  store?: CloudStore;
  createProvider?: (apiKey: string, org?: string) => CloudProvider;
  createTailscale?: (credentials: TailscaleOAuthCredentials) => TailscaleApi;
  bootstrap?: CloudBootstrap;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Defaults for `create` that tests and pinned rollouts set without a UI: `RUNPANE_CLOUD_PANE_DEB_URL` with
   * `RUNPANE_CLOUD_PANE_DEB_SHA256` (the Pane .deb to install) and `RUNPANE_CLOUD_NAME_PREFIX`. Default process.env.
   */
  env?: NodeJS.ProcessEnv;
}

export interface CloudBootstrap {
  provision: typeof provisionSandbox;
  repair: typeof repairSandboxTailnet;
  update: typeof updateSandboxPane;
  waitForHealth: (baseUrl: string, options: { timeoutMs: number; intervalMs?: number }) => Promise<DaemonHealthResult>;
}

const SANDBOX_READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 120_000;
const START_HEALTH_CHECK_MS = 30_000;
const REPAIRED_HEALTH_TIMEOUT_MS = 90_000;
const CREATE_HEALTH_TIMEOUT_MS = 180_000;
const UPDATE_HEALTH_TIMEOUT_MS = 120_000;
const STATUS_HEALTH_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_NAME_PREFIX = 'rp';
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function createCloudSandboxes(options: CloudSandboxesOptions = {}): CloudSandboxes {
  const store = options.store ?? createCloudStore(options.dir);
  const savedHosts = options.savedHosts ?? createDesktopConfigHosts();
  const createProvider = options.createProvider ?? ((apiKey: string, org?: string) => createBoatProvider({ apiKey, org }));
  const createTailscale = options.createTailscale ?? ((credentials: TailscaleOAuthCredentials) => createTailscaleApi(credentials));
  const bootstrap: CloudBootstrap = options.bootstrap ?? {
    provision: provisionSandbox,
    repair: repairSandboxTailnet,
    update: updateSandboxPane,
    waitForHealth: (baseUrl, healthOptions) => waitForDaemonHealth(baseUrl, healthOptions),
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;

  async function credentialsStatus(): Promise<CloudCredentialsStatus> {
    const credentials = await store.readCredentials();
    const settings = await store.readSettings();
    const status: CloudCredentialsStatus = {
      boat: { configured: Boolean(credentials.boat) },
      tailscale: { configured: Boolean(credentials.tailscale) },
      claude: { configured: Boolean(credentials.claude) },
      ready: Boolean(credentials.boat && credentials.tailscale),
    };
    if (settings.boatOrg) status.boat.org = settings.boatOrg;
    return status;
  }

  async function loadCloud() {
    const credentials = await store.readCredentials();
    if (!credentials.boat) throw new Error('No boat API key is saved. Add it in Settings > Remote Access, or run runpane cloud setup.');
    if (!credentials.tailscale) throw new Error('No Tailscale OAuth client is saved. Add it in Settings > Remote Access, or run runpane cloud setup.');
    return { credentials, boatKey: credentials.boat.apiKey, tailscale: credentials.tailscale };
  }

  async function loadHost(host: string) {
    const loaded = await loadCloud();
    const record = findHost(await store.listHosts(), host);
    return { ...loaded, record, provider: createProvider(loaded.boatKey, record.meta.boatOrg?.id) };
  }

  async function waitForSandbox(provider: CloudProvider, sandboxId: string, wanted: 'running' | 'stopped', timeoutMs: number): Promise<CloudSandbox> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state === wanted) return sandbox;
      if (sandbox.state === 'gone' || sandbox.state === 'error') {
        throw new Error(`Sandbox ${sandboxId} is ${sandbox.providerState}${sandbox.error ? `: ${sandbox.error}` : ''}.`);
      }
      if (now() >= deadline) {
        throw new Error(`Sandbox ${sandboxId} did not reach ${wanted} within ${Math.round(timeoutMs / 1000)} s (still ${sandbox.providerState}).`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** Tailnet devices first, then the sandbox (a live node would otherwise linger as an orphan). */
  async function destroyHost(record: CloudHostRecord, provider: CloudProvider, tailnet: TailscaleApi): Promise<void> {
    const { hostname, nodeId, sandboxId } = record.profile.cloud;
    await deleteOwnedDevices(tailnet, hostname, nodeId || undefined, () => undefined);
    await provider.destroy(sandboxId);
    const remaining = deletableNodeIds(await tailnet.findDevicesByHostname(hostname), [CLOUD_SESSION_TAG]).nodeIds;
    if (remaining.length > 0) {
      throw new Error(`Tailnet devices for ${hostname} are still listed after delete: ${remaining.join(', ')}.`);
    }
  }

  return {
    async setup(input) {
      const credentials = await store.readCredentials();
      const settings = await store.readSettings();
      const boatApiKey = nonEmpty(input.boatApiKey);
      if (boatApiKey) credentials.boat = { apiKey: boatApiKey };
      const clientId = nonEmpty(input.tailscaleClientId) ?? credentials.tailscale?.clientId;
      const clientSecret = nonEmpty(input.tailscaleClientSecret) ?? credentials.tailscale?.clientSecret;
      const tailnet = nonEmpty(input.tailnet) ?? credentials.tailscale?.tailnet;
      const tailscaleChanged = Boolean(nonEmpty(input.tailscaleClientId) || nonEmpty(input.tailscaleClientSecret) || nonEmpty(input.tailnet));
      if (tailscaleChanged) {
        if (!clientId || !clientSecret) throw new Error('The Tailscale OAuth client needs both its client id and its secret.');
        credentials.tailscale = tailnet ? { clientId, clientSecret, tailnet } : { clientId, clientSecret };
      }
      const claudeToken = nonEmpty(input.claudeToken);
      if (claudeToken) credentials.claude = { oauthToken: claudeToken };

      const wantedOrg = nonEmpty(input.boatOrg);
      if (wantedOrg && !credentials.boat) throw new Error('Choosing a boat wallet needs the boat API key.');
      if (credentials.boat && (boatApiKey || wantedOrg)) {
        const provider = createProvider(credentials.boat.apiKey);
        try {
          await provider.verifyCredentials();
        } catch (error) {
          throw new Error(`The boat API key was not accepted: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (wantedOrg) settings.boatOrg = await resolveBoatOrg(provider, wantedOrg);
      }
      if (credentials.tailscale && tailscaleChanged) {
        try {
          await createTailscale(credentials.tailscale).listDevices();
        } catch (error) {
          throw new Error(`The Tailscale OAuth client was not accepted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await store.writeCredentials(credentials);
      await store.writeSettings(settings);
      return credentialsStatus();
    },

    getCredentialsStatus: credentialsStatus,

    async create(createOptions = {}, onProgress) {
      const progress = (step: CloudProgressStep, message: string) => onProgress?.({ step, message });
      const { credentials, boatKey, tailscale } = await loadCloud();
      const settings = await store.readSettings();
      const org = createOptions.boatOrg
        ? await resolveBoatOrg(createProvider(boatKey), createOptions.boatOrg)
        : settings.boatOrg;
      const provider = createProvider(boatKey, org?.id);
      const size = createOptions.size ?? 'default';
      const paneSource = createOptions.paneSource ?? paneSourceFromEnv(env) ?? DEFAULT_PANE_SOURCE;
      const sessionId = randomSessionId();
      const hostname = cloudHostname(sessionId, createOptions.namePrefix ?? nonEmpty(env.RUNPANE_CLOUD_NAME_PREFIX) ?? DEFAULT_NAME_PREFIX);
      const label = createOptions.label?.trim() || hostname;
      const startedAt = new Date(now()).toISOString();

      progress('sandbox', `Creating a ${size} sandbox ${hostname}...`);
      const sandbox = await provider.create({ name: hostname, size, org: org?.id, idempotencyKey: `runpane-cloud-new-${sessionId}` });
      // Recorded before provisioning, so a failure part-way still leaves something remove() can find.
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
        meta: { createdAt: startedAt, startedAt, size, magicDnsName: '', paneSource },
      };
      const billedOrg = sandbox.org ?? org;
      if (billedOrg) record.meta.boatOrg = billedOrg;
      await store.writeHost(record);

      let health: DaemonHealthResult;
      try {
        if (sandbox.name !== hostname) await provider.rename(sandbox.id, hostname);
        const ready = await waitForSandbox(provider, sandbox.id, 'running', SANDBOX_READY_TIMEOUT_MS);
        if (ready.org) record.meta.boatOrg = ready.org;
        if (org && record.meta.boatOrg && record.meta.boatOrg.id !== org.id) {
          throw new Error(`boat billed ${describeOrg(record.meta.boatOrg)} instead of the requested ${describeOrg(org)}.`);
        }
        progress('tailnet', `Sandbox ${sandbox.id} is up; joining your tailnet...`);
        const outcome = await bootstrap.provision(provider.handle(sandbox.id), {
          sessionId,
          label,
          hostname,
          tailscale: createTailscale(tailscale),
          paneSource,
          agentEnv: agentEnvironment(credentials),
          transport: createOptions.transport ?? 'auto',
          healthTimeoutMs: CREATE_HEALTH_TIMEOUT_MS,
          onStep: (step) => {
            if (step.state === 'start') progress(progressStepFor(step.step), describeStep(step.step));
          },
        });
        health = outcome.health;
        record.profile = {
          ...record.profile,
          baseUrl: outcome.pairing.baseUrl,
          token: outcome.pairing.token,
          cloud: { ...record.profile.cloud, nodeId: outcome.nodeId },
        };
        if (outcome.pairing.tunnel?.kind === 'tailscale') {
          record.profile.tunnel = { kind: 'tailscale', selected: true };
          if (outcome.pairing.tunnel.note) record.profile.tunnel.note = outcome.pairing.tunnel.note;
        }
        record.meta.magicDnsName = outcome.magicDnsName;
        if (outcome.daemonVersion) record.meta.daemonVersion = outcome.daemonVersion;
        await store.writeHost(record);
        progress('saved-host', `Saving ${label} as a remote host...`);
        await savedHosts.upsert(record.profile);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!createOptions.keepOnFailure) {
          progress('removing', `Setup failed; removing ${hostname}...`);
          try {
            await destroyHost(record, provider, createTailscale(tailscale));
            await store.removeHost(hostname);
          } catch (cleanupError) {
            throw new Error(`Creating ${hostname} failed (${reason}), and removing it failed too (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}). Remove it with runpane cloud remove ${hostname}.`);
          }
        }
        throw new Error(`Creating ${hostname} failed: ${reason}`);
      }
      progress('done', `${label} is ready at ${record.profile.baseUrl}.`);
      return sandboxInfo(record, await provider.get(sandbox.id), health);
    },

    async list() {
      const records = await store.listHosts();
      if (records.length === 0) return [];
      const { boatKey } = await loadCloud();
      // One list call per wallet the records bill, each scoped to that wallet.
      const sandboxes = new Map<string, CloudSandbox>();
      for (const org of new Set(records.map((record) => record.meta.boatOrg?.id))) {
        for (const sandbox of await createProvider(boatKey, org).list()) sandboxes.set(sandbox.id, sandbox);
      }
      return records.map((record) => sandboxInfo(record, sandboxes.get(record.profile.cloud.sandboxId)));
    },

    async status(host) {
      const { record, provider } = await loadHost(host);
      const sandbox = await provider.get(record.profile.cloud.sandboxId);
      const health = sandbox.state === 'running' && record.profile.baseUrl
        ? await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: STATUS_HEALTH_TIMEOUT_MS, intervalMs: 1_000 })
        : undefined;
      return sandboxInfo(record, sandbox, health);
    },

    async stop(host, onProgress) {
      const { record, provider } = await loadHost(host);
      const { sandboxId, hostname } = record.profile.cloud;
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state === 'gone') throw new Error(`The provider no longer has ${hostname}'s sandbox ${sandboxId}.`);
      if (sandbox.state === 'stopped') return sandboxInfo(record, sandbox);
      onProgress?.({ step: 'stopping', message: `Stopping ${record.profile.label}...` });
      if (sandbox.state === 'running') {
        // boat powers off right after its snapshot, with no SIGTERM: flush the page cache first. Best effort.
        await provider.handle(sandboxId).runScript('sync; sleep 0.2; sync', { timeoutSeconds: 30 }).catch(() => undefined);
      }
      if (sandbox.state !== 'stopping') await provider.stop(sandboxId);
      const stopped = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS);
      onProgress?.({ step: 'done', message: `${record.profile.label} is stopped.` });
      return sandboxInfo(record, stopped);
    },

    async start(host, onProgress) {
      const { record, provider, tailscale } = await loadHost(host);
      const { sandboxId, hostname } = record.profile.cloud;
      if (!record.profile.baseUrl) throw new Error(`${hostname} never finished its setup. Remove it and create a new one.`);
      let sandbox = await provider.get(sandboxId);
      if (sandbox.state === 'gone' || sandbox.state === 'error') {
        throw new Error(`${hostname} is lost: the provider reports ${sandbox.providerState} for ${sandboxId}.`);
      }
      onProgress?.({ step: 'starting', message: `Starting ${record.profile.label}...` });
      if (sandbox.state === 'stopping') sandbox = await waitForSandbox(provider, sandboxId, 'stopped', STOP_TIMEOUT_MS);
      if (sandbox.state === 'stopped') {
        await provider.resume(sandboxId);
        record.meta.startedAt = new Date(now()).toISOString();
        await store.writeHost(record);
      }
      sandbox = await waitForSandbox(provider, sandboxId, 'running', SANDBOX_READY_TIMEOUT_MS);
      // A healthy start answers in about 10 s; after that, check the node before waiting longer.
      let health = await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: START_HEALTH_CHECK_MS, intervalMs: 500 });
      if (!health.ok) {
        onProgress?.({ step: 'repair', message: `${record.profile.label} is not answering yet; checking its tailnet node...` });
        const repair = await bootstrap.repair(provider.handle(sandboxId), {
          hostname,
          tailscale: createTailscale(tailscale),
          oldNodeId: record.profile.cloud.nodeId || undefined,
          transport: hostTransport(record),
        });
        if (repair.reenrolled) {
          // Same MagicDNS name and address; only the node id changes.
          record.profile.cloud = { ...record.profile.cloud, nodeId: repair.nodeId, version: record.profile.cloud.version + 1 };
          await store.writeHost(record);
          await savedHosts.upsert(record.profile);
        }
        health = await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: REPAIRED_HEALTH_TIMEOUT_MS, intervalMs: 500 });
      }
      if (!health.ok) throw new Error(`${record.profile.label} is running, but its Pane daemon did not answer at ${record.profile.baseUrl}.`);
      onProgress?.({ step: 'done', message: `${record.profile.label} is running.` });
      return sandboxInfo(record, sandbox, health);
    },

    async update(host, pane, onProgress) {
      const { record, provider } = await loadHost(host);
      const { sandboxId } = record.profile.cloud;
      const sandbox = await provider.get(sandboxId);
      if (sandbox.state !== 'running') throw new Error(`${record.profile.label} is ${sandbox.state}; start it before updating Pane.`);
      onProgress?.({ step: 'update', message: `Installing Pane on ${record.profile.label}...` });
      const installed = await bootstrap.update(provider.handle(sandboxId), pane);
      const health = await bootstrap.waitForHealth(record.profile.baseUrl, { timeoutMs: UPDATE_HEALTH_TIMEOUT_MS, intervalMs: 1_000 });
      if (!health.ok) throw new Error(`Pane was installed on ${record.profile.label}, but its daemon did not come back at ${record.profile.baseUrl}.`);
      const version = health.version ?? installed.version;
      if (version) record.meta.daemonVersion = version;
      record.meta.paneSource = { kind: 'deb-url', url: pane.debUrl, sha256: pane.sha256 };
      await store.writeHost(record);
      onProgress?.({ step: 'done', message: `${record.profile.label} runs Pane ${version ?? '(version unknown)'}.` });
      return sandboxInfo(record, sandbox, health);
    },

    async remove(host, onProgress) {
      const { record, provider, tailscale } = await loadHost(host);
      onProgress?.({ step: 'removing', message: `Removing ${record.profile.label}...` });
      await destroyHost(record, provider, createTailscale(tailscale));
      await savedHosts.remove(record.profile.cloud.sessionId);
      await store.removeHost(record.profile.cloud.hostname);
      onProgress?.({ step: 'done', message: `${record.profile.label} is removed.` });
    },
  };
}

function sandboxInfo(record: CloudHostRecord, sandbox?: CloudSandbox, health?: DaemonHealthResult): CloudSandboxInfo {
  const info: CloudSandboxInfo = {
    hostname: record.profile.cloud.hostname,
    label: record.profile.label,
    profileId: record.profile.id,
    sessionId: record.profile.cloud.sessionId,
    sandboxId: record.profile.cloud.sandboxId,
    state: sandbox?.state ?? 'gone',
    providerState: sandbox?.providerState ?? 'not_found',
    baseUrl: record.profile.baseUrl,
    transport: hostTransport(record),
    size: sandbox?.size ?? record.meta.size,
    createdAt: record.meta.createdAt,
  };
  if (record.meta.startedAt) info.startedAt = record.meta.startedAt;
  if (record.meta.daemonVersion) info.daemonVersion = record.meta.daemonVersion;
  const org = sandbox?.org ?? record.meta.boatOrg;
  if (org) info.org = org;
  if (health) info.health = health.version ? { ok: health.ok, version: health.version } : { ok: health.ok };
  return info;
}

function paneSourceFromEnv(env: NodeJS.ProcessEnv): PaneSource | undefined {
  const url = nonEmpty(env.RUNPANE_CLOUD_PANE_DEB_URL);
  if (!url) return undefined;
  const sha256 = nonEmpty(env.RUNPANE_CLOUD_PANE_DEB_SHA256);
  // Installed as root: the digest is what vouches for the package.
  if (!sha256) throw new Error('RUNPANE_CLOUD_PANE_DEB_URL needs RUNPANE_CLOUD_PANE_DEB_SHA256.');
  return { kind: 'deb-url', url, sha256 };
}

function hostTransport(record: CloudHostRecord): 'https' | 'http' {
  return record.profile.baseUrl.startsWith('http://') ? 'http' : 'https';
}

/** The agent sign-in every new sandbox gets, as `KEY=value` lines; undefined when none is saved. */
function agentEnvironment(credentials: CloudCredentials): string | undefined {
  return credentials.claude ? `CLAUDE_CODE_OAUTH_TOKEN=${credentials.claude.oauthToken}\n` : undefined;
}

function progressStepFor(step: ProvisionStepName): CloudProgressStep {
  switch (step) {
    case 'agent-env':
    case 'agent-prompts':
    case 'install-pane':
      return 'install';
    case 'pairing':
      return 'pairing';
    case 'health':
    case 'cert-check':
    case 'serve-http':
    case 'serve-guard':
      return 'health';
    default:
      return 'tailnet';
  }
}

function describeStep(step: ProvisionStepName): string {
  switch (step) {
    case 'upload-scripts': return 'Uploading the setup scripts...';
    case 'identity': return 'Resetting the sandbox identity...';
    case 'tailscale-install': return 'Installing Tailscale...';
    case 'check': return 'Checking the sandbox identity...';
    case 'firewall': return 'Closing inbound tailnet ports...';
    case 'tailscale-join': return 'Joining your tailnet...';
    case 'agent-env': return 'Signing agents in...';
    case 'agent-prompts': return 'Answering Claude Code\'s first-run prompts...';
    case 'install-pane': return 'Installing Pane...';
    case 'pairing': return 'Pairing...';
    case 'health': return 'Waiting for the Pane daemon...';
    case 'cert-check': return 'Checking the HTTPS certificate...';
    case 'serve-http': return 'Serving over plain HTTP inside your tailnet (no HTTPS certificate)...';
    case 'serve-guard': return 'Keeping Tailscale Serve across restarts...';
  }
}

/** Finds a wallet by id, name (case-insensitive) or `personal`. */
async function resolveBoatOrg(provider: CloudProvider, wanted: string): Promise<BoatOrg> {
  const orgs = await provider.listOrgs();
  const needle = wanted.trim().toLowerCase();
  const byId = orgs.find((org) => org.id.toLowerCase() === needle);
  const matches = byId ? [byId] : orgs.filter((org) => org.name.toLowerCase() === needle);
  if (matches.length > 1) throw new Error(`Several boat organizations are named "${wanted}"; use the id: ${matches.map((org) => org.id).join(', ')}.`);
  const [match] = matches;
  if (!match) {
    throw new Error(`No boat wallet "${wanted}". Yours: ${orgs.map((org) => `${org.name} (${org.id})${org.active ? ' [active]' : ''}`).join(', ')}.`);
  }
  return { id: match.id, name: match.name };
}

function describeOrg(org: BoatOrg): string {
  return org.id === PERSONAL_ORG.id ? 'Personal' : `${org.name} (${org.id})`;
}

function randomSessionId(): string {
  let id = '';
  for (const byte of randomBytes(10)) id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  return id;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
