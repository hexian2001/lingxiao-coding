# 凌霄剑域 · LingXiao

<p align="center">
  <img src="./assets/logo.svg" width="96" alt="LingXiao logo" />
</p>

> One sword cleaves the sky. Build what you envision.

[中文](#中文) | [English](#english)

![LingXiao WebUI 指挥中心](./docs/images/homepage.png)

---

## License / 许可协议

本项目采用 **双授权模式 (Dual License)**：

- **个人 & 非商业用途** — 免费使用、学习、修改
- **商业用途** — 需购买商业授权（内部部署、集成到商业产品、SaaS 服务、转售等）

详见 [LICENSE](./LICENSE)。商用授权联系：hexian2001@github.com

---

<a id="中文"></a>

## 中文

### 一句话

凌霄把"和模型聊天"升级成"指挥一个可观测、可恢复、可审查的 AI 专家团队"。

你给目标，Leader 负责判断、拆解、规划、建 DAG、组专家团、派发任务；Worker 专家并行执行研究、前端、后端、测试、审查、文档、Git 操作等工作；WebUI/TUI 实时同步完整运行态，所有任务、工具、权限、证据和会话状态都进入同一个工程内核。

### 安装

#### 前置要求

- [Node.js](https://nodejs.org/) >= 24.0.0
- npm 或兼容包管理器

#### 从源码安装

```bash
git clone https://github.com/hexian2001/lingxiao-coding.git
cd lingxiao-coding
npm install
npm run build
npm link
```

安装完成后，终端直接运行：

```bash
lingxiao
```

首次运行会引导你配置模型和 API Key。

#### 升级

```bash
cd lingxiao-coding
git pull
npm install
npm run build
```

### 核心特色

#### 专家团，不是单 Agent 独白

- **Leader**：总指挥，理解目标、拆任务、建 DAG、调度专家、监督收尾。
- **Architect**：架构设计、接口边界、模块拆分、风险控制。
- **Backend**：后端实现、状态机、API、数据库、任务调度。
- **Frontend**：WebUI/TUI 交互、状态投影、可视化工作台。
- **Researcher**：资料调研、方案比较、外部验证。
- **QA/Reviewer**：测试、回归、代码审查、验收证据。
- **自定义角色**：通过角色注册、技能系统和工具权限扩展专家能力。

#### 任务 DAG，让复杂工程可调度

复杂目标会被拆成带依赖关系的任务图，可并行任务并行跑，有依赖任务按顺序解锁，每个任务拥有 owner、状态、阻塞关系、结果和证据。

#### 全状态机同步

WebUI、TUI 和后端运行时收拢到统一状态链路，`session:runtime_state` 统一快照负责校准，流式事件负责体验。

#### 工具系统

内置 80+ 工具覆盖文件读写、代码搜索、AST 查询、Shell 执行、浏览器自动化、Git 操作、HTTP 请求、MCP 集成、Office 文档生成等。支持技能系统和 MCP 协议扩展。

### 快速开始

1. 安装完成后运行 `lingxiao`
2. 首次启动引导配置模型 provider 和 API Key
3. 选择 TUI 模式或 WebUI 模式
4. 给出目标，凌霄开始工作

### 技术栈

- **后端**：Node.js 24+、TypeScript、Fastify
- **前端**：React 19、Vite、Ink (TUI)
- **AI SDK**：OpenAI / Anthropic / Google / Amazon Bedrock
- **工具链**：Playwright、Sharp、Tesseract.js、MCP SDK

### 项目结构

```
lingxiao-coding/
├── src/            # 后端源码（TypeScript）
├── web/            # WebUI 前端（React + Vite）
├── scripts/        # 构建/工具脚本
├── skills/         # 技能包
├── docs/           # 文档与截图
├── assets/         # 静态资源
├── package.json
└── LICENSE
```

### 开发

```bash
# 安装依赖
npm install
npm install --prefix web

# 构建
npm run build          # 后端+前端
npm run build:server   # 仅后端
npm run build:web      # 仅前端

# 运行
npm start              # 启动凌霄
npm run dev:test-llm-request  # 测试 LLM 连接
```

---

<a id="english"></a>

## English

### In One Sentence

LingXiao upgrades "chatting with a model" into "commanding an observable, recoverable, auditable team of AI specialists."

You provide the goal. The Leader breaks it down, builds a DAG, assembles a specialist team, and dispatches tasks. Workers execute in parallel — research, frontend, backend, testing, review, documentation, Git operations. WebUI/TUI sync the full runtime state in real time.

### Installation

#### Prerequisites

- [Node.js](https://nodejs.org/) >= 24.0.0
- npm or compatible package manager

#### Install from Source

```bash
git clone https://github.com/hexian2001/lingxiao-coding.git
cd lingxiao-coding
npm install
npm run build
npm link
```

Then run:

```bash
lingxiao
```

First launch guides you through model and API key setup.

### Key Features

- **Specialist Team**: Leader + Workers architecture, not a single agent
- **Task DAG**: Complex goals decomposed into dependency-aware task graphs
- **Full State Sync**: WebUI, TUI, and runtime share unified state
- **80+ Built-in Tools**: File I/O, code search, AST query, shell, browser automation, Git, HTTP, MCP, Office docs
- **Skill System**: Extensible knowledge and workflow injection
- **MCP Protocol**: Connect external systems via Model Context Protocol

### Tech Stack

- **Backend**: Node.js 24+, TypeScript, Fastify
- **Frontend**: React 19, Vite, Ink (TUI)
- **AI SDK**: OpenAI / Anthropic / Google / Amazon Bedrock
- **Toolchain**: Playwright, Sharp, Tesseract.js, MCP SDK

### Development

```bash
npm install
npm install --prefix web
npm run build
npm start
```

---

## Contributing

欢迎提交 Issue 和 Pull Request。请确保：

1. 代码通过 `npm run build` 构建
2. 不引入新的硬编码密钥或敏感信息
3. 遵循现有代码风格

## Links

- **GitHub**: [hexian2001/lingxiao-coding](https://github.com/hexian2001/lingxiao-coding)
- **Issues**: [Report a bug or request a feature](https://github.com/hexian2001/lingxiao-coding/issues)
- **Commercial License**: hexian2001@github.com
