import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cloudBootstrapAssets, type CloudBootstrapAssetName } from './generated/assets';

// SAFETY: Object.keys of the generated const record returns exactly its asset names.
const names = Object.keys(cloudBootstrapAssets) as CloudBootstrapAssetName[];

/** Every step provision.ts runs. */
const PROVISION_STEPS = [
  'identity', 'tailscale-install', 'tailnet-identity', 'check', 'firewall', 'tailscale-up', 'ts-guard', 'agent-env', 'agent-prompts', 'claude-model', 'install-pane',
  'pairing-read', 'health-local', 'cert-status', 'serve-http', 'serve-guard', 'tailscale-reset', 'serve-restore', 'update-pane',
  'startup-install', 'startup-run', 'startup-status', 'startup-log',
];

/** Runs one rp-bootstrap.sh step in a temp HOME; `functions` replace commands (exported bash functions win over PATH). */
function runStep(step: string, args: string[], functions: Map<string, string> = new Map(), home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-assets-'))) {
  const dir = home;
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

test('agent-env hands the 0600 env file to the daemon unit without printing it', () => {
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

  assert.match(runStep('agent-env', [path.join(dir, 'missing')]).stdout, /"error": "agent-env: no environment file"/u);
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('agent-prompts answers Claude Code\'s trust and bypass prompts for home, its repositories and their worktrees', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  for (const dir of ['project/.git', 'project/worktrees/feature-1/.git-dir', 'code/app/.git']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const result = runStep('agent-prompts', [], new Map(), home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RP_RESULT \{"ok": true, "trustedFolders": 4\}$/mu);
  const claude = readJson(path.join(home, '.claude.json'));
  assert.equal(claude.hasCompletedOnboarding, true);
  assert.equal(claude.bypassPermissionsModeAccepted, true);
  for (const folder of ['', '/project', '/project/worktrees/feature-1', '/code/app']) {
    assert.equal(claude.projects[`${home}${folder}`].hasTrustDialogAccepted, true, `trusts ${folder || 'home'}`);
  }
  assert.equal(readJson(path.join(home, '.claude/settings.json')).skipDangerousModePermissionPrompt, true);
  assert.equal(fs.statSync(path.join(home, '.claude.json')).mode & 0o777, 0o600);
});

test('agent-prompts merges into an existing ~/.claude.json, is idempotent, and never overwrites a broken one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const existing = { userID: 'u1', theme: 'dark', projects: { [home]: { allowedTools: ['Bash'] }, '/elsewhere': { hasTrustDialogAccepted: false } } };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(existing), { mode: 0o640 });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus' }));
  assert.equal(runStep('agent-prompts', [], new Map(), home).status, 0);
  const once = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
  const merged = JSON.parse(once);
  assert.equal(merged.userID, 'u1');
  assert.equal(merged.theme, 'dark');
  assert.deepEqual(merged.projects[home], { allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  assert.deepEqual(merged.projects['/elsewhere'], { hasTrustDialogAccepted: false });
  assert.deepEqual(readJson(path.join(home, '.claude/settings.json')), { model: 'opus', skipDangerousModePermissionPrompt: true });
  assert.equal(runStep('agent-prompts', [], new Map(), home).status, 0);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), once, 'a second run changes nothing');
  assert.equal(fs.statSync(path.join(home, '.claude.json')).mode & 0o777, 0o640, 'the file keeps its mode');
  assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left behind');

  fs.writeFileSync(path.join(home, '.claude.json'), '{ not json');
  const broken = runStep('agent-prompts', [], new Map(), home);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /"error": "agent-prompts: /u);
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{ not json');
});

