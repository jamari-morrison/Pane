#!/usr/bin/env node
// A stand-in for Claude Code on the fake host when no Claude credential is available (CI): it draws Claude's
// prompt footer, answers the harness's two prompts, and keeps a per-session transcript so that
// `--resume <id>` brings the conversation back the way a resumed Claude does. It exercises the harness and
// the app (panel, terminal, resume), never Claude itself.
//   SUM:  "...compute 123+456..."             -> SUM=579
//   WORD: "The code word is X." then later "What was the code word..." -> WORD=X (from the transcript)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const resumed = flag('--resume');
const sessionId = resumed ?? flag('--session-id') ?? `fake-${process.pid}`;
const transcriptDir = path.join(os.homedir(), '.claude', 'projects', 'fake-claude');
fs.mkdirSync(transcriptDir, { recursive: true });
const transcript = path.join(transcriptDir, `${sessionId}.jsonl`);
const append = (role, text) => fs.appendFileSync(transcript, `${JSON.stringify({ role, text, at: new Date().toISOString() })}\n`);

const footer = () => process.stdout.write('\n> \n  ? for shortcuts\n  >> bypass permissions on\n');
process.stdout.write(`Claude Code (cs-e2e stand-in)\n${process.cwd()}\n${resumed ? `resumed ${sessionId}\n` : ''}`);
footer();

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  append('user', line);
  let answer = 'OK';
  const sum = line.match(/(\d+)\s*\+\s*(\d+)/);
  if (sum) answer = `SUM=${Number(sum[1]) + Number(sum[2])}`;
  if (/what was the code word/i.test(line)) {
    const said = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((entry) => JSON.parse(entry))
      .map((entry) => entry.role === 'user' && entry.text.match(/code word is (\S+?)\./i)?.[1]).filter(Boolean).at(-1);
    answer = said ? `WORD=${said}` : 'No code word in this conversation.';
  }
  append('assistant', answer);
  process.stdout.write(`\n* ${answer}\n`);
  footer();
});
