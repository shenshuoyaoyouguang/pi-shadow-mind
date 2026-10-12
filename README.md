# Pi Shadow Mind

![Pi Shadow Mind — the main agent builds while Shadow Minds review, verify, and maintain](./assets/shadow-mind-hero-v2.png)

**Configurable cognitive cores for Pi.**

**为 Pi 配置多个独立的认知核心。**

[English](#english) · [中文](#中文)

## English

Pi Shadow Mind runs specialized agents alongside the main agent. Each Shadow Mind owns a persistent responsibility—architecture, correctness, documentation, project grounding, or anything else you define.

While the main agent implements, other minds can independently review decisions, verify claims, maintain related files, and intervene before mistakes become expensive to undo.

> Build and review in the same pass.

### One agent, multiple responsibilities

The main agent keeps moving. Shadow Minds independently protect the parts of the work that matter to you.

| Cognitive core | Responsibility |
|---|---|
| Architecture review | Detect growing god components, misplaced responsibilities, missing module boundaries, and fragile extension points while code is being written |
| Project grounding | Check claims against the actual repository and catch invented APIs, files, constraints, or implementation details |
| Documentation maintenance | Track implementation changes and keep architecture notes, decisions, and usage documentation aligned |
| Completion review | Independently verify that the result satisfies the task before the main agent declares it finished |

These are not temporary tasks delegated by the main agent. They are persistent, user-defined cognitive roles that decide independently when to inspect, act, or report.

### Shadows can review—or work

A Shadow Mind may remain read-only and report findings to the main agent, or receive additional tools and own a parallel line of work.

While the main agent writes code, another Shadow can maintain documentation, update architectural decisions, or work on a separate file. Tool access is configured per Shadow, so each cognitive core receives only the capabilities its responsibility requires.

```text
Main Agent          Architecture Shadow
implements feature  reviews module boundaries

Main Agent          Documentation Shadow
writes code         maintains design documentation
```

Review is only one possible responsibility. A Shadow Mind can observe, verify, maintain, or build.

### Start with an Architecture Shadow

Create `~/.pi/agent/shadow-minds/architecture-review.md`:

```markdown
---
id: architecture-review
name: Architecture review
active_for_models: ["*"]
tools: [read, grep]
---

Review the main agent's current implementation for architectural drift.

Check whether responsibilities have clear owners, modules have coherent
boundaries, and new behavior uses appropriate extension points. Detect growing
god components, unrelated state or methods accumulating in one module, and
business differences implemented as expanding conditionals.

Report only concrete, actionable issues grounded in the visible trajectory or
repository. If the current work is unrelated, do not intervene.
```

This Shadow is read-only. It reviews the implementation in parallel and reports concrete architectural concerns without taking control of the main task. Tool names extend the default read-only set; use `tools: ["*"]` only when the Shadow should inherit every tool currently registered in the main session, including tools added later.

### How it works

After a main-agent `turn_end` that completed at least one tool call, the extension calls a lightweight gatekeeper model once with the sanitized trajectory and every candidate Shadow's responsibility summary. Pure text-only conversation turns are skipped, so ordinary discussion does not wake Shadows. The gatekeeper decides which Shadows to wake—possibly none—and attaches a one-sentence focus hint to each. At most two Shadows run concurrently.

If the gatekeeper fails (bad output, timeout, missing auth), the turn is skipped and logged; there is no random fallback.

Use `trigger: [final_response]` for completion review. It activates after the main agent has emitted its final text and bypasses the gatekeeper. All checks for that final response finish before their findings are sent together through one `shadow-report` follow-up, so a slow sibling cannot leak into a revised answer. Set the per-Shadow `final_response_rounds` to limit execution rounds after completion: `1` allows at most one round to prevent feedback loops, while omitted or `0` means unlimited. `trigger: [heartbeat, final_response]` enables both modes; `heartbeat` is the default and routes through the gatekeeper. `max_parallel_shadows` remains the concurrency limit; excess final-response checks are queued rather than skipped.

Each activation starts a fresh temporary session. It inherits the main agent's unchanged system prompt but receives only a sanitized plain-text trajectory: assistant thinking is removed, while tool calls retain compact, deterministic result summaries.

A Shadow first decides whether the trajectory is relevant to its responsibility. If unrelated, it exits without calling tools or `report_to_main`. When the main agent should receive a concrete result, the Shadow calls `report_to_main`, which immediately ends that run.

Shadow definitions are ordinary Markdown files. They can be created and adjusted by the user or managed by the agent through the extension's tools. Model filters let different models receive different supporting minds.

The gatekeeper model resolves as `gatekeeper_model` → `default_shadow_model` → the main agent's current model. Legacy scheduling knobs (`heartbeat_probability`, per-Shadow `activation_probability`, `random_seed`) are still parsed but ignored.

### Installation

```bash
pi install npm:pi-shadow-mind@0.2.0
```

On the first session start, the extension creates:

```text
~/.pi/agent/shadow-minds/
  config.json
  *.md
  logs/<shadow-id>/*.jsonl   # only when debug: true
```

No default Shadow Mind is created. The global runtime timeout defaults to 300 seconds, and individual Shadows may override it with `timeout_seconds`.

A Shadow session loads the same extensions as the main session, minus this plugin and anything listed in `excluded_extensions`. Extensions that archive or record whole sessions would otherwise file every Shadow run as one more user session, so `pi-experiencev2` is excluded by default. An entry is an exact identifier, not a pattern: a package name (`pi-experiencev2`, `@scope/name`), a package directory name, a single-file extension's file name, or an absolute path. Set `"excluded_extensions": []` to load everything the main session loads. Shadows need their model provider, so keep provider extensions off this list.

Press `F6` or `Alt+S` to pause or resume Shadow Mind for the current session. On macOS, you may need `Fn+F6`; `Alt+S` corresponds to `Option+S` and depends on the terminal's Option key mapping. The paused footer reads `🐙 Paused` without a redundant zero count. Use `/shadow` to toggle the status panel, `/shadow status` for a summary, or `/shadow toggle`, `/shadow pause`, and `/shadow resume` for command-based control. In TUI mode, `/shadow reports` opens a bounded, scrollable viewer for the five most recently delivered reports, independent of the recent-run list. Use ↑/↓, PageUp/PageDown, or Home/End to scroll; Escape or `/shadow reports hide` closes it. The viewer shows a snapshot; reopen to see new deliveries. Report history is session-local and clears on session replacement or reload; persisted reports remain in the conversation. The status panel keeps its compact summary. Management tools can list, create, update, enable, disable, and delete Shadow Minds, as well as read or update the global configuration. Every write requires user confirmation.

### Using with DSH

To use Shadow Mind in DSH, see [`whutzefengxie-ops/dsh-shadow-mind`](https://github.com/whutzefengxie-ops/dsh-shadow-mind). That project provides the DSH-specific integration.

For development:

```powershell
npm install
pi -e ./src/index.ts
```

See [DESIGN.md](./DESIGN.md) for the behavioral contract and [BENCHMARK.md](./BENCHMARK.md) for benchmark methodology and lessons learned.

## 中文

Pi Shadow Mind 让多个专业化认知核心与主 Agent 并行工作。每个 Shadow Mind 都拥有一项持续、稳定的职责，例如架构审阅、正确性检查、文档维护、项目事实核验，或任何由你定义的任务。

主 Agent 负责持续推进，其他认知核心则独立审阅决策、核验事实、维护相关文件，并在错误产生高昂返工成本之前介入。

> 让实现与审阅发生在同一轮工作中。

### 一个 Agent，多项独立职责

| 认知核心 | 职责 |
|---|---|
| 架构审阅 | 在编码过程中发现上帝组件、职责错位、模块边界缺失和脆弱的扩展点 |
| 项目事实核验 | 对照真实仓库检查结论，发现模型编造的 API、文件、约束和实现细节 |
| 文档维护 | 跟踪实现变化，让架构说明、设计决策和使用文档保持同步 |
| 完成度审阅 | 在主 Agent 宣布完成前，独立检查结果是否真正满足任务要求 |

它们不是主 Agent 临时委派的任务，而是由用户定义、持续存在的认知职责，可以独立决定何时检查、行动或汇报。

### Shadow 不只审阅，也可以工作

Shadow Mind 可以保持只读，只向主 Agent 汇报发现；也可以获得额外工具，独立负责另一条任务线。

当主 Agent 编写代码时，另一个 Shadow 可以同步维护文档、更新架构决策，或处理独立文件。工具权限由每个 Shadow 单独配置，因此每个认知核心只获得其职责真正需要的能力。

```text
主 Agent             Architecture Shadow
实现功能              审阅模块边界

主 Agent             Documentation Shadow
编写代码              维护设计文档
```

审阅只是一种职责。Shadow Mind 可以观察、核验、维护，也可以直接构建。

### 从 Architecture Shadow 开始

创建 `~/.pi/agent/shadow-minds/architecture-review.md`：

```markdown
---
id: architecture-review
name: Architecture review
active_for_models: ["*"]
tools: [read, grep]
---

审阅主 Agent 当前实现是否正在偏离合理架构。

检查每项职责是否有明确所有者、模块边界是否内聚、新能力是否使用了合适的扩展点。
发现不断膨胀的上帝组件、堆积在同一模块中的无关状态与方法，以及用持续增长的条件
分支承载业务差异的实现。

只报告能够从当前轨迹或仓库中得到证据、并且可以采取行动的问题。如果当前工作与该职责
无关，不要介入。
```

这个 Shadow 默认只读。它会在实现过程中并行审阅架构，并向主 Agent 报告具体问题，但不会接管主任务。工具名在默认只读集合之上扩展；仅当 Shadow 需要继承主 Session 当前注册的全部工具（包括后续新增的工具）时才使用 `tools: ["*"]`。

### 工作方式

主 Agent 的一次 `turn_end` 只有在该轮至少完成过一个工具调用时，扩展才会调用一次轻量门卫模型，输入净化后的轨迹和所有候选 Shadow 的职责摘要。纯文本对话轮次会被跳过，因此普通讨论不会唤醒 Shadow。门卫决定本次唤醒哪些 Shadow（也可以一个都不唤醒），并为每个被唤醒的 Shadow 附上一句话焦点提示。默认最多同时运行两个。

门卫失败（输出无法解析、超时、模型未认证）时本轮直接跳过并记录事件，不回退随机调度。

使用 `trigger: [final_response]` 进行完成度审阅。它在主 Agent 输出最终文字后激活，绕过门卫。同一最终回复的所有检查完成后，发现才会通过一次 `shadow-report` follow-up 一起发送，因此较慢的同批检查不会泄漏到已修订的回答中。通过每个 Shadow 的 `final_response_rounds` 限制完成后的运行轮数：设为 `1` 时仅运行一轮以避免反馈循环，缺省或 `0` 表示不限制。`trigger: [heartbeat, final_response]` 同时启用两种模式；`heartbeat` 是默认值，经由门卫分派。`max_parallel_shadows` 仍是并发上限，超额的最终回复检查进入队列而非被跳过。

每次激活都会创建一个全新的临时 Session。它继承主 Agent 原封不动的 system prompt，但只接收净化后的文本轨迹：思考内容会被移除，工具调用后仅保留简洁、确定性的结果概述。

Shadow 会先判断轨迹是否与自己的职责相关。无关时直接结束，不调用工具或 `report_to_main`；需要向主 Agent 提交具体结果时，通过 `report_to_main` 上报并立即结束本轮。

Shadow 定义只是普通 Markdown 文件，可以由用户创建和调整，也可以由 Agent 通过扩展工具管理。模型过滤允许不同模型获得不同的辅助认知核心。

门卫模型按 `gatekeeper_model` → `default_shadow_model` → 主 Agent 当前模型的顺序回退。旧调度参数（`heartbeat_probability`、每个 Shadow 的 `activation_probability`、`random_seed`）仍会被解析但被忽略。

### 安装

```bash
pi install npm:pi-shadow-mind@0.2.0
```

首次启动 Session 时，扩展会创建：

```text
~/.pi/agent/shadow-minds/
  config.json
  *.md
  logs/<shadow-id>/*.jsonl   # 仅在 debug: true 时生成
```

扩展不会默认创建 Shadow Mind。全局默认运行超时为 300 秒，单个 Shadow 可以通过 `timeout_seconds` 覆盖。

Shadow Session 加载的扩展是主 Session 的子集：去掉本插件自身，再去掉 `excluded_extensions` 列出的扩展。归档或记录整段会话的扩展否则会把每次 Shadow 运行都记为一次新的用户会话，因此默认排除 `pi-experiencev2`。条目是精确标识而非模式：包名（`pi-experiencev2`、`@scope/name`）、包目录名、单文件扩展的文件名或绝对路径。设为 `"excluded_extensions": []` 即加载主 Session 的全部扩展。Shadow 需要模型 provider 扩展，因此不要把 provider 扩展列入该清单。

按 `F6` 或 `Alt+S` 可以暂停或恢复当前 Session 的 Shadow Mind。在 macOS 上可能需要 `Fn+F6`；`Alt+S` 对应 `Option+S`，取决于终端的 Option 键映射。暂停时底部状态显示为 `🐙 Paused`，不再显示没有信息量的零计数。使用 `/shadow` 显示或隐藏状态面板，`/shadow status` 查看摘要，也可以通过 `/shadow toggle`、`/shadow pause` 和 `/shadow resume` 控制状态。在 TUI 模式下，`/shadow reports` 打开一个有界、可滚动的查看器，展示最近 5 份已交付报告，与最近运行列表相互独立。用 ↑/↓、PageUp/PageDown 或 Home/End 滚动；Escape 或 `/shadow reports hide` 关闭。查看器展示的是快照，重新打开可看到新交付。报告历史仅存在于当前 Session，在会话替换或重载时清空；已持久化的报告仍保留在会话中。状态面板保持紧凑摘要。管理工具可以查询、创建、更新、启用、禁用和删除 Shadow Mind，以及读取或修改全局配置。所有写操作都需要用户确认。

### 与 DSH 配合使用

在 DSH 中使用 Shadow Mind，参见 [`whutzefengxie-ops/dsh-shadow-mind`](https://github.com/whutzefengxie-ops/dsh-shadow-mind)。该项目提供 DSH 专属集成。

开发模式：

```powershell
npm install
pi -e ./src/index.ts
```

完整行为约定见 [DESIGN.md](./DESIGN.md)，Benchmark 方法与经验见 [BENCHMARK.md](./BENCHMARK.md)。