test('update-pane re-answers Claude Code\'s prompts and re-lays the daemon drop-ins before restarting it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state/pairing.code'), 'pane-remote://x');
  const calls = path.join(home, 'calls');
  const record = (name: string) => `() { echo "${name} $*" >> '${calls}'; return 0; }`;
  const result = runStep('update-pane', ['https://example.com/pane.deb', 'a'.repeat(64)], new Map([
    // curl -o <file> <url>: create the file; the digest check and apt-get are stubbed.
    ['curl', `() { while [ $# -gt 1 ]; do [ "$1" = -o ] && : > "$2"; shift; done; echo "curl" >> '${calls}'; }`],
    ['sha256sum', record('sha256sum')],
    ['sudo', record('sudo')],
    ['systemctl', record('systemctl')],
    ['dpkg', '() { return 1; }'],
  ]), home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readJson(path.join(home, '.claude.json')).projects[home].hasTrustDialogAccepted, true);
  assert.equal(fs.readFileSync(path.join(home, '.config/systemd/user/pane-remote-daemon.service.d/resume-agents.conf'), 'utf8'),
    '[Service]\nEnvironment=PANE_RESUME_AGENTS_ON_START=1\n');
  assert.equal(fs.readFileSync(path.join(home, '.config/systemd/user/pane-remote-daemon.service.d/claude-sandboxed.conf'), 'utf8'),
    '[Service]\nEnvironment=CLAUDE_CODE_SANDBOXED=1\n');
  assert.match(fs.readFileSync(calls, 'utf8'), /sudo DEBIAN_FRONTEND=noninteractive apt-get install[^\n]*\nsystemctl --user daemon-reload\nsystemctl --user restart pane-remote-daemon\.service/u);
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

test('install-pane gives the sandbox a git identity and has the daemon resume agent panels on start', () => {
  const script = cloudBootstrapAssets['rp-bootstrap.sh'];
  assert.match(script, /git config --global user\.name >\/dev\/null 2>&1 \|\| git config --global user\.name /u);
  assert.match(script, /Environment=PANE_RESUME_AGENTS_ON_START=1/u);
  assert.match(script, /Environment=CLAUDE_CODE_SANDBOXED=1/u);
});

test('install-pane on an already provisioned sandbox still lays the daemon drop-ins down', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  fs.mkdirSync(path.join(home, 'state'));
  fs.writeFileSync(path.join(home, 'state/pairing.code'), 'pane-remote://x');
  const result = runStep('install-pane', ['runpane-npm', '', '', 'runpane@latest', 'Cloud'], new Map([
    ['systemctl', '() { return 0; }'],
    ['dpkg', '() { return 1; }'],
  ]), home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"skipped": true/u);
  const dropIns = path.join(home, '.config/systemd/user/pane-remote-daemon.service.d');
  assert.deepEqual(fs.readdirSync(dropIns).sort(), ['claude-sandboxed.conf', 'resume-agents.conf']);
});

/** The repository root: the nearest folder above this file with pnpm-workspace.yaml. */
function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    assert.notEqual(parent, dir, 'pnpm-workspace.yaml not found above the test');
    dir = parent;
  }
  return dir;
}

