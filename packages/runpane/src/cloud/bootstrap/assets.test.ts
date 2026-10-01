import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cloudBootstrapAssets, type CloudBootstrapAssetName } from './generated/assets';

// SAFETY: Object.keys of the generated const record returns exactly its asset names.
const names = Object.keys(cloudBootstrapAssets) as CloudBootstrapAssetName[];

/** Every step provision.ts runs. */
const PROVISION_STEPS = [
  'identity', 'tailscale-install', 'tailnet-identity', 'check', 'firewall', 'tailscale-up', 'ts-guard', 'agent-env', 'install-pane',
  'pairing-read', 'health-local', 'cert-status', 'serve-http', 'serve-guard', 'tailscale-reset', 'serve-restore', 'update-pane',
];

/** Runs one rp-bootstrap.sh step in a temp HOME; `functions` replace commands (exported bash functions win over PATH). */
function runStep(step: string, args: string[], functions: Map<string, string> = new Map()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, RP_STATE: path.join(dir, 'state'), XDG_RUNTIME_DIR: dir };
  for (const [name, body] of functions) env[`BASH_FUNC_${name}%%`] = body;
  const result = childProcess.spawnSync('bash', [file, step, ...args], { encoding: 'utf8', env });
  return { dir, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('every embedded asset is valid bash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, cloudBootstrapAssets[name]);
    const result = childProcess.spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test('the bootstrap handles every step provision.ts runs', () => {
  const script = cloudBootstrapAssets['rp-bootstrap.sh'];
  for (const step of PROVISION_STEPS) assert.match(script, new RegExp(`^  ${step}\\) step_`, 'mu'), `missing step ${step}`);
});

test('the bootstrap never enables Tailscale SSH and never mv-s into kept paths', () => {
  for (const name of names) {
    const text = cloudBootstrapAssets[name];
    assert.ok(!/tailscale up[^\n]*--ssh(?!=false)/u.test(text), `${name} must not run tailscale up --ssh`);
    assert.ok(!/^\s*(sudo )?mv /mu.test(text), `${name} must not mv files (an mv into kept paths arrives empty after a boat restore)`);
  }
});

test('an unknown step fails with a parsable result', () => {
  const result = runStep('nope', []);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RP_RESULT \{"ok": false, "error": "unknown step 'nope'"\}$/mu);
});

// A start runs tailnet-identity while the resumed box may still be booting, and re-enrols the node unless it reports
// Running. Seen live: an empty status first, then tailscaled's transient NoState and Starting. The step must wait.
test('tailnet-identity waits until tailscaled answers and settles past NoState and Starting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const counter = path.join(dir, 'calls');
  const status = (state: string) => `{"BackendState":"${state}","Self":{"ID":"n1","HostName":"rp-x","DNSName":"rp-x.ts.net.","TailscaleIPs":["100.64.0.1"]}}`;
  // Calls 0-1: no answer; 2-3: NoState; 4: Starting; then Running. Only `status --json` prints.
  const fake = `() { n=$(cat '${counter}' 2>/dev/null || echo 0); echo $((n+1)) > '${counter}'; [ "$1 $2" = "status --json" ] || return 0; `
    + `if [ "$n" -lt 2 ]; then return 1; elif [ "$n" -lt 4 ]; then echo '${status('NoState')}'; elif [ "$n" -lt 5 ]; then echo '${status('Starting')}'; else echo '${status('Running')}'; fi; }`;
  const result = runStep('tailnet-identity', [], new Map([['tailscale', fake], ['sudo', '() { "$@"; }']]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RP_RESULT .*"backendState": "Running"/mu);
});

test('agent-env hands the 0600 env file to the daemon unit and pre-answers Claude Code, without printing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const envFile = path.join(dir, 'agent.env');
  fs.writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN=claude-token-SECRET\n', { mode: 0o644 });
  const result = runStep('agent-env', [envFile], new Map([['systemctl', '() { return 0; }']]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RP_RESULT \{"ok":true\}$/mu);
  assert.doesNotMatch(result.stdout + result.stderr, /claude-token-SECRET/u);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const dropIn = fs.readFileSync(path.join(result.dir, '.config/systemd/user/pane-remote-daemon.service.d/runpane-cloud-agent.conf'), 'utf8');
  assert.equal(dropIn, `[Service]\nEnvironmentFile=${envFile}\n`);
  const claude = JSON.parse(fs.readFileSync(path.join(result.dir, '.claude.json'), 'utf8'));
  assert.equal(claude.hasCompletedOnboarding, true);
  assert.equal(claude.projects[result.dir].hasTrustDialogAccepted, true);

  assert.match(runStep('agent-env', [path.join(dir, 'missing')]).stdout, /"error": "agent-env: no environment file"/u);
});

test('update-pane requires a sha256, a provisioned sandbox and an https .deb', () => {
  const sha = 'a'.repeat(64);
  assert.match(runStep('update-pane', ['https://example.com/pane.deb', 'nope']).stdout, /sha256 must be 64 lowercase hex/u);
  assert.match(runStep('update-pane', ['https://example.com/pane.deb', sha]).stdout, /this sandbox was never provisioned/u);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'));
  const file = path.join(dir, 'rp-bootstrap.sh');
  fs.writeFileSync(file, cloudBootstrapAssets['rp-bootstrap.sh']);
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'pairing.code'), 'pane-remote://x');
  const result = childProcess.spawnSync('bash', [file, 'update-pane', 'http://example.com/pane.deb', sha], {
    encoding: 'utf8', env: { ...process.env, HOME: dir, RP_STATE: state },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the Pane \.deb URL must be https:\/\//u);
});

test('the identity check passes nothing inherited: it fails on leftover credentials and Pane state', () => {
  const script = cloudBootstrapAssets['identity-check.sh'];
  for (const item of ['claude credentials', 'pane remote state/pairing/client records', 'tailscaled state backup', 'machine-id fresh', 'ssh host keys regenerated']) {
    assert.ok(script.includes(item), `identity-check.sh checks ${item}`);
  }
  assert.match(cloudBootstrapAssets['identity-scrub.sh'], /"\$h\/\.pane_remote" "\$h\/\.pane\/config\.json"/u);
});
