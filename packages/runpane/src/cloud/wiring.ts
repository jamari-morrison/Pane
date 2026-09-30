import { promises as fs } from 'node:fs';
import { createBoatProvider } from './boat';
import { cloudHostname, provisionSandbox, waitForDaemonHealth } from './bootstrap';
import type { CloudDeps } from './commands';
import { defaultDesktopDir } from './desktop';
import type { BootstrapPort } from './ports';
import { createCloudStore } from './store';
import { createTailscaleApi } from './tailscale';

/** The real dependencies behind `runpane cloud`: boat REST, m1-bootstrap, the Tailscale API, local files. */
export function createDefaultCloudDeps(env: NodeJS.ProcessEnv = process.env): CloudDeps {
  const bootstrap: BootstrapPort = {
    cloudHostname,
    createTailnet: (credentials) => createTailscaleApi(credentials),
    waitForDaemonHealth: (baseUrl, options) => waitForDaemonHealth(baseUrl, options),
    async provision(sandbox, request, tailnet) {
      const result = await provisionSandbox(sandbox, {
        sessionId: request.sessionId,
        label: request.label,
        hostname: request.hostname,
        tailscale: createTailscaleApi(tailnet),
        paneSource: request.paneSource,
        repo: request.repo,
        pairingOutputPath: request.pairingOutputPath,
        extraClients: request.extraClients,
        healthTimeoutMs: request.healthTimeoutMs,
        onStep: (step) => {
          if (step.state === 'done') {
            request.onStep?.(`${step.step} done${step.elapsedMs !== undefined ? ` (${(step.elapsedMs / 1000).toFixed(1)} s)` : ''}${step.detail ? `: ${step.detail}` : ''}`);
          }
        },
      });
      return {
        hostname: result.hostname,
        magicDnsName: result.magicDnsName,
        nodeId: result.nodeId,
        baseUrl: result.baseUrl,
        pairingPath: result.pairingPath,
        daemonVersion: result.daemonVersion,
        timings: result.timings,
      };
    },
  };

  return {
    store: createCloudStore(),
    createProvider: (credentials) => {
      if (!credentials.boat) throw new Error('No boat API key saved. Run: runpane cloud setup --boat-key-file <path|->');
      return createBoatProvider({ apiKey: credentials.boat.apiKey });
    },
    bootstrap,
    readSecretFile,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env,
    defaultDesktopDir: defaultDesktopDir(env),
  };
}

/** Reads a secret from a file, or from stdin for "-". Secrets never come from argv (visible in `ps`). */
async function readSecretFile(filePath: string): Promise<string> {
  if (filePath !== '-') return fs.readFile(filePath, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
