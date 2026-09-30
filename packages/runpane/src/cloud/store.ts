import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CloudSize } from './provider';

/**
 * Local state for `runpane cloud`, on the user's machine only. Never in the desktop app or a sandbox.
 *
 *   <dir>/credentials.json        0600  provider key, Tailscale OAuth client, optional Anthropic key
 *   <dir>/settings.json           0600  non-secret defaults (golden snapshot, size, name prefix, Pane source)
 *   <dir>/hosts/<hostname>.json    0600  one record per cloud Session: the saved remote host profile plus CLI metadata
 *   <dir>/hosts/<hostname>.pairing 0600  the pane-remote:// code, written by bootstrap and never printed unless `pair` asks
 *
 * The dir is `$RUNPANE_CLOUD_DIR`, else `$XDG_CONFIG_HOME/runpane-cloud`, else `~/.config/runpane-cloud` (0700).
 */

export interface CloudCredentials {
  boat?: { apiKey: string };
  tailscale?: { clientId: string; clientSecret: string; tailnet?: string };
  anthropic?: { apiKey: string };
}

export type PaneSource =
  | { kind: 'runpane-npm'; spec: string }
  | { kind: 'deb-url'; url: string; sha256?: string }
  | { kind: 'preinstalled' };

export interface CloudSettings {
  goldenSnapshot?: string;
  size?: CloudSize;
  namePrefix?: string;
  paneSource?: PaneSource;
  /** Largest number of live cloud sandboxes `new` may leave running (final-plan §4 runaway guard). */
  maxLiveSandboxes?: number;
  coordinator?: { enabled: boolean };
}

export const DEFAULT_NAME_PREFIX = 'rp';
export const DEFAULT_MAX_LIVE_SANDBOXES = 25;
export const DEFAULT_PANE_SOURCE: PaneSource = { kind: 'runpane-npm', spec: 'runpane@latest' };

/**
 * The `cloud` field on a saved remote host profile (final-plan S2). Single writer: the CLI at
 * creation, then the coordinator; `version` goes up whenever the address changes.
 */
export interface CloudProfileInfo {
  provider: 'boat';
  sandboxId: string;
  sessionId: string;
  nodeId: string;
  hostname: string;
  version: number;
}

/** Same shape as the desktop's RemotePaneConnectionProfile (shared/types/remoteDaemon.ts) plus `cloud`. */
export interface CloudHostProfile {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  transport: 'http+sse';
  tunnel?: { kind: 'tailscale'; selected: boolean; note?: string };
  cloud: CloudProfileInfo;
}

export interface CloudHostMeta {
  createdAt: string;
  size: CloudSize;
  namePrefix: string;
  magicDnsName: string;
  pairingPath: string;
  coordinatorPairingPath?: string;
  paneSource: PaneSource;
  daemonVersion?: string;
  pinnedVersion?: string;
  repo?: { url: string; ref?: string };
}

export interface CloudHostRecord {
  version: 1;
  profile: CloudHostProfile;
  meta: CloudHostMeta;
}

export interface CloudStore {
  readonly dir: string;
  readCredentials(): Promise<CloudCredentials>;
  writeCredentials(credentials: CloudCredentials): Promise<void>;
  readSettings(): Promise<CloudSettings>;
  writeSettings(settings: CloudSettings): Promise<void>;
  listHosts(): Promise<CloudHostRecord[]>;
  writeHost(record: CloudHostRecord): Promise<void>;
  removeHost(hostname: string): Promise<void>;
  pairingPath(hostname: string): string;
  coordinatorPairingPath(hostname: string): string;
  readPairing(hostname: string): Promise<string>;
}

export function defaultCloudDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNPANE_CLOUD_DIR) return path.resolve(env.RUNPANE_CLOUD_DIR);
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), '.config');
  return path.join(configHome, 'runpane-cloud');
}

const HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function createCloudStore(dir: string = defaultCloudDir()): CloudStore {
  const hostsDir = path.join(dir, 'hosts');
  const hostFile = (hostname: string, suffix: string): string => {
    if (!HOSTNAME_PATTERN.test(hostname)) throw new Error(`Invalid cloud host name "${hostname}".`);
    return path.join(hostsDir, `${hostname}${suffix}`);
  };

  return {
    dir,
    async readCredentials() {
      return (await readJsonFile<CloudCredentials>(path.join(dir, 'credentials.json'))) ?? {};
    },
    async writeCredentials(credentials) {
      await writePrivateJson(path.join(dir, 'credentials.json'), credentials);
    },
    async readSettings() {
      return (await readJsonFile<CloudSettings>(path.join(dir, 'settings.json'))) ?? {};
    },
    async writeSettings(settings) {
      await writePrivateJson(path.join(dir, 'settings.json'), settings);
    },
    async listHosts() {
      let entries: string[];
      try {
        entries = await fs.readdir(hostsDir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const records: CloudHostRecord[] = [];
      for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
        const record = await readJsonFile<CloudHostRecord>(path.join(hostsDir, entry));
        if (record?.version === 1 && record.profile?.cloud?.hostname) records.push(record);
      }
      return records;
    },
    async writeHost(record) {
      await writePrivateJson(hostFile(record.profile.cloud.hostname, '.json'), record);
    },
    async removeHost(hostname) {
      for (const suffix of ['.json', '.pairing', '.coordinator.pairing']) {
        await fs.rm(hostFile(hostname, suffix), { force: true });
      }
    },
    pairingPath: (hostname) => hostFile(hostname, '.pairing'),
    coordinatorPairingPath: (hostname) => hostFile(hostname, '.coordinator.pairing'),
    async readPairing(hostname) {
      return (await fs.readFile(hostFile(hostname, '.pairing'), 'utf8')).trim();
    },
  };
}

/** Writes JSON through a 0600 temp file and a rename, creating parent dirs 0700. */
export async function writePrivateJson(filePath: string, value: CloudCredentials | CloudSettings | CloudHostRecord): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

export async function readJsonFile<Value>(filePath: string): Promise<Value | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    // SAFETY: local files this CLI wrote itself; callers check the fields they rely on.
    return JSON.parse(text) as Value;
  } catch {
    throw new Error(`${filePath} is not valid JSON. Fix or remove it, then retry.`);
  }
}

export function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** Finds a host by tailnet hostname, cloud Session id, label or sandbox id. */
export function findHost(records: readonly CloudHostRecord[], selector: string): CloudHostRecord {
  const wanted = selector.trim();
  const matches = records.filter((record) => {
    const { profile } = record;
    return profile.cloud.hostname === wanted
      || profile.cloud.sessionId === wanted
      || profile.cloud.sandboxId === wanted
      || profile.label === wanted
      || record.meta.magicDnsName === wanted;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const known = records.map((record) => record.profile.cloud.hostname).join(', ') || 'none';
    throw new Error(`No cloud host matches "${selector}". Known hosts: ${known}. Run runpane cloud list.`);
  }
  throw new Error(`"${selector}" matches ${matches.length} cloud hosts; use the host name from runpane cloud list.`);
}
