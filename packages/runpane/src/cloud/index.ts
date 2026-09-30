import { parseCloudArgs } from './args';
import { runCloudCommand, type CloudDeps } from './commands';

/**
 * `runpane cloud <subcommand> ...`: create and manage cloud Sessions from the user's machine.
 * The desktop app never manages machines (#695); it only sees the saved remote host profiles.
 */
export async function runCloud(argv: readonly string[], deps?: CloudDeps): Promise<number> {
  const args = parseCloudArgs(argv);
  // Loaded lazily so the rest of the CLI never pays for the cloud modules.
  const resolved = deps ?? (await import('./wiring')).createDefaultCloudDeps();
  return runCloudCommand(args, resolved);
}
