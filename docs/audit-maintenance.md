# 凌霄剑域 · 维护文档

> 版本：1.0 | 基于全库审计 T-3~T-7 综合产出
>
> 本文档面向项目维护者和贡献者，涵盖代码结构、开发规范、已知技术债和重构路线图。

---

## 一、项目结构总览

```
lingxiao-coding/
├── src/                    # 后端源码（TypeScript）
│   ├── core/               # 核心引擎层（9 个核心模块）
│   │   ├── EventEmitter.ts       # 自定义事件发射器（非 Node.js 原生）
│   │   ├── MessageBus.ts         # 消息总线（优先级队列）
│   │   ├── Database.ts           # SQLite 数据库管理
│   │   ├── ScheduledTaskManager.ts  # 定时任务调度
│   │   ├── WorkerProcessRunner.ts   # Worker 子进程管理
│   │   ├── ResourceBudgetService.ts # 磁盘/DB 清理服务
│   │   ├── Log.ts                # 日志系统
│   │   ├── RuntimeGuards.ts      # 进程级异常防护
│   │   ├── TempDownloadRegistry.ts # 临时下载注册表
│   │   └── UpdateChecker.ts      # 版本更新检查（新增）
│   ├── agents/             # Agent 编排层（115 个 TS 文件）
│   │   ├── LeaderAgent.ts        # ★ 巨型文件 3500+ 行（P0-3）
│   │   ├── LeaderTools.ts        # Leader 工具注册（80+ 工具）
│   │   ├── BaseAgentRuntime.ts   # Agent 基类（2500+ 行）
│   │   ├── AgentPoolRuntime.ts   # Agent 池管理（2265 行）
│   │   ├── LeaderSupervisionCoordinator.ts  # 监督协调
│   │   ├── LlmGuard.ts           # LLM 安全防护
│   │   ├── pool/FaultRecovery.ts # 故障恢复
│   │   └── runtime/              # 运行时工具
│   ├── web-server/         # Web 服务器层（42 个文件）
│   │   ├── SseBridge.ts          # SSE 事件桥接
│   │   ├── ConnectionManager.ts  # 连接管理
│   │   ├── ServerAuth.ts         # 认证
│   │   ├── AcpRoutes.ts          # API 路由
│   │   ├── GitIntegrationApi.ts  # Git 集成（⚠️ P0-5 路径遍历）
│   │   └── ...Routes.ts          # 其他路由
│   ├── tui/               # TUI 终端界面（Ink）
│   │   ├── LingXiaoTUI.tsx       # ★ 巨型文件 2800+ 行（P0-8）
│   │   └── runtime/useTuiEventBridge.ts  # 事件桥接
│   ├── runtime/            # 运行时
│   │   └── SessionManagerRuntime.ts  # 会话管理（2530 行）
│   ├── config.ts           # 配置管理（1633 行）
│   ├── cli.ts              # CLI 主入口（1703 行）
│   ├── cli_upgrade.ts      # 升级命令
│   ├── version.ts          # 版本管理
│   └── server.ts           # Fastify 服务器入口
├── web/                   # WebUI 前端（React 19 + Vite）
│   └── src/
│       ├── App.tsx               # 应用入口
│       ├── stores/
│       │   ├── sseStore.ts       # ★ 巨型文件 1400+ 行（P0-7）
│       │   ├── sessionStore.ts   # 会话状态
│       │   └── sessionStoreHelpers.ts  # 内存防护常量
│       ├── api/AcpClient.ts      # SSE 客户端
│       └── components/           # UI 组件
├── scripts/               # 构建/工具脚本
│   ├── build.mjs                 # 主构建脚本
│   ├── postinstall.mjs           # 安装后脚本
│   ├── bump-version.mjs          # 版本管理
│   └── run-tests.mjs             # 测试脚本
├── skills/                # 技能包
├── docs/                  # 文档与截图
├── assets/                # 静态资源
├── package.json
├── tsconfig.json          # 前端 TS 配置
├── tsconfig.cli.json      # 后端 TS 配置
└── .gitignore
```

### 文件规模热力图

