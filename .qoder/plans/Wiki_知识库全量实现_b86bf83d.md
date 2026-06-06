# Wiki 知识库全量实现

## 整体架构

```
原始信号（代码/对话/配置）
    ↓ 第一次凝练
Knowledge Card（.xt/repo/cards/*.json）— Agent 直接消费
    ↓ 第二次凝练
RepoWiki（.xt/repo/wiki/*.md）— 人类可读连贯文章
```

**Wiki 模式 UI 布局（复用 file-preview 模式模式）：**
- 左侧：`chat-card`（405px，保持不变）
- 中间：`wiki-panel`（`left: 437px`，`right: 272px`，自适应填充）
- 右侧：`repo-browser`（240px，`right: 16px`）
- 底部-left（wiki-panel 内）：迭代控制卡片（类似 canvas-directory-card）

---

## Task 1：HTML 结构 — 仓库面板与仓库管理器

文件：`ai-experts/index.html`

在 `file-browser-card` 之前添加：

```html
<!-- 仓库模式：中央 Wiki 面板 -->
<div id="wiki-panel" style="display:none;">
  <div class="wiki-header">
    <span class="wiki-title" id="wiki-title">Wiki</span>
    <div class="wiki-tabs" id="wiki-tabs">
      <button class="wiki-tab active" data-wiki-tab="article" type="button">文章</button>
      <button class="wiki-tab" data-wiki-tab="cards" type="button">知识卡片</button>
    </div>
    <button class="wiki-back" id="wiki-back" type="button">
      <svg><!-- 返回图标 --></svg>
      返回
    </button>
  </div>
  <div class="wiki-divider"></div>
  <div class="wiki-body" id="wiki-body">
    <!-- 文章视图 -->
    <div class="wiki-article" id="wiki-article"></div>
    <!-- 卡片视图 -->
    <div class="wiki-cards-list" id="wiki-cards-list"></div>
  </div>
  <!-- 迭代控制卡片（左下角悬浮） -->
  <div class="wiki-iteration-card" id="wiki-iteration-card">
    <div class="wiki-iteration-header">
      <span>迭代控制</span>
      <select class="wiki-iteration-mode" id="wiki-iteration-mode">
        <option value="manual">手动</option>
        <option value="self">自迭代</option>
        <option value="auto">自动迭代</option>
      </select>
    </div>
    <div class="wiki-iteration-status" id="wiki-iteration-status">就绪</div>
    <button class="wiki-iteration-btn" id="wiki-iteration-btn" type="button">执行迭代</button>
  </div>
</div>

<!-- 仓库模式：右侧仓库管理器 -->
<div id="repo-browser" style="display:none;">
  <div class="repo-browser-header">
    <span class="repo-browser-title">仓库管理器</span>
  </div>
  <div class="repo-browser-divider"></div>
  <div class="repo-browser-list" id="repo-browser-list">
    <!-- 动态渲染，默认选中 Wiki -->
  </div>
</div>
```

---

## Task 2：CSS 样式

文件：`ai-experts/src/styles.css`

新增以下样式块（约 120 行）：

```css
/* 仓库模式：中央 Wiki 面板 */
#wiki-panel {
  position: absolute;
  top: 16px; left: 437px; right: 272px; bottom: 16px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  display: none;
  flex-direction: column;
  overflow: hidden;
  z-index: 100;
}
#wiki-panel.active { display: flex; }

/* Wiki 头部 */
.wiki-header { /* flex, padding, 类似 file-preview-header */ }
.wiki-tabs { /* 页签容器 */ }
.wiki-tab { /* 页签按钮，类似 canvas-directory-tab */ }
.wiki-tab.active { /* 激活态 */ }
.wiki-back { /* 返回按钮，复用 file-preview-back 样式 */ }

/* Wiki 主体 */
.wiki-body { flex:1, overflow-y:auto, padding }
.wiki-article { /* Markdown 渲染容器，复用 file-preview-md 样式 */ }
.wiki-cards-list { display:none, flex-direction:column, gap:12px }
.wiki-card-item { /* 卡片项：带标题、标签、摘要的圆角卡片 */ }

/* 迭代控制卡片（左下角悬浮） */
.wiki-iteration-card {
  position: absolute;
  bottom: 12px; left: 12px;
  width: 220px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.1);
  padding: 12px;
  z-index: 110;
}

/* 右侧仓库管理器 */
#repo-browser {
  position: absolute;
  top: 16px; right: 16px; bottom: 16px;
  width: 240px;
  background: #fff;
  border-radius: 10px;
  display: none;
  flex-direction: column;
  z-index: 100;
}
#repo-browser.active { display: flex; }

.repo-browser-list { flex:1, overflow-y:auto, padding:8px }
.repo-nav-item { /* 导航项：图标 + 文字，激活态高亮 */ }
.repo-nav-item.active { background: #e8f0fe; color: #5B8DEF; }
```

