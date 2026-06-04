// ========== 本地记忆系统 - 基于 SQLite + TF-IDF 关键词检索 ==========
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use crate::tfidf;

// ---- 核心数据结构 ----

/// 记忆条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub project_id: i64,
    pub expert_id: String,
    pub memory_type: String, // "ephemeral" | "working" | "longterm"
    pub content: String,
    pub keywords: Vec<String>,
    pub context_summary: String,
    pub created_at: i64,
    pub access_count: i32,
    pub last_accessed: i64,
}

/// 记忆检索请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryQuery {
    pub project_id: i64,
    pub expert_id: Option<String>,
    pub query_text: String,
    pub memory_type: Option<String>,
    pub limit: usize,
}

/// 记忆检索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySearchResult {
    pub entry: MemoryEntry,
    pub score: f64,
}

// ---- 存储路径 ----

fn get_memory_dir(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join(".xt").join("memory")
}

fn get_memory_file(project_dir: &Path, memory_type: &str) -> std::path::PathBuf {
    get_memory_dir(project_dir).join(format!("{}.json", memory_type))
}

fn persist_memory_entries(
    project_dir: &Path,
    memory_type: &str,
    entries: &[MemoryEntry],
) -> Result<(), String> {
    let mem_dir = get_memory_dir(project_dir);
    fs::create_dir_all(&mem_dir).map_err(|e| format!("创建记忆目录失败: {}", e))?;

    let file_path = get_memory_file(project_dir, memory_type);
    if entries.is_empty() {
        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| format!("删除记忆文件失败: {}", e))?;
        }
        return Ok(());
    }

    let json =
        serde_json::to_string_pretty(entries).map_err(|e| format!("序列化记忆失败: {}", e))?;
    fs::write(&file_path, json).map_err(|e| format!("写入记忆文件失败: {}", e))?;
    Ok(())
}

fn touch_memory_entry(project_dir: &Path, memory_type: &str, id: &str) -> Result<(), String> {
    let mut entries = load_memory_entries(project_dir, memory_type)?;
    if let Some(entry) = entries.iter_mut().find(|e| e.id == id) {
        entry.access_count += 1;
        entry.last_accessed = current_timestamp();
        persist_memory_entries(project_dir, memory_type, &entries)?;
    }
    Ok(())
}

// ---- 记忆 CRUD ----

/// 保存记忆条目
pub fn save_memory(project_dir: &Path, entry: &MemoryEntry) -> Result<(), String> {
    let mem_dir = get_memory_dir(project_dir);
    fs::create_dir_all(&mem_dir).map_err(|e| format!("创建记忆目录失败: {}", e))?;

    let mut entries = load_memory_entries(project_dir, &entry.memory_type)?;

    // 更新或追加
    let pos = entries.iter().position(|e| e.id == entry.id);
    if let Some(idx) = pos {
        entries[idx] = entry.clone();
    } else {
        entries.push(entry.clone());
    }

    // 上限保护：每类记忆最多 500 条
    const MAX_ENTRIES_PER_TYPE: usize = 500;
    if entries.len() > MAX_ENTRIES_PER_TYPE {
        // 按 last_accessed 排序，保留最近访问的
        entries.sort_by(|a, b| b.last_accessed.cmp(&a.last_accessed));
        entries.truncate(MAX_ENTRIES_PER_TYPE);
    }

    persist_memory_entries(project_dir, &entry.memory_type, &entries)?;

    Ok(())
}

/// 加载指定类型的所有记忆条目
pub fn load_memory_entries(
    project_dir: &Path,
    memory_type: &str,
) -> Result<Vec<MemoryEntry>, String> {
    let file_path = get_memory_file(project_dir, memory_type);
    if !file_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&file_path).map_err(|e| format!("读取记忆文件失败: {}", e))?;
    let entries: Vec<MemoryEntry> =
        serde_json::from_str(&content).map_err(|e| format!("解析记忆文件失败: {}", e))?;

    Ok(entries)
}

/// 加载所有类型的记忆条目
pub fn load_all_memories(project_dir: &Path) -> Result<Vec<MemoryEntry>, String> {
    let mut all = vec![];
    for mem_type in &["ephemeral", "working", "longterm"] {
        all.extend(load_memory_entries(project_dir, mem_type)?);
    }
    Ok(all)
}

