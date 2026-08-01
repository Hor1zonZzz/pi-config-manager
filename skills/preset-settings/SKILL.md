---
name: preset-settings
description: Safely edit Pi preset profile configuration in presets.json. Use when the user asks to add, remove, rename, or change a preset's model, thinking level, tools, skills, or instructions.
---

# Pi Preset Settings

Use this workflow for named Pi preset profiles. If a restrictive preset prevents the requested work, ask the user to return to default mode through `/preset` first.

## Choose the configuration file

1. If the current repository manages Pi configuration and contains a root `presets.json`, treat that file as its source of truth rather than editing an installed copy.
2. Otherwise edit the global `${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-~/.pi/agent}}/presets.json`.
3. Use `.pi/presets.json` only when the user explicitly requests a project-local preset; project presets are loaded only for trusted projects.
4. Read the existing file first and preserve unrelated profiles and unknown top-level profiles.

Do not create a profile named `default` merely to change defaults. `default` means no named preset is active.

## Preset shape

`presets.json` is an object keyed by preset name:

```json
{
  "review": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinkingLevel": "high",
    "tools": ["read", "bash"],
    "skills": ["preset-settings"],
    "instructions": "Review carefully and do not edit files."
  }
}
```

Rules:

- Keep `provider` and `model` together. Verify identifiers with `pi --list-models` before adding a model.
- Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `tools` is a replacement list. An empty list disables all tools; omitting it preserves the tool policy active when the preset is applied.
- `skills` is a model-visible allowlist. An empty list hides all model-invocable skills; omitting it uses Config Manager's normal global/project policy.
- `instructions` is appended to the system prompt while the preset is active.
- Use discovered tool and skill names; do not place filesystem paths in these arrays.
- Never store credentials or machine-local authentication data in a preset.

## Validate

Parse the edited JSON and check the repository diff. When Config Manager source is available, also run its tests and typecheck. Report the profile changed, validation performed, and whether the source change was installed into the live Pi agent directory.
