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
- Optional event API for presets, read-only modes, and other policy extensions
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

With no preset integration active, Config Manager opens in **Default** scope. An integration can mark a preset active, in which case it opens in **Session** scope. Press `G` at any time to switch.

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

Session overrides are stored as `pi-config-manager-state` entries in Pi's session tree, so `/tree`, resume, and branch navigation restore the correct policy.

For migration from earlier standalone resource extensions, a session branch without `pi-config-manager-state` can import legacy `tools-config` and `skills-manager-state` entries. The first run can also import `disabledSkills` from the legacy global `skill-settings.json` file.

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

Layers compose by ID. Required tools are added after disabled tools for each layer, and only discovered tools can be activated.

### Preset compatibility

Config Manager listens for:

```typescript
pi.events.emit("preset:tools-changed", {
  tools: ["read", "bash"],
  resetSessionOverride: true,
});

pi.events.emit("preset:skills-changed", {
  skills: ["review"],
  resetSessionOverride: true,
});

pi.events.emit("config-manager:preset-state", {
  name: "review",
});
```

To observe counts, listen for `config-manager:state-changed`. Emit `config-manager:request-snapshot` to request an immediate snapshot.

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

## License

[MIT](LICENSE)
