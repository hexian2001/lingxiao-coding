# 凌霄剑域 · LingXiao

<p align="center">
  <img src="./assets/logo.svg" width="96" alt="LingXiao logo" />
</p>

> One sword cleaves the sky. Build what you envision.

[中文](./README.md) | [English](./README.en.md)

![LingXiao WebUI 指挥中心](./docs/images/homepage.png)

## 前言

AI 编程工具已经不少了，各有各的擅长。我们在长期使用和实践中，一直有一个小愿望： AI 工具能不能更像一个有经验的技术总监那样，帮我们拆解任务、并行推进、全程可追溯？

**凌霄剑域 · LingXiao** 应运而生。这是一个开源的多智能体协作系统，你可以把它当作现有工具的平替或补充，尤其适合中大型项目。

接下来，我将为大家介绍一下我们的产品：它到底能做什么、怎么做到的，以及实际使用体验。当然，如果有优化建议、使用反馈，都欢迎交流讨论，一起学习进步。

[产品网站](https://hexian2001.github.io/lingxiao_website/) |  [仓库地址](https://github.com/hexian2001/lingxiao-coding)

## 一句话介绍

**凌霄剑域把和AI聊天升级成了指挥一支AI专家军团——你定目标，它来干活。**

具体来说：Leader Agent 负责拆解需求、制定方案、组建专家团队、派发任务；各个 Worker 专家并行推进前端、后端、测试、文档、Git 操作等具体工作。整个过程在 WebUI 或 TUI 上实时可见，所有任务进度、工具调用、决策依据都清晰可查，你随时可以介入调整。

## 界面一览

<table>
  <tr>
    <td width="50%" align="center"><b>WebUI 任务面板</b></td>
    <td width="50%" align="center"><b>WebUI 专家面板</b></td>
  </tr>
  <tr>
    <td><img src="./docs/images/tasks.png" alt="任务面板" /></td>
    <td><img src="./docs/images/agents.png" alt="专家面板" /></td>
  </tr>
  <tr>
    <td align="center"><b>TUI 终端界面</b></td>
    <td align="center"><b>WebUI 对话与黑板</b></td>
  </tr>
  <tr>
    <td><img src="./docs/images/TUI.png" alt="TUI 终端界面" /></td>
    <td><img src="./docs/images/chat.png" alt="对话界面" /></td>
  </tr>
</table>

## 项目介绍

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

### 技术栈

- **后端**：Node.js 24+、TypeScript、Fastify
- **前端**：React 19、Vite、Ink (TUI)
- **AI SDK**：OpenAI / Anthropic / Google / Amazon Bedrock
- **工具链**：Playwright、Sharp、Tesseract.js、MCP SDK

## 核心特色

### 专家团，不是单 Agent 独白

- **Leader**：总指挥，理解目标、拆任务、建 DAG、调度专家、监督收尾。
- **Architect**：架构设计、接口边界、模块拆分、风险控制。
- **Backend**：后端实现、状态机、API、数据库、任务调度。
- **Frontend**：WebUI/TUI 交互、状态投影、可视化工作台。
- **Researcher**：资料调研、方案比较、外部验证。
- **QA/Reviewer**：测试、回归、代码审查、验收证据。
- **自定义角色**：通过角色注册、技能系统和工具权限扩展专家能力。

### 任务 DAG

复杂目标会被 Leader 拆成一张带依赖关系的任务图。每个任务声明后，系统自动计算反向边，形成完整的有向无环图。三个闸门决定一个任务能否执行：候选闸（任务状态为 dispatchable且无阻塞原因）、依赖闸（所有前置任务已完成）、合约闸（架构合约就绪）。前置任务完成后，被阻塞的后续任务自动解锁为 dispatchable，不需要人工逐个排期。WebUI 的任务面板以可视化图谱呈现整张 DAG，哪些完成了、哪些在跑、哪些被阻塞、依赖线怎么走——一目了然。

### 全状态机同步

WebUI、TUI 和后端运行时共享同一个 EventEmitter 作为事件中枢。SseBridge 订阅 43 种会话级事件和 11 种 Agent 级事件，通过 agentId→sessionId 映射精准路由到对应前端连接。session:runtime_state 作为统一状态快照负责校准——前端重连或切屏回来时，直接从快照恢复完整状态，不走事件重放。流式事件负责实时体验，状态快照负责最终一致性。

### 自动验收回路

每个 `implement` 任务完成后，系统**自动**创建 Evaluator 验证任务，对实现结果进行多维度评估（功能正确性、代码质量、视觉设计、产品深度）。验证不通过时自动生成 Repair 修复任务，Worker 修复后再次验收，直到通过或达到修复上限。这不是 prompt 里说一句"记得检查"——是写死在执行流程里的质量闸门。

### 黑板知识图谱

Agent 之间的结构化共识不是简单的聊天记录。Worker 将事实、意图、设计文档、合约、评审结论等 10 种节点类型写入共享知识图谱。Leader 每轮读取图谱分析，感知全局进展和认知对齐状态。Agent 之间不靠聊天传话，靠结构化图谱对齐认知。

### 外部 Agent 驱动

LingXiao 内置了 Claude Code Driver 和 Codex Driver，可以把 `claude` CLI 或 `codex` CLI 启动为 Worker 子进程——注入 LingXiao Worker 身份、流式解析输出、收集完成报告。这意味着你可以用 LingXiao 当总指挥，把 Claude Code 或 Codex CLI 当作具体干活的专家来调度。

### 工具插件 & MCP 生态

完整的插件系统（plugin.json 清单、发现、安装、贡献枚举），支持注入 skills、MCP Server、自定义工具和 hooks（before/after 拦截修改工具调用）。内置 80+ 工具覆盖文件读写、代码搜索、AST 查询、Shell 执行、浏览器自动化、Git 操作、HTTP 请求、MCP 集成、Office 文档生成等。支持技能系统和 MCP 协议扩展。

## 快速开始

### 前置要求

```
- [Node.js](https://nodejs.org/) >= 24.0.0
- npm 或兼容包管理器
```

### 源码安装

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

首次运行会引导你配置模型和 API Key，选择 TUI 模式或 WebUI 模式给出目标，凌霄开始工作。

> 注：如果初始化的模型和 API Key配置失败可以去/root/.lingxiao/settings.json查看更新，Windows是用户下的./lingxiao

![LingXiao 使用界面](./docs/images/use.png)

详细文档可以访问[文档](https://hexian2001.github.io/lingxiao_website/getting-started/introduction/)查看。

### 升级

```bash
lingxiao upgrade
```

或手动执行：

```bash
cd lingxiao-coding
git pull
npm install
npm run build
```

## 许可 & 参与

本项目采用 **AGPL v3 + 商业双授权** 模式：个人/开源使用免费，修改需开源；若作为 SaaS/API 对外提供服务，须向用户开放源码；商用闭源请联系购买商业授权（详见 [LICENSE](./LICENSE)）。

欢迎提交 Issue 和 PR 参与共建（提交前请确保代码通过 `npm run build` 构建，且不引入硬编码密钥或敏感信息，遵循现有代码风格）。

商用授权联系：hexian2001@github.com


## 连接 & 社区

- **GitHub**：[hexian2001/lingxiao-coding](https://github.com/hexian2001/lingxiao-coding)
- **Issues**：[提交 Bug 或功能建议](https://github.com/hexian2001/lingxiao-coding/issues)
- **社区**：已链接并认可 [LINUX DO 社区](https://linux.do)

<p align="center">
  <img src="./docs/images/QQ.jpg" width="200" alt="QQ群二维码" /><img src="./docs/images/weixin.jpg" width="200" alt="微信群二维码" /><br>
  扫码加入 QQ/微信 交流群，获取最新动态、使用帮助和开发者交流
</p>
