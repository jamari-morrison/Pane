import type {
  CloudCredentialStatus,
  CloudCredentialsUpdate,
  CloudSandboxAction,
  CloudSandboxCreateRequest,
  CloudSandboxesSnapshot,
  CloudSandboxProgressStep,
  CloudSandboxState,
  CloudSandboxView,
} from '../../../shared/types/cloudSandboxes';
import type {
  CloudCredentialsStatus,
  CloudProgress,
  CloudSandboxes,
  CloudSandboxInfo,
} from '../../../packages/runpane/src/cloud/api';

/**
 * Cloud sandboxes (experimental). runpane's cloud library (packages/runpane/src/cloud/api.ts) creates,
 * stops, starts, updates and removes the sandboxes; this service only calls it, remembers what this app
 * started, and turns both into the snapshot the Remote Access settings and host switcher render.
 */

/** The parts of the cloud library this app calls. */
export type CloudSandboxLibrary = Pick<
  CloudSandboxes,
  'setup' | 'getCredentialsStatus' | 'create' | 'list' | 'stop' | 'start' | 'update' | 'remove' | 'syncAgentDefaults'
>;

/** A Pane .deb the cloud library installs on a running sandbox: https only, checked against sha256. */
export interface CloudPaneDeb {
  debUrl: string;
  sha256: string;
}

export class CloudSandboxesUnavailableError extends Error {
  constructor() {
    super('Cloud sandboxes are not available in this build of Pane.');
    this.name = 'CloudSandboxesUnavailableError';
  }
}

interface CloudSandboxOperation {
  action: CloudSandboxAction;
  running: boolean;
  /** Set for creates, so Retry can run the same request again. */
  request?: CloudSandboxCreateRequest;
  steps: CloudSandboxProgressStep[];
  error?: string;
}

interface CloudSandboxManagerOptions {
  loadLibrary: () => Promise<CloudSandboxLibrary>;
  onChange: (snapshot: CloudSandboxesSnapshot) => void;
  /** This app's own Pane version, which Update Pane installs on a sandbox; unknown offers no update. */
  appVersion?: string;
  /** Asks a running sandbox's daemon for its Pane version through the saved host profile. */
  readDaemonVersion: (profileId: string) => Promise<string | undefined>;
  /** The Pane .deb for a version, from that release's published checksums. */
  resolvePaneDeb: (version: string) => Promise<CloudPaneDeb>;
  /**
   * The Claude Code default model new panels in a sandbox should start with (null: unknown right now, so nothing is
   * sent and every sandbox keeps the model it has). The library reads the same source when it applies the model, so
   * this only decides when a sandbox needs it again.
   */
  readDefaultClaudeModel: () => Promise<string | null>;
}

type HostAction = Exclude<CloudSandboxAction, 'create'>;

const CREATE_ID_PREFIX = 'create:';
const NO_CREDENTIALS: CloudCredentialStatus = { boat: false, tailscale: false, claude: false };

export class CloudSandboxManager {
  private libraryPromise: Promise<CloudSandboxLibrary> | null = null;
  private available = true;
  private credentials: CloudCredentialStatus = NO_CREDENTIALS;
  private listed: CloudSandboxInfo[] = [];
  private loadError: string | undefined;
  private readonly operations = new Map<string, CloudSandboxOperation>();
  /** Daemon versions by hostname, read while each sandbox runs. */
  private readonly daemonVersions = new Map<string, string>();
  /** The default Claude model each sandbox was last given, by hostname; absent means unknown. */
  private readonly syncedClaudeModels = new Map<string, string | null>();
  private readonly syncingClaudeModels = new Set<string>();

  constructor(private readonly options: CloudSandboxManagerOptions) {}

  getSnapshot(): CloudSandboxesSnapshot {
    const rows: CloudSandboxView[] = [];
    for (const [id, operation] of this.operations) {
      if (!id.startsWith(CREATE_ID_PREFIX) || !operation.request) continue;
      rows.push({
        id,
        label: operation.request.name,
        state: operation.running ? 'creating' : 'error',
        size: operation.request.size,
        steps: [...operation.steps],
        error: operation.error,
        failedAction: operation.error ? 'create' : undefined,
      });
    }
    for (const summary of this.listed) {
      const operation = this.operations.get(summary.hostname);
      const daemonVersion = summary.state === 'running'
        ? this.daemonVersions.get(summary.hostname) ?? summary.daemonVersion
        : undefined;
      rows.push({
        id: summary.hostname,
        label: summary.label,
        hostname: summary.hostname,
        profileId: summary.profileId,
        state: getViewState(summary.state),
        size: summary.size ?? 'default',
        startedAt: summary.state === 'running' ? summary.startedAt : undefined,
        daemonVersion,
        updateAvailable: Boolean(this.options.appVersion) && daemonVersion !== undefined
          && comparePaneVersions(daemonVersion, this.options.appVersion ?? '') !== 0,
        pending: operation?.running ? getPendingAction(operation.action) : undefined,
        error: operation?.error ?? (summary.state === 'gone' ? 'boat.dev no longer has this sandbox.' : undefined),
        failedAction: operation?.error ? operation.action : undefined,
      });
    }
    return {
      available: this.available,
      credentials: { ...this.credentials },
      sandboxes: rows,
      loadError: this.loadError,
    };
  }

