# 星图专家团工作台（社区版）

一款 AI 驱动的专家团协作工作台，通过模拟多领域专家协作的方式，帮助开发者高效完成代码分析、架构设计、文档编写等复杂任务。

## 核心功能

- **专家团协作**：支持配置多个 AI 专家角色（架构师、开发者、测试工程师等），实现多专家协同工作
- **智能路由**：根据用户意图自动分派任务给最合适的专家
- **可视化画布**：无限画布支持项目结构可视化、草稿绘制、流程图设计
- **仓库 Wiki**：自动生成项目知识库，支持迭代优化
- **词元管理**：项目级和用户级的 Token 用量统计与配额管理
- **密钥池配置**：支持多种 AI 服务提供商的密钥统一管理

## 开发者

**江仕玺**

## 开源协议

本软件采用双许可证模式，开源仅针对于个人用户：

| 许可证 | 适用场景 |
|--------|----------|
| MIT | 个人非商用非营利目的 |
| GPL-3.0 | 个人商用、盈利目的 |

> **企业版声明**：开源仅针对于个人，企业、组织或机构如需部署、使用或二次开发本软件，需购买企业版授权。

## 技术栈

- **前端**：Vanilla TypeScript + HTML/CSS
- **桌面框架**：Tauri 2.x
- **后端**：Rust
- **构建工具**：Vite

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) 最新稳定版

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run tauri dev
```

### 构建发布版

```bash
npm run tauri build
```

## 推荐开发环境

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