// CLAUDE_CODE_SANDBOXED turns off Claude Code's folder-trust check. Only a disposable cloud sandbox may set it, and
// only for its own daemon: never Local Pane, a manually set up remote host, or any other code path.
test('CLAUDE_CODE_SANDBOXED is set only by the cloud sandbox daemon drop-in', () => {
  const script = cloudBootstrapAssets['rp-bootstrap.sh'];
  const setters = script.split('\n').filter((line) => line.includes('CLAUDE_CODE_SANDBOXED') && !line.trimStart().startsWith('#'));
  assert.deepEqual(setters, [`  printf '[Service]\\nEnvironment=CLAUDE_CODE_SANDBOXED=1\\n' >"$dir/claude-sandboxed.conf"`]);
  assert.match(script, /install_agent_dropins\(\) \{\n {2}local dir="\$HOME\/\.config\/systemd\/user\/pane-remote-daemon\.service\.d"/u);

  const root = repoRoot();
  const allowed = new Set([
    'packages/runpane/src/cloud/bootstrap/assets/rp-bootstrap.sh',
    'packages/runpane/src/cloud/bootstrap/generated/assets.ts',
    'packages/runpane/src/cloud/bootstrap/assets.test.ts',
    'docs/SELF_HOSTED_REMOTE_DAEMON.md',
  ]);
  const listed = childProcess.spawnSync('git', ['grep', '-l', 'CLAUDE_CODE_SANDBOXED'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const offenders = listed.stdout.split('\n').filter((file) => file && !allowed.has(file));
  assert.deepEqual(offenders, [], 'no other source (main, frontend, shared, the rest of runpane) mentions CLAUDE_CODE_SANDBOXED');
});

test('claude-model sets the default model and keeps a model chosen in the sandbox', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const settingsFile = path.join(home, '.claude/settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
  const run = (model: string) => {
    const result = runStep('claude-model', [model], new Map(), home);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').pop()?.replace(/^RP_RESULT /u, '') ?? '{}');
  };
  assert.equal(run('claude-opus-5-5').outcome, 'set');
  assert.deepEqual(readJson(settingsFile), { skipDangerousModePermissionPrompt: true, model: 'claude-opus-5-5' });
  assert.equal(run('claude-opus-5-5').outcome, 'current');
  assert.equal(run('sonnet').outcome, 'set');
  assert.deepEqual(readJson(settingsFile), { skipDangerousModePermissionPrompt: true, model: 'sonnet' });

  // Someone picked a model inside the sandbox (/model writes settings.json): that choice stays.
  run('claude-opus-5-5');
  fs.writeFileSync(settingsFile, JSON.stringify({ skipDangerousModePermissionPrompt: true, model: 'haiku' }));
  assert.equal(run('sonnet').outcome, 'kept-sandbox-choice');
  assert.equal(readJson(settingsFile).model, 'haiku');
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);

  assert.match(runStep('claude-model', ['opus; rm -rf ~'], new Map(), home).stdout, /"error": "claude-model: not a Claude model id"/u);
  // There is no clear: an unknown default sends nothing at all.
  assert.match(runStep('claude-model', ['--clear'], new Map(), home).stdout, /"error": "claude-model: not a Claude model id"/u);
});

/** Runs rp-user-startup.sh against a temp HOME with a short time limit; returns the HOME and the runner's exit. */
function runUserStartup(home: string, script: string | null, limitSeconds = 30) {
  const runner = path.join(home, 'rp-user-startup.sh');
  fs.writeFileSync(runner, cloudBootstrapAssets['rp-user-startup.sh']);
  const scriptFile = path.join(home, '.config/runpane-cloud/startup.sh');
  if (script === null) fs.rmSync(scriptFile, { force: true });
  else {
    fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
    fs.writeFileSync(scriptFile, script, { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, RP_STARTUP_TIMEOUT_SECONDS: String(limitSeconds) };
  return childProcess.spawnSync('bash', [runner], { encoding: 'utf8', env });
}

const startupState = (home: string) => path.join(home, '.local/state/runpane-cloud');
const sha256Of = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

test('rp-user-startup records a successful run: status JSON and the script output in the log', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const script = 'echo MARKER-ONE\n';
  const result = runUserStartup(home, script);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const status = readJson(path.join(startupState(home), 'startup-status.json'));
  assert.deepEqual(Object.keys(status).sort(), ['exitCode', 'finishedAt', 'sha256', 'startedAt', 'timedOut']);
  assert.equal(status.exitCode, 0);
  assert.equal(status.timedOut, false);
  assert.equal(status.sha256, sha256Of(script));
  assert.match(status.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
  assert.ok(Date.parse(status.finishedAt) >= Date.parse(status.startedAt));
  assert.match(fs.readFileSync(path.join(startupState(home), 'startup.log'), 'utf8'), /MARKER-ONE/u);
  assert.equal(fs.statSync(startupState(home)).mode & 0o777, 0o700);
});

test('rp-user-startup records a failing run with its exit code', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const result = runUserStartup(home, 'echo about to fail >&2\nexit 7\n');
  assert.equal(result.status, 7);
  const status = readJson(path.join(startupState(home), 'startup-status.json'));
  assert.equal(status.exitCode, 7);
  assert.equal(status.timedOut, false);
  assert.match(fs.readFileSync(path.join(startupState(home), 'startup.log'), 'utf8'), /about to fail/u);
});

test('rp-user-startup kills a script that runs past the time limit and records the timeout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const started = Date.now();
  const result = runUserStartup(home, 'echo started\nsleep 30\necho never\n', 1);
  assert.ok(Date.now() - started < 15_000, 'the runner did not wait for the script');
  assert.notEqual(result.status, 0);
  const status = readJson(path.join(startupState(home), 'startup-status.json'));
  assert.equal(status.timedOut, true);
  assert.notEqual(status.exitCode, 0);
  const log = fs.readFileSync(path.join(startupState(home), 'startup.log'), 'utf8');
  assert.match(log, /started/u);
  assert.doesNotMatch(log, /never/u);
});

test('rp-user-startup keeps the logs of the last 5 runs, rotated in place', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  for (let run = 1; run <= 7; run += 1) assert.equal(runUserStartup(home, `echo RUN-${run}\n`).status, 0);
  const state = startupState(home);
  assert.deepEqual(fs.readdirSync(state).sort(),
    ['startup-status.json', 'startup.log', 'startup.log.1', 'startup.log.2', 'startup.log.3', 'startup.log.4']);
  const runIn = (name: string) => /RUN-(\d)/u.exec(fs.readFileSync(path.join(state, name), 'utf8'))?.[1];
  assert.deepEqual(['startup.log', 'startup.log.1', 'startup.log.2', 'startup.log.3', 'startup.log.4'].map(runIn), ['7', '6', '5', '4', '3']);
});

test('rp-user-startup does nothing without a script', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const result = runUserStartup(home, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(startupState(home)), false);
});