/// 删除单条记忆
pub fn delete_memory(project_dir: &Path, memory_type: &str, id: &str) -> Result<bool, String> {
    let mut entries = load_memory_entries(project_dir, memory_type)?;
    let before = entries.len();
    entries.retain(|e| e.id != id);
    let after = entries.len();

    if before != after {
        persist_memory_entries(project_dir, memory_type, &entries)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 清空指定类型的记忆
pub fn clear_memory_type(project_dir: &Path, memory_type: &str) -> Result<(), String> {
    let file_path = get_memory_file(project_dir, memory_type);
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| format!("删除记忆文件失败: {}", e))?;
    }
    Ok(())
}

// ---- 记忆检索（TF-IDF 关键词匹配） ----

/// 基于 TF-IDF 关键词匹配的记忆检索
pub fn search_memories(
    project_dir: &Path,
    query: &MemoryQuery,
) -> Result<Vec<MemorySearchResult>, String> {
    // 1. 加载候选记忆
    let candidates = if let Some(ref mem_type) = query.memory_type {
        load_memory_entries(project_dir, mem_type)?
    } else {
        load_all_memories(project_dir)?
    };

    if candidates.is_empty() {
        return Ok(vec![]);
    }

    // 2. 过滤 project_id 和 expert_id
    let mut filtered: Vec<&MemoryEntry> = candidates
        .iter()
        .filter(|e| e.project_id == query.project_id)
        .collect();

    if let Some(ref expert_id) = query.expert_id {
        // 优先匹配同专家的记忆，但也保留其他专家的记忆（权重降低）
        let same_expert: Vec<&MemoryEntry> = filtered
            .iter()
            .filter(|e| e.expert_id == *expert_id)
            .copied()
            .collect();
        if !same_expert.is_empty() {
            filtered = same_expert;
        }
    }

    if filtered.is_empty() {
        return Ok(vec![]);
    }

    let limit = query.limit.max(1).min(1000);
    let trimmed_query = query.query_text.trim();
    if trimmed_query.is_empty() {
        let mut sorted = filtered;
        sorted.sort_by(|a, b| {
            b.last_accessed
                .cmp(&a.last_accessed)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });

        let results: Vec<MemorySearchResult> = sorted
            .into_iter()
            .take(limit)
            .map(|entry| MemorySearchResult {
                entry: entry.clone(),
                score: 1.0,
            })
            .collect();

        for result in &results {
            let _ = touch_memory_entry(project_dir, &result.entry.memory_type, &result.entry.id);
        }

        return Ok(results);
    }

    // 3. 对查询文本分词
    let query_tokens: HashSet<String> = tfidf::tokenize(trimmed_query).into_iter().collect();

    if query_tokens.is_empty() {
        return Ok(vec![]);
    }

    let now = current_timestamp();

    // 4. 计算每条记忆的得分
    let mut scored: Vec<(f64, &MemoryEntry)> = Vec::new();
    for entry in filtered {
        let entry_keywords: HashSet<String> = entry.keywords.iter().cloned().collect();

        // 关键词重叠度
        let overlap: HashSet<&String> = query_tokens.intersection(&entry_keywords).collect();
        let keyword_score = if query_tokens.is_empty() {
            0.0
        } else {
            overlap.len() as f64 / query_tokens.len() as f64
        };

        // 内容匹配度（简单词频）
        let content_tokens = tfidf::tokenize(&entry.content);
        let content_set: HashSet<String> = content_tokens.into_iter().collect();
        let content_overlap: HashSet<&String> = query_tokens.intersection(&content_set).collect();
        let content_score = if query_tokens.is_empty() {
            0.0
        } else {
            content_overlap.len() as f64 / query_tokens.len() as f64
        };

        // 时间衰减因子（越新的记忆权重越高）
        let age_days = ((now - entry.created_at) as f64 / 86400.0).max(0.0);
        let time_decay = (-age_days / 30.0).exp(); // 30天半衰期

        // 访问频率加成
        let access_boost = 1.0 + (entry.access_count as f64 * 0.05).min(0.5);

        // 记忆类型权重
        let type_weight = match entry.memory_type.as_str() {
            "longterm" => 1.2,
            "working" => 1.0,
            "ephemeral" => 0.7,
            _ => 1.0,
        };

        // 综合得分
        let score =
            (keyword_score * 0.5 + content_score * 0.3) * time_decay * access_boost * type_weight;

        if score > 0.01 {
            scored.push((score, entry));
        }
    }

    // 5. 按得分降序排序
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // 6. 返回 Top-N
    let results: Vec<MemorySearchResult> = scored
        .into_iter()
        .take(limit)
        .map(|(score, entry)| MemorySearchResult {
            entry: entry.clone(),
            score,
        })
        .collect();

    for result in &results {
        let _ = touch_memory_entry(project_dir, &result.entry.memory_type, &result.entry.id);
    }

    Ok(results)
}

