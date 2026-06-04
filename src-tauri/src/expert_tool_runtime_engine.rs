use crate::expert_tool_engine::ExpertToolRequest;
use crate::shell_executor::CommandResult;
use crate::web_search::SearchResult;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertToolExecutionRequest {
    pub request: ExpertToolRequest,
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    pub approval_decision: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertToolCommandAuthorization {
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub reason: String,
    pub command: String,
    pub working_dir: String,
    pub auth_mode: String,
    pub safety_reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertToolWebSearchEvent {
    pub kind: String,
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub reason: String,
    pub query: String,
    pub status: String,
    pub results: Option<Vec<SearchResult>>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertToolCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertToolCommandEvent {
    pub kind: String,
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub reason: String,
    pub command: String,
    pub working_dir: String,
    pub auth_mode: String,
    pub status: String,
    pub safety_reason: Option<String>,
    pub output: Option<ExpertToolCommandOutput>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum ExpertToolEventPayload {
    WebSearch(ExpertToolWebSearchEvent),
    Command(ExpertToolCommandEvent),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertToolExecutionResult {
    pub requires_authorization: bool,
    pub tool_context: Option<String>,
    pub event: Option<ExpertToolEventPayload>,
    pub authorization: Option<ExpertToolCommandAuthorization>,
}

pub fn resolve_command_auth_mode(requires_auth: bool, auth_reason: &str) -> String {
    if !requires_auth {
        return "auto".to_string();
    }
    if auth_reason.contains("管理员权限") {
        return "admin".to_string();
    }
    "restricted".to_string()
}

pub fn summarize_tool_text(text: &str, max_chars: usize) -> String {
    if text.is_empty() {
        return "(空)".to_string();
    }
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head_len = ((max_chars as f32) * 0.6).floor() as usize;
    let tail_len = ((max_chars as f32) * 0.25).floor() as usize;
    let head: String = text.chars().take(head_len).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(tail_len)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    let omitted = text.chars().count().saturating_sub(head_len + tail_len);
    format!("{head}\n...\n[输出过长，已截断 {omitted} 个字符]\n...\n{tail}")
}

pub fn truncate_tool_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let head_chars = ((max_chars as f32) * 0.55).floor().max(6000.0) as usize;
    let tail_chars = (max_chars.saturating_sub(head_chars)).max(4000);
    let head: String = text.chars().take(head_chars).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    let omitted = text.chars().count().saturating_sub(head_chars + tail_chars);
    format!(
        "{head}\n\n...(truncated, omitted {omitted} chars, keep using READ_FILE with start_line/end_line for the missing section)...\n\n{tail}"
    )
}

pub fn build_web_search_success(
    request: &ExpertToolExecutionRequest,
    results: Vec<SearchResult>,
) -> ExpertToolExecutionResult {
    let results_json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[网络搜索结果]\n发起理由：{}\n查询：{}\n结果：{}",
            request_reason(&request.request),
            request_query(&request.request),
            results_json
        )),
        event: Some(ExpertToolEventPayload::WebSearch(
            ExpertToolWebSearchEvent {
                kind: "web-search".to_string(),
                expert_id: request.expert_id.clone(),
                expert_name: request.expert_name.clone(),
                expert_title: request.expert_title.clone(),
                reason: request_reason(&request.request).to_string(),
                query: request_query(&request.request).to_string(),
                status: "success".to_string(),
                results: Some(results),
                error: None,
            },
        )),
        authorization: None,
    }
}

pub fn build_web_search_error(
    request: &ExpertToolExecutionRequest,
    error: &str,
) -> ExpertToolExecutionResult {
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[网络搜索失败]\n发起理由：{}\n查询：{}\n错误：{}",
            request_reason(&request.request),
            request_query(&request.request),
            error
        )),
        event: Some(ExpertToolEventPayload::WebSearch(
            ExpertToolWebSearchEvent {
                kind: "web-search".to_string(),
                expert_id: request.expert_id.clone(),
                expert_name: request.expert_name.clone(),
                expert_title: request.expert_title.clone(),
                reason: request_reason(&request.request).to_string(),
                query: request_query(&request.request).to_string(),
                status: "error".to_string(),
                results: None,
                error: Some(error.to_string()),
            },
        )),
        authorization: None,
    }
}

