// Independent checks outside the app: the boat API, the Tailscale API and the desktop's config.json.
// They use the same credentials the user typed (from secrets.mjs) and return only ids, names and states.
import fs from 'node:fs';
import path from 'node:path';
import { secretValue } from './secrets.mjs';

const BOAT_API = 'https://boat.dev/api/v1';
const TAILSCALE_API = 'https://api.tailscale.com/api/v2';

export async function boatSandbox(sandboxId, org) {
  const response = await fetch(`${BOAT_API}/sandboxes/${encodeURIComponent(sandboxId)}`, {
    headers: { Authorization: `Bearer ${secretValue('boatApiKey')}`, 'X-Boat-Org': org },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return { exists: false, status: 404 };
  const body = await response.json().catch(() => ({}));
  const sandbox = body.sandbox ?? body;
  return { exists: response.ok && sandbox.state !== 'destroyed', status: response.status, state: sandbox.state, name: sandbox.name, team: sandbox.team?.id ?? sandbox.team ?? null, teamName: sandbox.team?.name ?? null };
}

async function tailscaleToken() {
  const form = new URLSearchParams({ client_id: secretValue('tailscaleClientId'), client_secret: secretValue('tailscaleClientSecret') });
  const response = await fetch(`${TAILSCALE_API}/oauth/token`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Tailscale OAuth token: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

/** Tailnet devices whose hostname or MagicDNS name starts with `hostname`: [{ id, hostname, name, online }]. */
export async function tailnetDevices(hostname) {
  const token = await tailscaleToken();
  const response = await fetch(`${TAILSCALE_API}/tailnet/-/devices`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Tailscale devices: HTTP ${response.status}`);
  const { devices = [] } = await response.json();
  return devices
    .filter((device) => device.hostname === hostname || String(device.name ?? '').startsWith(`${hostname}.`))
    .map((device) => ({ id: device.nodeId ?? device.id, hostname: device.hostname, name: device.name, online: device.connectedToControl ?? null }));
}

/** The saved remote hosts in a desktop data dir, without tokens. */
export function savedHosts(paneDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8'));
    return (config.remoteDaemon?.client?.profiles ?? []).map((profile) => ({
      id: profile.id,
      label: profile.label,
      baseUrl: profile.baseUrl,
      cloud: profile.cloud ? { sandboxId: profile.cloud.sandboxId, sessionId: profile.cloud.sessionId, hostname: profile.cloud.hostname, nodeId: profile.cloud.nodeId } : undefined,
    }));
  } catch {
    return [];
  }
}

/** The saved token of one host, for redaction only. */
export function savedHostToken(paneDir, profileId) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8'));
    return (config.remoteDaemon?.client?.profiles ?? []).find((profile) => profile.id === profileId)?.token;
  } catch {
    return undefined;
  }
}

export async function health(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}
