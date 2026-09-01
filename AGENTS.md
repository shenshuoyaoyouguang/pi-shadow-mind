# Communication style

- 默认使用简单、结论优先的叙述方式。讨论设计或方案时，先说明核心思路、主要差异和推荐结论。
- 不要主动展开文件级改动清单、接口细节、完整边界情况或冗长实现步骤；只有用户明确要求深入时再补充。
- 能用几段短文说明的内容，不要写成长篇分层方案。避免术语堆叠，并保持用户无需反复阅读就能理解。

# Architecture preferences

- 设计阶段就避免以不断增长的 `if/else`、`switch` 或类型判断承载业务差异。优先使用清晰的职责拆分、策略分派、注册表和组合；必要的输入校验与简单控制流不受此限制。
- 不允许出现上帝组件、上帝对象或持续膨胀的入口文件。状态和行为必须放在实际拥有该职责的模块中；入口层只负责组合、编排和暴露能力。
- 新能力落地前先确定所有者和扩展点。若实现主要是在大型组件或主流程中追加状态、分支和方法，应先拆出独立职责，再接入外层。

# Repo basics

- 这是 Pi 扩展（`pi-package`），纯 ESM TypeScript，构建目标 Node 20。入口 `src/index.ts` 只做组合，真正的注册逻辑在 `src/runtime.ts` 的 `ShadowMindRuntime`。
- 模块解析为 NodeNext：src 内相对导入必须带 `.js` 后缀。
- 常用命令：
  - `npm run verify`：typecheck + 全部测试，提交前必跑
  - `npx vitest run test/registry.test.ts`：跑单个测试文件
  - `npm run build`：清理后 tsc 生成声明，esbuild 打包到 `dist/index.js`
  - 开发运行：`pi -e ./src/index.ts`
- 测试用 vitest globals，`test/*.test.ts` 与 src 模块一一对应，纯单元测试，无外部服务依赖。
- README.md 是英/中双语，行为变化需同步更新两节；DESIGN.md 是行为契约文档。

# Build invariants（scripts/build.mjs 强制校验）

- 只有 `@earendil-works/*`、`typebox`、`node:*` 允许 external，其余依赖一律打入单文件 ESM bundle；出现其他 external 导入会构建失败。
- `yaml` 是 devDependency，仅构建期使用并打进 bundle；不要把它改成 runtime/peer 依赖。
- bundle 必须是纯 ESM：出现 esbuild 的 `__require` CJS 兼容 shim 会构建失败。
- `dist/` 只允许 `index.js`、`index.js.map`、`index.d.ts` 三个文件。
- 构建末尾用原生 ESM import 冒烟加载 dist，因为 `pi -e` 走 Jiti 的 CJS 兼容层，可能掩盖真实环境的 ESM 加载问题。

# Release process

发布目标是同时生成两个产物：用于 npm 发布的 `pi-shadow-mind-<version>.tgz`，以及解压后可由 `pi install ./pi-shadow-mind-<version>` 安装的 standalone ZIP。

1. 发布前更新 `package.json` 版本并运行 `npm install` 同步 lockfile。代码有变化时提升版本，不覆盖同版本的既有正式产物。
2. `npm run verify` 通过后再 `npm run build`。
3. 已提前验证和构建时，用 `npm pack --ignore-scripts --pack-destination release` 生成 `.tgz`；否则用普通 `npm pack`，由 `prepack` 自动完成 verify + build。
4. 制作 standalone ZIP：将 `.tgz` 解包至同名目录，再压缩整个同名目录。ZIP 内必须保留顶层包目录，且接收方无需另行安装 `yaml` 等运行时依赖。
5. 冒烟检查：`node scripts/smoke-standalone.mjs <standalone-package-directory>`。脚本在隔离沙箱中通过 Pi `DefaultResourceLoader` 加载 `dist/index.js`（`noExtensions: true` 且仅经 `additionalExtensionPaths` 加载待测入口，避免本机已配置的同名插件造成假冲突），并校验 8 个管理工具、`/shadow` 命令和 Alt+S 快捷键齐全。
6. 为 `.tgz` 和 ZIP 生成 SHA-256 写入 `release/SHA256SUMS.txt`。交付优先提供 standalone ZIP；`.tgz` 用于 npm 发布（`.npmrc` 依赖 `NPM_TOKEN` 环境变量）。

清理或覆盖 `release/` 下的暂存目录和旧产物前，必须解析并核对目标的绝对路径确实位于当前项目的 `release/` 内，不得对工作区根目录使用递归删除。