pub fn build_file_read_result(
    request: &ExpertToolExecutionRequest,
    content: &str,
) -> ExpertToolExecutionResult {
    let (path, start_line, end_line): (&str, Option<usize>, Option<usize>) = match &request.request
    {
        ExpertToolRequest::FileRead {
            path,
            start_line,
            end_line,
            ..
        } => (path.as_str(), *start_line, *end_line),
        _ => ("", None, None),
    };
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[文件读取结果]\n发起理由：{}\n文件：{}\n范围：{}-{}\n内容：\n```{}\n```",
            request_reason(&request.request),
            path,
            start_line.unwrap_or(1),
            end_line
                .map(|value| value.to_string())
                .unwrap_or_else(|| "EOF".to_string()),
            truncate_tool_text(content, 20000)
        )),
        event: None,
        authorization: None,
    }
}

pub fn build_file_read_error(
    request: &ExpertToolExecutionRequest,
    error: &str,
) -> ExpertToolExecutionResult {
    let path = match &request.request {
        ExpertToolRequest::FileRead { path, .. } => path.as_str(),
        _ => "",
    };
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[文件读取失败]\n发起理由：{}\n文件：{}\n错误：{}",
            request_reason(&request.request),
            path,
            error
        )),
        event: None,
        authorization: None,
    }
}

pub fn build_file_list_result(
    request: &ExpertToolExecutionRequest,
    listing: &str,
) -> ExpertToolExecutionResult {
    let (path, recursive) = match &request.request {
        ExpertToolRequest::FileList {
            path, recursive, ..
        } => (path.as_str(), *recursive),
        _ => (".", false),
    };
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[目录读取结果]\n发起理由：{}\n目录：{}\n递归：{}\n结果：\n```{}\n```",
            request_reason(&request.request),
            if path.is_empty() { "." } else { path },
            if recursive { "是" } else { "否" },
            truncate_tool_text(listing, 20000)
        )),
        event: None,
        authorization: None,
    }
}

pub fn build_file_list_error(
    request: &ExpertToolExecutionRequest,
    error: &str,
) -> ExpertToolExecutionResult {
    let path = match &request.request {
        ExpertToolRequest::FileList { path, .. } => path.as_str(),
        _ => ".",
    };
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[目录读取失败]\n发起理由：{}\n目录：{}\n错误：{}",
            request_reason(&request.request),
            path,
            error
        )),
        event: None,
        authorization: None,
    }
}

pub fn build_command_authorization(
    request: &ExpertToolExecutionRequest,
    safety: &CommandResult,
    working_dir: &str,
) -> ExpertToolExecutionResult {
    let auth_mode = resolve_command_auth_mode(true, &safety.auth_reason);
    ExpertToolExecutionResult {
        requires_authorization: true,
        tool_context: None,
        event: None,
        authorization: Some(ExpertToolCommandAuthorization {
            expert_id: request.expert_id.clone(),
            expert_name: request.expert_name.clone(),
            expert_title: request.expert_title.clone(),
            reason: request_reason(&request.request).to_string(),
            command: request_command(&request.request).to_string(),
            working_dir: working_dir.to_string(),
            auth_mode,
            safety_reason: safety.auth_reason.clone(),
        }),
    }
}

pub fn build_command_denied(
    request: &ExpertToolExecutionRequest,
    working_dir: &str,
    safety_reason: &str,
) -> ExpertToolExecutionResult {
    let auth_mode = resolve_command_auth_mode(true, safety_reason);
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[命令未执行]\n发起理由：{}\n命令：{}\n工作目录：{}\n状态：用户未授权\n说明：{}",
            request_reason(&request.request),
            request_command(&request.request),
            working_dir,
            if safety_reason.is_empty() {
                "命令需要用户授权"
            } else {
                safety_reason
            }
        )),
        event: Some(ExpertToolEventPayload::Command(ExpertToolCommandEvent {
            kind: "command".to_string(),
            expert_id: request.expert_id.clone(),
            expert_name: request.expert_name.clone(),
            expert_title: request.expert_title.clone(),
            reason: request_reason(&request.request).to_string(),
            command: request_command(&request.request).to_string(),
            working_dir: working_dir.to_string(),
            auth_mode,
            status: "denied".to_string(),
            safety_reason: Some(safety_reason.to_string()),
            output: None,
            error: None,
        })),
        authorization: None,
    }
}

