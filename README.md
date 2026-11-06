# dsh-cbm-autorefresh

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that keeps
[codebase-memory](https://www.npmjs.com/package/codebase-memory-mcp) indexes fresh **per Session**.

Harness opens one MCP connection for the whole app, so `codebase-memory` never learns which
workspace a Session is actually working in — every project reports
`watch.reason: not_session_project` and nothing auto-refreshes. This plugin closes that gap:

- on `session/created`, it refreshes the index of **that Session's own working directory**;
- on `working-directory/change`, it refreshes the **new** directory instead;
- when the plugin itself (re)loads, it catches up on the Sessions that already exist.

Each refresh is one or more short-lived CLI calls (1–3 s when nothing changed). All heavy
indexing happens inside codebase-memory's shared daemon, so the plugin never keeps a background
process alive: N Sessions do **not** mean N resident processes.

## Install

```bash
# in your DSH profile directory, e.g. ~/.dsh/profiles/desktop
pnpm add dsh-cbm-autorefresh
```

Then add the bundle to the profile manifest and reload:

```jsonc
// package.json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-cbm-autorefresh"]
    }
  }
}
```

The package ships its own `cordis.patch.yml`, so it mounts itself; override or disable it from
your profile patch:

```yaml
- id: cbm-autorefresh
  disabled: true
```

## Configuration

```yaml
- id: cbm-autorefresh
  name: dsh-cbm-autorefresh
  config:
    enabled: true                 # false turns every trigger off
    binary: /path/to/codebase-memory-mcp   # default: $CBM_BIN, then ~/.local/bin/codebase-memory-mcp
    minIntervalMs: 300000         # per-directory throttle (default 5 minutes)
    timeoutMs: 600000             # per CLI call timeout (default 10 minutes)
    logFile: /tmp/cbm-autorefresh.log      # optional: also append every refresh line to a file
```

## Behaviour and limits

| Situation | Result |
|---|---|
| Session starts in an indexed repo | index refreshed (≈1–3 s when unchanged) |
| Session switches to another indexed repo | that repo's index refreshed |
| Repo not indexed yet | skipped and logged — first indexing stays a deliberate act |
| Not a git working directory | skipped and logged |
| Same directory within `minIntervalMs` | skipped (throttled) |
| Same repo already refreshing | skipped (single-flight) |

Known limits:

- the plugin does not create indexes, it only refreshes existing ones;
- a Session that edits a lot without starting a new turn or changing directory stays refreshed
  at session start only — raise the triggers yourself if you need more;
- requires `codebase-memory-mcp` on the machine (the `binary` config or `$CBM_BIN`).

## How it works

```
session/created ─┐
                 ├─► session working directory ─► git rev-parse --show-toplevel
working-directory/change ─┘                          │
                                                     ├─► codebase-memory-mcp cli list_projects --format json
                                                     │      (find the project whose root_path matches)
                                                     └─► codebase-memory-mcp cli index_repository --repo-path <root>
```

## Testing

```bash
npm test
```

## License

MIT
