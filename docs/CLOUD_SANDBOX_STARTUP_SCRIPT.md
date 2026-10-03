# Cloud sandbox startup script

A startup script sets up every cloud sandbox the same way: install a tool, clone a dotfiles repository, or
anything else you would otherwise do by hand after each start. It is one script for all of your sandboxes.

> **Don't put secrets here; it's stored unencrypted.** Sign in to tools that need a secret (for example
> `doppler login`, `gh auth login` or `codex login --device-auth`) yourself, in the sandbox's terminal.

## Where it is set and stored

- Edit it in **Settings > Remote Access > Cloud sandboxes > Startup script**. **Startup script** on a sandbox's
  row leads to the same editor.
- Desktop Pane keeps it only on this computer, as plain text: `<pane data dir>/cloud-sandboxes/startup.sh`
  (`~/.pane/cloud-sandboxes/startup.sh` by default, mode 0600).
- Each sandbox gets a copy at `~/.config/runpane-cloud/startup.sh` (mode 0700, owned by `user`). Pane pushes the
  current script when it creates a sandbox and every time it starts one, before it waits for the sandbox's Pane
  daemon. Saving an empty script removes the copy, and then nothing runs.
- `runpane cloud` never pushes a script: a sandbox started from the command line keeps the one it has.

## When it runs

- **On every start of the sandbox.** A systemd system unit, `rp-user-startup.service`, runs it as `user` at every
  boot, after the network is up (`Type=oneshot`, `After=network-online.target`). A stopped sandbox boots again when
  it starts, so this covers every **Start**.
- **Once after Create.** The new sandbox's row shows "Running your startup script…" while it runs.
- **Once after you save an edit**, on every running sandbox. A stopped sandbox gets the edit at its next start: the
  boot runs the copy it had, and Pane runs the script once more if you changed it since.
- The script runs with `bash`, from your home folder, without a terminal. `PATH` is the system path plus
  `~/.local/bin`; `sudo` works without a password.
- It never holds up Pane: the Pane daemon starts on its own, so the sandbox is usable while the script runs.

## Make it safe to run again

The script runs on every start, so a step that already happened must be skipped or harmless. That is up to you.
Guard installs, for example:

```bash
command -v doppler >/dev/null || curl -Ls --tlsv1.2 --proto "=https" https://cli.doppler.com/install.sh | sudo sh
[ -d ~/dotfiles ] || git clone https://github.com/<you>/dotfiles ~/dotfiles
```

## Logs and failures

- `~/.local/state/runpane-cloud/startup.log` holds the output of the latest run. `startup.log.1` to `startup.log.4`
  keep the 4 runs before it, so the last 5 runs are kept.
- `~/.local/state/runpane-cloud/startup-status.json` describes the latest run: `exitCode`, `startedAt`, `finishedAt`,
  the script's `sha256` and `timedOut`. While a run is in progress, `exitCode` and `finishedAt` are `null`.
- After Create, Start or a saved edit, Pane reads the status. When the script exits with a non-zero code, the row
  shows **⚠ Startup script failed (exit N) · View log**; when it ran too long, **(timed out after 10 min)**.
  **View log** shows the last 200 lines of the latest run. The sandbox stays usable either way.
- The log holds whatever your script prints, so don't print secrets from it either.

## Known limits

- **10 minutes per run.** After that the script is stopped and the run counts as failed (timed out).
- **No background services.** Processes the script leaves running are stopped when it finishes. Run a long-lived
  process as a systemd user service instead.
- **No input.** The script has no terminal and its input is empty, so a command that asks a question gets no answer:
  pass its non-interactive flag (for example `apt-get -y`).
- **The failure chip is kept in memory only.** A row shows the run the desktop read after Create, Start or an edit.
  Pane doesn't watch later runs, and the chip is not kept across a desktop restart: it comes back at the next Start
  or edit. The sandbox's `startup-status.json` and logs always have the latest run.
- **Plain text.** The script is not encrypted on this computer or in the sandbox.
