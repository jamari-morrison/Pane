/**
 * Provider interface for `runpane cloud`: the only thing the CLI needs from a sandbox host.
 * boat.dev is the v1 adapter (./boat.ts); a second adapter is post-v1 (final-plan S5).
 */

export type CloudSize = 'small' | 'default' | 'large';
export const CLOUD_SIZES: readonly CloudSize[] = ['small', 'default', 'large'];

/** Provider-neutral lifecycle state. `gone` means the provider no longer knows the sandbox. */
export type CloudSandboxState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | 'gone';

export interface CloudSandbox {
  id: string;
  name: string;
  state: CloudSandboxState;
  /** The provider's own state string, for display and debugging. */
  providerState: string;
  size?: CloudSize;
  error?: string | null;
  createdAt?: string | null;
}

export interface CreateSandboxRequest {
  name: string;
  size: CloudSize;
  /** Named snapshot (golden image) to start from. */
  fromSnapshot?: string;
  /**
   * Makes a retried create return the same sandbox instead of a second one.
   * The CLI derives it from the cloud Session id.
   */
  idempotencyKey: string;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * What bootstrap needs to run inside a sandbox. It matches m1-bootstrap's SandboxHandle
 * (~/rc-loop/ledger/iface-bootstrap.md): scripts and file contents are never logged, because
 * they can carry secrets and stdout can carry the pairing code.
 */
export interface SandboxHandle {
  readonly id: string;
  runScript(script: string, options?: { timeoutSeconds?: number }): Promise<SandboxCommandResult>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface CloudProvider {
  readonly name: 'boat';
  /** Cheap authenticated call, used by `runpane cloud setup` to check the key. */
  verifyCredentials(): Promise<{ account: string }>;
  create(request: CreateSandboxRequest): Promise<CloudSandbox>;
  /** Returns a `gone` sandbox (never throws) when the provider answers 404. */
  get(sandboxId: string): Promise<CloudSandbox>;
  list(): Promise<CloudSandbox[]>;
  rename(sandboxId: string, name: string): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  resume(sandboxId: string, options?: { size?: CloudSize }): Promise<void>;
  /** Permanently deletes the sandbox and its disk. Idempotent: a 404 counts as deleted. */
  destroy(sandboxId: string): Promise<void>;
  handle(sandboxId: string): SandboxHandle;
}

export class CloudProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CloudProviderError';
  }
}