/** Runs a startup step with sudo passed through, systemctl recorded, and the unit and runner installed under the temp HOME. */
function runStartupStep(home: string, step: string, args: string[], systemctl = '') {
  const calls = path.join(home, 'calls');
  fs.rmSync(calls, { force: true });
  const env = new Map([
    ['sudo', '() { "$@"; }'],
    ['chown', '() { return 0; }'],
    ['systemctl', `() { echo "systemctl $*" >> '${calls}'; ${systemctl} }`],
  ]);
  fs.mkdirSync(path.join(home, 'root/etc/systemd/system'), { recursive: true });
  fs.mkdirSync(path.join(home, 'root/usr/local/sbin'), { recursive: true });
  const dir = home;
  const file = path.join(dir, 'rp-bootstrap.sh');
  for (const name of names) fs.writeFileSync(path.join(dir, name), cloudBootstrapAssets[name]);
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env, HOME: dir, RP_STATE: path.join(dir, 'state'), XDG_RUNTIME_DIR: dir,
    RP_UNIT_DIR: path.join(home, 'root/etc/systemd/system'), RP_SBIN: path.join(home, 'root/usr/local/sbin'),
  };
  for (const [name, body] of env) processEnv[`BASH_FUNC_${name}%%`] = body;
  const result = childProcess.spawnSync('bash', [file, step, ...args], { encoding: 'utf8', env: processEnv });
  const payload = result.stdout.trim().split('\n').pop()?.replace(/^RP_RESULT /u, '') ?? '{}';
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, payload: JSON.parse(payload), calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('startup-install lays down the boot unit: a oneshot system unit run as the login user, after the network, killed after 10 min', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/startup.sh.new'), 'echo hi\n');
  const result = runStartupStep(home, 'startup-install', [path.join(home, 'state/startup.sh.new')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const user = os.userInfo().username;
  const unit = fs.readFileSync(path.join(home, 'root/etc/systemd/system/rp-user-startup.service'), 'utf8');
  assert.equal(unit, [
    '[Unit]',
    'Description=Pane cloud sandbox: run the user\'s startup script (~/.config/runpane-cloud/startup.sh)',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `User=${user}`,
    `WorkingDirectory=${home}`,
    `Environment=PATH=${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ExecStart=${home}/root/usr/local/sbin/rp-user-startup`,
    // The runner kills the script at 10 min (and records it); this only backs it up.
    'TimeoutStartSec=660',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n'));
  // Nothing orders the Pane daemon (a user unit) after it, so a slow script never holds the daemon up.
  assert.doesNotMatch(unit, /Before=|pane-remote-daemon|RequiredBy/u);
  assert.equal(fs.readFileSync(path.join(home, 'root/usr/local/sbin/rp-user-startup'), 'utf8'), cloudBootstrapAssets['rp-user-startup.sh']);
  assert.equal(fs.statSync(path.join(home, 'root/usr/local/sbin/rp-user-startup')).mode & 0o777, 0o755);
  assert.match(result.calls, /systemctl daemon-reload\nsystemctl enable rp-user-startup\.service/u);
  assert.doesNotMatch(result.calls, /--now|systemctl start /u, 'installing never runs the script');

  const script = path.join(home, '.config/runpane-cloud/startup.sh');
  assert.equal(fs.readFileSync(script, 'utf8'), 'echo hi\n');
  assert.equal(fs.statSync(script).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(home, 'state/startup.sh.new')), false, 'the upload is removed');
  assert.deepEqual(result.payload, { ok: true, sha256: sha256Of('echo hi\n') });
});

test('startup-install with no file removes the script, and is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const script = path.join(home, '.config/runpane-cloud/startup.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'echo old\n');
  for (let run = 0; run < 2; run += 1) {
    const result = runStartupStep(home, 'startup-install', ['']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.payload, { ok: true, sha256: null });
  }
  assert.equal(fs.existsSync(script), false);
});

