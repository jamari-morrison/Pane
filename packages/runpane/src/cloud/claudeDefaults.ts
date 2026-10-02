import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundary, decodeBoundary } from '../boundaryDecoder';

/** A model id or alias as `claude --model` takes it: claude-opus-5-5, opus, claude-opus-5-5[1m]. */
const MODEL_PATTERN = /^[A-Za-z0-9][\]A-Za-z0-9._:@/[-]{0,99}$/u;

const settingsSchema = boundary.object({ model: boundary.optional(boundary.string) });

/**
 * The model the user's own Claude Code starts with when Pane launches it on this machine. Pane's Claude panels pass
 * no `--model` (agentTemplates `claude --dangerously-skip-permissions`), so Claude Code resolves it: `ANTHROPIC_MODEL`,
 * then `model` in the user settings (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). Null when
 * neither is set (Claude Code then picks its own default for the account) or the value is not a model id.
 */
export async function readLocalClaudeModel(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Promise<string | null> {
  const fromEnv = env.ANTHROPIC_MODEL?.trim();
  if (fromEnv) return MODEL_PATTERN.test(fromEnv) ? fromEnv : null;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  let text: string;
  try {
    text = await fs.readFile(path.join(configDir, 'settings.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const model = decodeBoundary(JSON.parse(text), settingsSchema).model?.trim();
    return model && MODEL_PATTERN.test(model) ? model : null;
  } catch {
    return null;
  }
}
