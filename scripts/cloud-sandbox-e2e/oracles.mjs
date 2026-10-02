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

/** Runs a shell command on the sandbox through boat (as the library does); { exitCode, stdout }. Callers print
 *  only what they extract from stdout. */
export async function boatExec(sandboxId, org, command, timeoutSeconds = 60) {
  const response = await fetch(`${BOAT_API}/sandboxes/${encodeURIComponent(sandboxId)}/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretValue('boatApiKey')}`, 'X-Boat-Org': org, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, timeoutSeconds }),
    signal: AbortSignal.timeout((timeoutSeconds + 30) * 1000),
  });
  if (!response.ok) throw new Error(`boat command: HTTP ${response.status}`);
  const body = await response.json();
  const result = body.result ?? body;
  return { exitCode: result.exitCode ?? null, stdout: result.stdout ?? '' };
}

// What the sandbox's agents are doing, counted on the machine itself (no desktop involved): running Claude
// processes and how many were started with --resume, the daemon's [PanelResume] lines, and each Claude
// transcript's size. Prints no command lines or environment.
const AGENT_STATE_SCRIPT = [
  'echo "claude=$(pgrep -fc "(^|/)claude( |$)" || true)"',
  'echo "claude_resume=$(pgrep -fa "(^|/)claude( |$)" | grep -c -- "--resume" || true)"',
  'echo "resumed_log=$( (journalctl --no-pager -q -o cat 2>/dev/null; cat /home/user/.pane/logs/*.log 2>/dev/null) | grep -o "\\[PanelResume\\] Resumed [0-9]* of [0-9]*" | tail -1)"',
  'find /home/user/.claude/projects -name "*.jsonl" -printf "transcript %f %s\\n" 2>/dev/null',
].join('; ');

export async function sandboxAgentState(sandboxId, org) {
  const { stdout } = await boatExec(sandboxId, org, AGENT_STATE_SCRIPT);
  const field = (name) => stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  const transcripts = Object.fromEntries([...stdout.matchAll(/^transcript (\S+) (\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
  return { claude: Number(field('claude') || 0), claudeResume: Number(field('claude_resume') || 0), resumedLog: field('resumed_log'), transcripts };
}

/** Calls the host's daemon like a paired client (POST /invoke with the saved host token) and returns the
 *  handler's data. Used to identify Panes and panels by id; never prints the token. */
export async function daemonInvoke(baseUrl, token, channel, ...args) {
  const response = await fetch(`${baseUrl}/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(`${channel}: HTTP ${response.status} ${body.error?.code ?? ''}`.trim());
  const result = body.result;
  if (result && result.success === false) throw new Error(`${channel}: ${result.error ?? 'failed'}`);
  return result?.data ?? result;
}

/** The host's Panes with their Claude Code panels: [{ id, name, worktreePath, claudePanels: [{ id, isActive }] }]. */
export async function panesWithClaude(baseUrl, token) {
  const sessions = await daemonInvoke(baseUrl, token, 'sessions:get-all');
  return Promise.all((sessions ?? []).map(async (session) => {
    const panels = await daemonInvoke(baseUrl, token, 'panels:list', session.id).catch(() => []);
    return {
      id: session.id,
      name: session.name,
      worktreePath: session.worktreePath,
      claudePanels: (panels ?? []).filter((panel) => /Claude Code/.test(panel.title ?? '')).map((panel) => ({ id: panel.id, isActive: Boolean(panel.state?.isActive) })),
    };
  }));
}