| 文件 | 行数 | 风险 | 优先级 |
|------|------|------|--------|
| `src/agents/LeaderAgent.ts` | 3500+ | 🔴 极高 | P0-3 |
| `src/tui/LingXiaoTUI.tsx` | 2800+ | 🔴 极高 | P0-8 |
| `src/agents/BaseAgentRuntime.ts` | 2500+ | 🟡 高 | P2 |
| `src/agents/AgentPoolRuntime.ts` | 2265 | 🟡 高 | P2 |
| `src/runtime/SessionManagerRuntime.ts` | 2530 | 🟡 高 | P2 |
| `src/cli.ts` | 1703 | 🟡 中 | P2 |
| `src/config.ts` | 1633 | 🟡 中 | P2 |
| `web/src/stores/sseStore.ts` | 1400+ | 🔴 极高 | P0-7 |
| `src/agents/LeaderTools.ts` | 687+ | 🟢 低 | - |

---

## 二、开发规范

### 2.1 代码规范

**TypeScript 严格度：**
- 当前 `tsconfig.cli.json` 未全量开启 strict 模式（⚠️ P1-27）
- 建议：启用 `strictNullChecks` + `noUncheckedIndexedAccess`
- 已有：`as any` 0 处、`: any` 0 处（类型安全良好）

**异常处理规范（针对 P0-2/P0-4 修复）：**
```typescript
// ❌ 禁止：静默吞掉异常
try { await db.write(); } catch { /* ignore */ }

// ✅ 正确：至少记录日志
try {
  await db.write();
} catch (err) {
  coreLogger.debug(`[Context] db.write failed: ${err instanceof Error ? err.message : err}`);
}

// ✅ 正确：业务路径异常向上传播
try {
  await sessionManager.destroySession(id);
} catch (err) {
  throw new Error(`Failed to destroy session ${id}: ${err}`);
}
```

**定时器规范（针对 P0-1/P1-7/P1-13 修复）：**
```typescript
// 长生命周期定时器必须 unref()
this.timer = setInterval(() => { ... }, 30_000);
this.timer.unref();  // ✅ 不阻止进程退出

// 短生命周期定时器（会 clearTimeout 的）可以不 unref
```

**事件订阅规范：**
```typescript
// useEffect 中必须配对清理
useEffect(() => {
  const unsub = emitter.subscribe('event', handler);
  return () => unsub();  // ✅ 必须调用
}, [deps]);

// 类中必须在 destroy/cleanup 中取消订阅
class Foo {
  private unsub: (() => void)[];
  destroy() {
    this.unsub.forEach(fn => fn());  // ✅ 全部调用
  }
}
```

### 2.2 文件行数上限

| 类型 | 建议上限 | 硬上限 |
|------|----------|--------|
| 单文件 | 500 行 | 800 行 |
| 单组件 | 300 行 | 500 行 |
| 单函数 | 50 行 | 100 行 |

超出硬上限的文件需在重构路线图中规划拆分。

### 2.3 安全规范

**路径校验（针对 P0-5 修复）：**
```typescript
import { resolve, relative } from 'path';

function isPathInside(target: string, root: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith('..') && !resolve(root, rel).startsWith('..');
}

// 所有文件操作入口必须校验
const workspace = resolveReadWorkspace(req);
if (!isPathInside(workspace, PROJECT_ROOT)) {
  return reply.code(403).send({ error: 'Path outside workspace' });
}
```

**Token 传递（针对 P0-6 修复）：**
- ❌ 禁止：`window.__LINGXIAO_TOKEN__` 全局变量注入
- ✅ 正确：HttpOnly cookie + CSRF token
- `postMessage` 必须指定 `targetOrigin`，禁止 `'*'`

---

## 三、构建与发布

### 3.1 构建命令

```bash
npm run build              # 后端 + 前端完整构建
npm run build:server       # 仅后端（tsc -p tsconfig.cli.json）
npm run build:web          # 仅前端（vite build）
npm run build:package      # 打包便携版
npm run build:binary       # 构建二进制
npm run package:portable   # 便携包打包
```

### 3.2 构建流程

