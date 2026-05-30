// ========== 交付清单生成系统 ==========
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

// ---- 数据结构 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deliverable {
    pub task_id: String,
    pub created_at: String,
    pub summary: String,
    pub code_changes: Vec<CodeChange>,
    pub review_findings: Vec<ReviewFinding>,
    pub test_suggestions: Vec<String>,
    pub expert_contributions: Vec<ExpertContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeChange {
    pub file_path: String,
    pub change_type: String, // "create" | "modify" | "delete"
    pub expert_id: String,
    pub expert_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewFinding {
    pub severity: String, // "critical" | "warning" | "info"
    pub file_path: String,
    pub line_number: Option<usize>,
    pub issue: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpertContribution {
    pub expert_id: String,
    pub expert_name: String,
    pub status: String,
    pub tokens_used: u64,
    pub response_time_ms: u64,
}

// ---- 交付清单生成 ----

/// 从专家任务输出解析交付清单
pub fn generate_deliverable(
    task_id: &str,
    task_description: &str,
    expert_outputs: &[(String, String, String, String)], // (expert_id, expert_name, status, output)
) -> Deliverable {
    let mut code_changes: Vec<CodeChange> = Vec::new();
    let mut review_findings: Vec<ReviewFinding> = Vec::new();
    let mut test_suggestions: Vec<String> = Vec::new();
    let mut expert_contributions: Vec<ExpertContribution> = Vec::new();

    for (expert_id, expert_name, status, output) in expert_outputs {
        // 1. 解析代码变更（ACTION 标记）
        let changes = parse_code_actions(output, expert_id, expert_name);
        code_changes.extend(changes);

        // 2. 解析审查意见
        if expert_id.contains("yingqiu") || expert_name.contains("审查") {
            let findings = parse_review_findings(output);
            review_findings.extend(findings);
        }

        // 3. 解析测试建议
        let tests = parse_test_suggestions(output);
        test_suggestions.extend(tests);

        // 4. 记录专家贡献
        expert_contributions.push(ExpertContribution {
            expert_id: expert_id.clone(),
            expert_name: expert_name.clone(),
            status: status.clone(),
            tokens_used: 0, // 由调用方填充
            response_time_ms: 0,
        });
    }

    // 去重代码变更
    let mut seen_changes: HashSet<String> = HashSet::new();
    code_changes.retain(|c| {
        let key = format!("{}:{}", c.file_path, c.change_type);
        seen_changes.insert(key)
    });

    // 生成摘要
    let summary = generate_summary_text(task_description, &code_changes, &review_findings, &test_suggestions);

    Deliverable {
        task_id: task_id.to_string(),
        created_at: current_timestamp(),
        summary,
        code_changes,
        review_findings,
        test_suggestions,
        expert_contributions,
    }
}

// ---- 解析函数 ----

/// 解析输出中的 ACTION 标记，提取代码变更
fn parse_code_actions(output: &str, expert_id: &str, expert_name: &str) -> Vec<CodeChange> {
    let mut changes = Vec::new();

    // 匹配 [ACTION:CREATE_FILE:路径]
    for line in output.lines() {
        let trimmed = line.trim();

        if let Some(path) = extract_action_path(trimmed, "CREATE_FILE") {
            changes.push(CodeChange {
                file_path: path,
                change_type: "create".to_string(),
                expert_id: expert_id.to_string(),
                expert_name: expert_name.to_string(),
            });
        } else if let Some(path) = extract_action_path(trimmed, "WRITE_FILE") {
            changes.push(CodeChange {
                file_path: path,
                change_type: "modify".to_string(),
                expert_id: expert_id.to_string(),
                expert_name: expert_name.to_string(),
            });
        } else if let Some(path) = extract_action_path(trimmed, "CREATE_FOLDER") {
            changes.push(CodeChange {
                file_path: path,
                change_type: "create_folder".to_string(),
                expert_id: expert_id.to_string(),
                expert_name: expert_name.to_string(),
            });
        } else if let Some(path) = extract_action_path(trimmed, "DELETE") {
            changes.push(CodeChange {
                file_path: path,
                change_type: "delete".to_string(),
                expert_id: expert_id.to_string(),
                expert_name: expert_name.to_string(),
            });
        }
    }

    changes
}

fn extract_action_path(line: &str, action: &str) -> Option<String> {
    let prefix = format!("[ACTION:{}:", action);
    if let Some(start) = line.find(&prefix) {
        let rest = &line[start + prefix.len()..];
        if let Some(end) = rest.find(']') {
            return Some(rest[..end].trim().to_string());
        }
    }
    None
}

/// 解析审查员的输出，提取审查意见
fn parse_review_findings(output: &str) -> Vec<ReviewFinding> {
    let mut findings = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();

        // 匹配格式：- [严重程度] [文件:行号] 问题描述 → 修改建议
        if trimmed.starts_with("-") || trimmed.starts_with("*") {
            let content = trimmed.trim_start_matches("-").trim_start_matches("*").trim();

            // 尝试提取严重程度
            let severity = if content.contains("[严重]") || content.contains("critical") || content.contains("不通过") {
                "critical"
            } else if content.contains("[警告]") || content.contains("warning") || content.contains("有条件通过") {
                "warning"
            } else {
                "info"
            };

            // 尝试提取文件路径
            let file_path = extract_file_path(content).unwrap_or_default();

            // 尝试提取行号
            let line_number = extract_line_number(content);

            // 提取问题和建议
            let (issue, suggestion) = if let Some(pos) = content.find("→") {
                (content[..pos].trim().to_string(), content[pos + 3..].trim().to_string())
            } else if let Some(pos) = content.find("->") {
                (content[..pos].trim().to_string(), content[pos + 2..].trim().to_string())
            } else {
                (content.to_string(), String::new())
            };

            if !issue.is_empty() {
                findings.push(ReviewFinding {
                    severity: severity.to_string(),
                    file_path,
                    line_number,
                    issue,
                    suggestion,
                });
            }
        }
    }

    findings
}

fn extract_file_path(text: &str) -> Option<String> {
    // 匹配 `path/to/file.ext` 或 [文件:path]
    if let Some(start) = text.find('`') {
        if let Some(end) = text[start + 1..].find('`') {
            let path = &text[start + 1..start + 1 + end];
            if path.contains('.') || path.contains('/') {
                return Some(path.to_string());
            }
        }
    }

    // 匹配 [文件:xxx] 格式
    if let Some(start) = text.find("[文件:") {
        let rest = &text[start + 4..];
        if let Some(end) = rest.find(']') {
            return Some(rest[..end].trim().to_string());
        }
    }

    None
}

fn extract_line_number(text: &str) -> Option<usize> {
    // 匹配 :123 或 L123 或 第123行
    let patterns = [
        (":", ":"),
        ("L", "L"),
        ("第", "行"),
    ];

    for (start_pat, _end_pat) in &patterns {
        if let Some(start) = text.find(start_pat) {
            let rest = &text[start + start_pat.len()..];
            let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(num) = num_str.parse::<usize>() {
                if num > 0 {
                    return Some(num);
                }
            }
        }
    }

    None
}

/// 解析测试建议
fn parse_test_suggestions(output: &str) -> Vec<String> {
    let mut suggestions = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();

        // 匹配测试相关建议
        if trimmed.to_lowercase().contains("test")
            || trimmed.to_lowercase().contains("测试")
            || trimmed.to_lowercase().contains("assert")
            || trimmed.to_lowercase().contains("验证")
        {
            if trimmed.starts_with("-") || trimmed.starts_with("*") || trimmed.starts_with("1.") || trimmed.starts_with("2.") {
                let content = trimmed.trim_start_matches("-").trim_start_matches("*").trim();
                if content.len() > 10 && content.len() < 300 {
                    suggestions.push(content.to_string());
                }
            }
        }
    }

    // 去重
    let mut seen = HashSet::new();
    suggestions.retain(|s| seen.insert(s.clone()));
    suggestions.truncate(10);

    suggestions
}