  /** Re-reads the saved credentials and the provider's list, then each running daemon's version. */
  async refresh(): Promise<CloudSandboxesSnapshot> {
    const library = await this.getLibrary();
    if (!library) return this.getSnapshot();
    try {
      const [credentials, listed] = await Promise.all([library.getCredentialsStatus(), library.list()]);
      this.credentials = toCredentialStatus(credentials);
      this.listed = listed;
      this.loadError = undefined;
    } catch (error) {
      this.loadError = getCloudErrorMessage(error, 'Failed to load cloud sandboxes');
    }
    const snapshot = this.emit();
    // Versions arrive in a later snapshot so a slow or asleep daemon never holds up the list.
    for (const summary of this.listed) void this.readDaemonVersion(summary);
    void this.syncDefaultClaudeModel();
    return snapshot;
  }

  async updateCredentials(update: CloudCredentialsUpdate): Promise<CloudSandboxesSnapshot> {
    const library = await this.requireLibrary();
    this.credentials = toCredentialStatus(await library.setup({
      boatApiKey: update.boatApiKey,
      boatOrg: update.boatOrg,
      tailscaleClientId: update.tailscale?.clientId,
      tailscaleClientSecret: update.tailscale?.clientSecret,
      claudeToken: update.claudeToken,
    }));
    return this.emit();
  }

  /** Resolves with the snapshot once the sandbox is ready; a failure stays on its row for Retry. */
  async create(request: CloudSandboxCreateRequest): Promise<CloudSandboxesSnapshot> {
    const library = await this.requireLibrary();
    const id = `${CREATE_ID_PREFIX}${request.name}`;
    if (this.operations.get(id)?.running) throw new Error(`"${request.name}" is already being created.`);
    if (this.listed.some((summary) => summary.label === request.name)) {
      throw new Error(`A cloud sandbox named "${request.name}" already exists.`);
    }
    const operation: CloudSandboxOperation = { action: 'create', running: true, request, steps: [] };
    this.operations.set(id, operation);
    this.emit();
    try {
      const claudeModel = await this.readDefaultClaudeModel();
      const summary = await library.create({ label: request.name, size: request.size }, (progress) => {
        operation.steps = applyProgress(operation.steps, progress);
        this.emit();
      });
      this.operations.delete(id);
      this.replaceListed(summary.hostname, summary);
      if (claudeModel !== null) this.syncedClaudeModels.set(summary.hostname, claudeModel);
      void this.readDaemonVersion(summary);
    } catch (error) {
      operation.running = false;
      operation.error = getCloudErrorMessage(error, `Failed to create ${request.name}`);
    }
    return this.emit();
  }