// ---- 记忆生命周期管理 ----

/// 将 Ephemeral 记忆中有价值的条目提升到 Working 记忆
/// 规则：access_count >= 2 或内容长度 >= 200
pub fn promote_ephemeral_to_working(project_dir: &Path) -> Result<usize, String> {
    let ephemeral = load_memory_entries(project_dir, "ephemeral")?;
    let mut promoted = 0usize;

    for entry in ephemeral {
        let should_promote = entry.access_count >= 2 || entry.content.len() >= 200;
        if should_promote {
            let mut working_entry = entry.clone();
            working_entry.memory_type = "working".to_string();
            working_entry.id = format!("working-{}", entry.id);
            save_memory(project_dir, &working_entry)?;
            promoted += 1;
        }
    }

    // 清理旧的 ephemeral 记忆（保留最近 7 天的）
    let now = current_timestamp();
    let seven_days_ago = now - 7 * 86400;
    let remaining: Vec<MemoryEntry> = load_memory_entries(project_dir, "ephemeral")?
        .into_iter()
        .filter(|e| e.created_at >= seven_days_ago)
        .collect();

    // 保存清理后的 ephemeral
    let file_path = get_memory_file(project_dir, "ephemeral");
    if remaining.is_empty() {
        let _ = fs::remove_file(&file_path);
    } else {
        persist_memory_entries(project_dir, "ephemeral", &remaining)?;
    }

    Ok(promoted)
}

/// 将 Working 记忆中有价值的条目凝练为 LongTerm 记忆
/// 规则：access_count >= 5 且存在超过 14 天
pub fn consolidate_working_to_longterm(project_dir: &Path) -> Result<usize, String> {
    let working = load_memory_entries(project_dir, "working")?;
    let now = current_timestamp();
    let fourteen_days_ago = now - 14 * 86400;
    let mut consolidated = 0usize;

    for entry in working {
        if entry.access_count >= 5 && entry.created_at <= fourteen_days_ago {
            let mut longterm_entry = entry.clone();
            longterm_entry.memory_type = "longterm".to_string();
            longterm_entry.id = format!("longterm-{}", entry.id);
            // 压缩内容：保留摘要，截断长内容
            if longterm_entry.content.len() > 1000 {
                longterm_entry.content = format!("{}...(已凝练)", &longterm_entry.content[..800]);
            }
            save_memory(project_dir, &longterm_entry)?;
            consolidated += 1;
        }
    }

    // 清理旧的 working 记忆（保留最近 30 天的）
    let thirty_days_ago = now - 30 * 86400;
    let remaining: Vec<MemoryEntry> = load_memory_entries(project_dir, "working")?
        .into_iter()
        .filter(|e| e.created_at >= thirty_days_ago)
        .collect();

    let file_path = get_memory_file(project_dir, "working");
    if remaining.is_empty() {
        let _ = fs::remove_file(&file_path);
    } else {
        persist_memory_entries(project_dir, "working", &remaining)?;
    }

    Ok(consolidated)
}

/// 运行完整的记忆生命周期管理
pub fn run_memory_lifecycle(project_dir: &Path) -> Result<String, String> {
    let promoted = promote_ephemeral_to_working(project_dir)?;
    let consolidated = consolidate_working_to_longterm(project_dir)?;
    Ok(format!(
        "记忆生命周期管理完成：{} 条 ephemeral -> working，{} 条 working -> longterm",
        promoted, consolidated
    ))
}

// ---- 辅助函数 ----

/// 生成唯一记忆 ID
#[allow(dead_code)]
pub fn generate_memory_id() -> String {
    format!("mem-{}-{}", current_timestamp(), random_suffix())
}

/// 从文本提取关键词
#[allow(dead_code)]
pub fn extract_keywords(text: &str) -> Vec<String> {
    let tokens = tfidf::tokenize(text);
    // 去重并过滤
    let mut seen = HashSet::new();
    let mut keywords: Vec<String> = Vec::new();
    for token in tokens {
        if token.len() >= 2 && !is_common_stopword(&token) && seen.insert(token.clone()) {
            keywords.push(token);
        }
    }
    // 限制关键词数量
    keywords.truncate(30);
    keywords
}