```
build.mjs:
1. tsc -p tsconfig.cli.json     → dist/（后端 JS）
2. vite build                   → web/dist/（前端静态文件）
3. 复制 web/dist → dist/web/
4. prune generated dist sidecars without active src
5. generate-settings.mjs        → dist/settings-schema.json
```

### 3.3 版本发布

```bash
# 1. 版本号自增
npm run bump-version -- patch    # 0.1.0 → 0.1.1
npm run bump-version -- minor    # 0.1.0 → 0.2.0
npm run bump-version -- major    # 0.1.0 → 1.0.0

# 2. 构建
npm run build

# 3. 提交并打 tag
git add -A && git commit -m "release: v0.x.x"
git tag v0.x.x
git push && git push --tags
```

### 3.4 升级流程

```
用户端: lingxiao upgrade
  → fetchLatestRelease()        GitHub API
  → compareVersions()           semver 比较
  → detectInstallType()         portable / npm / source
  → 执行升级
    portable: downloadAndExtract → refreshSymlink
    source:   git fetch → checkout tag → npm install → build → npm link
    npm:      提示 npm update -g
```

**升级安全要求（针对 P0-10 修复）：**
- 下载到临时目录，验证完整性后原子替换
- 旧版本备份到 `.bak` 目录
- 升级中断后可从 `.bak` 恢复

---

## 四、已知技术债

### 4.1 高优先级技术债

| ID | 技术债 | 影响范围 | 修复成本 | 关联问题 |
|----|--------|----------|----------|----------|
| TD-1 | LeaderAgent.ts 3500+ 行未拆分 | Agent 系统 | 高（3-5天） | P0-3 |
| TD-2 | LingXiaoTUI.tsx 2800+ 行未拆分 | TUI | 高（3-5天） | P0-8 |
| TD-3 | sseStore.ts 1400+ 行未拆分 | WebUI | 中（2-3天） | P0-7 |
| TD-4 | 异常吞没（77+ 处） | 全局 | 中（2-3天） | P0-2, P0-4 |
| TD-5 | 定时器 unref 遗漏 | 全局 | 低（0.5天） | P0-1, P1-7, P1-13 |
| TD-6 | 路径遍历漏洞 | Web 服务器 | 低（0.5天） | P0-5 |
| TD-7 | Token XSS 链 | Web 服务器 + 前端 | 中（1-2天） | P0-6, P1-19 |
| TD-8 | 配置无恢复机制 | CLI | 低（0.5天） | P0-9 |
| TD-9 | 升级无原子回滚 | CLI | 中（1-2天） | P0-10 |
| TD-10 | MessageBus.unregister 泄漏 | 核心引擎 | 低（0.5天） | P1-1 |

### 4.2 中优先级技术债

| ID | 技术债 | 修复建议 |
|----|--------|----------|
| TD-11 | 认证逻辑分散未中间件化 | 迁移为 Fastify preHandler |
| TD-12 | cli.ts 命令注册集中 | 拆分为 commands/ 目录 |
| TD-13 | 缺少 CHANGELOG.md | 添加版本变更记录 |
| TD-14 | 缺少 CONTRIBUTING.md | 添加贡献指南 |
| TD-15 | tsconfig strict 未全量 | 逐步启用 strict 检查 |
| TD-16 | i18n 翻译不完整 | 审计补全缺失键 |
| TD-17 | 无自动化测试 | 添加 vitest + 集成测试 |

---

## 五、重构路线图

### 阶段一：安全与稳定性修复（1-2 周）
```
[ ] TD-6: GitIntegrationApi 路径遍历修复
[ ] TD-7: Token 传递改为 HttpOnly cookie
[ ] TD-5: 全局定时器 unref 排查修复
[ ] TD-8: 配置文件损坏恢复机制
[ ] TD-9: 升级原子回滚
[ ] TD-10: MessageBus.unregister 调用
[ ] P1-12: TempDownloadRoutes 认证
[ ] P1-14: SSRF 防护
```

### 阶段二：异常治理（1 周）
```
[ ] TD-4: 审查 77+ 处 catch，添加日志/传播
[ ] 建立 catch 规范文档
[ ] 添加 lint 规则禁止空 catch
```