  start(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'start', (library, hostname) => library.start(hostname));
  }

  stop(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'stop', (library, hostname) => library.stop(hostname));
  }

  /** Installs this app's Pane version on a running sandbox. */
  update(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'update', async (library, hostname) => {
      const { appVersion } = this.options;
      if (!appVersion) throw new Error('This app does not know its own Pane version.');
      return library.update(hostname, await this.options.resolvePaneDeb(appVersion));
    });
  }

  remove(id: string): Promise<CloudSandboxesSnapshot> {
    return this.runHostAction(id, 'remove', async (library, hostname) => {
      await library.remove(hostname);
      return null;
    });
  }

  /** Runs a failed row's action again. */
  async retry(id: string): Promise<CloudSandboxesSnapshot> {
    const operation = this.operations.get(id);
    if (!operation?.error) throw new Error('Nothing to retry for this cloud sandbox.');
    if (operation.action === 'create') {
      if (!operation.request) throw new Error('Nothing to retry for this cloud sandbox.');
      this.operations.delete(id);
      return this.create(operation.request);
    }
    return this.runListedAction(id, operation.action);
  }

  /** Clears a row's error; a failed create's row goes away. */
  dismiss(id: string): CloudSandboxesSnapshot {
    if (!this.operations.get(id)?.running) this.operations.delete(id);
    return this.emit();
  }

  private runListedAction(id: string, action: HostAction): Promise<CloudSandboxesSnapshot> {
    if (action === 'start') return this.start(id);
    if (action === 'stop') return this.stop(id);
    if (action === 'update') return this.update(id);
    return this.remove(id);
  }

  private async runHostAction(
    id: string,
    action: HostAction,
    run: (library: CloudSandboxLibrary, hostname: string) => Promise<CloudSandboxInfo | null>,
  ): Promise<CloudSandboxesSnapshot> {
    const library = await this.requireLibrary();
    const listed = this.listed.find((summary) => summary.hostname === id);
    if (!listed) throw new Error(`Unknown cloud sandbox "${id}".`);
    if (this.operations.get(id)?.running) throw new Error(`${listed.label} is busy; try again when it finishes.`);
    const operation: CloudSandboxOperation = { action, running: true, steps: [] };
    this.operations.set(id, operation);
    this.emit();
    try {
      // start and update give the sandbox the user's default model; remember which one it got.
      const claudeModel = action === 'start' || action === 'update' ? await this.readDefaultClaudeModel() : undefined;
      const summary = await run(library, listed.hostname);
      this.operations.delete(id);
      this.daemonVersions.delete(id);
      if (!summary) this.syncedClaudeModels.delete(id);
      else if (claudeModel) this.syncedClaudeModels.set(id, claudeModel);
      this.replaceListed(id, summary);
      if (summary) void this.readDaemonVersion(summary);
    } catch (error) {
      operation.running = false;
      operation.error = getCloudErrorMessage(error, `Failed to ${action} ${listed.label}`);
    }
    return this.emit();
  }

  /**
   * Gives running sandboxes the user's default Claude model when it differs from the one they last got. With a
   * profile id (the desktop just connected to that host) it syncs that sandbox whatever it last got. Best effort:
   * a failure leaves the sandbox's record unchanged, so the next refresh tries again.
   */
  async syncDefaultClaudeModel(target?: { profileId: string }): Promise<void> {
    const library = await this.getLibrary();
    if (!library) return;
    if (target && !this.listed.some((summary) => summary.profileId === target.profileId)) await this.refresh();
    const candidates = this.listed.filter((summary) => summary.state === 'running'
      && !this.operations.get(summary.hostname)?.running
      && !this.syncingClaudeModels.has(summary.hostname)
      && (!target || summary.profileId === target.profileId));
    // Reading the default can run the user's own claude, so only when a running sandbox could need it.
    if (candidates.length === 0) return;
    const model = await this.readDefaultClaudeModel();
    // Unknown (a failed detection) is not a change: send nothing and keep what each sandbox last got.
    if (model === null) return;
    // Another sync may have started one of them while the default was read.
    const due = candidates.filter((summary) => !this.syncingClaudeModels.has(summary.hostname) && (target
      || !this.syncedClaudeModels.has(summary.hostname) || this.syncedClaudeModels.get(summary.hostname) !== model));
    await Promise.all(due.map(async (summary) => {
      this.syncingClaudeModels.add(summary.hostname);
      try {
        await library.syncAgentDefaults(summary.hostname);
        this.syncedClaudeModels.set(summary.hostname, model);
      } catch (error) {
        console.warn(`[CloudSandboxes] ${summary.label} kept its Claude model:`, getCloudErrorMessage(error, 'sync failed'));
      } finally {
        this.syncingClaudeModels.delete(summary.hostname);
      }
    }));
  }

  private async readDefaultClaudeModel(): Promise<string | null> {
    try {
      return await this.options.readDefaultClaudeModel();
    } catch {
      return null;
    }
  }

  private replaceListed(hostname: string, summary: CloudSandboxInfo | null): void {
    const others = this.listed.filter((current) => current.hostname !== hostname);
    const index = this.listed.findIndex((current) => current.hostname === hostname);
    if (!summary) {
      this.listed = others;
    } else if (index === -1) {
      this.listed = [...others, summary];
    } else {
      this.listed = this.listed.map((current, currentIndex) => currentIndex === index ? summary : current);
    }
  }

  private async readDaemonVersion(summary: CloudSandboxInfo): Promise<void> {
    if (summary.state !== 'running') return;
    try {
      const version = await this.options.readDaemonVersion(summary.profileId);
      if (!version || this.daemonVersions.get(summary.hostname) === version) return;
      this.daemonVersions.set(summary.hostname, version);
      this.emit();
    } catch {
      // An unreachable daemon just shows no version; the row's state already says why.
    }
  }

  private async getLibrary(): Promise<CloudSandboxLibrary | null> {
    this.libraryPromise ??= this.options.loadLibrary();
    try {
      const library = await this.libraryPromise;
      this.available = true;
      return library;
    } catch (error) {
      if (!(error instanceof CloudSandboxesUnavailableError)) {
        // A transient load failure is retried on the next call.
        this.libraryPromise = null;
        this.loadError = getCloudErrorMessage(error, 'Failed to load the cloud library');
      }
      this.available = false;
      return null;
    }
  }

  private async requireLibrary(): Promise<CloudSandboxLibrary> {
    const library = await this.getLibrary();
    if (!library) throw new CloudSandboxesUnavailableError();
    return library;
  }

  private emit(): CloudSandboxesSnapshot {
    const snapshot = this.getSnapshot();
    this.options.onChange(snapshot);
    return snapshot;
  }
}

