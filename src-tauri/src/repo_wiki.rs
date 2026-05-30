// ========== Wiki 知识库引擎 ==========
// 两层凝练架构：
//   原始信号 → Knowledge Card (.xt/repo/cards/*.json) — Agent 直接消费
//   Knowledge Card → RepoWiki (.xt/repo/wiki/*.md) — 人类可读连贯文章

use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};

use crate::{code_chunker, DeepSeekMessage, DeepSeekRequest, DeepSeekResponse};

const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1/chat/completions";

// ========== 数据结构 ==========

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct KnowledgeCard {
    pub id: String,
    pub title: String,
    pub category: String, // overview/architecture/tech_stack/spec/config
    pub tags: Vec<String>,
    pub content: String,  // Markdown 内容
    pub sources: Vec<String>,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WikiArticle {
    pub title: String,
    pub content: String,   // Markdown
    pub source_cards: Vec<String>,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoItem {
    pub id: String,
    pub name: String,
    pub icon: String, // "wiki" | "cards" | "graph"
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignalData {
    pub file_summaries: Vec<FileSummary>,
    pub chat_summaries: Vec<ChatSummary>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileSummary {
    pub path: String,
    pub language: String,
    pub snippet: String, // 前 500 字符
    pub chunk_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatSummary {
    pub session_name: String,
    pub message_count: usize,
    pub last_message_snippet: String,
}

// ========== 核心函数 ==========

/// 列出 .xt/repo/ 子目录，返回 RepoItem 列表
pub fn list_repo_items(project_dir: &Path) -> Vec<RepoItem> {
    let mut items = vec![];

    let wiki_dir = project_dir.join(".xt/repo/wiki");

    // Wiki 条目
    if wiki_dir.exists() {
        if let Ok(entries) = fs::read_dir(&wiki_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    let name = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    items.push(RepoItem {
                        id: format!("wiki:{}", name),
                        name: format!("Wiki - {}", name),
                        icon: "wiki".to_string(),
                    });
                }
            }
        }
    }

    // 代码图谱（如果有 code_graph 数据）
    let graph_dir = project_dir.join(".xt/repo/graph");
    if graph_dir.exists() {
        items.push(RepoItem {
            id: "graph".to_string(),
            name: "代码图谱".to_string(),
            icon: "graph".to_string(),
        });
    }

    items
}

/// 读取 .xt/repo/cards/*.json，返回 Vec<KnowledgeCard>
pub fn read_cards(project_dir: &Path) -> Result<Vec<KnowledgeCard>, String> {
    let cards_dir = project_dir.join(".xt/repo/cards");
    if !cards_dir.exists() {
        return Ok(vec![]);
    }

    let mut cards = vec![];
    if let Ok(entries) = fs::read_dir(&cards_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                let content = fs::read_to_string(&path)
                    .map_err(|e| format!("读取卡片文件失败: {}", e))?;
                let card: KnowledgeCard = serde_json::from_str(&content)
                    .map_err(|e| format!("解析卡片失败: {}", e))?;
                cards.push(card);
            }
        }
    }

    Ok(cards)
}

/// 读取 .xt/repo/wiki/{name}.md，返回内容字符串
pub fn read_wiki(project_dir: &Path, name: &str) -> Result<String, String> {
    let wiki_path = project_dir.join(format!(".xt/repo/wiki/{}.md", name));
    if !wiki_path.exists() {
        return Err(format!("Wiki 文章 {} 不存在", name));
    }
    fs::read_to_string(&wiki_path)
        .map_err(|e| format!("读取 Wiki 文件失败: {}", e))
}

/// 确保 .xt/repo/cards/ 和 .xt/repo/wiki/ 存在
pub fn ensure_repo_dirs(project_dir: &Path) -> Result<(), String> {
    let cards_dir = project_dir.join(".xt/repo/cards");
    let wiki_dir = project_dir.join(".xt/repo/wiki");

    fs::create_dir_all(&cards_dir)
        .map_err(|e| format!("创建 cards 目录失败: {}", e))?;
    fs::create_dir_all(&wiki_dir)
        .map_err(|e| format!("创建 wiki 目录失败: {}", e))?;

    Ok(())
}

/// 感知层：扫描项目文件 + 读取对话摘要
pub fn collect_signals(project_dir: &Path) -> Result<SignalData, String> {
    let mut file_summaries = vec![];

    // 递归扫描项目文件（跳过 .xt 和隐藏文件）
    scan_files_recursive(project_dir, project_dir, &mut file_summaries)?;

    // 读取对话摘要
    let chat_summaries = read_chat_summaries(project_dir).unwrap_or_default();

    Ok(SignalData {
        file_summaries,
        chat_summaries,
    })
}

/// Wiki 信号采集跳过目录集合
const WIKI_SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "__pycache__", "venv", ".venv",
    "build", ".next", "coverage", "vendor", ".gradle", "gradle",
    "obj", "bin", "out", "packages", ".nuget", "Pods", "DerivedData",
    ".dart_tool", ".pub-cache", "bower_components", "jspm_packages",
    ".cache", ".parcel-cache", ".terraform", ".serverless",
    "logs", "tmp", "temp",
];

