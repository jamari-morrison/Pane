import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readLocalClaudeModel } from './claudeDefaults';

function homeWithSettings(settings: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-claude-home-'));
  if (settings !== null) {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude/settings.json'), settings);
  }
  return home;
}

test('reads the user\'s default the way Claude Code does: ANTHROPIC_MODEL, then settings.json model', async () => {
  const home = homeWithSettings(JSON.stringify({ model: 'claude-opus-5-5', theme: 'dark' }));
  assert.equal(await readLocalClaudeModel({}, home), 'claude-opus-5-5');
  assert.equal(await readLocalClaudeModel({ ANTHROPIC_MODEL: ' sonnet ' }, home), 'sonnet');
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(JSON.stringify({ model: 'claude-opus-5-5[1m]' }))), 'claude-opus-5-5[1m]');
});

test('honours CLAUDE_CONFIG_DIR', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-claude-config-'));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
  assert.equal(await readLocalClaudeModel({ CLAUDE_CONFIG_DIR: configDir }, homeWithSettings(JSON.stringify({ model: 'sonnet' }))), 'opus');
});

test('null when nothing is set or the value is unusable, so the sandbox keeps Claude Code\'s own default', async () => {
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(null)), null);
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(JSON.stringify({ theme: 'dark' }))), null);
  assert.equal(await readLocalClaudeModel({}, homeWithSettings('{ not json')), null);
  assert.equal(await readLocalClaudeModel({}, homeWithSettings(JSON.stringify({ model: 'opus; rm -rf /' }))), null);
  assert.equal(await readLocalClaudeModel({ ANTHROPIC_MODEL: '$(id)' }, homeWithSettings(null)), null);
});
