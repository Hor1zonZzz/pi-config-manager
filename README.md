# Pi Config Manager

Manage Pi tools, skills, context files, and extensions from one searchable TUI overlay.

English | [简体中文](README.zh-CN.md)

Pi Config Manager is a resource-policy extension for [Pi Coding Agent](https://github.com/earendil-works/pi). Pi remains the source of truth for resource discovery, loading, deduplication, and provenance; Config Manager only decides which discovered resources are enabled.

## Highlights

- One UI for **Tools**, **Skills**, **Context Files**, and **Extensions**
- Searchable, keyboard-driven overlay that keeps the current conversation visible
- Persistent **Default** settings and branch-aware **Session** overrides
- Context Monitor showing how the selected resource contributes to the model-visible prompt
- A compact resource HUD above the editor
- Source-aware extension toggles saved through Pi's public settings APIs
- Built-in named presets for model, thinking level, tools, skills, and instructions
- Optional runtime-layer event API for read-only modes and other policy extensions
- No telemetry and no network requests

## Requirements

- Pi Coding Agent **0.83.x**
- Interactive TUI mode for the visual manager

The current release is tested against Pi 0.83.0. Later Pi releases may work, but Pi's extension and TUI APIs can change; check this project's release notes before upgrading.

## Install

Install globally for all projects:

```bash
pi install npm:pi-config-manager
```

Or install for the current project:

```bash
pi install -l npm:pi-config-manager
```

Try it for one run without changing settings:

```bash
pi -e npm:pi-config-manager
```

Start Pi, then run:

```text
/config-manager
```

## Quick start

1. Run `/config-manager`.
2. Press `Tab` to move between resource tabs.
3. Type to filter the current list.
4. Press `Space` or `Enter` to toggle the selected resource.
5. Press `G` to switch between Default and Session scope.
6. In Extensions, press `S` to save staged changes and reload Pi.

### Keyboard controls

| Key | Action |
| --- | --- |
| `Tab` | Next resource tab |
| Type text | Filter the current resource list |
| `↑` / `↓` | Move through resources, or scroll the focused monitor |
| `←` / `→` | Focus the resource list or Context Monitor |
| `Space` / `Enter` | Toggle the selected resource |
| `G` | Switch Default/Session scope |
| `S` | Save staged extension changes and reload Pi |
| `Esc` | Close the manager |

Keybinding-aware actions follow Pi's configured TUI keybindings.

## Commands

| Command | Description |
| --- | --- |
| `/config-manager` | Open the unified overview |
| `/tools` | Open the Tools tab |
| `/skills` | Open the Skills tab |
| `/contexts` | Open the Context Files tab |
| `/extensions` | Open the Extensions tab |
| `/preset` | Select or clear a named preset |
| `/preset <name>` | Activate a named preset directly |

Global defaults can also be changed directly:

```text
/tools global enable|disable <tool-name>
/skills global enable|disable <skill-name>
/contexts global enable|disable <absolute-path>
```

## Default and Session scopes

| Scope | Persistence | Best for |
| --- | --- | --- |
| **Default** | Writes global choices to `~/.pi/agent/resource-settings.json`; new sessions inherit them | Your normal tool, skill, and context setup |
| **Session** | Stores overrides in the current session branch | Temporary changes for one task or conversation branch |

With no active preset, Config Manager opens in **Default** scope. With a named preset active, it opens in **Session** scope. Press `G` at any time to switch.

Trusted projects may add repository-specific defaults in `.pi/resource-settings.json`. The visual Default scope edits global defaults; project files stay source-controlled and are edited separately.

Extension changes are independent of Default/Session scope. They are staged in the UI and then written to the appropriate global or project Pi settings when you press `S` and confirm reload.

## Resource behavior

### Tools

Tool changes apply immediately through `pi.setActiveTools()`. Config Manager uses Pi's discovered tool inventory and preserves tools added by other extensions when it can observe them.

### Skills

Disabled skills are removed from Pi's standard system-prompt skill catalog. Invoking a disabled `/skill:<name>` command is also blocked with a notification.

### Context Files

Disabled context files are removed from Pi's standard `project_context` prompt block. This controls model-visible prompt content; it does **not** prevent tools from reading a known file path.

### Extensions

Extension toggles are staged until saved. Config Manager writes Pi's native extension/package filters through the public `SettingsManager`, then asks Pi to reload.

Pi cannot apply a per-extension filter when a local package source directly names a single extension file. Config Manager reports this case instead of saving an ineffective toggle. It also prevents disabling itself from its active UI.

## Context Monitor

On wide terminals, the overlay displays resources on the left and a Context Monitor on the right. Selecting a resource shows:

- **Tools:** description, parameter schema, prompt snippet, and prompt guidelines
- **Skills:** the skill's system-prompt catalog entry
- **Context Files:** the complete `project_context` block
- **Extensions:** source, scope, package origin, and path details

Before the first agent run, the monitor uses Pi's current prompt preview. After a run starts, it shows the effective system prompt captured at `agent_start` and highlights the selected resource when present. Policy changes made while the manager is open appear in the captured prompt after the next agent run.

On narrow terminals, Config Manager falls back to the resource list without the monitor pane.

## Configuration

Global defaults:

```text
~/.pi/agent/resource-settings.json
```

Trusted project defaults:

```text
.pi/resource-settings.json
```

Schema:

```json
{
  "version": 1,
  "disabledTools": ["write"],
  "disabledSkills": ["deploy"],
  "disabledContexts": ["/absolute/path/to/AGENTS.md"]
}
```

Session overrides and the active preset are stored together as version 2 `pi-config-manager-state` entries in Pi's session tree, so `/tree`, resume, and branch navigation restore the correct policy.

Version 2 is an intentional breaking reset. Version 1 `pi-config-manager-state`, standalone `preset-state`, `tools-config`, and `skills-manager-state` entries are not imported.

## Presets

Config Manager loads named presets from:

```text
~/.pi/agent/presets.json
.pi/presets.json
```

Project-local presets are loaded only for trusted projects and override global presets with the same name. Each preset may configure:

```json
{
  "review": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinkingLevel": "high",
    "tools": ["read", "bash"],
    "skills": ["preset-settings"],
    "instructions": "Review carefully before making changes."
  }
}
```

Use `/preset`, `/preset <name>`, `pi --preset <name>`, or `Ctrl+Shift+U`. Selecting `(none)` restores the model, thinking level, and base tool policy captured before the first preset was activated. An explicit empty `tools` or `skills` array enables none; omitting either field preserves the corresponding normal policy. Preset instructions are appended to the system prompt while the preset is active.

The package includes the `preset-settings` skill for safely editing these files.

## Policy precedence

```text
runtime constraint > session override > preset > project/global default > Pi default
```

Runtime constraints currently apply to tools. They are intended for integrations such as read-only or sandbox modes.

## Integration events

Config Manager works standalone. Other extensions can optionally coordinate policy through `pi.events`.

### Runtime tool layer

```typescript
pi.events.emit("config-manager:layer-set", {
  id: "read-only-mode",
  disableTools: ["edit", "write"],
  requireTools: ["read"],
});

pi.events.emit("config-manager:layer-clear", {
  id: "read-only-mode",
});
```

Layers compose by ID. Required tools are added after disabled tools for each layer, and only discovered tools can be activated. Callers may set or clear layers at any time, including before Config Manager's `session_start`; early events are stored and applied only after the default tool inventory is initialized.

To observe resource counts, listen for `config-manager:state-changed`. Emit `config-manager:request-snapshot` to request an immediate snapshot.

The former `preset:tools-changed`, `preset:skills-changed`, and `config-manager:preset-state` integration events have been removed. Presets are now owned directly by Config Manager.

## Limitations and security

- Pi extensions run with the user's full system permissions. Review third-party packages before installing them.
- Config Manager is a prompt/resource policy tool, not a filesystem or process sandbox.
- Skill and context filtering expects Pi's standard prompt sections. If a custom system prompt removes or rewrites those sections, Config Manager leaves the prompt unchanged and warns the user.
- The visual manager requires TUI mode. In RPC, JSON, and print modes, the overlay is unavailable.
- Extension changes require a Pi reload.

## Development

Requirements: Node.js 22.19+, [Bun](https://bun.sh/), and Pi 0.83.0+.

```bash
git clone https://github.com/Hor1zonZzz/pi-config-manager.git
cd pi-config-manager
npm install
npm run check
```

Run the local extension directly:

```bash
pi --no-extensions -e ./src/index.ts
```

### Publishing releases

Stable GitHub Releases automatically publish the matching package version to npm through `.github/workflows/publish.yml`. The workflow checks out the release tag, verifies that `v<package.json version>` exactly matches the tag, runs the full check suite, and publishes with npm trusted publishing. Prereleases are intentionally skipped.

Before the first automated publish, configure the package on npmjs.com under **Settings → Trusted Publisher → GitHub Actions**:

- Organization or user: `Hor1zonZzz`
- Repository: `pi-config-manager`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Then update `package.json` and `package-lock.json`, finalize `CHANGELOG.md`, commit and push, create the matching tag (for example `v0.1.1`), and publish a GitHub Release for that tag. The workflow uses OIDC, so no long-lived `NPM_TOKEN` secret is required. The npm configuration and workflow filename are case-sensitive.

## License

[MIT](LICENSE)