---

## Task 3：Rust 后端 — `repo_wiki.rs` 知识引擎模块

新建：`ai-experts/src-tauri/src/repo_wiki.rs`

### 数据结构

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct KnowledgeCard {
    pub id: String,
    pub title: String,
    pub category: String,  // overview/architecture/tech_stack/spec/config
    pub tags: Vec<String>,
    pub content: String,   // Markdown 内容
    pub sources: Vec<String>,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct WikiArticle {
    pub title: String,
    pub content: String,   // Markdown
    pub source_cards: Vec<String>,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
pub struct RepoItem {
    pub id: String,
    pub name: String,
    pub icon: String,  // "wiki" | "cards" | "graph"
}
```

### 核心函数

| 函数 | 职责 |
|------|------|
| `list_repo_items(project_dir)` | 列出 `.xt/repo/` 子目录，返回 RepoItem 列表 |
| `read_cards(project_dir)` | 读取 `.xt/repo/cards/*.json`，返回 Vec<KnowledgeCard> |
| `read_wiki(project_dir, name)` | 读取 `.xt/repo/wiki/{name}.md`，返回内容字符串 |
| `ensure_repo_dirs(project_dir)` | 确保 `.xt/repo/cards/` 和 `.xt/repo/wiki/` 存在 |
| `collect_signals(project_dir)` | 感知层：扫描项目文件（复用 code_chunker），读取 chat_sessions.json 对话摘要 |
| `build_relation_graph(cards)` | 图谱层：根据 sources/tags 构建卡片关系图 |
| `generate_cards_prompt(signals)` | 构造 AI 生成卡片的 Prompt（返回结构化 JSON） |
| `generate_wiki_prompt(cards)` | 构造 AI 凝练 Wiki 的 Prompt（返回 Markdown） |
| `incremental_cards_update(project_dir, existing_cards, new_signals)` | 增量更新：diff 后只生成/修改变化的卡片 |

---

## Task 4：Rust Tauri 命令注册

文件：`ai-experts/src-tauri/src/lib.rs`

新增 `mod repo_wiki;` 并注册以下命令：

```rust
#[tauri::command]
async fn repo_list_items(project_name: String, app_handle: AppHandle) -> Result<String, String>
// 返回 JSON: [{id:"wiki", name:"Wiki", icon:"wiki"}, ...]

#[tauri::command]
async fn repo_read_cards(project_name: String, app_handle: AppHandle) -> Result<String, String>
// 读取 .xt/repo/cards/*.json，返回 JSON 数组

#[tauri::command]
async fn repo_read_wiki(project_name: String, name: String, app_handle: AppHandle) -> Result<String, String>
// 读取 .xt/repo/wiki/{name}.md 内容

#[tauri::command]
async fn repo_generate_cards(project_name: String, api_key: String, app_handle: AppHandle) -> Result<String, String>
// 全量生成 Knowledge Cards（调用 AI）

#[tauri::command]
async fn repo_synthesize_wiki(project_name: String, api_key: String, name: String, app_handle: AppHandle) -> Result<String, String>
// 从卡片二次凝练 Wiki 文章（调用 AI）

#[tauri::command]
async fn repo_incremental_update(project_name: String, api_key: String, app_handle: AppHandle) -> Result<String, String>
// 增量迭代：对比文件快照，只更新变化的卡片
```

`Cargo.toml` 无需新增依赖（复用 `reqwest`、`serde_json`、`tokio`）。

---

## Task 5：前端 TypeScript — 仓库模式状态机

文件：`ai-experts/src/main.ts`

新增状态变量（约 10 行）：

```typescript
let wikiMode: "article" | "cards" = "article";
let wikiIterationMode: "manual" | "self" | "auto" = "manual";
let wikiActiveItem: string = "wiki";  // 当前选中的仓库导航项
let wikiAutoTimer: ReturnType<typeof setInterval> | null = null;
```

新增函数：

| 函数 | 职责 |
|------|------|
| `enterWikiMode()` | 隐藏 canvas，显示 wiki-panel + repo-browser，加载仓库列表 |
| `exitWikiMode()` | 反向操作，回到画布视图 |
| `loadRepoBrowser()` | 调用 `repo_list_items`，渲染侧边栏导航 |
| `selectRepoItem(id)` | 切换选中项，加载对应内容到中央面板 |
| `loadWikiArticle()` | 调用 `repo_read_wiki("index")`，渲染 Markdown 到 wiki-article |
| `loadWikiCards()` | 调用 `repo_read_cards`，渲染卡片列表到 wiki-cards-list |
| `switchWikiTab(tab)` | 切换"文章"和"知识卡片"两个视图 |
| `executeIteration()` | 根据 wikiIterationMode 执行对应迭代 |
| `startAutoIteration()` | 启动定时器，每 N 分钟自动执行增量更新 |
| `stopAutoIteration()` | 清除定时器 |

---

## Task 6：前端事件绑定

文件：`ai-experts/src/main.ts`

| 事件 | 处理逻辑 |
|------|----------|
| `btn-repo` click | 调用 `enterWikiMode()` |
| `wiki-back` click | 调用 `exitWikiMode()` |
| `wiki-tabs` 内 tab click | 调用 `switchWikiTab(tab)` |
| `wiki-iteration-btn` click | 调用 `executeIteration()` |
| `wiki-iteration-mode` change | 更新 `wikiIterationMode`，auto 时启动定时器，否则停止 |
| `executeAgentActions` 中文件操作后 | 若 `wikiIterationMode === "self"` 则触发增量更新 |
| 项目切换 (`chat-changed` 事件) | 若处于 wiki 模式，调用 `loadRepoBrowser()` 刷新 |

---

## Task 7：AI Prompt 设计（知识凝练核心）

### 第一次凝练 Prompt（generate_cards）

```
你是知识引擎的"凝练核心层"。请分析以下项目的原始信号（代码结构 + 关键文件内容 + 对话摘要），
为每个有意义的模块生成一张 Knowledge Card。

每张卡片格式（JSON）：
{
  "id": "snake_case 标识",
  "title": "模块名称",
  "category": "overview|architecture|tech_stack|spec|config",
  "tags": ["相关模块", "关键技术"],
  "content": "Markdown 高密度知识（用途、设计决策、注意事项）",
  "sources": ["相关文件路径"]
}

项目原始信号：
{signals}

请返回 JSON 数组：[{...}, {...}, ...]，只返回 JSON，不要其他解释。
```

### 第二次凝练 Prompt（synthesize_wiki）

```
你是知识凝练引擎的"认知中枢层"。
请将以下 Knowledge Cards（给 AI Agent 用的高密度知识单元）
二次加工为一篇连贯、易读的 RepoWiki 文章（给人类阅读）。

要求：
- 使用 Markdown 格式，含章节标题、段落、列表
- 不是简单罗列卡片，而是有逻辑的叙事
- 包含架构决策的背景和原因
- 适当引用文件路径作为链接

Knowledge Cards：
{cards_json}

请返回完整 Markdown 文章，不要其他解释。
```

---

## Task 8：迭代机制实现

### 手动迭代
- 用户点击"执行迭代"按钮
- 依次调用 `repo_generate_cards` → `repo_synthesize_wiki` → 刷新中央面板

### 自迭代（监听变化）
- `executeAgentActions` 中检测到 `CREATE_FILE` / `DELETE_FILE` / `EDIT_FILE` 动作后
- 调用 `repo_incremental_update`（diff 文件快照，增量更新卡片）
- 然后重新调用 `repo_synthesize_wiki` 更新文章
- 更新迭代控制卡片状态文字

### 自动迭代（定时）
- 切换到"自动迭代"模式时，启动 `setInterval`（默认 10 分钟）
- 每次执行 `repo_incremental_update` + `repo_synthesize_wiki`
- 切回其他模式时清除定时器

---

## Task 9：编译验证

```
npx tsc --noEmit        # TypeScript 类型检查
cargo check             # Rust 编译检查
```

---

## 文件变更汇总

| 文件 | 操作 |
|------|------|
| `ai-experts/index.html` | 新增 `wiki-panel` + `repo-browser` HTML |
| `ai-experts/src/styles.css` | 新增约 120 行 CSS |
| `ai-experts/src/main.ts` | 新增约 250 行 TS（状态机、事件、渲染） |
| `ai-experts/src-tauri/src/repo_wiki.rs` | 新建，约 350 行 Rust |
| `ai-experts/src-tauri/src/lib.rs` | 新增 `mod repo_wiki;` + 6 个命令 + 注册 |