### 阶段三：巨型文件拆分（2-3 周）
```
[ ] TD-1: LeaderAgent.ts → LeaderDecisionEngine + LeaderToolExecutor + LeaderStateManager
[ ] TD-3: sseStore.ts → sseConnection + sseHandler + sseUpdateReducer
[ ] TD-2: LingXiaoTUI.tsx → ChatPanel + TaskBoard + AgentPanel + NotificationCenter
[ ] TD-12: cli.ts → commands/ 目录拆分
```

### 阶段四：工程化提升（1-2 周）
```
[ ] TD-15: tsconfig strict 全量
[ ] TD-17: 添加自动化测试框架
[ ] TD-13: CHANGELOG.md
[ ] TD-14: CONTRIBUTING.md
[ ] TD-16: i18n 补全
```

---

## 六、维护检查清单

### 发布前检查
- [ ] `npm run build` 成功（后端 + 前端）
- [ ] `npx tsc --noEmit` 无类型错误
- [ ] 无新引入的 `as any` 或 `: any`
- [ ] 无新引入的空 `catch {}`
- [ ] 新增定时器有 `.unref()` 或对应清理
- [ ] 新增事件订阅有配对 unsubscribe
- [ ] 新增文件操作有路径校验
- [ ] 新增 API 端点有 `requireServerToken` 认证
- [ ] 版本号已更新（package.json + tag）
- [ ] CHANGELOG 已更新

### 定期维护
- [ ] 依赖安全审计：`npm audit`
- [ ] 依赖版本更新检查
- [ ] 技术债回顾（每月）
- [ ] 重构路线图进度跟踪

### 紧急修复流程
1. 在 `main` 分支创建 hotfix 分支
2. 修复 + 测试
3. 合并到 `main` 和 `beta`
4. 打 tag 并发布 release
5. 更新 CHANGELOG

---

## 七、调试指南

### 7.1 日志系统

```typescript
import { coreLogger } from './core/Log.js';

coreLogger.info('消息');     // 正常流程
coreLogger.warn('警告');     // 非预期但不致命
coreLogger.error('错误');    // 错误但可恢复
coreLogger.debug('调试');    // 调试信息
```

日志输出到 `~/.lingxiao/logs/lingxiao-{date}.log`，按大小轮转。

### 7.2 常见问题排查

| 现象 | 可能原因 | 排查方法 |
|------|----------|----------|
| 进程无法退出 | 定时器未 unref | 检查 setInterval/setTimeout 是否有 unref |
| Agent 无响应 | LLM 超时 / Worker 崩溃 | 查日志 `[FaultRecovery]` + `[WorkerProcessRunner]` |
| SSE 断连 | 连接超限 / 网络中断 | 查 ConnectionManager 连接数 + SseBridge heartbeat |
| 数据库锁定 | WAL checkpoint 冲突 | 查 `PRAGMA wal_checkpoint` + 并发写入 |
| 升级失败 | 网络 / 权限 / 磁盘空间 | 查 `.bak` 目录 + curl 输出 |
| 配置加载失败 | JSON 格式错误 | 检查 `~/.lingxiao/config.json` 语法 |

### 7.3 开发调试模式

```bash
# 测试 LLM 连接
npm run dev:test-llm-request

# 开发模式（热重载）
npm run dev   # 如果有配置

# 查看运行时状态
lingxiao --version    # 确认版本
lingxiao upgrade --check  # 检查更新
```

---

## 八、贡献者指南要点

1. **代码风格**：遵循现有 TypeScript 风格，无 `any`，无空 `catch`
2. **文件规模**：单文件不超过 800 行，超出需拆分
3. **安全**：文件操作必须路径校验，API 端点必须认证
4. **定时器**：长生命周期定时器必须 `.unref()`
5. **事件订阅**：必须有配对 unsubscribe
6. **测试**：新增功能需附带测试
7. **提交**：`feat:` / `fix:` / `docs:` / `refactor:` 前缀
8. **依赖**：不引入新依赖除非必要，引入前评估安全性和维护性
