import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunpaneArgs } from '../commands';
import { parseCloudArgs } from './args';

test('host commands take the host as a positional argument or --host', () => {
  assert.equal(parseCloudArgs(['wake', 'rp-abc12345']).host, 'rp-abc12345');
  assert.equal(parseCloudArgs(['stop', '--host', 'rp-abc12345', '--yes']).host, 'rp-abc12345');
  assert.throws(() => parseCloudArgs(['destroy', '--yes']), /needs a host/u);
  assert.throws(() => parseCloudArgs(['wake', 'a', 'b']), /Unexpected argument/u);
});

test('new parses its options and rejects options of other commands', () => {
  const parsed = parseCloudArgs(['new', '--label', 'Checkout', '--size=large', '--from', 'rp-golden', '--timeout-ms', '90000', '--yes', '--json']);
  assert.equal(parsed.label, 'Checkout');
  assert.equal(parsed.size, 'large');
  assert.equal(parsed.fromSnapshot, 'rp-golden');
  assert.equal(parsed.timeoutMs, 90000);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.json, true);
  assert.throws(() => parseCloudArgs(['new', '--force']), /Unknown option for runpane cloud new: --force/u);
  assert.throws(() => parseCloudArgs(['new', '--size', 'huge']), /--size must be one of/u);
  assert.throws(() => parseCloudArgs(['new', '--label']), /--label requires a value/u);
  assert.throws(() => parseCloudArgs(['new', '--pane-deb-url', 'u', '--pane-preinstalled']), /only one of/u);
  assert.throws(() => parseCloudArgs(['new', '--name-prefix', 'Bad_Prefix']), /--name-prefix/u);
});

test('secrets are only accepted as files, never as values', () => {
  assert.throws(() => parseCloudArgs(['setup', '--boat-key', 'boat_123']), /Unknown option/u);
  assert.equal(parseCloudArgs(['setup', '--boat-key-file', '-']).boatKeyFile, '-');
});

test('the shared parser hands cloud arguments through untouched', () => {
  const parsed = parseRunpaneArgs(['cloud', 'new', '--label', 'x', '--size', 'large', '--yes']);
  assert.equal(parsed.command, 'cloud new');
  assert.deepEqual(parsed.cloudArgv, ['new', '--label', 'x', '--size', 'large', '--yes']);
  assert.deepEqual(parseRunpaneArgs(['cloud', 'coordinator', 'mint-token', 'x', '--help']).cloudArgv, ['coordinator', 'mint-token', 'x', '--help']);
});

test('cloud help resolves to the group or the command topic', () => {
  assert.deepEqual([parseRunpaneArgs(['cloud']).command, parseRunpaneArgs(['cloud']).helpTopic], ['help', 'cloud']);
  assert.equal(parseRunpaneArgs(['cloud', '--help']).helpTopic, 'cloud');
  assert.equal(parseRunpaneArgs(['cloud', 'wake', '--help']).helpTopic, 'cloud wake');
  assert.throws(() => parseRunpaneArgs(['cloud', 'explode']), /Unknown cloud command: explode/u);
});