pub fn build_command_success(
    request: &ExpertToolExecutionRequest,
    result: &CommandResult,
    working_dir: &str,
    safety_reason: &str,
) -> ExpertToolExecutionResult {
    let auth_mode = resolve_command_auth_mode(result.requires_auth, safety_reason);
    let summarized_stdout = summarize_tool_text(&result.stdout, 6000);
    let summarized_stderr = summarize_tool_text(&result.stderr, 2500);
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[命令执行结果]\n发起理由：{}\n命令：{}\n工作目录：{}\n退出码：{}\n标准输出：\n{}\n标准错误：\n{}",
            request_reason(&request.request),
            request_command(&request.request),
            working_dir,
            result.exit_code,
            summarized_stdout,
            summarized_stderr
        )),
        event: Some(ExpertToolEventPayload::Command(ExpertToolCommandEvent {
            kind: "command".to_string(),
            expert_id: request.expert_id.clone(),
            expert_name: request.expert_name.clone(),
            expert_title: request.expert_title.clone(),
            reason: request_reason(&request.request).to_string(),
            command: request_command(&request.request).to_string(),
            working_dir: working_dir.to_string(),
            auth_mode,
            status: "success".to_string(),
            safety_reason: if safety_reason.is_empty() {
                None
            } else {
                Some(safety_reason.to_string())
            },
            output: Some(ExpertToolCommandOutput {
                stdout: result.stdout.clone(),
                stderr: result.stderr.clone(),
                exit_code: result.exit_code,
            }),
            error: None,
        })),
        authorization: None,
    }
}

pub fn build_command_error(
    request: &ExpertToolExecutionRequest,
    working_dir: &str,
    error: &str,
) -> ExpertToolExecutionResult {
    ExpertToolExecutionResult {
        requires_authorization: false,
        tool_context: Some(format!(
            "[命令执行失败]\n发起理由：{}\n命令：{}\n工作目录：{}\n错误：{}",
            request_reason(&request.request),
            request_command(&request.request),
            working_dir,
            error
        )),
        event: Some(ExpertToolEventPayload::Command(ExpertToolCommandEvent {
            kind: "command".to_string(),
            expert_id: request.expert_id.clone(),
            expert_name: request.expert_name.clone(),
            expert_title: request.expert_title.clone(),
            reason: request_reason(&request.request).to_string(),
            command: request_command(&request.request).to_string(),
            working_dir: working_dir.to_string(),
            auth_mode: "auto".to_string(),
            status: "error".to_string(),
            safety_reason: None,
            output: None,
            error: Some(error.to_string()),
        })),
        authorization: None,
    }
}

fn request_reason(request: &ExpertToolRequest) -> &str {
    match request {
        ExpertToolRequest::WebSearch { reason, .. }
        | ExpertToolRequest::Command { reason, .. }
        | ExpertToolRequest::FileRead { reason, .. }
        | ExpertToolRequest::FileList { reason, .. } => reason.as_str(),
    }
}

fn request_query(request: &ExpertToolRequest) -> &str {
    match request {
        ExpertToolRequest::WebSearch { query, .. } => query.as_str(),
        _ => "",
    }
}

fn request_command(request: &ExpertToolRequest) -> &str {
    match request {
        ExpertToolRequest::Command { command, .. } => command.as_str(),
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expert_tool_engine::ExpertToolRequest;

    #[test]
    fn command_denied_result_contains_user_visible_context() {
        let request = ExpertToolExecutionRequest {
            request: ExpertToolRequest::Command {
                command: "npm test".to_string(),
                reason: "验证修改结果".to_string(),
                working_dir: ".".to_string(),
            },
            expert_id: "jiang".to_string(),
            expert_name: "江".to_string(),
            expert_title: "工程师".to_string(),
            project_name: None,
            project_path: None,
            approval_decision: Some(false),
        };

        let result = build_command_denied(&request, ".", "命令需要用户授权");
        assert!(!result.requires_authorization);
        assert!(result
            .tool_context
            .unwrap_or_default()
            .contains("状态：用户未授权"));
    }

    #[test]
    fn file_read_result_truncates_large_content() {
        let request = ExpertToolExecutionRequest {
            request: ExpertToolRequest::FileRead {
                path: "app.js".to_string(),
                reason: "查看源码".to_string(),
                start_line: Some(1),
                end_line: Some(200),
            },
            expert_id: "jiang".to_string(),
            expert_name: "江".to_string(),
            expert_title: "工程师".to_string(),
            project_name: None,
            project_path: None,
            approval_decision: None,
        };

        let content = "a".repeat(25000);
        let result = build_file_read_result(&request, &content);
        assert!(result
            .tool_context
            .unwrap_or_default()
            .contains("truncated"));
    }
}