/// 生成上下文摘要（取前 100 字符）
#[allow(dead_code)]
pub fn generate_summary(text: &str) -> String {
    if text.chars().count() <= 100 {
        text.to_string()
    } else {
        format!("{}...", text.chars().take(100).collect::<String>())
    }
}

/// 获取当前时间戳（秒）
fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[allow(dead_code)]
fn random_suffix() -> String {
    format!("{:04x}", rand::random::<u16>())
}

/// 常见停用词过滤
#[allow(dead_code)]
fn is_common_stopword(word: &str) -> bool {
    let stopwords: HashSet<&str> = [
        "the",
        "a",
        "an",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "could",
        "should",
        "may",
        "might",
        "must",
        "shall",
        "can",
        "need",
        "dare",
        "ought",
        "used",
        "to",
        "of",
        "in",
        "for",
        "on",
        "with",
        "at",
        "by",
        "from",
        "as",
        "into",
        "through",
        "during",
        "before",
        "after",
        "above",
        "below",
        "between",
        "under",
        "and",
        "but",
        "or",
        "yet",
        "so",
        "if",
        "because",
        "although",
        "though",
        "while",
        "where",
        "when",
        "that",
        "which",
        "who",
        "whom",
        "whose",
        "what",
        "this",
        "these",
        "those",
        "i",
        "you",
        "he",
        "she",
        "it",
        "we",
        "they",
        "me",
        "him",
        "her",
        "us",
        "them",
        "my",
        "your",
        "his",
        "its",
        "our",
        "their",
        "的",
        "了",
        "在",
        "是",
        "我",
        "有",
        "和",
        "就",
        "不",
        "人",
        "都",
        "一",
        "一个",
        "上",
        "也",
        "很",
        "到",
        "说",
        "要",
        "去",
        "你",
        "会",
        "着",
        "没有",
        "看",
        "好",
        "自己",
        "这",
        "那",
        "个",
        "为",
        "之",
        "与",
        "及",
        "等",
        "或",
        "但",
        "而",
        "因",
        "于",
        "以",
        "所",
        "被",
        "把",
        "给",
        "让",
        "向",
        "从",
        "到",
        "对",
        "关于",
        "根据",
        "function",
        "const",
        "let",
        "var",
        "return",
        "if",
        "else",
        "for",
        "while",
        "import",
        "export",
        "from",
        "class",
        "interface",
        "type",
        "async",
        "await",
        "pub",
        "fn",
        "struct",
        "enum",
        "impl",
        "use",
        "mod",
        "let",
        "mut",
    ]
    .iter()
    .copied()
    .collect();

    stopwords.contains(word.to_lowercase().as_str())
}

// ---- 增强搜索：共现词加权 + 专家维度 + Token预算 ----

/// 增强搜索：在现有关键词匹配基础上增加共现词相关度和专家维度过滤
pub fn search_memories_enhanced(
    project_dir: &Path,
    query: &MemoryQuery,
    expert_id_filter: Option<&str>,
    max_tokens: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    // 1. 基础关键词搜索（复用现有逻辑，取双倍结果供重排序）
    let mut extended_query = query.clone();
    extended_query.limit = query.limit * 2;
    let mut results = search_memories(project_dir, &extended_query)?;

    // 2. 共现词加权：如果query中的多个词在同一记忆中都出现，额外加分
    let query_words: HashSet<String> = tfidf::tokenize(query.query_text.trim())
        .into_iter()
        .collect();

    for result in &mut results {
        let memory_words: HashSet<String> =
            tfidf::tokenize(&result.entry.content).into_iter().collect();
        let co_occurrence = query_words
            .iter()
            .filter(|w| memory_words.contains(*w))
            .count();
        if co_occurrence >= 2 {
            result.score *= 1.0 + (co_occurrence as f64 * 0.15);
        }
    }

    // 3. 专家维度过滤：如果指定了expert_id，优先返回该专家相关的记忆
    if let Some(eid) = expert_id_filter {
        for result in &mut results {
            if result.entry.expert_id == eid {
                result.score *= 1.3; // 相关专家的记忆加权30%
            }
        }
    }

    // 4. 重新排序
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 5. Token预算截断
    if let Some(budget) = max_tokens {
        let mut token_count = 0usize;
        results = results
            .into_iter()
            .take_while(|r| {
                let est = estimate_tokens(&r.entry.content);
                token_count += est;
                token_count <= budget
            })
            .collect();
    }

    results.truncate(query.limit);
    Ok(results)
}

