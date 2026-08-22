# 门卫调度机制设计（替代随机抽签）

日期：2026-08-22
状态：待评审

## 1. 背景与目标

当前调度是两层盲抽：合格 `turn_end` 先按 `heartbeat_probability` 抽是否心跳，命中后每个 Shadow 再按各自 `activation_probability` 独立抽签。判定完全不看内容与职责。

确认的三个失效模式：

1. **漏报**：关键时刻（核心文件变更、声称完成）可能因抽签不中而无人唤醒。
2. **噪音**：大量无关轮次照样抽签，Shadow 醒来发现没事可做。
3. **表达力**：概率数字无法表达"什么时候该我管"，用户配不出有意义的触发条件。

目标：把"何时唤醒谁"的判断交给一个轻量 LLM 门卫（gatekeeper），它读取净化轨迹与所有候选 Shadow 的职责摘要，一次调用产出唤醒名单。时效性不变——仍只挂 `turn_end`，不新增事件源。

## 2. 总体流程

```text
turn_end（≥1 次工具结果；纯文本轮仍跳过）
    │
    ▼
本地预筛（确定性，零成本）
    enabled ∧ 未在运行 ∧ active_for_models 匹配 ∧ 有空闲 slot
    │ 候选为空 → 直接跳过，不调门卫
    ▼
门卫调用（单次 LLM 补全，串行进入现有 heartbeatChain）
    输入：净化轨迹 + 候选 Shadow 的 id/名称/职责摘要
    输出：严格 JSON {"activations":[{"id","brief"}]}
    │ 解析失败 / 超时 / 无 auth → 本轮跳过，记轻量事件
    ▼
按名单激活（上限 min(availableSlots, 名单长度)）
    每个 Shadow 的 brief 注入其提示词
```

关键语义：

- 随机抽签整体移除。合格的 `turn_end` 必调门卫（有候选时），由它决定名单，可以为空。
- 门卫失败**不回退**随机抽签，fail-closed：跳过本轮并记录原因。
- 并发上限、暂停、epoch 失效、新输入中止等既有防线全部保留，位置不变。
- 在途门卫调用挂 AbortSignal：新输入 bump epoch 时立即中止，不在超时窗口内白烧 token（launch 前的 staleness 检查已保证正确性，此处仅止损）。
- Shadow 醒来后保留原有"不相关即退出"自检，作为最后防线；brief 以中性参考注入（"唤醒理由（供参考）：…"），不作为指令，自检优先于 brief——门卫误报时 Shadow 仍能自行退出。

## 3. 门卫契约

### 3.1 输入

复用 `serializeTrajectory` 产出的净化轨迹（与 Shadow 看到的一致）。提示词结构：

- system：固定调度员角色说明（输出格式约束写在这里）。
- user：三段式——候选清单（每行 `id | name | 职责摘要`）、净化轨迹、任务指令（"判断哪些候选的职责与本轮轨迹相关，返回 JSON；无关则返回空列表"）。

职责摘要取 Shadow Markdown 正文的前若干字符（截断到常量 `GATEKEEPER_BRIEF_CHARS`，初值 400），不做额外总结调用。

轨迹超出门卫模型上下文窗口时，保头+保尾截断：首条 USER 消息（原始任务意图，是相关性判断的最强信号）必保留，剩余预算留给尾部（最近的工具活动），并记入决策事件。不做分块或多次调用。

### 3.2 输出

要求模型只输出 JSON：

```json
{"activations": [{"id": "grounded-reviewer", "brief": "主 Agent 刚重写了 scheduler，需检查职责归属"}]}
```

解析规则：

- 提取首个 JSON 对象（容忍 markdown 代码围栏）；`id` 必须出现在候选清单中，未知 id 丢弃；`brief` 缺省为空字符串；重复 id 去重。
- 解析失败、JSON 非法、`activations` 不是数组 → 视为门卫失败，跳过本轮。

### 3.3 模型与超时

- 模型回退链：`config.gatekeeper_model` → `default_shadow_model` → Main 当前模型。auth 校验与 Shadow 相同；无 auth 视为门卫失败。
- thinking level：使用插件 `default_thinking_level` 回退链的最简形式（`gatekeeper` 不单独设字段；直接用 `defaultThinkingLevel`，模型不支持该等级时回退 Main 当前等级，复用 `resolveRunThinkingLevel` 的候选逻辑）。
- 超时：模块常量 `GATEKEEPER_TIMEOUT_MS = 30_000`，不设配置字段。超时即门卫失败。门卫调用串行进入现有 `heartbeatChain`，因此超时会推迟下一轮心跳最多一个周期，可接受。门卫调用挂 AbortSignal，超时与新输入（epoch 失效）都会中止在途调用。

### 3.4 调用方式

用 `@earendil-works/pi-ai` 的 `completeSimple` 直接发单轮补全，不走 `createAgentSession`（无需工具、无需资源加载器）。模型解析与 auth 判断复用 runtime 已注入的 `resolveModel` / `modelAuthOk`。

