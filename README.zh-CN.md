# Pi Config Manager

在一个可搜索的 TUI 浮层中管理 Pi 的工具、技能、上下文文件与扩展。

[English](README.md) | 简体中文

Pi Config Manager 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的资源策略扩展。资源的发现、加载、去重与来源标注仍由 Pi 负责；Config Manager 只决定 Pi 已发现的资源是否启用。

## 主要特性

- 在一个界面中管理 **Tools、Skills、Context Files 和 Extensions**
- 可搜索、全键盘操作的浮层，并保留当前对话作为背景
- 持久化的 **Default** 设置与跟随会话分支的 **Session** 覆盖
- Context Monitor 可查看所选资源对模型可见提示词的贡献
- 编辑器上方显示紧凑的资源状态 HUD
- 根据资源来源，通过 Pi 公开设置 API 保存扩展开关
- 内置命名 Preset，可统一配置模型、思考等级、工具、技能和指令
- 提供可选运行时策略层事件 API，方便只读模式等扩展接入
- 无遥测，不发起网络请求

## 环境要求

- Pi Coding Agent **0.83.x**
- 可视化管理器需要交互式 TUI 模式

当前版本已在 Pi 0.83.0 上完成测试。更高版本的 Pi 可能也能运行，但 Pi 的扩展与 TUI API 可能发生变化；升级前请先查看本项目的发布说明。

## 安装

全局安装，供所有项目使用：

```bash
pi install npm:pi-config-manager
```

仅为当前项目安装：

```bash
pi install -l npm:pi-config-manager
```

不修改设置，临时试用一次：

```bash
pi -e npm:pi-config-manager
```

启动 Pi 后运行：

```text
/config-manager
```

## 快速上手

1. 运行 `/config-manager`。
2. 按 `Tab` 在资源页签之间切换。
3. 直接输入文字过滤当前列表。
4. 按 `Space` 或 `Enter` 切换所选资源。
5. 按 `G` 切换 Default 与 Session 作用域。
6. 在 Extensions 页按 `S` 保存暂存变更并重新加载 Pi。

### 键盘操作

| 按键 | 操作 |
| --- | --- |
| `Tab` | 切换到下一个资源页签 |
| 输入文字 | 过滤当前资源列表 |
| `↑` / `↓` | 移动选择，或滚动已聚焦的 Monitor |
| `←` / `→` | 聚焦资源列表或 Context Monitor |
| `Space` / `Enter` | 切换所选资源 |
| `G` | 切换 Default/Session 作用域 |
| `S` | 保存暂存的扩展变更并重新加载 Pi |
| `Esc` | 关闭管理器 |