fn scan_files_recursive(
    base: &Path,
    current: &Path,
    result: &mut Vec<FileSummary>,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过隐藏文件和 .xt 目录
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            // 跳过符号链接和常见无关目录
            if path.is_symlink() || WIKI_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            scan_files_recursive(base, &path, result)?;
        } else {
            // 文件大小保护（512KB）
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() > 512 * 1024 {
                    continue;
                }
            }

            // 只采集代码/配置文件
            let ext = path.extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let wiki_exts = [
                "ts", "tsx", "js", "jsx", "rs", "py", "md", "json",
                "html", "css", "go", "java", "kt", "swift", "c", "cpp",
                "h", "hpp", "yaml", "yml", "toml", "xml", "sql",
                "sh", "bash", "txt", "cfg", "ini",
            ];
            if !wiki_exts.contains(&ext.as_str()) {
                continue;
            }

            // 读取文件内容的前 500 字符作为摘要
            if let Ok(content) = fs::read_to_string(&path) {
                let relative = path.strip_prefix(base)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                let language = code_chunker::detect_language(&relative);
                let chunk_count = code_chunker::chunk_file(&relative, &content).len();
                let snippet = if content.len() > 500 {
                    format!("{}...", &content[..500])
                } else {
                    content.clone()
                };

                result.push(FileSummary {
                    path: relative,
                    language,
                    snippet,
                    chunk_count,
                });
            }
        }
    }

    Ok(())
}

fn read_chat_summaries(project_dir: &Path) -> Result<Vec<ChatSummary>, String> {
    let sessions_file = project_dir.join(".xt/chat_sessions.json");
    if !sessions_file.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&sessions_file)
        .map_err(|e| format!("读取会话文件失败: {}", e))?;

    let sessions: Vec<serde_json::Value> = serde_json::from_str(&content)
        .map_err(|e| format!("解析会话文件失败: {}", e))?;

    let mut summaries = vec![];
    for session in sessions.iter().take(10) {
        // 限制只读最近 10 个会话
        let name = session["name"].as_str().unwrap_or("未命名").to_string();
        let messages = session["messages"].as_array().map(|a| a.len()).unwrap_or(0);
        let last_snippet = session["messages"]
            .as_array()
            .and_then(|msgs| msgs.last())
            .and_then(|msg| msg["content"].as_str())
            .map(|s| {
                if s.len() > 200 {
                    format!("{}...", &s[..200])
                } else {
                    s.to_string()
                }
            })
            .unwrap_or_default();

        summaries.push(ChatSummary {
            session_name: name,
            message_count: messages,
            last_message_snippet: last_snippet,
        });
    }

    Ok(summaries)
}

/// 构造 AI 生成卡片的 Prompt
pub fn generate_cards_prompt(signals: &SignalData) -> String {
    let signals_json = serde_json::to_string(signals).unwrap_or_default();

    format!(
        r#"你是知识引擎的"凝练核心层"。请分析以下项目的原始信号（代码结构 + 关键文件内容 + 对话摘要），
为每个有意义的模块生成一张 Knowledge Card。

每张卡片格式（JSON）：
{{
  "id": "snake_case 标识",
  "title": "模块名称",
  "category": "overview|architecture|tech_stack|spec|config",
  "tags": ["相关模块", "关键技术"],
  "content": "Markdown 高密度知识（用途、设计决策、注意事项）",
  "sources": ["相关文件路径"],
  "updated_at": "2026-05-30T12:00:00Z"
}}

项目原始信号：
{}

请返回 JSON 数组：[{{...}}, {{...}}, ...]，只返回 JSON，不要其他解释。"#,
        signals_json
    )
}

