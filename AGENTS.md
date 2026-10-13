# Project instructions

## Communication style

- 默认使用简单、结论优先的叙述方式。讨论设计或方案时，先说明核心思路、主要差异和推荐结论。
- 不要主动展开文件级改动清单、接口细节、完整边界情况或冗长实现步骤；只有用户明确要求深入时再补充。
- 能用几段短文说明的内容，不要写成长篇分层方案。避免术语堆叠，并保持用户无需反复阅读就能理解。

## Architecture preferences

- 设计阶段就避免以不断增长的 `if/else`、`switch` 或类型判断承载业务差异。优先使用清晰的职责拆分、策略分派、注册表和组合；必要的输入校验与简单控制流不受此限制。
- 不允许出现上帝组件、上帝对象或持续膨胀的入口文件。状态和行为必须放在实际拥有该职责的模块中；入口层只负责组合、编排和暴露能力。
- 新能力落地前先确定所有者和扩展点。若实现主要是在大型组件或主流程中追加状态、分支和方法，应先拆出独立职责，再接入外层。

## UI font-size rules

- 字号按信息角色统一，不随组件随意放大：页面标题约 `22px`，连续正文与主要输入约 `14px`，常规按钮、菜单、导航和列表约 `13px`，辅助说明与紧凑控件约 `11px`，代码约 `12px`。
- 优先复用项目已有的字号 token 或共用类，不散落新的任意字号；确有特殊层级时才局部覆盖，并保持同类组件一致。
- 密集工具栏、Composer 操作行、状态切换和菜单项不能直接沿用组件库偏大的默认字号，应主动校准到 `11–13px`。
- `10px` 只用于极弱、非关键元数据，不用于正文、操作标签、表单内容或必须快速识别的状态；不要用缩小字体代替合理的布局和截断。
- 缩小字号时同步检查行高、图标尺寸、对齐、焦点环和点击区域；文字可以紧凑，但交互命中区不得随之缩小。

## Repo basics

- 这是 Pi 扩展（`pi-package`），纯 ESM TypeScript，构建目标 Node 20。入口 `src/index.ts` 只做组合，真正的注册逻辑在 `src/runtime.ts` 的 `ShadowMindRuntime`。
- 模块解析为 NodeNext：src 内相对导入必须带 `.js` 后缀。
- 常用命令：
  - `npm run verify`：typecheck + 全部测试，提交前必跑
  - `npx vitest run test/registry.test.ts`：跑单个测试文件
  - `npm run build`：清理后 tsc 生成声明，esbuild 打包到 `dist/index.js`
  - 开发运行：`pi -e ./src/index.ts`
- 测试用 vitest globals，`test/*.test.ts` 与 src 模块一一对应，纯单元测试，无外部服务依赖。vitest fake timers 下裸 `await setTimeout(0)` 会挂死测试；涉及定时的交错场景用真实定时器 + 短窗口。
- README.md 是英/中双语，行为变化需同步更新两节；DESIGN.md 是行为契约文档。`docs/superpowers/` 存放规格（specs）与实施计划（plans），`docs/reviews/` 是历史评审记录。`BENCHMARK.md` 是 Terminal-Bench 2.1 评测协议。

# Module map（src/ 按职责划分）

- `runtime.ts`：唯一编排层，接 Pi 事件、注册工具/命令/快捷键并持有各 Store；业务决策一律下沉到下列模块。
- 决策：`gatekeeper.ts`（LLM 调度判定）、`scheduler.ts`（确定性预筛选，纯函数）。
- 执行：`shadow-runner.ts`（影子运行）、`protocol.ts`（请求构造与类型）、`report-batcher.ts`、`summaries.ts`、`trajectory.ts`。
- 持久化：`registry.ts`、`entity-store.ts`、`usage-store.ts` + `usage-file-lock.ts` + `atomic-file.ts`、`config.ts`。
- 交互与收尾：`management-tools.ts`（8 个管理工具）、`session-lifetime.ts` + `shutdown-drain.ts`、`validation.ts`（输入校验）。
- 共享类型：`types.ts`（ShadowConfig/ShadowDefinition/ShadowReport 等领域类型）、`usage.ts`（用量统计类型与格式化的纯函数）。

## Build invariants（scripts/build.mjs 强制校验）

- 只有 `@earendil-works/*`、`typebox`、`node:*` 允许 external，其余依赖一律打入单文件 ESM bundle；出现其他 external 导入会构建失败。
- `yaml` 是 devDependency，仅构建期使用并打进 bundle；不要把它改成 runtime/peer 依赖。
- bundle 必须是纯 ESM：出现 esbuild 的 `__require` CJS 兼容 shim 会构建失败。
- `dist/` 只允许 `index.js`、`index.js.map`、`index.d.ts` 三个文件。
- 构建末尾用原生 ESM import 冒烟加载 dist，因为 `pi -e` 走 Jiti 的 CJS 兼容层，可能掩盖真实环境的 ESM 加载问题。

## Regression verification

- 涉及上下文投影、配置热更新或报告展示的跨模块改动，按风险补充受影响链路的定向回归：使用真实数据形态，经过实际消费入口，断言最终 Shadow 轨迹或用户可见输出。辅助函数测试用于验证局部逻辑，链路测试用于验证状态更新与模块组合；mock 保留被验证的关键路径。普通任务仍按需验证，不增加统一全量门禁。

## Pull request handling

- 用户要求合并 PR 时，默认执行审计、修复问题、按风险验证并合并；发现较大风险时暂停合并，先汇报风险与需要用户决定的事项。发布新版本按用户要求单独执行。

## Release process

发布目标是同时生成两个产物：用于 npm 发布的 `pi-shadow-mind-<version>.tgz`，以及解压后可由 `pi install ./pi-shadow-mind-<version>` 安装的 standalone ZIP。

1. 发布前更新 `package.json` 版本并运行 `npm install` 同步 lockfile。代码有变化时提升版本，不覆盖同版本的既有正式产物。
2. `npm run verify` 通过后再 `npm run build`。
3. 已提前验证和构建时，用 `npm pack --ignore-scripts --pack-destination release` 生成 `.tgz`；否则用普通 `npm pack`，由 `prepack` 自动完成 verify + build。
4. 制作 standalone ZIP：将 `.tgz` 解包至同名目录，再压缩整个同名目录。ZIP 内必须保留顶层包目录，且接收方无需另行安装 `yaml` 等运行时依赖。
5. 冒烟检查：`node scripts/smoke-standalone.mjs <standalone-package-directory>`。脚本在隔离沙箱中通过 Pi `DefaultResourceLoader` 加载 `dist/index.js`（`noExtensions: true` 且仅经 `additionalExtensionPaths` 加载待测入口，避免本机已配置的同名插件造成假冲突），并校验 8 个管理工具、`/shadow` 命令和 Alt+S 快捷键齐全。
6. 为 `.tgz` 和 ZIP 生成 SHA-256 写入 `release/SHA256SUMS.txt`。交付优先提供 standalone ZIP；`.tgz` 用于 npm 发布（`.npmrc` 依赖 `NPM_TOKEN` 环境变量）。

清理或覆盖 `release/` 下的暂存目录和旧产物前，必须解析并核对目标的绝对路径确实位于当前项目的 `release/` 内，不得对工作区根目录使用递归删除。
