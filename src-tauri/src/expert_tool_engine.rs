use crate::expert_identity::supports_source_reading_rewrite;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExpertToolRequest {
    #[serde(rename_all = "camelCase")]
    WebSearch { query: String, reason: String },
    #[serde(rename_all = "camelCase")]
    Command {
        command: String,
        reason: String,
        working_dir: String,
    },
    #[serde(rename_all = "camelCase")]
    FileRead {
        path: String,
        reason: String,
        start_line: Option<usize>,
        end_line: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    FileList {
        path: String,
        reason: String,
        recursive: bool,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequestPlan {
    pub requests: Vec<ExpertToolRequest>,
    pub stripped_reply: String,
}

fn decode_action_param_value(value: &str) -> String {
    value
        .replace("'\\''", "'")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\r", "\r")
        .replace("\\n", "\n")
}

fn parse_action_params(params_str: &str) -> std::collections::HashMap<String, String> {
    let mut params = std::collections::HashMap::new();
    let mut cursor = 0;
    let chars: Vec<char> = params_str.chars().collect();
    while cursor < chars.len() {
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        if cursor >= chars.len() {
            break;
        }
        let rest: String = chars[cursor..].iter().collect();
        let Some(caps) = Regex::new(r"^(\w+)=").expect("param regex").captures(&rest) else {
            break;
        };
        let key = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        cursor += key.len() + 1;
        if cursor >= chars.len() {
            break;
        }
        let quote = chars[cursor];
        if quote != '"' && quote != '\'' {
            break;
        }
        cursor += 1;
        let mut value = String::new();
        while cursor < chars.len() {
            let ch = chars[cursor];
            if ch == '\\' && cursor + 1 < chars.len() {
                value.push(ch);
                value.push(chars[cursor + 1]);
                cursor += 2;
                continue;
            }
            if ch == quote {
                cursor += 1;
                break;
            }
            value.push(ch);
            cursor += 1;
        }
        params.insert(key, decode_action_param_value(&value));
    }
    params
}

fn parse_optional_positive_int(value: Option<&str>) -> Option<usize> {
    value
        .unwrap_or("")
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
}

fn is_absolute_path(path: &str) -> bool {
    Regex::new(r"^[A-Za-z]:[\\/]")
        .expect("absolute path regex")
        .is_match(path)
        || path.starts_with("\\\\")
        || path.starts_with('/')
}

fn normalize_tool_path(path: Option<&str>, workspace_root: Option<&Path>) -> String {
    let trimmed = path.unwrap_or("").trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let decoded = decode_action_param_value(trimmed);
    if workspace_root.is_none() || !is_absolute_path(&decoded) {
        return decoded;
    }
    let absolute = PathBuf::from(&decoded);
    if let Ok(stripped) = absolute.strip_prefix(workspace_root.unwrap()) {
        return stripped.to_string_lossy().replace('\\', "/");
    }
    decoded
}

fn is_project_root_alias(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "项目根目录"
            | "项目根"
            | "根目录"
            | "当前项目"
            | "当前项目目录"
            | "当前工作区"
            | "当前工作目录"
            | "工作区根目录"
            | "workspace"
            | "workspace root"
            | "project"
            | "project root"
            | "root"
    )
}

fn resolve_working_dir(raw_dir: Option<&str>, workspace_root: Option<&Path>) -> String {
    let base_dir = workspace_root
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| ".".to_string());
    let trimmed = raw_dir.unwrap_or("").trim();
    if trimmed.is_empty() || trimmed == "." {
        return base_dir;
    }
    if is_project_root_alias(trimmed) {
        return base_dir;
    }
    if trimmed.starts_with("./") {
        return format!(
            "{}/{}",
            base_dir.trim_end_matches('/'),
            trimmed.trim_start_matches("./")
        );
    }
    trimmed.to_string()
}

fn extract_pattern_candidates(command: &str) -> Vec<String> {
    let raw_pattern = Regex::new(r#"\b-Pattern\s+['"]([^'"]+)['"]"#)
        .expect("pattern regex")
        .captures(command)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .or_else(|| {
            Regex::new(r#"\brg\b(?:\s+-[^\s]+\b|\s+--[^\s]+\b|\s+)+['"]([^'"]+)['"]"#)
                .expect("rg pattern regex")
                .captures(command)
                .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        })
        .unwrap_or_default();
    if raw_pattern.is_empty() {
        return vec![];
    }
    raw_pattern
        .replace("\\\"", "\"")
        .replace("\\'", "'")
        .split('|')
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .filter(|part| {
            !Regex::new(r"[()[\]{}^$*+?]")
                .expect("meta regex")
                .is_match(part)
        })
        .collect()
}

fn parse_line_window_from_command(command: &str, content: &str) -> Option<(usize, usize)> {
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();
    if let Some(caps) = Regex::new(r"\b-TotalCount\s+(\d+)")
        .expect("total regex")
        .captures(command)
    {
        let count = caps.get(1)?.as_str().parse::<usize>().ok()?;
        return Some((1, count.min(total_lines)));
    }
    if let Some(caps) = Regex::new(r"\|\s*Select-Object\s+-Last\s+(\d+)")
        .expect("last regex")
        .captures(command)
    {
        let count = caps.get(1)?.as_str().parse::<usize>().ok()?;
        return Some((
            total_lines.saturating_sub(count).saturating_add(1).max(1),
            total_lines,
        ));
    }
    let candidates = extract_pattern_candidates(command);
    if candidates.is_empty() {
        return None;
    }
    let found_index = candidates.iter().find_map(|candidate| {
        let lowered = candidate.to_lowercase();
        lines
            .iter()
            .position(|line| line.to_lowercase().contains(&lowered))
    })?;
    let (before, after) = if let Some(caps) = Regex::new(r"\b-Context\s+(\d+)\s*,\s*(\d+)")
        .expect("context regex")
        .captures(command)
    {
        (
            caps.get(1)
                .and_then(|m| m.as_str().parse::<usize>().ok())
                .unwrap_or(0),
            caps.get(2)
                .and_then(|m| m.as_str().parse::<usize>().ok())
                .unwrap_or(0),
        )
    } else {
        (6, 28)
    };
    Some((
        (found_index + 1).saturating_sub(before).max(1),
        (found_index + 1 + after).min(total_lines),
    ))
}

fn extract_readable_file_path_from_command(
    command: &str,
    workspace_root: Option<&Path>,
) -> Option<String> {
    let patterns = [
        r#"\btype\s+['"]?([^'"\s|]+?\.(?:js|jsx|ts|tsx|css|html|md|json|yml|yaml|toml|txt))['"]?"#,
        r#"\bGet-Content\b[\s\S]*?-Path\s+['"]?([^'"\s|]+?\.(?:js|jsx|ts|tsx|css|html|md|json|yml|yaml|toml|txt))['"]?"#,
        r#"\bGet-Content\s+['"]?([^'"\s|]+?\.(?:js|jsx|ts|tsx|css|html|md|json|yml|yaml|toml|txt))['"]?"#,
        r#"\bSelect-String\b[\s\S]*?-Path\s+['"]?([^'"\s|]+?\.(?:js|jsx|ts|tsx|css|html|md|json|yml|yaml|toml|txt))['"]?"#,
        r#"\bSelect-String\b[\s\S]*?\s([.\\\/A-Za-z0-9_\-]+?\.(?:js|jsx|ts|tsx|css|html|md|json|yml|yaml|toml|txt))\b"#,
        r#"\brg\b[\s\S]*?\s['"]?([^'"\s|]+?\.(?:js|jsx|ts|tsx|css|html|md|json|yml|yaml|toml|txt))['"]?"#,
    ];
    for pattern in patterns {
        if let Some(caps) = Regex::new(pattern)
            .expect("read path regex")
            .captures(command)
        {
            let candidate = normalize_tool_path(caps.get(1).map(|m| m.as_str()), workspace_root);
            if !candidate.is_empty() {
                return Some(candidate);
            }
        }
    }
    None
}

fn strip_inline_tool_actions(text: &str) -> String {
    Regex::new(r#"\[ACTION:(?:WEB_SEARCH|EXECUTE_CMD|READ_FILE|LIST_FILES)(?:[:][^\]]+|(?:\s+\w+="[^"]*")*)\]"#)
        .expect("strip tool action regex")
        .replace_all(text, "")
        .to_string()
        .replace("\r\n\r\n\r\n", "\r\n\r\n")
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_string()
}

pub fn extract_tool_requests(text: &str, workspace_root: Option<&Path>) -> Vec<ExpertToolRequest> {
    let mut requests = Vec::new();
    let action_regex = Regex::new(r#"\[ACTION:(WEB_SEARCH|EXECUTE_CMD)((?:\s+\w+="[^"]*")*)\]"#)
        .expect("tool action regex");
    for caps in action_regex.captures_iter(text) {
        let action_type = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let params = parse_action_params(caps.get(2).map(|m| m.as_str()).unwrap_or_default());
        if action_type == "WEB_SEARCH" {
            let query = params.get("query").map(|value| value.trim()).unwrap_or("");
            if !query.is_empty() {
                requests.push(ExpertToolRequest::WebSearch {
                    query: query.to_string(),
                    reason: params
                        .get("reason")
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "需要外部资料或最新信息支撑当前结论".to_string()),
                });
            }
            continue;
        }
        let command = params
            .get("command")
            .map(|value| value.trim())
            .unwrap_or("");
        if !command.is_empty() {
            requests.push(ExpertToolRequest::Command {
                command: command.to_string(),
                reason: params
                    .get("reason")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "需要通过本地命令核实环境或验证当前结论".to_string()),
                working_dir: resolve_working_dir(
                    params.get("dir").map(|s| s.as_str()),
                    workspace_root,
                ),
            });
        }
    }

    let read_legacy_regex =
        Regex::new(r"\[ACTION:READ_FILE:([^\]]+)\]").expect("read legacy regex");
    for caps in read_legacy_regex.captures_iter(text) {
        let path = normalize_tool_path(caps.get(1).map(|m| m.as_str()), workspace_root);
        if !path.is_empty() {
            requests.push(ExpertToolRequest::FileRead {
                path,
                reason: "需要基于真实文件内容继续分析或生成增量修改".to_string(),
                start_line: None,
                end_line: None,
            });
        }
    }

    let read_param_regex =
        Regex::new(r#"\[ACTION:READ_FILE((?:\s+\w+="[^"]*")*)\]"#).expect("read param regex");
    for caps in read_param_regex.captures_iter(text) {
        let params = parse_action_params(caps.get(1).map(|m| m.as_str()).unwrap_or_default());
        let path = normalize_tool_path(params.get("path").map(|s| s.as_str()), workspace_root);
        if !path.is_empty() {
            requests.push(ExpertToolRequest::FileRead {
                path,
                reason: params
                    .get("reason")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "需要基于真实文件内容继续分析或生成增量修改".to_string()),
                start_line: parse_optional_positive_int(
                    params
                        .get("start_line")
                        .or_else(|| params.get("startLine"))
                        .map(|s| s.as_str()),
                ),
                end_line: parse_optional_positive_int(
                    params
                        .get("end_line")
                        .or_else(|| params.get("endLine"))
                        .map(|s| s.as_str()),
                ),
            });
        }
    }

    let list_legacy_regex =
        Regex::new(r"\[ACTION:LIST_FILES:([^\]]+)\]").expect("list legacy regex");
    for caps in list_legacy_regex.captures_iter(text) {
        let path = normalize_tool_path(caps.get(1).map(|m| m.as_str()), workspace_root);
        requests.push(ExpertToolRequest::FileList {
            path: if path.is_empty() {
                ".".to_string()
            } else {
                path
            },
            reason: "需要先确认目录结构和候选文件位置".to_string(),
            recursive: true,
        });
    }

    let list_param_regex =
        Regex::new(r#"\[ACTION:LIST_FILES((?:\s+\w+="[^"]*")*)\]"#).expect("list param regex");
    for caps in list_param_regex.captures_iter(text) {
        let params = parse_action_params(caps.get(1).map(|m| m.as_str()).unwrap_or_default());
        let path = normalize_tool_path(params.get("path").map(|s| s.as_str()), workspace_root);
        requests.push(ExpertToolRequest::FileList {
            path: if path.is_empty() { ".".to_string() } else { path },
            reason: params
                .get("reason")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "需要先确认目录结构和候选文件位置".to_string()),
            recursive: matches!(params.get("recursive").map(|v| v.trim().to_lowercase()), Some(value) if value == "1" || value == "true" || value == "yes"),
        });
    }

    requests
}

pub fn rewrite_command_requests_for_source_reading(
    requests: &[ExpertToolRequest],
    expert_id: Option<&str>,
    expert_title: &str,
    workspace_root: Option<&Path>,
) -> Vec<ExpertToolRequest> {
    let title_supports_rewrite = Regex::new(r"(工程师|调研员|审查|审核|文档|统计)")
        .expect("expert title regex")
        .is_match(expert_title);
    if !expert_id
        .map(supports_source_reading_rewrite)
        .unwrap_or(title_supports_rewrite)
    {
        return requests.to_vec();
    }
    let mut rewritten = Vec::new();
    for request in requests {
        match request {
            ExpertToolRequest::Command {
                command, reason, ..
            } => {
                let Some(path) = extract_readable_file_path_from_command(command, workspace_root)
                else {
                    rewritten.push(request.clone());
                    continue;
                };
                let content = workspace_root
                    .map(|root| root.join(&path))
                    .filter(|path| path.exists())
                    .and_then(|path| std::fs::read_to_string(path).ok());
                let window = content
                    .as_deref()
                    .and_then(|body| parse_line_window_from_command(command, body));
                rewritten.push(ExpertToolRequest::FileRead {
                    path,
                    reason: format!(
                        "需要基于真实源码内容继续分析，已将源码探测命令改写为 READ_FILE：{}",
                        reason
                    ),
                    start_line: window.map(|item| item.0),
                    end_line: window.map(|item| item.1),
                });
            }
            _ => rewritten.push(request.clone()),
        }
    }
    rewritten
}

pub fn build_tool_request_plan(
    text: &str,
    expert_title: &str,
    workspace_root: Option<&Path>,
) -> ToolRequestPlan {
    build_tool_request_plan_for_expert(text, None, expert_title, workspace_root)
}

pub fn build_tool_request_plan_for_expert(
    text: &str,
    expert_id: Option<&str>,
    expert_title: &str,
    workspace_root: Option<&Path>,
) -> ToolRequestPlan {
    let extracted = extract_tool_requests(text, workspace_root);
    let rewritten = rewrite_command_requests_for_source_reading(
        &extracted,
        expert_id,
        expert_title,
        workspace_root,
    );
    ToolRequestPlan {
        requests: rewritten,
        stripped_reply: strip_inline_tool_actions(text),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_tool_request_plan, ExpertToolRequest};
    use std::fs;

    #[test]
    fn extracts_tool_requests_and_strips_actions() {
        let plan = build_tool_request_plan(
            r#"[ACTION:WEB_SEARCH query="rust tauri" reason="查资料"]
[ACTION:READ_FILE path="app.js"]"#,
            "前端工程师",
            None,
        );
        assert_eq!(plan.requests.len(), 2);
        assert!(plan.stripped_reply.is_empty());
    }

    #[test]
    fn rewrites_source_probe_command_to_file_read() {
        let temp_dir = std::env::temp_dir().join("ai-experts-tool-engine");
        let _ = fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("app.js");
        let _ = fs::write(&file_path, "line1\nfunction renderCalculator() {}\nline3\n");
        let plan = build_tool_request_plan(
            r#"[ACTION:EXECUTE_CMD command="Select-String -Path app.js -Pattern 'renderCalculator' -Context 0,2" reason="定位实现"]"#,
            "前端工程师",
            Some(&temp_dir),
        );
        match &plan.requests[0] {
            ExpertToolRequest::FileRead { path, .. } => assert_eq!(path, "app.js"),
            _ => panic!("expected file-read request"),
        }
    }

    #[test]
    fn review_discipline_can_also_rewrite_source_probe_command() {
        let temp_dir = std::env::temp_dir().join("ai-experts-review-tool-engine");
        let _ = fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("app.js");
        let _ = fs::write(&file_path, "line1\nconst risk = true;\nline3\n");
        let plan = super::build_tool_request_plan_for_expert(
            r#"[ACTION:EXECUTE_CMD command="Get-Content app.js | Select-Object -First 5" reason="审查真实源码"]"#,
            Some("discipline-620"),
            "安全审查专家",
            Some(&temp_dir),
        );
        match &plan.requests[0] {
            ExpertToolRequest::FileRead { path, .. } => assert_eq!(path, "app.js"),
            _ => panic!("expected file-read request"),
        }
    }
}
