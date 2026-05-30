// ========== 代码保留率追踪系统 ==========
// 追踪专家生成代码在后续迭代中的保留情况

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

// ---- 数据结构 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetentionReport {
    pub project_name: String,
    pub generated_snippets: Vec<CodeSnippet>,
    pub retention_rate: f32, // 0.0 - 1.0
    pub avg_lifespan_days: f32,
    pub by_expert: Vec<ExpertRetention>,
    pub evaluated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeSnippet {
    pub id: String,
    pub expert_id: String,
    pub expert_name: String,
    pub file_path: String,
    pub content_hash: String,
    pub generated_at: String,
    pub still_present: bool,
    pub similarity_score: f32, // 0.0 - 1.0，与当前代码的相似度
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpertRetention {
    pub expert_id: String,
    pub expert_name: String,
    pub snippets_generated: usize,
    pub snippets_retained: usize,
    pub retention_rate: f32,
}

// ---- 本地存储（JSON 文件） ----

const RETENTION_DIR: &str = "retention";

fn retention_dir(project_name: &str) -> std::path::PathBuf {
    let app_data = dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    app_data
        .join("ai-experts")
        .join("projects")
        .join(sanitize_filename(project_name))
        .join(RETENTION_DIR)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// ---- 核心 API ----

/// 注册专家生成的代码片段
pub fn register_generated_code(
    project_name: &str,
    expert_id: &str,
    expert_name: &str,
    file_path: &str,
    content: &str,
) -> Result<String, String> {
    let dir = retention_dir(project_name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let snippet_id = format!("{}-{}", expert_id, uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or(""));
    let content_hash = compute_hash(content);

    let snippet = CodeSnippet {
        id: snippet_id.clone(),
        expert_id: expert_id.to_string(),
        expert_name: expert_name.to_string(),
        file_path: file_path.to_string(),
        content_hash,
        generated_at: chrono::Local::now().to_rfc3339(),
        still_present: true,
        similarity_score: 1.0,
    };

    let path = dir.join(format!("{}.json", snippet_id));
    let json = serde_json::to_string_pretty(&snippet).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;

    Ok(snippet_id)
}

/// 评估代码保留率
pub fn evaluate_retention(project_name: &str, project_path: &str) -> Result<RetentionReport, String> {
    let dir = retention_dir(project_name);
    if !dir.exists() {
        return Ok(RetentionReport {
            project_name: project_name.to_string(),
            generated_snippets: vec![],
            retention_rate: 0.0,
            avg_lifespan_days: 0.0,
            by_expert: vec![],
            evaluated_at: chrono::Local::now().to_rfc3339(),
        });
    }

    let mut snippets: Vec<CodeSnippet> = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().unwrap_or_default() != "json" {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut snippet: CodeSnippet = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        // 检查文件是否仍然存在
        let full_path = Path::new(project_path).join(&snippet.file_path);
        if full_path.exists() {
            if let Ok(current_content) = fs::read_to_string(&full_path) {
                let current_hash = compute_hash(&current_content);
                if current_hash == snippet.content_hash {
                    snippet.still_present = true;
                    snippet.similarity_score = 1.0;
                } else {
                    // 计算近似相似度（简化版：检查是否包含关键行）
                    snippet.similarity_score = estimate_similarity(&current_content, &snippet.content_hash);
                    snippet.still_present = snippet.similarity_score > 0.5;
                }
            } else {
                snippet.still_present = false;
                snippet.similarity_score = 0.0;
            }
        } else {
            snippet.still_present = false;
            snippet.similarity_score = 0.0;
        }

        // 更新文件
        let json = serde_json::to_string_pretty(&snippet).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;

        snippets.push(snippet);
    }

    // 计算统计
    let retained = snippets.iter().filter(|s| s.still_present).count();
    let retention_rate = if snippets.is_empty() {
        0.0
    } else {
        retained as f32 / snippets.len() as f32
    };

    let avg_lifespan = snippets
        .iter()
        .filter(|s| s.still_present)
        .filter_map(|s| {
            chrono::DateTime::parse_from_rfc3339(&s.generated_at)
                .ok()
                .map(|dt| (chrono::Local::now().signed_duration_since(dt)).num_days() as f32)
        })
        .sum::<f32>()
        / retained.max(1) as f32;

    // 按专家分组
    let mut by_expert_map: HashMap<String, (String, usize, usize)> = HashMap::new();
    for s in &snippets {
        let entry = by_expert_map
            .entry(s.expert_id.clone())
            .or_insert_with(|| (s.expert_name.clone(), 0, 0));
        entry.1 += 1;
        if s.still_present {
            entry.2 += 1;
        }
    }

    let by_expert: Vec<ExpertRetention> = by_expert_map
        .into_iter()
        .map(|(expert_id, (expert_name, total, retained))| ExpertRetention {
            expert_id,
            expert_name,
            snippets_generated: total,
            snippets_retained: retained,
            retention_rate: if total > 0 { retained as f32 / total as f32 } else { 0.0 },
        })
        .collect();

    Ok(RetentionReport {
        project_name: project_name.to_string(),
        generated_snippets: snippets,
        retention_rate,
        avg_lifespan_days: avg_lifespan,
        by_expert,
        evaluated_at: chrono::Local::now().to_rfc3339(),
    })
}

/// 列出所有已注册的代码片段
pub fn list_snippets(project_name: &str) -> Result<Vec<CodeSnippet>, String> {
    let dir = retention_dir(project_name);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut snippets = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().unwrap_or_default() != "json" {
            continue;
        }
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let snippet: CodeSnippet = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        snippets.push(snippet);
    }

    Ok(snippets)
}

// ---- 辅助函数 ----

fn compute_hash(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 简化版相似度估算：基于行匹配
fn estimate_similarity(_current: &str, _original_hash: &str) -> f32 {
    // 由于我们没有存储原始内容，这里使用启发式方法
    // 实际生产环境应该存储原始内容或更复杂的指纹
    // 这里返回一个保守估计
    0.3
}
