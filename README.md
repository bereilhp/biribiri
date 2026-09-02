# biribiri
A tiny, opinionated CLI harness for Codex agents.

Biribiri is a zero-dependency terminal chat UI around Codex. It connects to the
Codex app-server supplied by the installed CLI, so Codex remains the source of
truth for sessions, conversation history, model settings, and usage. Biribiri
does not write a session index or transcript of its own.

## Run

```sh
npm start
```

No package installation is required; biribiri uses only Node.js built-ins.

Or link the local command:

```sh
npm link
biribiri
```

Codex must already be installed and logged in. Biribiri launches `codex
app-server --stdio`, starts a fresh Codex thread, and streams responses through
the current thread.

Options:

- `biribiri --cwd ./path` runs Codex against another working directory.
- `Ctrl-C` interrupts a response, or exits when idle.
- Every launch starts a fresh Codex thread. `Ctrl-N` starts another fresh thread
  and `Ctrl-L` clears the visible transcript.

No biribiri session data is stored. Existing metadata from older versions in
`~/.local/state/biribiri/sessions.json` is no longer read or updated.