## 4. 配置面变化

| 字段 | 变化 |
| --- | --- |
| `gatekeeper_model`（新增，可选） | 门卫模型，见 3.3 回退链 |
| `heartbeat_probability` | 废弃：解析器仍接受该字段（落入 `extraFields`），运行时忽略；文档标注废弃 |
| `activation_probability`（frontmatter） | 同上，frontmatter 解析仍接受但忽略 |
| `random_seed` | 废弃忽略；`random.ts` 及调度内采样逻辑删除 |

不做迁移逻辑、不自动改写用户的 `config.json` 或 Markdown。

## 5. 模块落点

遵循"入口只组合、职责进专属模块"：

| 模块 | 变化 |
| --- | --- |
| `src/gatekeeper.ts`（新增） | 门卫的全部逻辑：提示词构建、`completeSimple` 调用、JSON 解析、截断。导出 `runGatekeeper(deps)`，deps 注入 `completeSimple`/`resolveModel`/`modelAuthOk` 以便测试 |
| `src/scheduler.ts` | 删除 `decideHeartbeat` 与随机采样；保留并复用 `shouldEvaluateHeartbeat`、`matchesModel`；新增候选预筛函数 `selectCandidates(...)`（纯函数） |
| `src/protocol.ts` | `buildShadowRequest` 增加可选 `brief` 参数，以中性参考注入一行"唤醒理由（供参考）：…"；未传时输出与现状完全一致 |
| `src/runtime.ts` | 只改编排：`runHeartbeat` 中以 预筛→门卫→launch 替换 `decideHeartbeat`；新增门卫事件记录；`session-config` 事件不再记录 `randomSeed`。不新增状态、不分叉流程 |
| `src/config.ts` / `types.ts` | 新增 `gatekeeper_model` 可选字段；废弃字段保持宽松解析；`serializeConfig` 停止主动写出 `heartbeat_probability`/`random_seed`（旧文件中的同名键经 `extraFields` 原样透传） |
| `src/management-tools.ts` | `update_shadow_config` 参数 schema 移除 `heartbeat_probability`、`random_seed`；round-trip 不再引用已删除的 config 字段 |
| 删除 | `decideHeartbeat`、`sample`、调度路径上的 `random` 注入（`createRandom` 已确认无其他使用者，随 `random.ts` 一并删除） |

Shadow 执行路径（`shadow-runner.ts`、`trajectory.ts`、报告批处理、watchdog、headless drain）零改动，仅 `buildShadowRequest` 签名扩展。

## 6. 可观测性

新增事件（走现有 `record()` 与 `/shadow status` 最近事件列表，UI 无需专门改造）：

- `gatekeeper-decision`：`{ activated: [{id, brief}], candidates, truncated?: true }`
- `gatekeeper-error`：`{ error }`（含解析失败、超时、auth 缺失）

`statusLines()` 中原 `heartbeat x.x` 一段替换为 `gatekeeper <model>`；近期 `gatekeeper-error` 纳入状态行警告标志（复用 `hasRecentRunErrors` 的模式）——门卫持续失败等于 Shadow 永不唤醒，必须从 `🐙 n!` 直接可见，不能只沉在事件列表里。

## 7. 测试策略（vitest，纯单元）

- `test/gatekeeper.test.ts`（新增）：提示词包含候选与轨迹；合法/带围栏/非法 JSON 的解析；未知 id 过滤、去重、brief 缺省；截断触发；超时与 auth 失败 fail-closed。
- `test/scheduler.test.ts`：改写为 `selectCandidates` 的预筛规则（enabled、运行中去重、模型过滤、slot 为空）。
- `test/protocol.test.ts`：brief 注入格式；缺省 brief 时输出向后兼容快照。
- `test/runtime.test.ts`：注入假门卫，验证 预筛→门卫→激活 编排、失败跳过、事件记录。
- `test/config.test.ts`：`gatekeeper_model` 解析与旧字段宽容接受。
- `test/management-tools.test.ts`：`update_shadow_config` 不再接受废弃参数；旧配置中的废弃键经 `extraFields` 无损 round-trip。
- 删除 `test/random.test.ts`（随 `random.ts` 一并删除）。

## 8. 文档同步

- DESIGN.md：重写调度章节（第 2、4 节相关段落），废弃字段标注。
- README.md：英文与中文两节同步更新"How it works"、配置示例与 frontmatter 字段表。
- 版本号提升 minor（行为契约变化），`npm run verify` 通过后构建发布物按既有 release 流程执行。

## 9. 明确不做（YAGNI）

- 结构化触发器（glob/event 匹配）：等出现门卫成本或精度问题的真实证据再加。
- 门卫评分调制概率：单一决策者，不混两套机制。
- 项目级 Shadow、Shadow 间通信、持久记忆：不在本次范围。
- 门卫专用配置字段（thinking level、timeout）：先吃默认值，有需要再加。