支持 Pi 键位配置的操作会遵循当前 TUI keybindings。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/config-manager` | 打开统一概览 |
| `/tools` | 打开 Tools 页 |
| `/skills` | 打开 Skills 页 |
| `/contexts` | 打开 Context Files 页 |
| `/extensions` | 打开 Extensions 页 |
| `/preset` | 选择或清除命名 Preset |
| `/preset <名称>` | 直接激活命名 Preset |

也可以直接修改全局默认值：

```text
/tools global enable|disable <tool-name>
/skills global enable|disable <skill-name>
/contexts global enable|disable <absolute-path>
```

## Default 与 Session 作用域

| 作用域 | 持久化方式 | 适用场景 |
| --- | --- | --- |
| **Default** | 将全局选择写入 `~/.pi/agent/resource-settings.json`，新会话会继承 | 日常使用的工具、技能和上下文配置 |
| **Session** | 将覆盖项存储在当前会话分支中 | 针对单个任务或对话分支的临时调整 |

没有激活 Preset 时，Config Manager 默认以 **Default** 作用域打开。激活命名 Preset 后，它会默认以 **Session** 作用域打开。你可以随时按 `G` 切换。

受信任的项目可以在 `.pi/resource-settings.json` 中加入项目专属默认值。可视化界面的 Default 作用域只编辑全局默认值；项目文件继续由项目单独维护和纳入版本控制。

扩展开关不受 Default/Session 作用域影响。它们会先在界面中暂存，按 `S` 并确认重新加载后，再根据资源来源写入对应的全局或项目 Pi 设置。

## 各类资源的行为

### Tools

工具变更通过 `pi.setActiveTools()` 立即生效。Config Manager 使用 Pi 已发现的工具清单，并在能够观察到时保留其他扩展动态加入的工具。

### Skills

已禁用的技能会从 Pi 标准系统提示词的技能目录中移除。调用已禁用的 `/skill:<name>` 命令时，也会显示通知并阻止展开。

### Context Files

已禁用的上下文文件会从 Pi 标准的 `project_context` 提示词区段中移除。该设置只控制模型可见的提示词内容，**不会**阻止工具直接读取一个已知文件路径。

### Extensions

扩展开关在保存前只处于暂存状态。Config Manager 通过公开的 `SettingsManager` 写入 Pi 原生扩展/包过滤设置，然后请求 Pi 重新加载。

如果本地包来源直接指向单个扩展文件，Pi 无法为它应用单扩展过滤规则。Config Manager 会报告这个限制，而不是保存一个无效开关。管理器也不会允许在自己的活动界面中禁用自身。

## Context Monitor

终端宽度足够时，浮层左侧显示资源，右侧显示 Context Monitor。选择资源后可查看：

- **Tools：**描述、参数 schema、prompt snippet 与 prompt guidelines
- **Skills：**该技能在系统提示词目录中的条目
- **Context Files：**完整的 `project_context` 区块
- **Extensions：**来源、作用域、包来源类型与路径信息

第一次代理运行前，Monitor 使用 Pi 当前的提示词预览。运行开始后，它会显示在 `agent_start` 捕获的有效系统提示词，并在其中高亮所选资源。在管理器打开期间做出的策略变更，会在下一次代理运行后反映到捕获的提示词中。

终端较窄时，Config Manager 会退化为不带 Monitor 的资源列表。

## 配置文件

全局默认值：

```text
~/.pi/agent/resource-settings.json
```

受信任项目的默认值：

```text
.pi/resource-settings.json
```

配置格式：

```json
{
  "version": 1,
  "disabledTools": ["write"],
  "disabledSkills": ["deploy"],
  "disabledContexts": ["/absolute/path/to/AGENTS.md"]
}
```

Session 覆盖和当前 Preset 统一存储为版本 2 的 `pi-config-manager-state` 条目，因此 `/tree`、恢复会话和分支导航都能还原对应策略。

版本 2 是有意的破坏性状态重置。版本 1 的 `pi-config-manager-state` 以及独立的 `preset-state`、`tools-config`、`skills-manager-state` 条目不会被导入。

## Preset

Config Manager 从以下位置加载命名 Preset：

```text
~/.pi/agent/presets.json
.pi/presets.json
```

项目 Preset 只会在项目受信任时加载，并覆盖同名的全局 Preset。每个 Preset 可以配置：

```json
{
  "review": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinkingLevel": "high",
    "tools": ["read", "bash"],
    "skills": ["preset-settings"],
    "instructions": "修改前先认真审查。"
  }
}
```

可以使用 `/preset`、`/preset <名称>`、`pi --preset <名称>` 或 `Ctrl+Shift+U`。选择 `(none)` 会恢复进入第一个 Preset 前记录的模型、思考等级和基础工具策略。显式空的 `tools` 或 `skills` 数组表示全部禁用；省略字段表示保留对应的正常策略。Preset 激活期间，其 `instructions` 会追加到系统提示词。

该包同时提供 `preset-settings` Skill，用于安全编辑这些配置文件。

## 策略优先级

```text
运行时约束 > Session 覆盖 > 预设 > 项目/全局默认值 > Pi 默认值
```

目前运行时约束只作用于工具，主要供只读模式、沙箱模式等扩展集成使用。

## 扩展集成事件

Config Manager 可以独立运行。其他扩展也可以选择通过 `pi.events` 协调策略。

### 运行时工具层

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

每个策略层以 ID 区分并参与组合。每层中的必需工具会在禁用工具之后加入，而且只能激活 Pi 已发现的工具。

如需监听资源数量，可以订阅 `config-manager:state-changed`。发送 `config-manager:request-snapshot` 可以请求管理器立即发布一次快照。

原来的 `preset:tools-changed`、`preset:skills-changed` 和 `config-manager:preset-state` 集成事件已删除；Preset 现在由 Config Manager 直接拥有。

## 限制与安全说明

- Pi 扩展拥有当前用户的完整系统权限，安装第三方包前请先审查源码。
- Config Manager 是提示词/资源策略工具，不是文件系统或进程沙箱。
- 技能和上下文过滤依赖 Pi 的标准提示词区段。如果自定义系统提示词删除或重写了这些区段，Config Manager 会保留原提示词并警告用户。
- 可视化管理器只支持 TUI 模式；RPC、JSON 和 print 模式不能打开浮层。
- 扩展变更需要重新加载 Pi。

## 开发

需要 Node.js 22.19+、[Bun](https://bun.sh/) 与 Pi 0.83.0+。

```bash
git clone https://github.com/Hor1zonZzz/pi-config-manager.git
cd pi-config-manager
npm install
npm run check
```

直接加载本地扩展：

```bash
pi --no-extensions -e ./src/index.ts
```

## 许可证

[MIT](LICENSE)
