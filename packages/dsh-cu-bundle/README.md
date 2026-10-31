# @albaincompleta/dsh-cu-bundle

A DSH profile layer that mounts the D1 providers over a stock profile.

The bundle itself has no runtime code. Its `cordis.patch.yml` inserts:

| Entry | Purpose |
|---|---|
| `dsh-cu-client` | `@albaincompleta/dsh-cu-client`: the browser half that renders DSH-CU tool cards in the DSH client |
| `browser-use-registry` | The single browser-use registration slot (`@deepseek-ai/dsh-browser-use`) |
| `dsh-cu-browser` | `@albaincompleta/dsh-cu-browser-use-d1` in launch mode, headless off macOS, locale `zh` |
| `computer-use-registry` | `@deepseek-ai/dsh-computer-use`, disabled |
| `dsh-cu-computer` | `@albaincompleta/dsh-cu-computer-use-d1`, disabled (needs macOS Accessibility and Screen Recording) |

## Install

```bash
# 1. Build and register the packages in a profile.
dsh plugin --profile dsh-cu add \
  link:/path/to/dsh-cu-bundle \
  link:/path/to/dsh-cu-core \
  link:/path/to/dsh-browser-use-d1 \
  link:/path/to/dsh-computer-use-d1

# 2. Add the bundle to the profile's layer list.
#    ~/.dsh/profiles/dsh-cu/package.json
#    "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@albaincompleta/dsh-cu-bundle"] } }

# 3. Compose and verify without starting a browser or a model.
dsh --profile dsh-cu --dump-config | grep dsh-cu
```

`dsh plugin` forwards to pnpm, so a published package can be installed by name
instead of by link.

## Configuration

The bundle reads the environment at profile load:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_CU_DECISION_ENDPOINT` | `http://127.0.0.1:8765` | Local D1 decision service |
| `DSH_CU_DECISION_TOKEN` | `dsh-cu-local` | Bearer token for that service |
| `DSH_CU_CONTROL_TOKEN` | `dsh-cu-control` | Token for the loopback control page |
| `DSH_CU_HEADLESS` | unset | `1` forces the headless browser path |
| `DSH_CU_CAPTURE_SKILLS` | unset | `1` enables Skill candidate capture (needs `skillStorePath`) |

Per-profile overrides belong in `~/.dsh/profiles/<name>/cordis.patch.yml`, not in
this package: a patch entry with `id: dsh-cu-browser` replaces the bundled config.

## Requirements

- DSH `>=0.2.1-rc.5 <0.3.0` (`engines.dsh` on every package).
- `@deepseek-ai/cordis` `~4.0.5`.
- The profile must not already mount another browser-use provider: the slot is
  exclusive, and a second registration fails at startup.

## Native provider

The native entries ship disabled. Before enabling both, read the native section
of the provider README: it needs a local CUA helper, macOS Accessibility and
Screen Recording grants, and an authorized application per run.