// ---- 摘要生成 ----

fn generate_summary_text(
    task_description: &str,
    code_changes: &[CodeChange],
    review_findings: &[ReviewFinding],
    test_suggestions: &[String],
) -> String {
    let mut parts = Vec::new();

    parts.push(format!("任务：{}", task_description));

    if !code_changes.is_empty() {
        let create_count = code_changes.iter().filter(|c| c.change_type == "create").count();
        let modify_count = code_changes.iter().filter(|c| c.change_type == "modify").count();
        let delete_count = code_changes.iter().filter(|c| c.change_type == "delete").count();
        parts.push(format!(
            "代码变更：创建 {} 个文件，修改 {} 个文件，删除 {} 个文件",
            create_count, modify_count, delete_count
        ));
    }

    if !review_findings.is_empty() {
        let critical = review_findings.iter().filter(|f| f.severity == "critical").count();
        let warning = review_findings.iter().filter(|f| f.severity == "warning").count();
        let info = review_findings.iter().filter(|f| f.severity == "info").count();
        parts.push(format!(
            "审查意见：严重 {} 条，警告 {} 条，建议 {} 条",
            critical, warning, info
        ));
    }

    if !test_suggestions.is_empty() {
        parts.push(format!("测试建议：{} 条", test_suggestions.len()));
    }

    parts.join("\n")
}

// ---- 持久化 ----

/// 保存交付清单到 .xt/deliverables/
pub fn save_deliverable(project_dir: &Path, deliverable: &Deliverable) -> Result<(), String> {
    let dir = project_dir.join(".xt").join("deliverables");
    fs::create_dir_all(&dir).map_err(|e| format!("创建交付清单目录失败: {}", e))?;

    let file_path = dir.join(format!("{}.json", deliverable.task_id));
    let json = serde_json::to_string_pretty(deliverable)
        .map_err(|e| format!("序列化交付清单失败: {}", e))?;
    fs::write(&file_path, json).map_err(|e| format!("写入交付清单失败: {}", e))?;

    Ok(())
}

/// 加载交付清单
pub fn load_deliverable(project_dir: &Path, task_id: &str) -> Result<Option<Deliverable>, String> {
    let file_path = project_dir.join(".xt").join("deliverables").join(format!("{}.json", task_id));
    if !file_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("读取交付清单失败: {}", e))?;
    let deliverable: Deliverable = serde_json::from_str(&content)
        .map_err(|e| format!("解析交付清单失败: {}", e))?;

    Ok(Some(deliverable))
}

/// 列出所有交付清单
pub fn list_deliverables(project_dir: &Path) -> Result<Vec<Deliverable>, String> {
    let dir = project_dir.join(".xt").join("deliverables");
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut deliverables = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取交付清单目录失败: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(d) = serde_json::from_str::<Deliverable>(&content) {
                    deliverables.push(d);
                }
            }
        }
    }

    // 按创建时间降序
    deliverables.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(deliverables)
}

// ---- 辅助函数 ----

fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    secs.to_string()
}