/// 构造 AI 凝练 Wiki 的 Prompt
pub fn generate_wiki_prompt(cards_json: &str) -> String {
    format!(
        r#"你是知识凝练引擎的"认知中枢层"。
请将以下 Knowledge Cards（给 AI Agent 用的高密度知识单元）
二次加工为一篇连贯、易读的 RepoWiki 文章（给人类阅读）。

要求：
- 使用 Markdown 格式，含章节标题、段落、列表
- 不是简单罗列卡片，而是有逻辑的叙事
- 包含架构决策的背景和原因
- 适当引用文件路径作为链接

Knowledge Cards：
{}

请返回完整 Markdown 文章，不要其他解释。"#,
        cards_json
    )
}

/// 全量生成 Knowledge Cards（调用 AI）
pub async fn generate_cards(
    project_dir: &Path,
    api_key: &str,
) -> Result<Vec<KnowledgeCard>, String> {
    ensure_repo_dirs(project_dir)?;

    let signals = collect_signals(project_dir)?;
    let prompt = generate_cards_prompt(&signals);

    let response_text = call_ai(api_key, &prompt).await?;

    // 提取 JSON 数组
    let json_text = extract_json_array(&response_text);
    let cards: Vec<KnowledgeCard> = serde_json::from_str(&json_text)
        .map_err(|e| format!("解析 AI 返回的卡片 JSON 失败: {}", e))?;

    // 写入卡片文件
    let now = chrono_now();
    let cards_dir = project_dir.join(".xt/repo/cards");

    // 清除旧卡片
    if cards_dir.exists() {
        if let Ok(entries) = fs::read_dir(&cards_dir) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    for card in &cards {
        let mut c = card.clone();
        c.updated_at = now.clone();
        let file_name = format!("{}.json", c.id);
        let file_path = cards_dir.join(&file_name);
        let content = serde_json::to_string_pretty(&c)
            .map_err(|e| format!("序列化卡片失败: {}", e))?;
        fs::write(&file_path, content)
            .map_err(|e| format!("写入卡片文件失败: {}", e))?;
    }

    Ok(cards)
}

/// 从卡片二次凝练 Wiki 文章（调用 AI）
/// 若无卡片，自动从项目文件生成
pub async fn synthesize_wiki(
    project_dir: &Path,
    api_key: &str,
    name: &str,
) -> Result<WikiArticle, String> {
    let cards = read_cards(project_dir)?;
    let cards = if cards.is_empty() {
        // 无卡片时自动生成（初始化阶段）
        let generated = generate_cards(project_dir, api_key).await?;
        if generated.is_empty() {
            return Err("项目中没有可分析的文件，请先添加代码文件".to_string());
        }
        generated
    } else {
        cards
    };

    let cards_json = serde_json::to_string(&cards)
        .map_err(|e| format!("序列化卡片失败: {}", e))?;
    let prompt = generate_wiki_prompt(&cards_json);

    let response_text = call_ai(api_key, &prompt).await?;

    // 提取 Markdown（去除可能的代码块包裹）
    let markdown = extract_markdown(&response_text);

    let now = chrono_now();
    let article = WikiArticle {
        title: format!("{} - Wiki", name),
        content: markdown.clone(),
        source_cards: cards.iter().map(|c| c.id.clone()).collect(),
        updated_at: now.clone(),
    };

    // 写入 Wiki 文件
    ensure_repo_dirs(project_dir)?;
    let wiki_path = project_dir.join(format!(".xt/repo/wiki/{}.md", name));
    fs::write(&wiki_path, &markdown)
        .map_err(|e| format!("写入 Wiki 文件失败: {}", e))?;

    Ok(article)
}

/// 增量更新：对比信号变化，只更新变化的卡片
pub async fn incremental_update(
    project_dir: &Path,
    api_key: &str,
) -> Result<String, String> {
    let existing_cards = read_cards(project_dir).unwrap_or_default();
    let signals = collect_signals(project_dir)?;

    if existing_cards.is_empty() {
        // 全量生成
        let cards = generate_cards(project_dir, api_key).await?;
        let _wiki = synthesize_wiki(project_dir, api_key, "index").await?;
        return Ok(format!(
            "全量生成完成：{} 张知识卡片，Wiki 文章已更新。",
            cards.len()
        ));
    }

    // 增量更新：基于新的 signals 生成额外的上下文
    let signals_json = serde_json::to_string(&signals).unwrap_or_default();
    let existing_json = serde_json::to_string(&existing_cards).unwrap_or_default();

    let prompt = format!(
        r#"你是一个增量知识更新引擎。以下是项目的当前原始信号和已有的知识卡片。

已有卡片（JSON 数组）：
{}

新的项目信号：
{}

请比较两者，判断哪些卡片需要更新或新增：
1. 对于已有卡片中有变化的，返回更新后的完整卡片（保持 id 不变）
2. 对于新出现的模块，生成新卡片
3. 没有变化的卡片不需要返回

请返回 JSON 数组，格式与已有卡片相同。只返回 JSON，不要其他解释。"#,
        existing_json, signals_json
    );

    let response_text = call_ai(api_key, &prompt).await?;
    let json_text = extract_json_array(&response_text);
    let updated_cards: Vec<KnowledgeCard> = serde_json::from_str(&json_text)
        .map_err(|e| format!("解析增量更新结果失败: {}", e))?;

    // 合并卡片
    let now = chrono_now();
    let cards_dir = project_dir.join(".xt/repo/cards");
    ensure_repo_dirs(project_dir)?;

    let mut existing_map: std::collections::HashMap<String, KnowledgeCard> = existing_cards
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();

    for card in &updated_cards {
        let mut c = card.clone();
        c.updated_at = now.clone();
        existing_map.insert(c.id.clone(), c);
    }

    // 写回文件
    for (_, card) in &existing_map {
        let file_path = cards_dir.join(format!("{}.json", card.id));
        let content = serde_json::to_string_pretty(card)
            .map_err(|e| format!("序列化卡片失败: {}", e))?;
        fs::write(&file_path, content)
            .map_err(|e| format!("写入卡片文件失败: {}", e))?;
    }

    // 重新合成 Wiki
    let _wiki = synthesize_wiki(project_dir, api_key, "index").await?;

    Ok(format!(
        "增量更新完成：{} 张卡片变更，共 {} 张卡片，Wiki 已刷新。",
        updated_cards.len(),
        existing_map.len()
    ))
}

// ========== AI 调用 ==========

pub async fn call_ai(api_key: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::Client::new();

    let request_body = DeepSeekRequest {
        model: "deepseek-v4-flash".to_string(),
        messages: vec![DeepSeekMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
        stream: false,
    };

    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(120))
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("AI API 错误 ({}): {}", status, text));
    }

    let result: DeepSeekResponse = response
        .json()
        .await
        .map_err(|e| format!("解析 AI 响应失败: {}", e))?;

    result.choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| "AI 返回空内容".to_string())
}

