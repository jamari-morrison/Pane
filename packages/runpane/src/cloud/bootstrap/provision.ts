import crypto from 'node:crypto';
import path from 'node:path';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from '../../boundaryDecoder';
import { decodePairingCode, type PaneRemotePairing } from '../pairing';
import type { SandboxHandle } from '../provider';
import type { PaneSource } from '../store';
import { CLOUD_SESSION_TAG, deletableNodeIds, describeForeignDevice, type TailscaleApi, type TailscaleDevice } from '../tailscale';
import { cloudBootstrapAssets, type CloudBootstrapAssetName } from './generated/assets';
import { waitForDaemonHealth, type DaemonHealthResult } from './health';

/** boat's login user, which runs bootstrap and the Pane daemon. */
const DEFAULT_SANDBOX_HOME = '/home/user';
const UPLOADED_ASSETS: CloudBootstrapAssetName[] = ['rp-bootstrap.sh', 'identity-scrub.sh', 'identity-check.sh'];
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PAIRING_PATTERN = /pane-remote:\/\/\S+/gu;
/** auto transport: HTTPS gets this long before the certificate is checked. */
const AUTO_HTTPS_WAIT_MS = 45_000;

interface TailnetIdentity {
  /** Tailscale's stable node id (e.g. "nxw81ARJfq11CNTRL"); the admin API deletes devices by it. */
  nodeId: string;
  hostname: string;
  /** Fully qualified MagicDNS name without the trailing dot. */
  magicDnsName: string;
  tailscaleIps: string[];
  tags: string[];
  runSsh: boolean;
}

export type ProvisionStepName =
  | 'upload-scripts'
  | 'identity'
  | 'tailscale-install'
  | 'check'
  | 'firewall'
  | 'tailscale-join'
  | 'agent-env'
  | 'agent-prompts'
  | 'install-pane'
  | 'pairing'
  | 'health'
  | 'cert-check'
  | 'serve-http'
  | 'serve-guard';

export interface ProvisionStep {
  step: ProvisionStepName;
  state: 'start' | 'done';
  elapsedMs?: number;
  /** Non-secret detail, e.g. the MagicDNS name or the daemon version. */
  detail?: string;
}

export type CloudTransportMode = 'auto' | 'https' | 'http';

export interface ProvisionOptions {
  sessionId: string;
  label: string;
  hostname: string;
  tailscale: TailscaleApi;
  paneSource: PaneSource;
  /**
   * `KEY=value` lines (e.g. CLAUDE_CODE_OAUTH_TOKEN) the daemon's agents get in their environment. Written to a
   * 0600 file in the sandbox and never logged.
   */
  agentEnv?: string;
  /**
   * How clients reach the daemon. `https` is Tailscale Serve with a Let's Encrypt certificate; `http` serves plain
   * TCP inside the tailnet (WireGuard encrypts it; the phone PWA can't use it). `auto` (default) tries HTTPS and
   * switches to `http` when the certificate does not come: Let's Encrypt issues at most 50 per week for a
   * tailnet's domain, and every new node name needs one.
   */
  transport?: CloudTransportMode;
  /** auto: how long HTTPS gets before the certificate is checked (default 45 s). */
  autoHttpsWaitMs?: number;
  healthTimeoutMs?: number;
  sandboxHome?: string;
  fetchImpl?: typeof fetch;
  onStep?: (step: ProvisionStep) => void;
}

export interface ProvisionResult extends TailnetIdentity {
  /** The daemon's pairing (client token included): kept in memory and saved 0600 by the caller, never logged. */
  pairing: PaneRemotePairing;
  /** What `auto` settled on. */
  transport: 'https' | 'http';
  daemonVersion?: string;
  health: DaemonHealthResult;
  deletedStaleNodeIds: string[];
}

/** Failures carry the step name; messages are redacted. */
class BootstrapError extends Error {
  constructor(readonly step: string, message: string) {
    super(`cloud bootstrap step "${step}" failed: ${message}`);
    this.name = 'BootstrapError';
  }
}

/** `<prefix>-` plus the first 8 lowercase alphanumerics of the session id. */
export function cloudHostname(sessionId: string, prefix = 'rp'): string {
  const short = sessionId.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 8);
  if (short.length < 4) {
    throw new Error(`Session id "${sessionId}" has too few alphanumerics for a hostname`);
  }
  return assertHostname(`${prefix}-${short}`);
}

