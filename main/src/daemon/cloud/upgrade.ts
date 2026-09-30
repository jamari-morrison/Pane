import { createHash } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CloudUpgradeRequest, CloudUpgradeResult } from '../../../../shared/types/cloudDaemon';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+~-]{0,63}$/u;
const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9@_.-]+\.service$/u;

export class CloudUpgradeError extends Error {
  constructor(readonly code: string, message: string) {
    // The code leads the message: /invoke forwards only the message to the caller.
    super(`${code}: ${message}`);
    this.name = 'CloudUpgradeError';
  }
}

export interface CloudUpgradeDependencies {
  currentVersion: string;
  /** Where downloaded packages are kept (inside the Pane directory, so snapshots keep them). */
  downloadDirectory: string;
  /** The systemd user unit running this daemon, or null when it runs outside systemd. */
  resolveServiceUnit(): string | null;
  download(url: string, destination: string): Promise<void>;
  /** Runs the install-and-restart script outside this daemon's cgroup, so the restart cannot kill it. */
  runDetached(unitSuffix: string, script: string): Promise<void>;
}

const upgradeRequestSchema = boundary.object({
  version: boundary.nonEmptyString,
  url: boundary.optional(boundary.string),
  debUrl: boundary.optional(boundary.string),
  sha256: boundary.nonEmptyString,
});

export function parseCloudUpgradeRequest(value: unknown): CloudUpgradeRequest {
  let decoded: ReturnType<typeof upgradeRequestSchema.decode>;
  try {
    decoded = decodeBoundary(value, upgradeRequestSchema);
  } catch (error) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', `Invalid upgrade request: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url = decoded.url ?? decoded.debUrl;
  if (!url || !url.startsWith('https://')) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', 'An https:// package url is required');
  }
  const sha256 = decoded.sha256.toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', 'sha256 must be 64 hex characters');
  }
  if (!VERSION_PATTERN.test(decoded.version)) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_BAD_REQUEST', 'version has unexpected characters');
  }
  return { version: decoded.version, url, sha256 };
}

/**
 * Upgrade-on-wake: headless daemons never update themselves (bootstrap only runs the version
 * checker on the desktop), so the coordinator pins a version and, after a wake, asks the daemon
 * to install that exact .deb. The package is verified against its sha256, then a detached job
 * installs it with `sudo -n apt-get` and restarts this daemon's systemd unit. The caller polls
 * `/health` until `version` matches.
 */
export async function runCloudUpgrade(
  dependencies: CloudUpgradeDependencies,
  rawRequest: unknown,
): Promise<CloudUpgradeResult> {
  const request = parseCloudUpgradeRequest(rawRequest);
  const from = dependencies.currentVersion;
  if (request.version === from) {
    return { ok: true, upgraded: false, from, to: request.version };
  }
  if (process.platform !== 'linux') {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_UNSUPPORTED', 'Upgrade on wake installs a .deb and only runs on Linux');
  }
  const unit = dependencies.resolveServiceUnit();
  if (!unit) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_NO_SERVICE', 'This daemon does not run under a systemd user unit, so it cannot restart itself');
  }

  fs.mkdirSync(dependencies.downloadDirectory, { recursive: true, mode: 0o700 });
  const packagePath = path.join(dependencies.downloadDirectory, `pane-${request.version}.deb`);
  const partialPath = `${packagePath}.partial`;
  await dependencies.download(request.url, partialPath);
  const actual = await sha256File(partialPath);
  if (actual !== request.sha256) {
    fs.rmSync(partialPath, { force: true });
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_CHECKSUM', `Package sha256 ${actual} does not match ${request.sha256}`);
  }
  fs.renameSync(partialPath, packagePath);

  await dependencies.runDetached(request.version.replace(/[^A-Za-z0-9]/gu, '-'), buildUpgradeScript(packagePath, unit));
  return { ok: true, upgraded: 'scheduled', from, to: request.version, packagePath };
}

export function buildUpgradeScript(packagePath: string, unit: string): string {
  const deb = shellQuote(packagePath);
  return [
    'set -e',
    // Let the invoke response reach the caller before the daemon goes down.
    'sleep 1',
    `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades ${deb} || sudo -n dpkg -i ${deb}`,
    `systemctl --user restart ${shellQuote(unit)}`,
  ].join('\n');
}

/** The `*.service` this process runs in, from its cgroup path (cgroup v2 and v1). */
export function resolveSystemdUnitFromCgroup(cgroupText: string): string | null {
  for (const line of cgroupText.split('\n')) {
    const cgroupPath = line.split(':').slice(2).join(':');
    const segments = cgroupPath.split('/').reverse();
    const unit = segments.find(segment => SYSTEMD_UNIT_PATTERN.test(segment) && !segment.startsWith('user@'));
    if (unit) return unit;
  }
  return null;
}

export function resolveOwnSystemdUnit(): string | null {
  try {
    return resolveSystemdUnitFromCgroup(fs.readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {
    return null;
  }
}

export async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_DOWNLOAD', `Download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

export function runDetachedWithSystemd(unitSuffix: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('systemd-run', [
      '--user',
      '--collect',
      `--unit=pane-cloud-upgrade-${unitSuffix}-${Date.now()}`,
      'bash',
      '-c',
      script,
    ], { stdio: 'ignore' });
    child.on('error', error => reject(new CloudUpgradeError('ERR_CLOUD_UPGRADE_SPAWN', error.message)));
    child.on('close', code => (code === 0
      ? resolve()
      : reject(new CloudUpgradeError('ERR_CLOUD_UPGRADE_SPAWN', `systemd-run exited with ${code}`))));
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
