# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** Removed manual `G` target switching from the resource manager. The manager now always displays Effective resource state while automatically editing Global settings without a preset or Session overrides with an active preset.
- Split the resource header into explicit view/edit labels: `View: Effective · Edit: Global`, `View: Effective · Edit: Session · <preset>`, or `View/Edit: Pi settings` for Extensions.
- Runtime-controlled tools now show the owning constraint and are locked against ineffective toggles.
- Project-disabled resources are locked when the Global target cannot change their Effective state.
- View, edit target, and constraint metadata now render on separate lines, with lock icons kept visible in narrow resource panes.

### Fixed

- Clear hidden resource-session overrides whenever no preset is active, so effective resources cannot diverge from the Global view.
- Reset tool, skill, and context overrides when switching or clearing presets, preventing state from leaking between presets.
- Avoid labeling persistent Extension changes as Session-scoped while a preset is active.

## [0.1.2] - 2026-08-01

### Added

- Added persistent `enabledTools` policy so Global defaults can activate tools that Pi registered as initially inactive.

### Changed

- Refactored resource resolution into a reusable `PolicyManager`; the first-party Preset feature now submits a generic profile policy through the same core used by session overrides and runtime layers.
- Renamed the user-visible Default/Session scope selector to the less ambiguous Global defaults/Current session edit target.

### Fixed

- Runtime tool-layer events received before Config Manager finishes session initialization are now stored and applied after the default tool snapshot is captured, preventing extension load order from clearing active tools.

## [0.1.1] - 2026-08-01

### Added

- Added an npm trusted-publishing workflow that publishes stable GitHub Releases after validating the release tag and running the full check suite.
- Integrated named presets for model, thinking level, tools, skills, and system-prompt instructions.
- Added `/preset`, `--preset`, `Ctrl+Shift+U` cycling, the preset selector, and the editor-border preset label.
- Bundled the `preset-settings` skill with the package.

### Changed

- Unified preset and resource policy persistence in version 2 `pi-config-manager-state` session entries.
- Config Manager now owns preset policy directly instead of coordinating with a separate preset extension.

### Removed

- **Breaking:** Removed the `preset:tools-changed`, `preset:skills-changed`, and `config-manager:preset-state` integration events.
- **Breaking:** Removed migration of version 1 `pi-config-manager-state`, `preset-state`, `tools-config`, and `skills-manager-state` session entries. Existing sessions start from current defaults until new version 2 state is written.

### Fixed

- Prevented no-preset startup from clearing the default active tool set before Config Manager initialization.

## [0.1.0] - 2026-07-31

### Added

- Unified TUI overlay for tools, skills, context files, and extensions.
- Persistent Default resource scope and branch-aware Session overrides.
- Context Monitor and resource HUD.
- Source-aware staged extension settings with confirmed Pi reload.
- Optional preset and runtime policy-layer integration events.
- Behavior-contract test suite.

[Unreleased]: https://github.com/Hor1zonZzz/pi-config-manager/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Hor1zonZzz/pi-config-manager/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Hor1zonZzz/pi-config-manager/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Hor1zonZzz/pi-config-manager/releases/tag/v0.1.0