/**
 * The sandbox installs a Pane .deb it downloads with curl, as root: only an https:// URL is accepted (the
 * download also refuses redirects to anything else), so nothing between the sandbox and the server can swap it.
 */
function assertHttpsArtifactUrl(url: string, what: string): void {
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    // reported below
  }
  if (protocol !== 'https:') throw new Error(`${what} must be an https:// URL${protocol ? ` (got ${protocol}//)` : ''}.`);
}

/**
 * Provisions one cloud sandbox: identity reset, strip-list check, inbound tailnet firewall, tailnet join with a
 * single-use tagged key (never Tailscale SSH), agent environment, Pane daemon install, pairing, a /health wait over
 * the tailnet (falling back to plain HTTP inside the tailnet when no certificate comes) and the guards that bring
 * the tailnet node and Serve back after a stop/start. Safe to re-run: finished steps are detected and skipped.
 */
export async function provisionSandbox(sandbox: SandboxHandle, options: ProvisionOptions): Promise<ProvisionResult> {
  if (options.paneSource.kind === 'deb-url') assertHttpsArtifactUrl(options.paneSource.url, 'The Pane .deb URL');
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  const hostname = assertHostname(options.hostname);
  const tags = [CLOUD_SESSION_TAG];
  const step = async <T>(name: ProvisionStepName, run: () => Promise<T>, detail?: (value: T) => string): Promise<T> => {
    options.onStep?.({ step: name, state: 'start' });
    const started = Date.now();
    const value = await run();
    options.onStep?.({ step: name, state: 'done', elapsedMs: Date.now() - started, detail: detail?.(value) });
    return value;
  };
  const runner = new StepRunner(sandbox, home);

  await step('upload-scripts', () => uploadScripts(sandbox, home));
  await step('identity', () => runner.run('identity', [options.sessionId], identityStepSchema),
    (value) => (value.reset === true ? 'reset' : 'already this sandbox'));
  await step('tailscale-install', () => runner.run('tailscale-install', [], envelopeSchema));
  const current = await runner.run('tailnet-identity', [], tailnetStepSchema);
  const alreadyJoined = current.backendState === 'Running';
  if (!alreadyJoined) {
    await step('check', async () => {
      const check = await runner.run('check', [], checkStepSchema, { allowFailure: true });
      if (!check.ok) throw new BootstrapError('check', `identity strip-list check failed: ${check.failed?.join('; ') ?? 'unknown'}`);
      return check;
    }, (value) => `${String(value.passed)} passed`);
  }
  // Over the tailnet only Tailscale Serve (and replies) reach the sandbox: the provider's own services stay closed.
  await step('firewall', () => runner.run('firewall', ['443'], firewallStepSchema, { timeoutSeconds: 300 }),
    (value) => `tailnet tcp ${(value.allowedTcp ?? [443]).join(',')} only`);

  const deletedStaleNodeIds: string[] = [];
  const tailnet = await step('tailscale-join', async () => {
    if (alreadyJoined) {
      // tailscale-up installs the tailscaled.state guard; a retry past the join installs it here.
      await runner.run('ts-guard', [], envelopeSchema, { timeoutSeconds: 120 });
      return parseIdentity(current);
    }
    // A device left under this hostname would push the new node to "<hostname>-1". Only a stale node of ours is
    // deleted; anyone else's device under the name stops the join instead.
    const stale = deletableNodeIds(await options.tailscale.findDevicesByHostname(hostname), tags);
    refuseForeignDevices('tailscale-join', hostname, stale.foreign);
    for (const nodeId of stale.nodeIds) {
      if (await options.tailscale.deleteDevice(nodeId)) deletedStaleNodeIds.push(nodeId);
    }
    return joinTailnet(sandbox, runner, options.tailscale, home, hostname, tags);
  }, (value) => value.magicDnsName);
  assertTailnetIdentity(tailnet, hostname, tags);

  if (options.agentEnv) {
    const agentEnv = options.agentEnv;
    await step('agent-env', async () => {
      const envFile = path.posix.join(stateDir(home), 'agent.env');
      // The state dir is 0700, so the file is private from the moment it lands.
      await sandbox.writeFile(envFile, agentEnv.endsWith('\n') ? agentEnv : `${agentEnv}\n`);
      return runner.run('agent-env', [envFile], envelopeSchema, { timeoutSeconds: 60 });
    });
  }

  // Claude Code's folder-trust prompt defaults to exit and nobody watches a new panel: answer it up front.
  await step('agent-prompts', () => runner.run('agent-prompts', [], agentPromptsStepSchema, { timeoutSeconds: 60 }),
    (value) => `${value.trustedFolders ?? 0} trusted folder(s)`);

  const install = await step('install-pane', () => runner.run('install-pane', [
    options.paneSource.kind,
    options.paneSource.kind === 'deb-url' ? options.paneSource.url : '',
    options.paneSource.kind === 'deb-url' ? options.paneSource.sha256 ?? '' : '',
    options.paneSource.kind === 'runpane-npm' ? options.paneSource.spec : '',
    options.label,
  ], installStepSchema, { timeoutSeconds: 600 }), (value) => value.version ?? 'installed');

  let pairing = await step('pairing', async () => decodeSandboxPairing((await runner.run('pairing-read', [], pairingStepSchema)).code));

  const transportMode = options.transport ?? 'auto';
  const healthTimeoutMs = options.healthTimeoutMs ?? 120_000;
  let baseUrl = `https://${tailnet.magicDnsName}`;
  let transport: 'https' | 'http' = 'https';
  const waitHealth = (timeoutMs: number) => waitForDaemonHealth(baseUrl, { timeoutMs, fetchImpl: options.fetchImpl });
  const requireHealthy = async (result: DaemonHealthResult): Promise<DaemonHealthResult> => {
    if (result.ok) return result;
    const local = await runner.run('health-local', [], envelopeSchema, { allowFailure: true });
    throw new BootstrapError('health', `${baseUrl}/health not ready after ${result.elapsedMs} ms `
      + `(last HTTP ${result.status ?? 'none'}; in-sandbox loopback check ${local.ok ? 'ok' : 'failed'})`);
  };

  let health: DaemonHealthResult | undefined;
  if (transportMode !== 'http') {
    const firstWaitMs = transportMode === 'auto' ? Math.min(options.autoHttpsWaitMs ?? AUTO_HTTPS_WAIT_MS, healthTimeoutMs) : healthTimeoutMs;
    const first = await waitHealth(firstWaitMs);
    if (first.ok || transportMode === 'https') {
      health = await step('health', () => requireHealthy(first), (value) => `${value.elapsedMs} ms`);
    } else {
      const cert = await step('cert-check', () => runner.run('cert-status', [tailnet.magicDnsName], certStatusStepSchema, { timeoutSeconds: 60 }),
        (value) => (value.rateLimited ? `Let's Encrypt rate limit: ${value.detail ?? 'refused'}` : 'no rate limit in tailscaled\'s log'));
      // Without a logged refusal, HTTPS gets one more window (a first certificate can take ~30 s).
      const second = cert.rateLimited ? undefined : await waitHealth(Math.max(Math.min(healthTimeoutMs - first.elapsedMs, firstWaitMs), 1_000));
      if (second?.ok) {
        health = await step('health', () => requireHealthy(second), (value) => `${value.elapsedMs + first.elapsedMs} ms`);
      } else {
        // HTTPS is down. If the daemon answers on loopback, the problem is Serve's certificate: switch.
        // If it doesn't, the daemon itself is broken and plain HTTP wouldn't help.
        const local = await runner.run('health-local', [], envelopeSchema, { allowFailure: true });
        if (!local.ok) {
          throw new BootstrapError('health', `${baseUrl}/health not ready after ${first.elapsedMs + (second?.elapsedMs ?? 0)} ms `
            + `(last HTTP ${(second ?? first).status ?? 'none'}; in-sandbox loopback check failed)`);
        }
      }
    }
  }
  if (!health) {
    const served = await step('serve-http', () => runner.run('serve-http', [], serveHttpStepSchema, { timeoutSeconds: 180 }),
      (value) => value.baseUrl);
    baseUrl = served.baseUrl;
    transport = 'http';
    // The same pairing (same token), pointed at the plain-HTTP address. Serve's ports are answered by tailscaled
    // before the host firewall sees them, so the firewall stays at 443.
    pairing = { ...pairing, baseUrl };
    health = await step('health', async () => requireHealthy(await waitHealth(healthTimeoutMs)),
      (value) => `${value.elapsedMs} ms over plain HTTP inside the tailnet`);
  }

  // Serve lives in tailscaled.state, which a resume has brought back stale; keep a desired copy that a boot unit re-applies.
  await step('serve-guard', () => runner.run('serve-guard', [transport], serveGuardStepSchema, { timeoutSeconds: 180 }),
    () => `${transport} Serve re-applied on boot if lost`);

  return {
    ...tailnet,
    pairing,
    transport,
    daemonVersion: health.version ?? install.version ?? undefined,
    health,
    deletedStaleNodeIds,
  };
}

interface RepairOptions {
  hostname: string;
  tailscale: TailscaleApi;
  /** The node id recorded at provision time; devices under the hostname tagged like it are replaced. */
  oldNodeId?: string;
  transport: 'https' | 'http';
  sandboxHome?: string;
}

export type RepairResult =
  | { reenrolled: false; backendState: string; serveApplied: boolean }
  | ({ reenrolled: true; previousBackendState: string; deletedNodeIds: string[] } & TailnetIdentity);

/**
 * Start-time repair for a resumed sandbox whose daemon does not answer over the tailnet. Seen live on boat:
 * a resume can bring tailscaled.state back empty (the node is logged out), or valid but without the Serve config.
 * A logged-out node is re-enrolled under the SAME hostname (its old device is deleted first, or the name would
 * get a -1 suffix) and Serve is restored; a running node only gets its Serve config re-applied when missing.
 * Never stops or restarts the sandbox.
 */
export async function repairSandboxTailnet(sandbox: SandboxHandle, options: RepairOptions): Promise<RepairResult> {
  const home = options.sandboxHome ?? DEFAULT_SANDBOX_HOME;
  const hostname = assertHostname(options.hostname);
  const tags = [CLOUD_SESSION_TAG];
  await uploadScripts(sandbox, home);
  const runner = new StepRunner(sandbox, home);
  const current = await runner.run('tailnet-identity', [], tailnetStepSchema);
  const backendState = current.backendState ?? 'unknown';
  if (backendState === 'Running') {
    await runner.run('ts-guard', [], envelopeSchema, { timeoutSeconds: 120 });
    const serve = await runner.run('serve-guard', [options.transport], serveGuardStepSchema, { timeoutSeconds: 180 });
    return { reenrolled: false, backendState, serveApplied: serve.applied === true };
  }

  const doomed = deletableNodeIds(await options.tailscale.findDevicesByHostname(hostname), tags, options.oldNodeId);
  refuseForeignDevices('tailscale-reenrol', hostname, doomed.foreign);
  const deletedNodeIds: string[] = [];
  for (const nodeId of doomed.nodeIds) {
    if (await options.tailscale.deleteDevice(nodeId)) deletedNodeIds.push(nodeId);
  }
  await runner.run('tailscale-reset', [], envelopeSchema);
  const identity = await joinTailnet(sandbox, runner, options.tailscale, home, hostname, tags);
  assertTailnetIdentity(identity, hostname, tags);
  await runner.run('serve-restore', [], envelopeSchema);
  return { reenrolled: true, previousBackendState: backendState, deletedNodeIds, ...identity };
}

/**
 * Installs another Pane .deb on a provisioned sandbox and restarts its daemon (pairing, data and Serve are kept).
 * Resolves the installed package version.
 */
export async function updateSandboxPane(
  sandbox: SandboxHandle,
  pane: { debUrl: string; sha256: string },
  sandboxHome = DEFAULT_SANDBOX_HOME,
): Promise<{ version?: string }> {
  assertHttpsArtifactUrl(pane.debUrl, 'The Pane .deb URL');
  if (!/^[0-9a-f]{64}$/u.test(pane.sha256)) throw new Error('The Pane .deb sha256 must be 64 lowercase hex characters.');
  await uploadScripts(sandbox, sandboxHome);
  const installed = await new StepRunner(sandbox, sandboxHome).run('update-pane', [pane.debUrl, pane.sha256], installStepSchema,
    { timeoutSeconds: 600 });
  return { version: installed.version ?? undefined };
}

export type ClaudeModelOutcome = 'set' | 'current' | 'kept-sandbox-choice';

/**
 * Makes new Claude Code panels in the sandbox start with `model` (`model` in its ~/.claude/settings.json). Only a
 * value this wrote before is replaced: a model picked inside the sandbox with `/model` is kept (`kept-sandbox-choice`).
 */
export async function applyClaudeModel(
  sandbox: SandboxHandle,
  model: string,
  sandboxHome = DEFAULT_SANDBOX_HOME,
): Promise<{ outcome: ClaudeModelOutcome; model: string | null }> {
  await uploadScripts(sandbox, sandboxHome);
  const result = await new StepRunner(sandbox, sandboxHome).run('claude-model', [model], claudeModelStepSchema,
    { timeoutSeconds: 60 });
  return { outcome: result.outcome, model: result.model ?? null };
}

async function joinTailnet(
  sandbox: SandboxHandle,
  runner: StepRunner,
  tailscale: TailscaleApi,
  home: string,
  hostname: string,
  tags: string[],
): Promise<TailnetIdentity> {
  const key = await tailscale.mintAuthKey({ tags, description: `runpane cloud ${hostname}` });
  const keyPath = path.posix.join(stateDir(home), `tskey-${crypto.randomBytes(6).toString('hex')}`);
  // The state dir is 0700, so the key is private from the moment it lands; the step chmods and shreds it.
  await sandbox.writeFile(keyPath, key.key);
  return parseIdentity(await runner.run('tailscale-up', [keyPath, hostname], tailnetStepSchema, { timeoutSeconds: 120 }));
}

/** Runpane never deletes a device it did not create; one holding a managed hostname needs the user. */
function refuseForeignDevices(step: string, hostname: string, foreign: TailscaleDevice[]): void {
  if (foreign.length === 0) return;
  throw new BootstrapError(step, `the tailnet already has ${foreign.map(describeForeignDevice).join(', ')} named ${hostname}, `
    + 'which runpane did not create (only devices tagged like its own nodes are replaced). Rename or remove it in the Tailscale admin console, then retry.');
}

function assertTailnetIdentity(identity: TailnetIdentity, hostname: string, tags: string[]): void {
  if (identity.runSsh) {
    throw new BootstrapError('tailscale-join', 'Tailscale SSH is enabled on the node; cloud sandboxes must run without it');
  }
  const missing = tags.filter((tag) => !identity.tags.includes(tag));
  if (missing.length > 0) {
    throw new BootstrapError('tailscale-join', `node is missing tags ${missing.join(', ')}`);
  }
  const shortName = identity.magicDnsName.split('.')[0];
  if (shortName !== hostname) {
    throw new BootstrapError('tailscale-join', `node joined as "${shortName}" instead of "${hostname}" (a stale device still holds the name)`);
  }
}

async function uploadScripts(sandbox: SandboxHandle, home: string): Promise<void> {
  const dir = stateDir(home);
  const prepared = await sandbox.runScript(`umask 077; mkdir -p ${shellQuote(`${dir}/bin`)}; chmod 700 ${shellQuote(dir)}`);
  if (prepared.exitCode !== 0) {
    throw new BootstrapError('upload-scripts', `could not create ${dir} (exit ${String(prepared.exitCode)})`);
  }
  for (const name of UPLOADED_ASSETS) {
    await sandbox.writeFile(`${dir}/bin/${name}`, cloudBootstrapAssets[name]);
  }
}

const envelopeSchema = boundary.object({
  ok: boundary.boolean,
  error: boundary.optional(boundary.string),
});
const identityStepSchema = boundary.object({ ok: boundary.boolean, reset: boundary.optional(boundary.boolean) });
const optionalStringList = boundary.optional(boundary.array(boundary.string));
const tailnetStepSchema = boundary.object({
  backendState: boundary.optional(boundary.string),
  nodeId: boundary.optional(boundary.string),
  hostname: boundary.optional(boundary.string),
  magicDnsName: boundary.optional(boundary.string),
  tailscaleIps: optionalStringList,
  tags: optionalStringList,
  runSsh: boundary.optional(boundary.boolean),
});
const checkStepSchema = boundary.object({
  ok: boundary.boolean,
  failed: optionalStringList,
  passed: boundary.optional(boundary.number),
});
const installStepSchema = boundary.object({ version: boundary.optional(boundary.nullable(boundary.string)) });
const pairingStepSchema = boundary.object({ code: boundary.nonEmptyString });
const claudeModelStepSchema = boundary.object({
  outcome: boundary.enumeration('set', 'current', 'kept-sandbox-choice'),
  model: boundary.optional(boundary.nullable(boundary.string)),
});
const agentPromptsStepSchema = boundary.object({ trustedFolders: boundary.optional(boundary.number) });
const certStatusStepSchema = boundary.object({
  rateLimited: boundary.boolean,
  detail: boundary.optional(boundary.nullable(boundary.string)),
});
const serveHttpStepSchema = boundary.object({ baseUrl: boundary.nonEmptyString });
const serveGuardStepSchema = boundary.object({
  applied: boundary.optional(boundary.boolean),
  detail: boundary.optional(boundary.string),
});
const firewallStepSchema = boundary.object({ allowedTcp: boundary.optional(boundary.array(boundary.number)) });

type TailnetStepResult = ReturnType<typeof tailnetStepSchema.decode>;

class StepRunner {
  constructor(private readonly sandbox: SandboxHandle, private readonly home: string) {}

  async run<Value>(
    stepName: string,
    args: string[],
    schema: BoundarySchema<Value>,
    options: { timeoutSeconds?: number; allowFailure?: boolean } = {},
  ): Promise<Value> {
    const script = [`${stateDir(this.home)}/bin/rp-bootstrap.sh`, stepName, ...args].map(shellQuote).join(' ');
    const result = await this.sandbox.runScript(`bash ${script}`, { timeoutSeconds: options.timeoutSeconds ?? 300 });
    const payload = parseStepResult(result.stdout);
    if (!payload) {
      throw new BootstrapError(stepName, `no result (exit ${String(result.exitCode)}${result.timedOut ? ', timed out' : ''}): `
        + redact(`${result.stderr}\n${result.stdout}`).trim().split('\n').slice(-5).join(' | '));
    }
    try {
      const envelope = decodeBoundary(payload, envelopeSchema);
      if (!envelope.ok && !options.allowFailure) {
        throw new BootstrapError(stepName, redact(envelope.error ?? 'unknown error'));
      }
      return decodeBoundary(payload, schema);
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError(stepName, `malformed result: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
}

function parseStepResult(stdout: string): JsonObject | undefined {
  const line = stdout.split('\n').reverse().find((candidate) => candidate.startsWith('RP_RESULT '));
  if (!line) return undefined;
  try {
    return decodeBoundary(JSON.parse(line.slice('RP_RESULT '.length)), boundary.jsonObject);
  } catch {
    return undefined;
  }
}

function parseIdentity(payload: TailnetStepResult): TailnetIdentity {
  if (!payload.nodeId || !payload.magicDnsName) {
    throw new BootstrapError('tailscale-join', 'tailscale reported no node id or MagicDNS name');
  }
  return {
    nodeId: payload.nodeId,
    hostname: payload.hostname ?? '',
    magicDnsName: payload.magicDnsName,
    tailscaleIps: payload.tailscaleIps ?? [],
    tags: payload.tags ?? [],
    runSsh: payload.runSsh === true,
  };
}

function decodeSandboxPairing(code: string): PaneRemotePairing {
  try {
    return decodePairingCode(code);
  } catch {
    // The decoder's message never quotes the code, but keep this one fixed anyway.
    throw new BootstrapError('pairing', 'the sandbox returned no valid pane-remote:// code');
  }
}

/** Removes pairing codes and Tailscale keys from text that may reach an error message. */
export function redact(text: string): string {
  return text.replace(PAIRING_PATTERN, '<pairing-redacted>').replace(/tskey-[A-Za-z0-9-]+/gu, '<tskey-redacted>');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function assertHostname(hostname: string): string {
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(`"${hostname}" is not a valid tailnet hostname (lowercase letters, digits and dashes)`);
  }
  return hostname;
}

function stateDir(home: string): string {
  return path.posix.join(home, '.runpane-cloud');
}