// ========== 辅助函数 ==========

fn extract_json_array(text: &str) -> String {
    // 尝试提取 code block 中的 JSON
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start + 7..].find("```") {
            return text[start + 7..start + 7 + end].trim().to_string();
        }
    }
    if let Some(start) = text.find("```") {
        if let Some(end) = text[start + 3..].find("```") {
            let inner = text[start + 3..start + 3 + end].trim();
            if inner.starts_with('[') || inner.starts_with('{') {
                return inner.to_string();
            }
        }
    }
    // 直接找 JSON 数组
    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            return text[start..=end].to_string();
        }
    }
    text.to_string()
}

fn extract_markdown(text: &str) -> String {
    if let Some(start) = text.find("```markdown") {
        if let Some(end) = text[start + 11..].find("```") {
            return text[start + 11..start + 11 + end].trim().to_string();
        }
    }
    if let Some(start) = text.find("```md") {
        if let Some(end) = text[start + 5..].find("```") {
            return text[start + 5..start + 5 + end].trim().to_string();
        }
    }
    if let Some(start) = text.find("```") {
        if let Some(end) = text[start + 3..].find("```") {
            let inner = text[start + 3..start + 3 + end].trim();
            if !inner.starts_with('[') && !inner.starts_with('{') {
                return inner.to_string();
            }
        }
    }
    text.to_string()
}

fn chrono_now() -> String {
    // 简单的 ISO 时间戳
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    // 格式: 2024-01-01T00:00:00
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // 简化：从 UNIX epoch 算起，不准确但可接受
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        1970 + (days / 365) as u64,
        ((days % 365) / 30 + 1),
        ((days % 365) % 30 + 1),
        hours,
        minutes,
        seconds
    )
}