/// 估算文本的Token数(简单版)
fn estimate_tokens(text: &str) -> usize {
    let chinese_count = text
        .chars()
        .filter(|c| *c >= '\u{4e00}' && *c <= '\u{9fff}')
        .count();
    let rest_words = text
        .split_whitespace()
        .count()
        .saturating_sub(chinese_count);
    (chinese_count as f64 * 2.5 + rest_words as f64 * 1.5) as usize
}

/// 记忆相似度合并检测
#[allow(dead_code)]
pub fn find_similar_memories(
    project_dir: &Path,
    memory_type: &str,
    new_content: &str,
    threshold: f64,
) -> Result<Vec<String>, String> {
    let entries = load_memory_entries(project_dir, memory_type)?;
    let new_keywords: HashSet<String> = tfidf::tokenize(new_content).into_iter().collect();
    let similar_ids: Vec<String> = entries
        .iter()
        .filter_map(|m| {
            let existing_keywords: HashSet<String> =
                tfidf::tokenize(&m.content).into_iter().collect();
            let overlap = new_keywords
                .iter()
                .filter(|w| existing_keywords.contains(*w))
                .count();
            let similarity = overlap as f64 / (new_keywords.len().max(1) as f64);
            if similarity > threshold {
                Some(m.id.clone())
            } else {
                None
            }
        })
        .collect();
    Ok(similar_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai_experts_memory_{}_{}", name, random_suffix()));
        fs::create_dir_all(&dir).expect("create temp project dir");
        dir
    }

    fn make_entry(id: &str, memory_type: &str, content: &str, created_at: i64) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            project_id: 1,
            expert_id: "jiang-qinglan".to_string(),
            memory_type: memory_type.to_string(),
            content: content.to_string(),
            keywords: extract_keywords(content),
            context_summary: generate_summary(content),
            created_at,
            access_count: 0,
            last_accessed: created_at,
        }
    }

    #[test]
    fn search_memories_lists_entries_for_blank_query_and_touches_access_stats() {
        let dir = temp_project_dir("blank_query");
        let now = current_timestamp();

        save_memory(
            &dir,
            &make_entry(
                "working-1",
                "working",
                "修复记忆检索与打断转达逻辑",
                now - 30,
            ),
        )
        .expect("save working memory");
        save_memory(
            &dir,
            &make_entry(
                "longterm-1",
                "longterm",
                "专家团会把主管结论沉淀为长期知识",
                now - 10,
            ),
        )
        .expect("save longterm memory");

        let results = search_memories(
            &dir,
            &MemoryQuery {
                project_id: 1,
                expert_id: None,
                query_text: "".to_string(),
                memory_type: None,
                limit: 10,
            },
        )
        .expect("search memories");

        assert_eq!(results.len(), 2);

        let touched = load_memory_entries(&dir, "longterm").expect("reload longterm");
        let longterm = touched
            .iter()
            .find(|e| e.id == "longterm-1")
            .expect("find longterm");
        assert_eq!(longterm.access_count, 1);
        assert!(longterm.last_accessed >= now);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lifecycle_promotes_ephemeral_and_consolidates_old_working_memory() {
        let dir = temp_project_dir("lifecycle");
        let now = current_timestamp();

        let mut ephemeral = make_entry(
            "ephemeral-1",
            "ephemeral",
            "这是一次足够长的专家输出，用于触发工作记忆提升。",
            now - 60,
        );
        ephemeral.access_count = 2;
        save_memory(&dir, &ephemeral).expect("save ephemeral");

        let mut working = make_entry(
            "working-legacy",
            "working",
            "跨会话稳定知识：主管需要把专家结论转达给用户。",
            now - 15 * 86400,
        );
        working.access_count = 6;
        save_memory(&dir, &working).expect("save working");

        let summary = run_memory_lifecycle(&dir).expect("run lifecycle");
        assert!(summary.contains("ephemeral -> working"));
        assert!(summary.contains("working -> longterm"));

        let working_entries = load_memory_entries(&dir, "working").expect("reload working");
        assert!(working_entries
            .iter()
            .any(|e| e.id == "working-ephemeral-1"));

        let longterm_entries = load_memory_entries(&dir, "longterm").expect("reload longterm");
        assert!(longterm_entries
            .iter()
            .any(|e| e.id == "longterm-working-legacy"));

        let _ = fs::remove_dir_all(&dir);
    }
}