test('startup-run starts the unit without waiting; if-changed skips a script the last run used; a run in progress is busy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  const script = path.join(home, '.config/runpane-cloud/startup.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'echo v1\n');
  const statusFile = path.join(startupState(home), 'startup-status.json');
  const writeStatus = (sha: string) => {
    fs.mkdirSync(startupState(home), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({ exitCode: 3, startedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:00:01Z', sha256: sha, timedOut: false }));
  };
  const idle = '[ "$1" = is-active ] && echo inactive; return 0;';

  const first = runStartupStep(home, 'startup-run', ['if-changed'], idle);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.calls, /systemctl start --no-block rp-user-startup\.service/u);
  assert.deepEqual(first.payload, { ok: true, state: 'started', status: null });

  writeStatus(sha256Of('echo v1\n'));
  const unchanged = runStartupStep(home, 'startup-run', ['if-changed'], idle);
  assert.equal(unchanged.payload.state, 'skipped');
  assert.equal(unchanged.payload.status.exitCode, 3);
  assert.doesNotMatch(unchanged.calls, /systemctl start/u);

  assert.equal(runStartupStep(home, 'startup-run', ['always'], idle).payload.state, 'started');
  fs.writeFileSync(script, 'echo v2\n');
  assert.equal(runStartupStep(home, 'startup-run', ['if-changed'], idle).payload.state, 'started');

  // systemd merges a start into a run in progress instead of running again, so the caller waits and asks again.
  const busy = runStartupStep(home, 'startup-run', ['always'], '[ "$1" = is-active ] && echo activating; return 0;');
  assert.equal(busy.payload.state, 'busy');
  assert.doesNotMatch(busy.calls, /systemctl start/u);

  fs.rmSync(script);
  assert.deepEqual(runStartupStep(home, 'startup-run', ['always'], idle).payload, { ok: true, state: 'skipped', status: { exitCode: 3, startedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:00:01Z', sha256: sha256Of('echo v1\n'), timedOut: false } });
  assert.match(runStartupStep(home, 'startup-run', ['sometimes']).stdout, /"error": "startup-run: mode must be always or if-changed"/u);
});

test('startup-status reports whether the unit runs and the latest status', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  assert.deepEqual(runStartupStep(home, 'startup-status', [], '[ "$1" = is-active ] && echo activating; return 0;').payload,
    { ok: true, active: true, status: null });
  fs.mkdirSync(startupState(home), { recursive: true });
  fs.writeFileSync(path.join(startupState(home), 'startup-status.json'), '{"exitCode":0,"startedAt":"a","finishedAt":"b","sha256":"c","timedOut":false}\n');
  assert.deepEqual(runStartupStep(home, 'startup-status', [], '[ "$1" = is-active ] && echo failed; return 3;').payload,
    { ok: true, active: false, status: { exitCode: 0, startedAt: 'a', finishedAt: 'b', sha256: 'c', timedOut: false } });
  fs.writeFileSync(path.join(startupState(home), 'startup-status.json'), '{ half');
  assert.deepEqual(runStartupStep(home, 'startup-status', [], 'return 3;').payload, { ok: true, active: false, status: null });
});

test('startup-log returns the last 200 lines of the latest run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
  assert.deepEqual(runStartupStep(home, 'startup-log', []).payload, { ok: true, log: '' });
  fs.mkdirSync(startupState(home), { recursive: true });
  fs.writeFileSync(path.join(startupState(home), 'startup.log'), Array.from({ length: 250 }, (_, line) => `line ${line + 1}`).join('\n') + '\n');
  const lines = runStartupStep(home, 'startup-log', []).payload.log.trimEnd().split('\n');
  assert.equal(lines.length, 200);
  assert.equal(lines[0], 'line 51');
  assert.equal(lines[199], 'line 250');
});
