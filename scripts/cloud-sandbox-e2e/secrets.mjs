// Credentials for the run, read from files and kept in memory only. Values are never printed: callers get
// them through `secretValue(name)` to type into the app, and every log line, console message and evidence
// file goes through `redact()` / `scanForSecrets()`.
import fs from 'node:fs';
import path from 'node:path';

const values = new Map();

/** Loads one secret file. `transform` turns the file's text into the value (for example strips a header). */
export function loadSecret(name, file, transform = (text) => text.trim()) {
  const value = transform(fs.readFileSync(file, 'utf8'));
  if (!value) throw new Error(`secret ${name} is empty (${file})`);
  values.set(name, value);
  return { name, length: value.length };
}

/** Registers a value learned at run time (a pairing token, a saved host token) so it is redacted too. */
export function addSecret(name, value) {
  if (value) values.set(name, value);
}

export function secretValue(name) {
  const value = values.get(name);
  if (!value) throw new Error(`secret ${name} was not loaded`);
  return value;
}

export function secretNames() {
  return [...values.keys()];
}

export function redact(text) {
  let out = String(text);
  for (const [name, value] of values) {
    if (value.length >= 8) out = out.split(value).join(`<${name}>`);
  }
  return out;
}

/** Every file under `roots` that contains a secret value: [{ file, names }]. Reads bytes, so zips and
 *  sqlite files are searched as stored (a trace zip is deflated, so traces are also checked unzipped
 *  by the caller). */
export function scanForSecrets(roots) {
  const hits = [];
  let files = 0;
  const visit = (entry) => {
    let stat;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    if (!stat.isFile() || stat.size > 512 * 1024 * 1024) return;
    files += 1;
    const bytes = fs.readFileSync(entry);
    const names = [];
    for (const [name, value] of values) {
      if (value.length >= 8 && bytes.includes(value)) names.push(name);
    }
    if (names.length > 0) hits.push({ file: entry, names });
  };
  for (const root of roots) visit(root);
  return { files, hits };
}