function getPendingAction(action: CloudSandboxAction): CloudSandboxView['pending'] {
  if (action === 'start') return 'starting';
  if (action === 'stop') return 'stopping';
  if (action === 'remove') return 'removing';
  if (action === 'update') return 'updating';
  return undefined;
}

/** The library reports the step it starts; every earlier step is then done, and `done` ends them all. */
function applyProgress(steps: CloudSandboxProgressStep[], progress: CloudProgress): CloudSandboxProgressStep[] {
  const finished = steps.map((step): CloudSandboxProgressStep => ({ ...step, state: 'done' }));
  if (progress.step === 'done') return finished;
  const current: CloudSandboxProgressStep = { step: progress.step, state: 'start', message: progress.message };
  const index = finished.findIndex((step) => step.step === progress.step);
  if (index === -1) return [...finished, current];
  return finished.map((step, stepIndex) => stepIndex === index ? current : step);
}

function toCredentialStatus(status: CloudCredentialsStatus): CloudCredentialStatus {
  return {
    boat: status.boat.configured,
    tailscale: status.tailscale.configured,
    claude: status.claude.configured,
    boatOrg: status.boat.org?.name,
  };
}

function getViewState(state: CloudSandboxInfo['state']): CloudSandboxState {
  return state === 'gone' ? 'error' : state;
}

// The library redacts its own messages; this catches a token-shaped string that slipped through anyway.
const TOKEN_PATTERN = /\b(?:tskey-[\w-]+|sk-ant-[\w-]+|[A-Za-z0-9_]{32,})\b/g;

export function getCloudErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error && cause.message ? cause.message : fallback;
  return message.replace(TOKEN_PATTERN, '[redacted]');
}

interface PaneVersion {
  core: number[];
  prerelease: string[];
}

/**
 * A Pane version as semver. The .deb's version (dpkg) writes a prerelease with Debian's `~`, the app with `-`;
 * a leading `v`, a Debian epoch (`1:`) and build metadata (`+…`) are not part of the version.
 */
function parsePaneVersion(version: string): PaneVersion | null {
  const normalized = version.trim().replace(/^v/i, '').replace(/^\d+:/, '').split('+')[0].replace('~', '-');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence of two Pane versions (-1, 0 or 1), whichever separator each uses. Versions that don't
 * parse compare as their trimmed text, so they only match themselves.
 */
export function comparePaneVersions(left: string, right: string): number {
  const a = parsePaneVersion(left);
  const b = parsePaneVersion(right);
  if (!a || !b) return left.trim() === right.trim() ? 0 : left.trim() < right.trim() ? -1 : 1;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  // A release ranks above its prereleases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) return order;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

const RELEASE_BASE_URL = 'https://github.com/greenfield-inc/Pane/releases/download';

/**
 * The linux amd64 .deb of a published Pane release and its sha256 from the release's SHA256SUMS.txt.
 * Cloud sandboxes run amd64 Linux whatever this app's own platform is.
 */
export async function resolvePaneReleaseDeb(
  version: string,
  fetchText: (url: string) => Promise<string> = fetchReleaseText,
): Promise<CloudPaneDeb> {
  const fileName = `Pane-${version}-linux-amd64.deb`;
  const sums = await fetchText(`${RELEASE_BASE_URL}/v${version}/SHA256SUMS.txt`);
  const sha256 = sums.split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .find(([, name]) => name === fileName)?.[0];
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`Pane ${version} has no published checksum for ${fileName}.`);
  }
  return { debUrl: `${RELEASE_BASE_URL}/v${version}/${fileName}`, sha256: sha256.toLowerCase() };
}

async function fetchReleaseText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Could not read ${url} (HTTP ${response.status}).`);
  return response.text();
}
