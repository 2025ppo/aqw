// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use dunce;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Pool, Row, Sqlite};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

mod approval_store;
mod blackboard_engine;
mod code_chunker;
mod code_graph;
mod code_retention;
mod collaboration_engine;
mod config;
mod deliverables;
mod doc_processor;
mod experience;
mod expert_context_engine;
mod expert_identity;
mod expert_postprocess_engine;
mod expert_runtime_engine;
mod expert_session_engine;
mod expert_tool_engine;
mod expert_tool_runtime_engine;
mod file_patch;
mod health_score;
mod hooks;
mod llm_provider;
mod llm_stream;
mod memory;
mod perceptual_index;
mod pipeline_engine;
mod pipeline_progress_engine;
mod pipeline_runtime_engine;
mod pipeline_session_engine;
mod pipeline_step_engine;
mod prompt_module_engine;
mod rbac;
mod repo_wiki;
mod shell_executor;
mod supervisor_engine;
mod tfidf;
mod token_runtime_engine;
mod tool_system;
mod web_search;
mod workflow_engine;

/// 全局数据库连接池（应用级共享）
struct AppState {
    db: Pool<Sqlite>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmReplyEnvelope {
    content: String,
    usage: Option<DeepSeekUsage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorAnalyzeResponse {
    plan: supervisor_engine::SupervisorDispatchPlan,
    usage: Option<DeepSeekUsage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorReviewResponse {
    reply: String,
    usage: Option<DeepSeekUsage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorQuickAnswerResponse {
    reply: String,
    usage: Option<DeepSeekUsage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorRuntimeAnalyzeResponse {
    plan: supervisor_engine::SupervisorDispatchPlan,
    blocked_reason: Option<String>,
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorRuntimeReviewResponse {
    reply: String,
    blocked_reason: Option<String>,
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorRuntimeQuickAnswerResponse {
    reply: String,
    blocked_reason: Option<String>,
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineDeliveryFinalizeResponse {
    reply: String,
    blocked_reason: Option<String>,
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
    delivery_analysis: workflow_engine::DeliveryAnalysis,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorRuntimeFollowupResponse {
    decision: supervisor_engine::FollowupIntentDecision,
    blocked_reason: Option<String>,
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorTokenRuntimeContext {
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
    allocation: Option<token_runtime_engine::TokenAllocation>,
    key_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExpertTokenRuntimeContext {
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
    key_id: String,
    quota_exempt_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorFollowupResponse {
    decision: supervisor_engine::FollowupIntentDecision,
    usage: Option<DeepSeekUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorMidCheckResponse {
    decision: supervisor_engine::MidCheckDecision,
    usage: Option<DeepSeekUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineRoundSettleEnvelope {
    state: pipeline_session_engine::PipelineSessionState,
    decision: pipeline_step_engine::PipelineStepFinalizeDecision,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PipelineJoiningTask {
    expert_id: String,
    expert_name: String,
    expert_title: String,
    dispatch_wave: usize,
    input: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineLaunchEnvelope {
    pipeline_id: String,
    layout: pipeline_engine::PipelineLayout,
    state: pipeline_session_engine::PipelineSessionState,
    narrative: String,
    joining_tasks: Vec<PipelineJoiningTask>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineExecutionRoundEnvelope {
    plan: pipeline_session_engine::PipelineExecutionRoundPlan,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineFollowupExecutionRoundEnvelope {
    plan: pipeline_session_engine::PipelineFollowupExecutionRoundPlan,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenDashboardEnvelope {
    snapshot: token_runtime_engine::TokenDashboardSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineProgressEnvelope {
    snapshot: pipeline_progress_engine::PipelineProgressSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpertContextEnvelope {
    context: expert_context_engine::ExpertContextResponse,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpertToolPlanEnvelope {
    plan: expert_tool_engine::ToolRequestPlan,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolReminderEnvelope {
    decision: expert_runtime_engine::ToolReminderDecision,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolFollowupEnvelope {
    message: expert_runtime_engine::ToolFollowupMessage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpertToolExecutionEnvelope {
    result: expert_tool_runtime_engine::ExpertToolExecutionResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptPlanEnvelope {
    plan: prompt_module_engine::PromptPlanResponse,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExpertTaskRuntimeState {
    postprocess_state: expert_postprocess_engine::ExpertPostprocessState,
    task_description: String,
    project_id: Option<i64>,
    key_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpertTaskRuntimeEnvelope {
    blocked_reason: Option<String>,
    runtime_state: Option<ExpertTaskRuntimeState>,
    response: Option<expert_postprocess_engine::ExpertPostprocessResponse>,
    project_data: token_runtime_engine::TokenData,
    user_data: token_runtime_engine::TokenData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartExpertTaskRuntimeRequest {
    session_request: expert_session_engine::StartExpertSessionRequest,
    token_context: ExpertTokenRuntimeContext,
    key_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContinueExpertTaskRuntimeRequest {
    runtime_state: ExpertTaskRuntimeState,
    approval_decision: Option<bool>,
    token_context: ExpertTokenRuntimeContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeExpertTaskRequest {
    project_name: Option<String>,
    project_id: Option<i64>,
    expert_id: String,
    expert_name: String,
    scene: String,
    task_description: String,
    reply: String,
    learned_module_ids: Vec<String>,
    trigger_sources: Vec<String>,
    api_key: Option<String>,
    model: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineStepFinalizeEnvelope {
    decision: pipeline_step_engine::PipelineStepFinalizeDecision,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UiChatMessage {
    role: String,
    content: String,
}

fn parse_llm_reply_envelope(raw: &str) -> Result<LlmReplyEnvelope, String> {
    serde_json::from_str(raw).map_err(|e| format!("解析 LLM 响应失败: {}", e))
}

fn supervisor_quota_guard(context: &SupervisorTokenRuntimeContext) -> Option<String> {
    let decision = token_runtime_engine::check_quota(&token_runtime_engine::QuotaCheckRequest {
        expert_id: "jiang-xingtu".to_string(),
        expert_name: "江星图".to_string(),
        allocations: context.allocation.clone().into_iter().collect(),
        records: context.project_data.records.clone(),
        exempt_expert_ids: vec![
            "jiang-xingtu".to_string(),
            "jiang-xinghe".to_string(),
        ],
        now_ms: None,
    });
    if decision.allowed {
        None
    } else {
        decision.reason
    }
}

fn build_current_project_context_text(
    project_name: Option<&str>,
    workspace_path: Option<&str>,
    current_session_label: Option<&str>,
) -> Option<String> {
    let name = project_name?.trim();
    if name.is_empty() {
        return None;
    }
    let workspace = workspace_path
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("未记录工作目录");
    let session_label = current_session_label
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("未命名对话");
    Some(
        [
            "[当前项目上下文]".to_string(),
            format!("- 项目名称：{}", name),
            format!("- 工作目录：{}", workspace),
            format!("- 当前会话：{}", session_label),
            "- 说明：用户当前正在这个项目内发起提问、检索和修改，请不要忽略项目上下文。"
                .to_string(),
        ]
        .join("\n"),
    )
}

fn build_general_memory_context_text(
    project_dir: &Path,
    project_id: Option<i64>,
    query_text: &str,
) -> Option<String> {
    let Some(project_id) = project_id else {
        return None;
    };
    let query = memory::MemoryQuery {
        project_id,
        expert_id: None,
        query_text: query_text.to_string(),
        memory_type: None,
        limit: 3,
    };
    match memory::search_memories(project_dir, &query) {
        Ok(results) if !results.is_empty() => Some(expert_context_engine::format_memory_context(
            &results,
            "相关历史记忆",
        )),
        _ => None,
    }
}

fn build_workspace_preflight_context_text(
    user_message: &str,
    workspace_path: Option<&str>,
) -> Option<String> {
    let path = workspace_path?.trim();
    if path.is_empty() {
        return None;
    }
    match workflow_engine::verify_workspace_delivery(user_message, path) {
        Ok(issues) if !issues.is_empty() => Some(format!(
            "[当前工作区预检]\n{}",
            issues
                .iter()
                .map(|item| format!("- {}", item))
                .collect::<Vec<_>>()
                .join("\n")
        )),
        _ => None,
    }
}

fn summarize_expert_tasks_message(content: &str) -> String {
    let Ok(tasks) = serde_json::from_str::<Vec<serde_json::Value>>(content) else {
        return "专家协作快照：解析失败。".to_string();
    };
    if tasks.is_empty() {
        return "专家协作快照：暂无可用进展。".to_string();
    }
    let lines = tasks
        .iter()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|task| {
            let status = match task.get("status").and_then(|v| v.as_str()) {
                Some("done") => "已完成".to_string(),
                Some("running") => "执行中".to_string(),
                Some("error") => format!(
                    "失败：{}",
                    task.get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未知错误")
                ),
                _ => "等待中".to_string(),
            };
            let detail = task
                .get("output")
                .or_else(|| task.get("error"))
                .or_else(|| task.get("input"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .take(120)
                .collect::<String>();
            let expert_name = task
                .get("expertName")
                .and_then(|v| v.as_str())
                .or_else(|| task.get("expertId").and_then(|v| v.as_str()))
                .unwrap_or("未知专家");
            let expert_title = task
                .get("expertTitle")
                .and_then(|v| v.as_str())
                .unwrap_or("未知角色");
            if detail.is_empty() {
                format!("- {}（{}）：{}", expert_name, expert_title, status)
            } else {
                format!(
                    "- {}（{}）：{}；{}",
                    expert_name, expert_title, status, detail
                )
            }
        })
        .collect::<Vec<_>>();
    format!("专家协作快照：\n{}", lines.join("\n"))
}

fn summarize_tool_event_message(content: &str) -> String {
    let Ok(event) = serde_json::from_str::<serde_json::Value>(content) else {
        return "工具调用记录：解析失败。".to_string();
    };
    let initiator = format!(
        "{}（{}）",
        event
            .get("initiator")
            .and_then(|v| v.get("expertName"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知专家"),
        event
            .get("initiator")
            .and_then(|v| v.get("expertTitle"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知角色")
    );
    let status = match event.get("status").and_then(|v| v.as_str()) {
        Some("success") => "成功",
        Some("denied") => "被拒绝",
        Some("blocked") => "受限",
        _ => "失败",
    };
    if event.get("kind").and_then(|v| v.as_str()) == Some("web-search") {
        return format!(
            "工具调用记录：{} 因“{}”发起网络搜索「{}」，结果：{}。",
            initiator,
            event.get("reason").and_then(|v| v.as_str()).unwrap_or(""),
            event.get("query").and_then(|v| v.as_str()).unwrap_or(""),
            status
        );
    }
    let auth_label = match event.get("authMode").and_then(|v| v.as_str()) {
        Some("admin") => "管理员命令",
        Some("restricted") => "受限命令",
        _ => "命令",
    };
    let exit_code = event
        .get("output")
        .and_then(|v| v.get("exitCode"))
        .and_then(|v| v.as_i64())
        .map(|code| format!("，退出码 {}", code))
        .unwrap_or_default();
    format!(
        "工具调用记录：{} 因“{}”发起{}「{}」，结果：{}{}。",
        initiator,
        event.get("reason").and_then(|v| v.as_str()).unwrap_or(""),
        auth_label,
        event.get("command").and_then(|v| v.as_str()).unwrap_or(""),
        status,
        exit_code
    )
}

fn summarize_command_auth_message(content: &str) -> String {
    let Ok(auth) = serde_json::from_str::<serde_json::Value>(content) else {
        return "命令授权请求：解析失败。".to_string();
    };
    let initiator = format!(
        "{}（{}）",
        auth.get("initiator")
            .and_then(|v| v.get("expertName"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知专家"),
        auth.get("initiator")
            .and_then(|v| v.get("expertTitle"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知角色")
    );
    let status = match auth.get("status").and_then(|v| v.as_str()) {
        Some("approved") => "用户已同意",
        Some("denied") => "用户已拒绝",
        _ => "等待用户处理",
    };
    format!(
        "命令授权请求：{} 请求执行命令「{}」，状态：{}。",
        initiator,
        auth.get("command").and_then(|v| v.as_str()).unwrap_or(""),
        status
    )
}

fn sanitize_chat_messages_for_supervisor(messages: &[UiChatMessage]) -> Vec<DeepSeekMessage> {
    messages
        .iter()
        .filter_map(|message| match message.role.as_str() {
            "user" | "assistant" => Some(DeepSeekMessage {
                role: message.role.clone(),
                content: message.content.clone(),
            }),
            "expert-tasks" => Some(DeepSeekMessage {
                role: "assistant".to_string(),
                content: summarize_expert_tasks_message(&message.content),
            }),
            "tool-event" => Some(DeepSeekMessage {
                role: "assistant".to_string(),
                content: summarize_tool_event_message(&message.content),
            }),
            "command-auth" => Some(DeepSeekMessage {
                role: "assistant".to_string(),
                content: summarize_command_auth_message(&message.content),
            }),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod supervisor_dispatch_prep_tests {
    use super::{build_current_project_context_text, build_workspace_preflight_context_text};

    #[test]
    fn builds_current_project_context_text() {
        let text = build_current_project_context_text(
            Some("新建文件夹二"),
            Some("C:/workspace/demo"),
            Some("对话 3"),
        )
        .expect("should build context");
        assert!(text.contains("项目名称：新建文件夹二"));
        assert!(text.contains("工作目录：C:/workspace/demo"));
        assert!(text.contains("当前会话：对话 3"));
    }

    #[test]
    fn workspace_preflight_returns_none_without_path() {
        let text = build_workspace_preflight_context_text("添加一个函数计算器", None);
        assert!(text.is_none());
    }
}

fn append_supervisor_usage(
    context: &SupervisorTokenRuntimeContext,
    model: &str,
    usage: Option<DeepSeekUsage>,
) -> (
    token_runtime_engine::TokenData,
    token_runtime_engine::TokenData,
) {
    let Some(usage) = usage else {
        return (context.project_data.clone(), context.user_data.clone());
    };
    let result =
        token_runtime_engine::append_token_usage(&token_runtime_engine::AppendTokenUsageRequest {
            project_data: context.project_data.clone(),
            user_data: context.user_data.clone(),
            expert_id: "jiang-xingtu".to_string(),
            expert_name: "江星图".to_string(),
            expert_title: Some("主管".to_string()),
            model: model.to_string(),
            key_id: context.key_id.clone(),
            usage: token_runtime_engine::UsageSummary {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
            },
            timestamp: None,
        });
    (result.project_data, result.user_data)
}

fn check_expert_quota_internal(
    context: &ExpertTokenRuntimeContext,
    expert_id: &str,
    expert_name: &str,
) -> Option<String> {
    let decision = token_runtime_engine::check_quota(&token_runtime_engine::QuotaCheckRequest {
        expert_id: expert_id.to_string(),
        expert_name: expert_name.to_string(),
        allocations: context.project_data.allocations.clone(),
        records: context.project_data.records.clone(),
        exempt_expert_ids: context.quota_exempt_ids.clone(),
        now_ms: None,
    });
    if decision.allowed {
        None
    } else {
        decision.reason
    }
}

fn append_expert_usage(
    context: &ExpertTokenRuntimeContext,
    expert_id: &str,
    expert_name: &str,
    expert_title: Option<&str>,
    model: &str,
    usage: Option<DeepSeekUsage>,
) -> (
    token_runtime_engine::TokenData,
    token_runtime_engine::TokenData,
) {
    let Some(usage) = usage else {
        return (context.project_data.clone(), context.user_data.clone());
    };
    let result =
        token_runtime_engine::append_token_usage(&token_runtime_engine::AppendTokenUsageRequest {
            project_data: context.project_data.clone(),
            user_data: context.user_data.clone(),
            expert_id: expert_id.to_string(),
            expert_name: expert_name.to_string(),
            expert_title: expert_title.map(|value| value.to_string()),
            model: model.to_string(),
            key_id: context.key_id.clone(),
            usage: token_runtime_engine::UsageSummary {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
            },
            timestamp: None,
        });
    (result.project_data, result.user_data)
}

fn workspace_looks_empty_for_direct_creation(project_path: Option<&str>) -> bool {
    let Some(path) = project_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let root = Path::new(path);
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == ".xt" || name == ".git" {
            continue;
        }
        return false;
    }
    true
}

#[tauri::command]
fn verify_workspace_delivery(
    user_task_text: String,
    workspace_path: String,
) -> Result<String, String> {
    let issues = workflow_engine::verify_workspace_delivery(&user_task_text, &workspace_path)?;
    serde_json::to_string(&issues).map_err(|e| e.to_string())
}

#[tauri::command]
fn analyze_agent_delivery(
    sources_json: String,
    user_task_text: String,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let sources: Vec<workflow_engine::WorkflowInputSource> =
        serde_json::from_str(&sources_json).map_err(|e| format!("解析专家输出失败: {}", e))?;
    let analysis = workflow_engine::analyze_agent_delivery(
        &sources,
        &user_task_text,
        workspace_path.as_deref(),
    )?;
    serde_json::to_string(&analysis).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_analyze_dispatch(
    user_message: String,
    conversation_history_json: String,
    available_experts_json: String,
    supervisor_api_key: String,
    model: String,
) -> Result<String, String> {
    let conversation_history: Vec<DeepSeekMessage> =
        serde_json::from_str(&conversation_history_json)
            .map_err(|e| format!("解析主管历史上下文失败: {}", e))?;
    let available_experts: Vec<supervisor_engine::SupervisorExpertInfo> =
        serde_json::from_str(&available_experts_json)
            .map_err(|e| format!("解析可用专家失败: {}", e))?;
    let system_prompt = supervisor_engine::build_supervisor_prompt(&available_experts);

    let mut messages: Vec<DeepSeekMessage> = Vec::new();
    let recent_history = if conversation_history.len() > 5 {
        &conversation_history[conversation_history.len() - 5..]
    } else {
        &conversation_history[..]
    };
    if !recent_history.is_empty() {
        let history_text = recent_history
            .iter()
            .map(|message| {
                let role_label = if message.role == "user" {
                    "用户"
                } else {
                    "助手"
                };
                let snippet: String = message.content.chars().take(300).collect();
                format!("{}：{}", role_label, snippet)
            })
            .collect::<Vec<_>>()
            .join("\n");
        messages.push(DeepSeekMessage {
            role: "user".to_string(),
            content: format!("最近对话上下文：\n{}", history_text),
        });
    }
    messages.push(DeepSeekMessage {
        role: "user".to_string(),
        content: format!(
            "请分析以下需求并输出调度计划（仅输出 JSON，用自然亲切的语言理解用户需求）：\n{}",
            user_message
        ),
    });

    let raw_reply = call_llm(system_prompt, messages, supervisor_api_key, &model).await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;
    let response = SupervisorAnalyzeResponse {
        plan: supervisor_engine::parse_dispatch_plan(&envelope.content, &user_message),
        usage: envelope.usage,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_review_delivery(
    task_description: String,
    expert_results_json: String,
    supervisor_api_key: String,
    model: String,
) -> Result<String, String> {
    let expert_results: Vec<supervisor_engine::SupervisorExpertResult> =
        serde_json::from_str(&expert_results_json)
            .map_err(|e| format!("解析专家结果失败: {}", e))?;
    let raw_reply = call_llm(
        supervisor_engine::build_review_prompt().to_string(),
        vec![DeepSeekMessage {
            role: "user".to_string(),
            content: supervisor_engine::build_review_user_message(
                &task_description,
                &expert_results,
            ),
        }],
        supervisor_api_key,
        &model,
    )
    .await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;
    let response = SupervisorReviewResponse {
        reply: supervisor_engine::enforce_review_fact(&envelope.content, &expert_results),
        usage: envelope.usage,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_quick_answer(
    messages_json: String,
    supervisor_api_key: String,
    model: String,
) -> Result<String, String> {
    let messages: Vec<DeepSeekMessage> = serde_json::from_str(&messages_json)
        .map_err(|e| format!("解析主管快速回复消息失败: {}", e))?;
    let raw_reply = call_llm(
        "你是「江星图」，项目主管。现在用户有一个简单问题，请直接回答。回答要简洁明了；如果问题涉及当前项目、当前目录、当前对话或当前正在处理的内容，必须优先依据提供的项目上下文直接回答，不要假装不知道当前项目。".to_string(),
        messages,
        supervisor_api_key,
        &model,
    )
    .await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;
    let response = SupervisorQuickAnswerResponse {
        reply: envelope.content,
        usage: envelope.usage,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_quick_answer_runtime(
    messages_json: String,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
) -> Result<String, String> {
    let token_context: SupervisorTokenRuntimeContext = serde_json::from_str(&token_context_json)
        .map_err(|e| format!("解析主管 token 上下文失败: {}", e))?;
    if let Some(reason) = supervisor_quota_guard(&token_context) {
        let response = SupervisorRuntimeQuickAnswerResponse {
            reply: format!("主管快速回复被配额阻断：{}", reason),
            blocked_reason: Some(reason),
            project_data: token_context.project_data,
            user_data: token_context.user_data,
        };
        return serde_json::to_string(&response).map_err(|e| e.to_string());
    }
    let raw = supervisor_quick_answer(messages_json, supervisor_api_key, model.clone()).await?;
    let parsed: SupervisorQuickAnswerResponse =
        serde_json::from_str(&raw).map_err(|e| format!("解析主管快速回复失败: {}", e))?;
    let (project_data, user_data) = append_supervisor_usage(&token_context, &model, parsed.usage);
    let response = SupervisorRuntimeQuickAnswerResponse {
        reply: parsed.reply,
        blocked_reason: None,
        project_data,
        user_data,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_prepare_quick_answer_runtime(
    chat_messages_json: String,
    project_name: Option<String>,
    project_path: Option<String>,
    current_session_label: Option<String>,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
) -> Result<String, String> {
    let chat_messages: Vec<UiChatMessage> = serde_json::from_str(&chat_messages_json)
        .map_err(|e| format!("解析主管快速回复消息失败: {}", e))?;
    let mut messages = sanitize_chat_messages_for_supervisor(&chat_messages);
    if let Some(project_context) = build_current_project_context_text(
        project_name.as_deref(),
        project_path.as_deref(),
        current_session_label.as_deref(),
    ) {
        messages.insert(
            0,
            DeepSeekMessage {
                role: "user".to_string(),
                content: project_context,
            },
        );
    }
    supervisor_quick_answer_runtime(
        serde_json::to_string(&messages).map_err(|e| e.to_string())?,
        supervisor_api_key,
        model,
        token_context_json,
    )
    .await
}

#[tauri::command]
async fn supervisor_analyze_followup(
    request_json: String,
    supervisor_api_key: String,
    model: String,
) -> Result<String, String> {
    let request: supervisor_engine::FollowupIntentRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("解析跟进请求失败: {}", e))?;
    let raw_reply = call_llm(
        supervisor_engine::build_followup_prompt(&request),
        vec![DeepSeekMessage {
            role: "user".to_string(),
            content: request.followup_message.clone(),
        }],
        supervisor_api_key,
        &model,
    )
    .await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;
    let response = SupervisorFollowupResponse {
        decision: supervisor_engine::parse_followup_intent(&envelope.content, &request),
        usage: envelope.usage,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_analyze_dispatch_runtime(
    user_message: String,
    conversation_history_json: String,
    available_experts_json: String,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
) -> Result<String, String> {
    let token_context: SupervisorTokenRuntimeContext = serde_json::from_str(&token_context_json)
        .map_err(|e| format!("解析主管 token 上下文失败: {}", e))?;
    if let Some(reason) = supervisor_quota_guard(&token_context) {
        let response = SupervisorRuntimeAnalyzeResponse {
            plan: supervisor_engine::SupervisorDispatchPlan {
                scene: "quick-answer".to_string(),
                task_description: user_message,
                expert_ids: vec![],
                requires_design: Some(false),
                prompt_module_hints: None,
            },
            blocked_reason: Some(reason),
            project_data: token_context.project_data,
            user_data: token_context.user_data,
        };
        return serde_json::to_string(&response).map_err(|e| e.to_string());
    }
    let raw = supervisor_analyze_dispatch(
        user_message,
        conversation_history_json,
        available_experts_json,
        supervisor_api_key,
        model.clone(),
    )
    .await?;
    let parsed: SupervisorAnalyzeResponse =
        serde_json::from_str(&raw).map_err(|e| format!("解析主管调度响应失败: {}", e))?;
    let (project_data, user_data) = append_supervisor_usage(&token_context, &model, parsed.usage);
    let response = SupervisorRuntimeAnalyzeResponse {
        plan: parsed.plan,
        blocked_reason: None,
        project_data,
        user_data,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_prepare_and_analyze_dispatch_runtime(
    user_message: String,
    chat_messages_json: String,
    available_experts_json: String,
    project_name: Option<String>,
    project_path: Option<String>,
    project_id: Option<i64>,
    current_session_label: Option<String>,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let chat_messages: Vec<UiChatMessage> = serde_json::from_str(&chat_messages_json)
        .map_err(|e| format!("解析主管调度会话消息失败: {}", e))?;
    let conversation_history =
        serde_json::to_string(&sanitize_chat_messages_for_supervisor(&chat_messages))
            .map_err(|e| e.to_string())?;
    let project_dir = if project_name
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || project_path
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    {
        Some(resolve_sandbox_project_dir(
            project_name.as_deref().unwrap_or_default(),
            project_path.as_deref(),
            &app_handle,
        )?)
    } else {
        None
    };

    let project_context = build_current_project_context_text(
        project_name.as_deref(),
        project_path.as_deref(),
        current_session_label.as_deref(),
    );
    let search_context = project_dir
        .as_ref()
        .and_then(|dir| perceptual_index::search_formatted(dir, &user_message).ok())
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("[项目相关代码]\n{}", text));
    let memory_context = project_dir
        .as_deref()
        .and_then(|dir| build_general_memory_context_text(dir, project_id, &user_message));
    let preflight_context =
        build_workspace_preflight_context_text(&user_message, project_path.as_deref());

    let enriched_user_message = [
        project_context,
        preflight_context,
        search_context,
        memory_context.filter(|text| !text.trim().is_empty()),
        Some(format!("[用户需求]\n{}", user_message)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");

    supervisor_analyze_dispatch_runtime(
        enriched_user_message,
        conversation_history,
        available_experts_json,
        supervisor_api_key,
        model,
        token_context_json,
    )
    .await
}

#[tauri::command]
async fn supervisor_review_delivery_runtime(
    task_description: String,
    expert_results_json: String,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
) -> Result<String, String> {
    let token_context: SupervisorTokenRuntimeContext = serde_json::from_str(&token_context_json)
        .map_err(|e| format!("解析主管 token 上下文失败: {}", e))?;
    let expert_results: Vec<supervisor_engine::SupervisorExpertResult> =
        serde_json::from_str(&expert_results_json)
            .map_err(|e| format!("解析专家结果失败: {}", e))?;
    if let Some(reason) = supervisor_quota_guard(&token_context) {
        let summary = expert_results
            .iter()
            .map(|r| {
                format!(
                    "{}（{}）：{}",
                    r.expert_name,
                    r.expert_title,
                    r.output
                        .as_deref()
                        .unwrap_or(r.error.as_deref().unwrap_or("无输出"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let response = SupervisorRuntimeReviewResponse {
            reply: format!(
                "专家团已执行完毕，但主管审核被配额阻断：{}\n\n各专家结果：\n{}",
                reason, summary
            ),
            blocked_reason: Some(reason),
            project_data: token_context.project_data,
            user_data: token_context.user_data,
        };
        return serde_json::to_string(&response).map_err(|e| e.to_string());
    }
    let raw = supervisor_review_delivery(
        task_description,
        expert_results_json,
        supervisor_api_key,
        model.clone(),
    )
    .await?;
    let parsed: SupervisorReviewResponse =
        serde_json::from_str(&raw).map_err(|e| format!("解析主管审核响应失败: {}", e))?;
    let (project_data, user_data) = append_supervisor_usage(&token_context, &model, parsed.usage);
    let response = SupervisorRuntimeReviewResponse {
        reply: parsed.reply,
        blocked_reason: None,
        project_data,
        user_data,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn finalize_pipeline_delivery_runtime(
    task_description: String,
    pending_followup_messages: Vec<String>,
    expert_results_json: String,
    action_sources_json: String,
    workspace_path: Option<String>,
    require_real_mutations: bool,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
) -> Result<String, String> {
    let final_task_description = if pending_followup_messages.is_empty() {
        task_description
    } else {
        format!(
            "{}\n\n用户补充要求：{}",
            task_description,
            pending_followup_messages.join("；")
        )
    };

    let review_raw = supervisor_review_delivery_runtime(
        final_task_description.clone(),
        expert_results_json,
        supervisor_api_key,
        model,
        token_context_json,
    )
    .await?;
    let mut review: SupervisorRuntimeReviewResponse = serde_json::from_str(&review_raw)
        .map_err(|e| format!("解析主管审核收尾结果失败: {}", e))?;

    let action_sources: Vec<workflow_engine::WorkflowInputSource> =
        serde_json::from_str(&action_sources_json)
            .map_err(|e| format!("解析交付动作源失败: {}", e))?;
    let delivery_analysis = workflow_engine::analyze_agent_delivery(
        &action_sources,
        &final_task_description,
        workspace_path.as_deref(),
    )?;

    if require_real_mutations && !delivery_analysis.has_executable_mutation {
        review.reply = "未实际修改项目文件，当前前端工作流仍有阻塞，请重试。".to_string();
    }

    let response = PipelineDeliveryFinalizeResponse {
        reply: review.reply,
        blocked_reason: review.blocked_reason,
        project_data: review.project_data,
        user_data: review.user_data,
        delivery_analysis,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_analyze_followup_runtime(
    request_json: String,
    supervisor_api_key: String,
    model: String,
    token_context_json: String,
) -> Result<String, String> {
    let token_context: SupervisorTokenRuntimeContext = serde_json::from_str(&token_context_json)
        .map_err(|e| format!("解析主管 token 上下文失败: {}", e))?;
    let request: supervisor_engine::FollowupIntentRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("解析跟进请求失败: {}", e))?;
    if let Some(reason) = supervisor_quota_guard(&token_context) {
        let response = SupervisorRuntimeFollowupResponse {
            decision: supervisor_engine::FollowupIntentDecision {
                action: "append".to_string(),
                task_description: Some(request.followup_message),
                reply: None,
                target_expert_ids: vec![],
                delivery_mode: "next-relevant".to_string(),
            },
            blocked_reason: Some(reason),
            project_data: token_context.project_data,
            user_data: token_context.user_data,
        };
        return serde_json::to_string(&response).map_err(|e| e.to_string());
    }
    let raw = supervisor_analyze_followup(
        serde_json::to_string(&request).map_err(|e| e.to_string())?,
        supervisor_api_key,
        model.clone(),
    )
    .await?;
    let parsed: SupervisorFollowupResponse =
        serde_json::from_str(&raw).map_err(|e| format!("解析主管跟进响应失败: {}", e))?;
    let (project_data, user_data) = append_supervisor_usage(&token_context, &model, parsed.usage);
    let response = SupervisorRuntimeFollowupResponse {
        decision: parsed.decision,
        blocked_reason: None,
        project_data,
        user_data,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn supervisor_mid_check(
    request_json: String,
    supervisor_api_key: String,
    model: String,
) -> Result<String, String> {
    let request: supervisor_engine::MidCheckRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("解析中途检查请求失败: {}", e))?;
    let raw_reply = call_llm(
        "你是项目主管，负责监督专家团执行。仅输出 JSON，不要其他内容。".to_string(),
        vec![DeepSeekMessage {
            role: "user".to_string(),
            content: supervisor_engine::build_mid_check_prompt(&request),
        }],
        supervisor_api_key,
        &model,
    )
    .await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;
    let response = SupervisorMidCheckResponse {
        decision: supervisor_engine::parse_mid_check_decision(&envelope.content),
        usage: envelope.usage,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn finalize_pipeline_step_without_supervisor(request_json: String) -> Result<String, String> {
    let request: pipeline_step_engine::PipelineStepFinalizeRequest =
        serde_json::from_str(&request_json)
            .map_err(|e| format!("解析流水线步骤收尾请求失败: {}", e))?;
    let response = PipelineStepFinalizeEnvelope {
        decision: pipeline_step_engine::finalize_step_without_supervisor(&request),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn finalize_pipeline_step_with_supervisor(
    request_json: String,
    supervisor_api_key: String,
    model: String,
) -> Result<String, String> {
    let request: pipeline_step_engine::PipelineStepFinalizeRequest =
        serde_json::from_str(&request_json)
            .map_err(|e| format!("解析流水线步骤主管收尾请求失败: {}", e))?;
    let mut decision = pipeline_step_engine::finalize_step_without_supervisor(&request);
    if decision.should_stop || decision.runtime_transition.should_stop {
        let response = PipelineStepFinalizeEnvelope { decision };
        return serde_json::to_string(&response).map_err(|e| e.to_string());
    }

    let blackboard_context = if request.scene == "code-development" {
        blackboard_engine::render_blackboard_context(&decision.blackboard)
    } else {
        String::new()
    };
    let midcheck_request =
        pipeline_step_engine::build_midcheck_request(&request, &blackboard_context);
    let raw_reply = call_llm(
        "你是项目主管，负责监督专家团执行。仅输出 JSON，不要其他内容。".to_string(),
        vec![DeepSeekMessage {
            role: "user".to_string(),
            content: supervisor_engine::build_mid_check_prompt(&midcheck_request),
        }],
        supervisor_api_key,
        &model,
    )
    .await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;
    let midcheck = supervisor_engine::parse_mid_check_decision(&envelope.content);
    let transition = pipeline_runtime_engine::apply_decision(
        &pipeline_runtime_engine::PipelineRuntimeDecisionRequest {
            state: request.runtime_state.clone(),
            action: midcheck.action.clone(),
            current_step_expert_ids: request.step_expert_ids.clone(),
        },
    );
    let blocker_task = transition.breaker_message.clone().map(|message| {
        pipeline_step_engine::PipelineTaskSnapshot {
            expert_id: "pipeline-breaker".to_string(),
            expert_name: "流水线熔断".to_string(),
            expert_title: "协作门禁".to_string(),
            dispatch_wave: Some(request.step_index + 1),
            output: None,
            error: Some(message),
        }
    });

    decision.runtime_transition = transition.clone();
    decision.supervisor_action = Some(midcheck.action);
    decision.supervisor_reason = midcheck.reason;
    decision.blocker_task = blocker_task;
    decision.should_stop = transition.should_stop;

    let response = PipelineStepFinalizeEnvelope { decision };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

fn collect_workspace_snapshot_from_dir(
    project_dir: &Path,
) -> Result<(Vec<String>, Vec<String>), String> {
    fn walk(root: &Path, current: &Path, files: &mut Vec<String>) -> Result<(), String> {
        for entry in fs::read_dir(current).map_err(|e| format!("读取目录失败: {}", e))? {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .map_err(|e| format!("读取目录项元数据失败: {}", e))?;
            if metadata.is_dir() {
                walk(root, &path, files)?;
            } else if metadata.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
            if files.len() >= 4000 {
                break;
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    walk(project_dir, project_dir, &mut files)?;
    files.sort();
    files.dedup();

    let roots = fs::read_dir(project_dir)
        .map_err(|e| format!("读取根目录失败: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            entry
                .path()
                .strip_prefix(project_dir)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .flatten()
        .take(120)
        .collect::<Vec<_>>();

    Ok((files, roots))
}

#[tauri::command]
async fn prepare_pipeline_launch(
    request_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PipelineLaunchRequest {
        plan: pipeline_engine::PipelinePlanInput,
        project_name: Option<String>,
        project_path: Option<String>,
        pending_followups: Option<Vec<collaboration_engine::PipelineFollowup>>,
        max_step_retry: Option<usize>,
        experts: Vec<pipeline_engine::PipelineExpertInfo>,
    }

    let request: PipelineLaunchRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析流水线启动准备请求失败: {}", e))?;
    let layout = pipeline_engine::compute_pipeline_layout(&request.plan);
    let pipeline_id = format!(
        "pipeline-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        uuid::Uuid::new_v4().simple()
    );

    let project_name = request.project_name.unwrap_or_default();
    let project_dir =
        resolve_sandbox_project_dir(&project_name, request.project_path.as_deref(), &app_handle)?;
    let (workspace_files, workspace_roots) = if project_dir.exists() {
        collect_workspace_snapshot_from_dir(&project_dir)?
    } else {
        (vec![], vec![])
    };
    let blackboard = blackboard_engine::new_blackboard(
        &request.plan.task_description,
        workspace_files,
        workspace_roots,
        chrono::Utc::now().timestamp_millis() as u64,
    );
    let response = pipeline_session_engine::bootstrap_pipeline_session(
        &pipeline_session_engine::PipelineSessionBootstrapRequest {
            pipeline_id: pipeline_id.clone(),
            plan: request.plan.clone(),
            layout: layout.clone(),
            blackboard,
            pending_followups: request.pending_followups.unwrap_or_default(),
            max_step_retry: request.max_step_retry,
        },
    );
    let narrative = pipeline_engine::build_dispatch_narrative(&layout, &request.experts);
    let joining_tasks = layout
        .waves
        .iter()
        .flat_map(|wave| {
            wave.expert_ids.iter().map(|expert_id| PipelineJoiningTask {
                expert_id: expert_id.clone(),
                expert_name: request
                    .experts
                    .iter()
                    .find(|expert| expert.id == *expert_id)
                    .map(|expert| expert.name.clone())
                    .unwrap_or_else(|| expert_id.clone()),
                expert_title: request
                    .experts
                    .iter()
                    .find(|expert| expert.id == *expert_id)
                    .map(|expert| expert.title.clone())
                    .unwrap_or_else(|| "未知".to_string()),
                dispatch_wave: wave.wave,
                input: response.state.task_description.clone(),
                status: "pending".to_string(),
            })
        })
        .collect::<Vec<_>>();

    let envelope = PipelineLaunchEnvelope {
        pipeline_id: response.pipeline_id,
        layout: response.layout,
        state: response.state,
        narrative,
        joining_tasks,
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_current_pipeline_execution_round(state_json: String) -> Result<String, String> {
    let state: pipeline_session_engine::PipelineSessionState =
        serde_json::from_str(&state_json).map_err(|e| format!("解析流水线会话失败: {}", e))?;
    let response = PipelineExecutionRoundEnvelope {
        plan: pipeline_session_engine::get_current_execution_round_plan(&state),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_current_pipeline_followup_execution_round(state_json: String) -> Result<String, String> {
    let state: pipeline_session_engine::PipelineSessionState =
        serde_json::from_str(&state_json).map_err(|e| format!("解析流水线会话失败: {}", e))?;
    let response = PipelineFollowupExecutionRoundEnvelope {
        plan: pipeline_session_engine::get_current_followup_execution_round_plan(&state),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn settle_pipeline_execution_round(
    request_json: String,
    supervisor_api_key: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PipelineRoundSettleRequest {
        plan: pipeline_engine::PipelinePlanInput,
        layout: pipeline_engine::PipelineLayout,
        session_state: pipeline_session_engine::PipelineSessionState,
        current_tasks: Vec<pipeline_session_engine::PipelineTaskOutcome>,
        followup_tasks: Vec<pipeline_session_engine::PipelineTaskOutcome>,
        has_workspace_context: bool,
        experts: Vec<pipeline_engine::PipelineExpertInfo>,
    }

    let request: PipelineRoundSettleRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析流水线轮次收尾请求失败: {}", e))?;

    let settled_state = pipeline_session_engine::apply_pipeline_round_outcomes(
        &request.session_state,
        &pipeline_session_engine::PipelineRoundOutcomeBatch {
            current_tasks: request.current_tasks,
            followup_tasks: request.followup_tasks,
        },
    );

    let finalize_request = pipeline_step_engine::build_finalize_request(
        &pipeline_step_engine::PipelineStepRuntimeFinalizeRequest {
            plan: request.plan,
            layout: request.layout,
            session_state: settled_state.clone(),
            has_workspace_context: request.has_workspace_context,
            experts: request.experts,
        },
    );

    let should_use_supervisor = supervisor_api_key
        .as_ref()
        .map(|key| !key.trim().is_empty())
        .unwrap_or(false)
        && finalize_request.step_index < finalize_request.total_steps.saturating_sub(1);

    let decision = if !should_use_supervisor {
        pipeline_step_engine::finalize_step_without_supervisor(&finalize_request)
    } else {
        let response = finalize_pipeline_step_with_supervisor(
            serde_json::to_string(&finalize_request).map_err(|e| e.to_string())?,
            supervisor_api_key.unwrap_or_default(),
            model.unwrap_or_else(|| "deepseek-chat".to_string()),
        )
        .await?;
        let parsed: PipelineStepFinalizeEnvelope = serde_json::from_str(&response)
            .map_err(|e| format!("解析流水线轮次收尾结果失败: {}", e))?;
        parsed.decision
    };

    let next_state = pipeline_session_engine::PipelineSessionState {
        blackboard: decision.blackboard.clone(),
        runtime_state: decision.runtime_transition.state.clone(),
        ..settled_state
    };

    let response = PipelineRoundSettleEnvelope {
        state: next_state,
        decision,
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn build_token_dashboard_snapshot(request_json: String) -> Result<String, String> {
    let request: token_runtime_engine::TokenDashboardRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析词元仪表盘请求失败: {}", e))?;
    let response = TokenDashboardEnvelope {
        snapshot: token_runtime_engine::build_dashboard_snapshot(&request),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn build_pipeline_progress_snapshot(request_json: String) -> Result<String, String> {
    let request: pipeline_progress_engine::PipelineProgressSnapshotRequest =
        serde_json::from_str(&request_json)
            .map_err(|e| format!("解析流水线进度快照请求失败: {}", e))?;
    let response = PipelineProgressEnvelope {
        snapshot: pipeline_progress_engine::build_progress_snapshot(&request),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn build_expert_context(
    request_json: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let request: expert_context_engine::ExpertContextRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析专家上下文请求失败: {}", e))?;
    let context = build_expert_context_internal(&request, &app_handle, &state).await?;
    let response = ExpertContextEnvelope { context };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

async fn build_expert_context_internal(
    request: &expert_context_engine::ExpertContextRequest,
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, Arc<AppState>>,
) -> Result<expert_context_engine::ExpertContextResponse, String> {
    let mut negative_index: Vec<String> = Vec::new();
    let mut cards_context: Option<String> = None;
    let mut vector_context: Option<String> = None;
    let mut expert_memory_context: Option<String> = None;
    let mut shared_memory_context: Option<String> = None;

    if let Some(project_name) = request.project_name.clone() {
        let project_dir = resolve_project_dir(&project_name, app_handle, state).await?;
        match repo_wiki::read_cards(&project_dir) {
            Ok(cards) if !cards.is_empty() => {
                cards_context = Some(expert_context_engine::format_cards_context(&cards));
            }
            Ok(_) => negative_index.push("仓库知识卡片为空，项目结构认知不完整".to_string()),
            Err(_) => negative_index.push("仓库知识检索失败，无法获取项目全局视图".to_string()),
        }

        if request.project_id.is_some() {
            match perceptual_index::search_formatted(&project_dir, &request.task_description) {
                Ok(result) if !result.trim().is_empty() && result != "(未找到相关代码段)" =>
                {
                    vector_context = Some(result);
                }
                Ok(_) => negative_index
                    .push("向量检索未命中相关代码段，可能存在索引覆盖盲区".to_string()),
                Err(_) => negative_index.push("向量检索执行失败".to_string()),
            }
        }

        if let Some(project_id) = request.project_id {
            let expert_query = memory::MemoryQuery {
                project_id,
                expert_id: Some(request.expert_id.clone()),
                query_text: request.task_description.clone(),
                memory_type: None,
                limit: 3,
            };
            match memory::search_memories(&project_dir, &expert_query) {
                Ok(results) if !results.is_empty() => {
                    expert_memory_context = Some(expert_context_engine::format_memory_context(
                        &results,
                        "相关历史记忆",
                    ));
                }
                Ok(_) => {
                    negative_index.push("无相关历史记忆，当前任务缺乏历史经验参照".to_string())
                }
                Err(_) => negative_index.push("记忆检索失败".to_string()),
            }

            let shared_query = memory::MemoryQuery {
                project_id,
                expert_id: None,
                query_text: request.task_description.clone(),
                memory_type: None,
                limit: 3,
            };
            if let Ok(results) = memory::search_memories(&project_dir, &shared_query) {
                if !results.is_empty() {
                    shared_memory_context = Some(expert_context_engine::format_memory_context(
                        &results,
                        "共享项目记忆",
                    ));
                }
            }
        }
    }

    let retrieval_context = expert_context_engine::build_retrieval_context(
        cards_context,
        vector_context,
        expert_memory_context,
        shared_memory_context,
        &negative_index,
    );
    let messages = expert_context_engine::build_initial_messages(
        &request.previous_results,
        &request.task_description,
        &retrieval_context,
    );
    Ok(expert_context_engine::ExpertContextResponse {
        retrieval_context,
        negative_index,
        messages,
    })
}

#[tauri::command]
fn build_expert_tool_plan(
    text: String,
    expert_title: String,
    project_path: Option<String>,
    project_name: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let workspace_root = if let Some(path) = project_path.filter(|value| !value.trim().is_empty()) {
        Some(PathBuf::from(path))
    } else if let Some(project_name) = project_name.filter(|value| !value.trim().is_empty()) {
        Some(get_project_dir(&project_name, &app_handle)?)
    } else {
        None
    };
    let response = ExpertToolPlanEnvelope {
        plan: expert_tool_engine::build_tool_request_plan(&text, &expert_title, workspace_root.as_deref()),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn evaluate_tool_reminder(request_json: String, has_tool_requests: bool) -> Result<String, String> {
    let request: expert_runtime_engine::ToolReminderRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("解析工具提醒请求失败: {}", e))?;
    let response = ToolReminderEnvelope {
        decision: expert_runtime_engine::evaluate_tool_reminder(&request, has_tool_requests),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn build_tool_followup_message(request_json: String) -> Result<String, String> {
    let request: expert_runtime_engine::ToolFollowupMessageRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("解析工具跟进消息失败: {}", e))?;
    let response = ToolFollowupEnvelope {
        message: expert_runtime_engine::build_tool_followup_message(&request),
    };
    serde_json::to_string(&response).map_err(|e| e.to_string())
}

#[tauri::command]
fn resolve_expert_prompt_plan(
    request_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let request: prompt_module_engine::PromptPlanRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析提示词模块计划失败: {}", e))?;
    let plan = resolve_expert_prompt_plan_internal(&request, &app_handle)?;
    serde_json::to_string(&PromptPlanEnvelope { plan }).map_err(|e| e.to_string())
}

fn resolve_expert_prompt_plan_internal(
    request: &prompt_module_engine::PromptPlanRequest,
    app_handle: &tauri::AppHandle,
) -> Result<prompt_module_engine::PromptPlanResponse, String> {
    let traces = if let Some(project_name) = request
        .project_name
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        let project_dir = get_project_dir(project_name, app_handle)?;
        let trace_file = project_dir.join(".xt").join("prompt_module_traces.json");
        if trace_file.exists() {
            match fs::read_to_string(&trace_file) {
                Ok(content) => {
                    serde_json::from_str::<Vec<prompt_module_engine::PromptModuleTrace>>(&content)
                        .map(prompt_module_engine::dedupe_traces)
                        .unwrap_or_default()
                }
                Err(_) => vec![],
            }
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    Ok(prompt_module_engine::build_prompt_plan(request, &traces))
}

#[tauri::command]
async fn execute_expert_tool_request(
    request_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let request: expert_tool_runtime_engine::ExpertToolExecutionRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("解析专家工具请求失败: {}", e))?;
    let result = execute_expert_tool_request_internal(request, &app_handle).await?;
    serde_json::to_string(&ExpertToolExecutionEnvelope { result }).map_err(|e| e.to_string())
}

async fn execute_expert_tool_request_internal(
    request: expert_tool_runtime_engine::ExpertToolExecutionRequest,
    app_handle: &tauri::AppHandle,
) -> Result<expert_tool_runtime_engine::ExpertToolExecutionResult, String> {
    let workspace_root = match request
        .project_path
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(path) => Some(resolve_sandbox_project_dir(
            request.project_name.as_deref().unwrap_or_default(),
            Some(path.as_str()),
            app_handle,
        )?),
        None => request
            .project_name
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .map(|project_name| get_project_dir(project_name, app_handle))
            .transpose()?,
    };

    let result = match &request.request {
        expert_tool_engine::ExpertToolRequest::WebSearch { query, .. } => {
            match web_search::search(query, 5).await {
                Ok(results) => {
                    expert_tool_runtime_engine::build_web_search_success(&request, results)
                }
                Err(error) => expert_tool_runtime_engine::build_web_search_error(&request, &error),
            }
        }
        expert_tool_engine::ExpertToolRequest::FileRead {
            path,
            start_line,
            end_line,
            ..
        } => {
            let Some(project_dir) = workspace_root.as_ref() else {
                return Ok(expert_tool_runtime_engine::build_file_read_error(
                    &request,
                    "当前项目未提供可读取的工作区路径",
                ));
            };
            let raw_tool_result = dispatch_tool(
                "file_read".to_string(),
                serde_json::json!({
                    "path": path,
                    "start_line": start_line,
                    "end_line": end_line,
                })
                .to_string(),
                project_dir.to_string_lossy().to_string(),
                request.expert_id.clone(),
            )
            .await;
            match raw_tool_result {
                Ok(raw) => {
                    let parsed: tool_system::ToolOutput = serde_json::from_str(&raw)
                        .map_err(|e| format!("解析文件读取结果失败: {}", e))?;
                    if parsed.success {
                        expert_tool_runtime_engine::build_file_read_result(&request, &parsed.result)
                    } else {
                        expert_tool_runtime_engine::build_file_read_error(&request, &parsed.result)
                    }
                }
                Err(error) => expert_tool_runtime_engine::build_file_read_error(&request, &error),
            }
        }
        expert_tool_engine::ExpertToolRequest::FileList {
            path, recursive, ..
        } => {
            let Some(project_dir) = workspace_root.as_ref() else {
                return Ok(expert_tool_runtime_engine::build_file_list_error(
                    &request,
                    "当前项目未提供可读取的工作区路径",
                ));
            };
            let raw_tool_result = dispatch_tool(
                "file_list".to_string(),
                serde_json::json!({
                    "path": path,
                    "recursive": recursive,
                    "max_depth": if *recursive { 4 } else { 1 },
                })
                .to_string(),
                project_dir.to_string_lossy().to_string(),
                request.expert_id.clone(),
            )
            .await;
            match raw_tool_result {
                Ok(raw) => {
                    let parsed: tool_system::ToolOutput = serde_json::from_str(&raw)
                        .map_err(|e| format!("解析目录读取结果失败: {}", e))?;
                    if parsed.success {
                        expert_tool_runtime_engine::build_file_list_result(&request, &parsed.result)
                    } else {
                        expert_tool_runtime_engine::build_file_list_error(&request, &parsed.result)
                    }
                }
                Err(error) => expert_tool_runtime_engine::build_file_list_error(&request, &error),
            }
        }
        expert_tool_engine::ExpertToolRequest::Command {
            command,
            working_dir,
            ..
        } => {
            let project_dir = workspace_root
                .as_ref()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| working_dir.clone());
            let safety = shell_executor::check_safety(command, &[], working_dir, &project_dir);
            if safety.requires_auth {
                match request.approval_decision {
                    None => expert_tool_runtime_engine::build_command_authorization(
                        &request,
                        &safety,
                        working_dir,
                    ),
                    Some(false) => expert_tool_runtime_engine::build_command_denied(
                        &request,
                        working_dir,
                        &safety.auth_reason,
                    ),
                    Some(true) => match shell_executor::execute(command, &[], working_dir) {
                        Ok(command_result) => expert_tool_runtime_engine::build_command_success(
                            &request,
                            &command_result,
                            working_dir,
                            &safety.auth_reason,
                        ),
                        Err(error) => expert_tool_runtime_engine::build_command_error(
                            &request,
                            working_dir,
                            &error,
                        ),
                    },
                }
            } else {
                match shell_executor::execute(command, &[], working_dir) {
                    Ok(command_result) => expert_tool_runtime_engine::build_command_success(
                        &request,
                        &command_result,
                        working_dir,
                        "",
                    ),
                    Err(error) => expert_tool_runtime_engine::build_command_error(
                        &request,
                        working_dir,
                        &error,
                    ),
                }
            }
        }
    };

    Ok(result)
}

async fn advance_expert_postprocess_internal(
    request: expert_postprocess_engine::ExpertPostprocessRequest,
    app_handle: &tauri::AppHandle,
) -> Result<expert_postprocess_engine::ExpertPostprocessResponse, String> {
    let mut state = request.state;
    let mut tool_events = Vec::new();
    let mut progress_events = Vec::new();

    loop {
        if state.completed {
            break;
        }

        if let Some(pending_request) = state.pending_request.clone() {
            let execution = execute_expert_tool_request_internal(
                state.pending_execution_request(pending_request.clone(), request.approval_decision),
                &app_handle,
            )
            .await?;
            state.pending_request = None;
            if let Some(event) = execution.event {
                tool_events.push(event);
            }
            if let Some(tool_context) = execution.tool_context {
                state.current_tool_contexts.push(tool_context);
            }
            state.current_tool_index += 1;
            continue;
        }

        if state.current_tool_requests.is_empty() {
            let tool_plan = expert_tool_engine::build_tool_request_plan_for_expert(
                &state.reply,
                Some(&state.expert_id),
                &state.expert_title,
                state.project_path.as_ref().map(Path::new),
            );
            if tool_plan.requests.is_empty() {
                state.reply = tool_plan.stripped_reply;
                let reply_guard = workflow_engine::evaluate_expert_reply_guard(
                    &workflow_engine::ExpertReplyGuardRequest {
                        expert_id: state.expert_id.clone(),
                        has_workspace_context: state.has_workspace_context,
                        workspace_looks_empty: workspace_looks_empty_for_direct_creation(
                            state.project_path.as_deref(),
                        ),
                        task_description: state
                            .messages
                            .iter()
                            .find(|message| message.role == "user")
                            .map(|message| message.content.clone())
                            .unwrap_or_default(),
                        reply: state.reply.clone(),
                    },
                );
                if reply_guard.should_enforce && reply_guard.requires_retry {
                    if state.deliverable_attempt >= state.max_deliverable_attempts {
                        state.reply = reply_guard.final_failure_message.unwrap_or_else(|| {
                            "未交付任何可执行文件变更，当前实现失败，需要重试。".to_string()
                        });
                        state.completed = true;
                        break;
                    }
                    let detail = if state.deliverable_attempt == 0 {
                        reply_guard
                            .phase_detail
                            .clone()
                            .unwrap_or_else(|| "补交真实文件变更中...".to_string())
                    } else {
                        "逼近真实文件补丁中...".to_string()
                    };
                    state.push_progress(&mut progress_events, "analyzing", &detail);
                    state.messages.push(DeepSeekMessage {
                        role: "assistant".to_string(),
                        content: state.reply.clone(),
                    });
                    state.messages.push(DeepSeekMessage {
                        role: "user".to_string(),
                        content: if state.deliverable_attempt == 0 {
                            reply_guard
                                .reminder_prompt
                                .clone()
                                .unwrap_or_else(|| "请补交真实文件变更。".to_string())
                        } else {
                            "你已经拿到了真实文件内容或工具结果。现在禁止继续只解释思路、只复述已读代码、只列命令，必须直接基于刚才读到的真实原文输出至少一个可执行文件动作：优先使用 [ACTION:EDIT_FILE]，必要时再用 [ACTION:CREATE_FILE] / [ACTION:WRITE_FILE]。如果你声称还缺内容，必须给出带 start_line/end_line 的精确 READ_FILE 分段请求，而不是再次泛泛地说“我需要继续读取”。".to_string()
                        },
                    });
                    let raw_deliverable_reply = call_llm(
                        state.system_prompt.clone(),
                        state.messages.clone(),
                        state.api_key.clone(),
                        &state.model,
                    )
                    .await?;
                    let envelope = parse_llm_reply_envelope(&raw_deliverable_reply)?;
                    state.reply = envelope.content;
                    state.merge_usage(envelope.usage);
                    state.deliverable_attempt += 1;
                    state.current_tool_requests.clear();
                    state.current_tool_index = 0;
                    state.current_tool_contexts.clear();
                    continue;
                }

                state.completed = true;
                break;
            }

            state.current_tool_requests = tool_plan.requests;
            state.current_tool_index = 0;
            state.current_tool_contexts.clear();
            continue;
        }

        if state.current_tool_index < state.current_tool_requests.len() {
            let current_request = state.current_tool_requests[state.current_tool_index].clone();
            state.note_tool_kind(&current_request);
            match &current_request {
                expert_tool_engine::ExpertToolRequest::WebSearch { .. } => {
                    state.push_progress(&mut progress_events, "web-searching", "网络搜索中...");
                }
                expert_tool_engine::ExpertToolRequest::Command { .. } => {
                    state.push_progress(&mut progress_events, "running-command", "命令执行中...");
                }
                expert_tool_engine::ExpertToolRequest::FileRead { .. } => {
                    state.push_progress(&mut progress_events, "reading-file", "读取真实文件中...");
                }
                expert_tool_engine::ExpertToolRequest::FileList { .. } => {
                    state.push_progress(&mut progress_events, "listing-files", "读取目录结构中...");
                }
            }

            let execution = execute_expert_tool_request_internal(
                state.pending_execution_request(current_request.clone(), None),
                &app_handle,
            )
            .await?;
            if execution.requires_authorization {
                state.pending_request = Some(current_request);
                let response = expert_postprocess_engine::ExpertPostprocessResponse {
                    completed: false,
                    pending_authorization: execution.authorization,
                    tool_events,
                    progress_events,
                    state,
                };
                return Ok(response);
            }
            if let Some(event) = execution.event {
                tool_events.push(event);
            }
            if let Some(tool_context) = execution.tool_context {
                state.current_tool_contexts.push(tool_context);
            }
            state.current_tool_index += 1;
            continue;
        }

        if state.current_tool_contexts.is_empty() {
            state.reply = expert_tool_engine::build_tool_request_plan_for_expert(
                &state.reply,
                Some(&state.expert_id),
                &state.expert_title,
                state.project_path.as_ref().map(Path::new),
            )
            .stripped_reply;
            state.current_tool_requests.clear();
            state.current_tool_index = 0;
            if state.tool_round >= state.max_tool_rounds {
                state.completed = true;
            }
            continue;
        }

        state.push_progress(&mut progress_events, "analyzing", "结合工具结果分析中...");
        state.messages.push(DeepSeekMessage {
            role: "assistant".to_string(),
            content: state.reply.clone(),
        });
        state.messages.push(DeepSeekMessage {
            role: "user".to_string(),
            content: expert_runtime_engine::build_tool_followup_message(
                &expert_runtime_engine::ToolFollowupMessageRequest {
                    tool_contexts: state.current_tool_contexts.clone(),
                },
            )
            .content,
        });
        let raw_followup_reply = call_llm(
            state.system_prompt.clone(),
            state.messages.clone(),
            state.api_key.clone(),
            &state.model,
        )
        .await?;
        let envelope = parse_llm_reply_envelope(&raw_followup_reply)?;
        state.reply = envelope.content;
        state.merge_usage(envelope.usage);
        state.current_tool_requests.clear();
        state.current_tool_index = 0;
        state.current_tool_contexts.clear();
        state.tool_round += 1;
    }

    Ok(expert_postprocess_engine::ExpertPostprocessResponse {
        state: state.clone(),
        completed: state.completed,
        pending_authorization: None,
        tool_events,
        progress_events,
    })
}

async fn initialize_expert_postprocess_internal(
    request: expert_postprocess_engine::ExpertPostprocessInitRequest,
    app_handle: &tauri::AppHandle,
) -> Result<expert_postprocess_engine::ExpertPostprocessState, String> {
    let mut state = request.state;
    let current_tool_plan = expert_tool_engine::build_tool_request_plan_for_expert(
        &state.reply,
        Some(&state.expert_id),
        &state.expert_title,
        state.project_path.as_ref().map(Path::new),
    );
    if current_tool_plan.requests.is_empty() {
        let reminder_decision = expert_runtime_engine::evaluate_tool_reminder(
            &expert_runtime_engine::ToolReminderRequest {
                reply: state.reply.clone(),
            },
            false,
        );
        if reminder_decision.needs_retry {
            let mut hint_module_ids = request.explicit_hint_module_ids.clone();
            if reminder_decision
                .reminder_targets
                .iter()
                .any(|target| target == "网络搜索")
            {
                hint_module_ids.push("web-search-guidance".to_string());
            }
            if reminder_decision
                .reminder_targets
                .iter()
                .any(|target| target == "命令执行")
            {
                hint_module_ids.push("command-guidance".to_string());
            }
            if reminder_decision
                .reminder_targets
                .iter()
                .any(|target| target == "视频工作流")
            {
                hint_module_ids.push("video-workflow".to_string());
            }
            let refreshed_plan = resolve_expert_prompt_plan_internal(
                &prompt_module_engine::PromptPlanRequest {
                    project_name: state.project_name.clone(),
                    expert_id: state.expert_id.clone(),
                    base_prompt: state.base_prompt.clone(),
                    scene: state.scene.clone(),
                    task_description: state
                        .messages
                        .iter()
                        .find(|message| message.role == "user")
                        .map(|message| message.content.clone())
                        .unwrap_or_default(),
                    hint_module_ids,
                },
                app_handle,
            )?;
            state.system_prompt = refreshed_plan.prompt;
            state.messages.push(DeepSeekMessage {
                role: "assistant".to_string(),
                content: state.reply.clone(),
            });
            state.messages.push(DeepSeekMessage {
                role: "user".to_string(),
                content: reminder_decision.reminder_message.unwrap_or_else(|| {
                    "如果确实需要工具，请直接输出标准 ACTION 发起。".to_string()
                }),
            });
            let raw_retry_reply = call_llm(
                state.system_prompt.clone(),
                state.messages.clone(),
                state.api_key.clone(),
                &state.model,
            )
            .await?;
            let retry_envelope = parse_llm_reply_envelope(&raw_retry_reply)?;
            state.reply = retry_envelope.content;
            state.merge_usage(retry_envelope.usage);
        }
    }
    Ok(state)
}

async fn finalize_expert_task_internal(
    request: FinalizeExpertTaskRequest,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    if let Some(project_name) = request
        .project_name
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        if !request.learned_module_ids.is_empty() {
            let normalized_task_description =
                prompt_module_engine::sanitize_task_description(&request.task_description);
            append_prompt_module_trace(
                project_name.to_string(),
                PromptModuleTraceRecord {
                    expert_id: request.expert_id.clone(),
                    scene: request.scene.clone(),
                    task_description: if normalized_task_description.is_empty() {
                        request.task_description.chars().take(400).collect()
                    } else {
                        normalized_task_description
                    },
                    module_ids: request.learned_module_ids.clone(),
                    trigger_sources: request.trigger_sources.clone(),
                    created_at: chrono::Utc::now().timestamp_millis(),
                },
                app_handle.clone(),
            )?;
        }

        if let Some(project_id) = request.project_id {
            let content: String = if request.reply.chars().count() > 500 {
                let truncated: String = request.reply.chars().take(500).collect();
                format!("{truncated}...")
            } else {
                request.reply.clone()
            };
            let keyword_text = format!(
                "{} {} {}",
                request.task_description, request.expert_name, content
            );
            let entry = memory::MemoryEntry {
                id: memory::generate_memory_id(),
                project_id,
                expert_id: request.expert_id.clone(),
                memory_type: "working".to_string(),
                content: format!(
                    "[{}] {}\n\n{}",
                    request.expert_name, request.task_description, content
                ),
                keywords: memory::extract_keywords(&keyword_text),
                context_summary: request.task_description.chars().take(100).collect(),
                created_at: chrono::Utc::now().timestamp(),
                access_count: 0,
                last_accessed: chrono::Utc::now().timestamp(),
            };
            let project_dir = get_project_dir(project_name, app_handle)?;
            memory::save_memory(&project_dir, &entry)?;
        }

        if request.reply.contains("[INDEX_FEEDBACK:")
            && request
                .api_key
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .is_some()
            && request
                .model
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .is_some()
        {
            let _ = repo_incremental_update(
                project_name.to_string(),
                request.api_key.unwrap_or_default(),
                request.model.unwrap_or_default(),
                app_handle.clone(),
            )
            .await;
        }
    }

    Ok(())
}

async fn start_expert_session_internal(
    request: expert_session_engine::StartExpertSessionRequest,
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, Arc<AppState>>,
) -> Result<expert_session_engine::StartExpertSessionResponse, String> {
    let prompt_plan = resolve_expert_prompt_plan_internal(
        &prompt_module_engine::PromptPlanRequest {
            project_name: request.project_name.clone(),
            expert_id: request.expert_id.clone(),
            base_prompt: request.base_prompt.clone(),
            scene: request.scene.clone(),
            task_description: request.task_description.clone(),
            hint_module_ids: request.hint_module_ids.clone(),
        },
        &app_handle,
    )?;

    let context = build_expert_context_internal(
        &expert_context_engine::ExpertContextRequest {
            project_name: request.project_name.clone(),
            project_id: request.project_id,
            expert_id: request.expert_id.clone(),
            task_description: request.task_description.clone(),
            previous_results: request
                .previous_results
                .iter()
                .map(|item| expert_context_engine::PreviousExpertResult {
                    expert_id: None,
                    name: item.name.clone(),
                    title: item.title.clone(),
                    output: item.output.clone(),
                })
                .collect(),
        },
        &app_handle,
        &state,
    )
    .await?;

    let messages: Vec<DeepSeekMessage> = if context.messages.is_empty() {
        vec![DeepSeekMessage {
            role: "user".to_string(),
            content: request.task_description.clone(),
        }]
    } else {
        context
            .messages
            .iter()
            .map(|message| DeepSeekMessage {
                role: message.role.clone(),
                content: message.content.clone(),
            })
            .collect()
    };

    let raw_reply = call_llm(
        prompt_plan.prompt.clone(),
        messages.clone(),
        request.api_key.clone(),
        &request.model,
    )
    .await?;
    let envelope = parse_llm_reply_envelope(&raw_reply)?;

    let init_state = expert_postprocess_engine::ExpertPostprocessState {
        expert_id: request.expert_id.clone(),
        expert_name: request.expert_name.clone(),
        expert_title: request.expert_title.clone(),
        scene: request.scene.clone(),
        base_prompt: request.base_prompt.clone(),
        api_key: request.api_key.clone(),
        model: request.model.clone(),
        system_prompt: prompt_plan.prompt.clone(),
        project_name: request.project_name.clone(),
        project_path: request.project_path.clone(),
        has_workspace_context: request
            .project_path
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
            || request
                .project_name
                .as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false),
        messages,
        reply: envelope.content,
        usage: envelope.usage,
        tool_round: 0,
        max_tool_rounds: 3,
        current_tool_requests: vec![],
        current_tool_index: 0,
        current_tool_contexts: vec![],
        pending_request: None,
        deliverable_attempt: 0,
        max_deliverable_attempts: 2,
        completed: false,
        learned_module_ids: vec![],
        trigger_sources: vec![],
    };
    let final_state = initialize_expert_postprocess_internal(
        expert_postprocess_engine::ExpertPostprocessInitRequest {
            state: init_state,
            explicit_hint_module_ids: request.hint_module_ids.clone(),
        },
        app_handle,
    )
    .await?;

    Ok(expert_session_engine::StartExpertSessionResponse {
        state: final_state,
        prompt_char_count: prompt_plan.prompt.chars().count(),
        module_ids: prompt_plan.module_ids,
        history_hint_module_ids: prompt_plan.history_hint_module_ids,
    })
}

#[tauri::command]
async fn start_expert_task_runtime(
    request_json: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let request: StartExpertTaskRuntimeRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析专家任务运行时启动请求失败: {}", e))?;
    if let Some(reason) = check_expert_quota_internal(
        &request.token_context,
        &request.session_request.expert_id,
        &request.session_request.expert_name,
    ) {
        let envelope = ExpertTaskRuntimeEnvelope {
            blocked_reason: Some(reason),
            runtime_state: None,
            response: None,
            project_data: request.token_context.project_data,
            user_data: request.token_context.user_data,
        };
        return serde_json::to_string(&envelope).map_err(|e| e.to_string());
    }

    let started =
        start_expert_session_internal(request.session_request.clone(), &app_handle, &state).await?;
    let postprocess_response = advance_expert_postprocess_internal(
        expert_postprocess_engine::ExpertPostprocessRequest {
            state: started.state,
            approval_decision: None,
        },
        &app_handle,
    )
    .await?;

    let mut project_data = request.token_context.project_data.clone();
    let mut user_data = request.token_context.user_data.clone();
    let runtime_state = if postprocess_response.completed {
        finalize_expert_task_internal(
            FinalizeExpertTaskRequest {
                project_name: request.session_request.project_name.clone(),
                project_id: request.session_request.project_id,
                expert_id: request.session_request.expert_id.clone(),
                expert_name: request.session_request.expert_name.clone(),
                scene: request.session_request.scene.clone(),
                task_description: request.session_request.task_description.clone(),
                reply: postprocess_response.state.reply.clone(),
                learned_module_ids: postprocess_response.state.learned_module_ids.clone(),
                trigger_sources: postprocess_response.state.trigger_sources.clone(),
                api_key: Some(request.session_request.api_key.clone()),
                model: Some(request.session_request.model.clone()),
            },
            &app_handle,
        )
        .await?;
        let appended = append_expert_usage(
            &request.token_context,
            &request.session_request.expert_id,
            &request.session_request.expert_name,
            Some(&request.session_request.expert_title),
            &request.session_request.model,
            postprocess_response.state.usage.clone(),
        );
        project_data = appended.0;
        user_data = appended.1;
        None
    } else {
        Some(ExpertTaskRuntimeState {
            postprocess_state: postprocess_response.state.clone(),
            task_description: request.session_request.task_description.clone(),
            project_id: request.session_request.project_id,
            key_id: request.key_id,
        })
    };

    let envelope = ExpertTaskRuntimeEnvelope {
        blocked_reason: None,
        runtime_state,
        response: Some(postprocess_response),
        project_data,
        user_data,
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

#[tauri::command]
async fn continue_expert_task_runtime(
    request_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let request: ContinueExpertTaskRuntimeRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("解析专家任务运行时续跑请求失败: {}", e))?;
    let postprocess_response = advance_expert_postprocess_internal(
        expert_postprocess_engine::ExpertPostprocessRequest {
            state: request.runtime_state.postprocess_state,
            approval_decision: request.approval_decision,
        },
        &app_handle,
    )
    .await?;

    let mut project_data = request.token_context.project_data.clone();
    let mut user_data = request.token_context.user_data.clone();
    let runtime_state = if postprocess_response.completed {
        finalize_expert_task_internal(
            FinalizeExpertTaskRequest {
                project_name: postprocess_response.state.project_name.clone(),
                project_id: request.runtime_state.project_id,
                expert_id: postprocess_response.state.expert_id.clone(),
                expert_name: postprocess_response.state.expert_name.clone(),
                scene: postprocess_response.state.scene.clone(),
                task_description: request.runtime_state.task_description.clone(),
                reply: postprocess_response.state.reply.clone(),
                learned_module_ids: postprocess_response.state.learned_module_ids.clone(),
                trigger_sources: postprocess_response.state.trigger_sources.clone(),
                api_key: Some(postprocess_response.state.api_key.clone()),
                model: Some(postprocess_response.state.model.clone()),
            },
            &app_handle,
        )
        .await?;
        let appended = append_expert_usage(
            &request.token_context,
            &postprocess_response.state.expert_id,
            &postprocess_response.state.expert_name,
            Some(&postprocess_response.state.expert_title),
            &postprocess_response.state.model,
            postprocess_response.state.usage.clone(),
        );
        project_data = appended.0;
        user_data = appended.1;
        None
    } else {
        Some(ExpertTaskRuntimeState {
            postprocess_state: postprocess_response.state.clone(),
            task_description: request.runtime_state.task_description,
            project_id: request.runtime_state.project_id,
            key_id: request.runtime_state.key_id,
        })
    };

    let envelope = ExpertTaskRuntimeEnvelope {
        blocked_reason: None,
        runtime_state,
        response: Some(postprocess_response),
        project_data,
        user_data,
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentDeliveryExecutionResult {
    parsed_action_count: usize,
    structured_change_count: usize,
    applied: usize,
    failed: usize,
    file_mutations_applied: usize,
    folder_ops_applied: usize,
    touched_files: Vec<String>,
    errors: Vec<String>,
    required_files: Vec<String>,
}

#[tauri::command]
fn apply_agent_delivery_changes(
    project_name: String,
    project_path: Option<String>,
    task_description: String,
    user_task_text: String,
    sources_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let sources: Vec<workflow_engine::WorkflowInputSource> =
        serde_json::from_str(&sources_json).map_err(|e| format!("解析专家输出失败: {}", e))?;
    let extracted = workflow_engine::extract_delivery_payload(&sources);

    let changes: Vec<ChangeSet> = extracted
        .change_sets
        .iter()
        .map(|change| ChangeSet {
            operation: change.operation.clone(),
            path: change.path.clone(),
            search_text: change.search_text.clone(),
            replace_text: change.replace_text.clone(),
            content: change.content.clone(),
            rationale: change.rationale.clone(),
            risk: change.risk.clone(),
            allow_overwrite: change.allow_overwrite,
        })
        .collect();

    let mut result = AgentDeliveryExecutionResult {
        parsed_action_count: extracted.parsed_action_count,
        structured_change_count: extracted.structured_change_count,
        applied: 0,
        failed: 0,
        file_mutations_applied: 0,
        folder_ops_applied: 0,
        touched_files: vec![],
        errors: vec![],
        required_files: extracted.required_files.clone(),
    };

    if changes.is_empty() {
        if result.parsed_action_count > 0 {
            result.failed = 1;
            result.errors.push(
                "检测到文件动作声明，但没有解析出可执行的文件变更。请改用完整的 CREATE_FILE / WRITE_FILE 内容，或使用带精确 searchText / replaceText 的 EDIT_FILE。"
                    .to_string(),
            );
        }
        return serde_json::to_string(&result).map_err(|e| e.to_string());
    }

    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let workspace_path = project_dir.to_string_lossy().to_string();
    let delivery_check =
        workflow_engine::analyze_agent_delivery(&sources, &user_task_text, Some(&workspace_path))?;
    if !delivery_check.has_executable_mutation {
        return serde_json::to_string(&result).map_err(|e| e.to_string());
    }

    let proposed_raw = propose_patch(
        project_name.clone(),
        task_description,
        changes,
        Some(extracted.required_files.clone()),
        project_path.clone(),
        app_handle.clone(),
    )?;
    let proposed: ChangeSession =
        serde_json::from_str(&proposed_raw).map_err(|e| format!("解析变更会话失败: {}", e))?;

    if proposed.status == "blocked" {
        result.failed = std::cmp::max(proposed.errors.len(), 1);
        result.errors = proposed.errors;
        return serde_json::to_string(&result).map_err(|e| e.to_string());
    }

    let applied_raw = apply_approved_patch(project_name, proposed.id, project_path, app_handle)?;
    let applied: ChangeSession =
        serde_json::from_str(&applied_raw).map_err(|e| format!("解析已合入会话失败: {}", e))?;

    result.touched_files = applied
        .changes
        .iter()
        .map(|item| item.change.path.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    result.applied = result.touched_files.len();
    result.folder_ops_applied = applied
        .changes
        .iter()
        .filter(|item| normalize_change_operation(&item.change.operation) == "create_folder")
        .count();
    result.file_mutations_applied = applied
        .changes
        .iter()
        .filter(|item| normalize_change_operation(&item.change.operation) != "create_folder")
        .count();
    result.failed = applied.errors.len();
    result.errors = applied.errors;
    if result.parsed_action_count > 0
        && result.applied == 0
        && result.failed == 0
        && result.folder_ops_applied == 0
    {
        result.failed = 1;
        result.errors.push(
            "检测到文件动作，但没有任何源码或目录变更真正落盘。请重新输出精确可执行的文件动作。"
                .to_string(),
        );
    }

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

/// 初始化数据库连接池
async fn init_db_pool(app_handle: &tauri::AppHandle) -> Result<Pool<Sqlite>, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    // 确保应用数据目录存在
    fs::create_dir_all(&app_data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;

    let db_path = app_data_dir.join("chat_history.db");
    let db_path_str = db_path.to_string_lossy().to_string();

    eprintln!("[DB] 数据库路径: {}", db_path_str);

    // Windows路径需要转换为URL格式：把反斜杠换成正斜杠，并添加file://协议
    let db_url = format!("sqlite:///{}", db_path_str.replace("\\", "/"));
    eprintln!("[DB] 连接URL: {}", db_url);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .map_err(|e| format!("数据库连接失败: {}", e))?;

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .map_err(|e| format!("启用外键失败: {}", e))?;

    // 创建表
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            icon_color TEXT,
            workspace_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )",
    )
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(pool)
}

const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1/chat/completions";

/// DeepSeek 请求体
#[derive(Serialize)]
pub struct DeepSeekRequest {
    pub model: String,
    pub messages: Vec<DeepSeekMessage>,
    pub stream: bool,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeepSeekMessage {
    pub role: String,
    pub content: String,
}

/// DeepSeek 响应体
#[derive(Deserialize, Debug)]
pub struct DeepSeekResponse {
    pub choices: Vec<DeepSeekChoice>,
    pub usage: Option<DeepSeekUsage>,
}

#[derive(Deserialize, Debug)]
pub struct DeepSeekChoice {
    pub message: DeepSeekMessage,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DeepSeekUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

// === 多模态消息结构体 ===
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageUrlDetail {
    pub url: String,
    pub detail: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum ContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlDetail },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Multimodal(Vec<ContentPart>),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MultimodalMessage {
    pub role: String,
    pub content: MessageContent,
}

#[derive(Serialize, Deserialize, Debug)]
struct MultimodalRequest {
    pub model: String,
    pub messages: Vec<MultimodalMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

// 图像生成请求/响应
#[derive(Serialize, Debug)]
struct ImageGenerationRequest {
    pub model: String,
    pub prompt: String,
    pub n: u32,
    pub size: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct ImageGenerationResponse {
    pub data: Vec<ImageData>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct ImageData {
    pub url: Option<String>,
    pub b64_json: Option<String>,
}

/// 测试 API 密钥是否有效
#[derive(Deserialize)]
struct TestKeyConfig {
    #[serde(rename = "type")]
    key_type: String,
    api_key: String,
    endpoint: Option<String>,
    model: Option<String>,
    modalities: Option<Vec<String>>,
}

#[derive(Serialize)]
struct TestKeyResult {
    ok: Vec<String>,
    failed: Vec<ModalityError>,
}

#[derive(Serialize)]
struct ModalityError {
    modality: String,
    error: String,
}

async fn test_single_modality(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    modality: &str,
) -> Result<(), String> {
    let prompt = match modality {
        "text" => "hi",
        "image" => "Describe a red apple in one sentence.",
        "video" => "What is the most popular video format? Answer in one word.",
        "audio" => "What is the most common audio sample rate? Answer in one number.",
        _ => "hi",
    };

    let request_body = DeepSeekRequest {
        model: model.to_string(),
        messages: vec![DeepSeekMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
        stream: false,
        max_tokens: Some(128),
        temperature: Some(0.0),
    };

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .json(&request_body)
        .send()
        .await;

    match response {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                Ok(())
            } else {
                let body = resp.text().await.unwrap_or_default();
                let short_body = if body.len() > 100 {
                    &body[..100]
                } else {
                    &body
                };
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    Err("密钥无效或被拒绝访问".to_string())
                } else {
                    Err(format!("HTTP {}: {}", status.as_u16(), short_body))
                }
            }
        }
        Err(e) => {
            if e.is_timeout() {
                Err("连接超时".to_string())
            } else if e.is_connect() {
                Err("无法连接".to_string())
            } else {
                Err(format!("{}", e))
            }
        }
    }
}

#[tauri::command]
async fn test_api_key(config: TestKeyConfig) -> Result<String, String> {
    let client = reqwest::Client::new();

    let (url, model) = if config.key_type == "relay" {
        let endpoint = config.endpoint.ok_or("缺少端点地址")?;
        let model = config.model.unwrap_or_else(|| "default".to_string());
        (endpoint, model)
    } else {
        let provider_id = &config.key_type;
        let model = config.model.unwrap_or_else(|| "default".to_string());
        let url = match provider_id.as_str() {
            "deepseek" => "https://api.deepseek.com/v1/chat/completions",
            "openai" => "https://api.openai.com/v1/chat/completions",
            "anthropic" => "https://api.anthropic.com/v1/messages",
            "aliyun" => "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "tencent" => "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
            _ => return Err(format!("未知厂商: {}", provider_id)),
        };
        (url.to_string(), model)
    };

    let modalities = config
        .modalities
        .unwrap_or_else(|| vec!["text".to_string()]);

    let mut ok_modalities: Vec<String> = Vec::new();
    let mut failed_modalities: Vec<ModalityError> = Vec::new();

    for modality in &modalities {
        match test_single_modality(&client, &url, &config.api_key, &model, modality).await {
            Ok(()) => {
                eprintln!("[API_TEST] 模态 {} 验证成功", modality);
                ok_modalities.push(modality.clone());
            }
            Err(e) => {
                eprintln!("[API_TEST] 模态 {} 验证失败: {}", modality, e);
                failed_modalities.push(ModalityError {
                    modality: modality.clone(),
                    error: e,
                });
            }
        }
    }

    let result = TestKeyResult {
        ok: ok_modalities,
        failed: failed_modalities,
    };

    let json = serde_json::to_string(&result).map_err(|e| format!("序列化失败: {}", e))?;
    Ok(json)
}

/// 沙箱系统提示词
const SYSTEM_PROMPT: &str = r#"你是一个AI专家团助手，帮助用户管理项目文件和文件夹。

当用户要求创建文件夹或文件时，请在回复末尾使用以下动作标记格式：

创建文件夹：[ACTION:CREATE_FOLDER:相对路径]
创建文件：
[ACTION:CREATE_FILE:相对路径]
```
文件内容
```

例如：
- 用户说"创建一个集合文件夹" -> 你在回复末尾添加：[ACTION:CREATE_FOLDER:集合]
- 用户说"在集合里创建一个README" -> 你在回复末尾添加：
  [ACTION:CREATE_FILE:集合/README.md]
  ```
  # 集合
  
  这是集合的说明文档。
  ```

重要规则：
1. 所有路径都是相对于项目根目录的
2. 不要包含解释文字，只添加动作标记
3. 文件内容用三个反引号包裹
4. 动作标记放在回复的最后"#;

/// 发送消息到 DeepSeek API
/// 返回 JSON 字符串，包含 content 和 usage
#[tauri::command]
async fn chat_with_deepseek(
    messages: Vec<DeepSeekMessage>,
    api_key: String,
    model: String,
) -> Result<String, String> {
    call_llm(SYSTEM_PROMPT.to_string(), messages, api_key, &model).await
}

/// 使用自定义 system prompt 调用 LLM（供专家团路由使用）
/// 返回 JSON 字符串，包含 content 和 usage
#[tauri::command]
async fn chat_with_expert(
    messages: Vec<DeepSeekMessage>,
    api_key: String,
    system_prompt: String,
    model: String,
) -> Result<String, String> {
    call_llm(system_prompt, messages, api_key, &model).await
}

/// 内部通用 LLM 调用函数
/// 返回 JSON 字符串，包含 content 和 usage
async fn call_llm(
    system_prompt: String,
    messages: Vec<DeepSeekMessage>,
    api_key: String,
    model: &str,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 LLM 客户端失败: {}", e))?;

    let mut full_messages = vec![DeepSeekMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];
    full_messages.extend(messages);

    let joined_prompt = full_messages
        .iter()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let implementation_session = joined_prompt.contains("code-development")
        || joined_prompt.contains("discipline-4")
        || joined_prompt.contains("discipline-5")
        || joined_prompt.contains("discipline-610")
        || joined_prompt.contains("实现步骤")
        || joined_prompt.contains("补交真实文件变更中")
        || joined_prompt.contains("CREATE_FILE:index.html")
        || joined_prompt.contains("CREATE_FILE:./index.html");
    let large_deliverable_request = implementation_session
        && (joined_prompt.contains("当前工作区几乎为空目录")
            || joined_prompt.contains("未交付任何可执行文件变更")
            || joined_prompt.contains("支持添加")
            || joined_prompt.contains("待办")
            || joined_prompt.contains("HTML"));
    let max_tokens = if large_deliverable_request {
        5200
    } else {
        2200
    };

    let request_body = DeepSeekRequest {
        model: model.to_string(),
        messages: full_messages,
        stream: false,
        max_tokens: Some(max_tokens),
        temperature: Some(0.2),
    };

    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "LLM 请求超时（120 秒），已中止本轮专家调用，请重试".to_string()
            } else {
                format!("请求失败: {}", e)
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, text));
    }

    let result: DeepSeekResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = if let Some(choice) = result.choices.first() {
        choice.message.content.clone()
    } else {
        String::new()
    };

    let reply = serde_json::json!({
        "content": content,
        "usage": result.usage,
    });

    Ok(reply.to_string())
}

/// 获取应用数据目录
#[tauri::command]
fn get_app_data_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn read_frontend_e2e_control(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("frontend_e2e_control.json");
    if !path.exists() {
        return Ok(None);
    }
    let data =
        fs::read_to_string(&path).map_err(|e| format!("读取前端 E2E 控制文件失败: {}", e))?;
    Ok(Some(data))
}

#[tauri::command]
fn clear_frontend_e2e_control(app_handle: tauri::AppHandle) -> Result<(), String> {
    let path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("frontend_e2e_control.json");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除前端 E2E 控制文件失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn save_frontend_e2e_status(data: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用目录失败: {}", e))?;
    let path = dir.join("frontend_e2e_status.json");
    fs::write(&path, data).map_err(|e| format!("写入前端 E2E 状态失败: {}", e))
}

#[tauri::command]
fn append_frontend_e2e_log(line: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用目录失败: {}", e))?;
    let path = dir.join("frontend_e2e.log");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开前端 E2E 日志失败: {}", e))?;
    writeln!(file, "{}", line).map_err(|e| format!("写入前端 E2E 日志失败: {}", e))
}

/// 创建工作区文件夹，并自动生成 .xt 配置文件夹及子文件夹
/// project_name: 项目名称
/// 返回创建的项目目录路径
#[tauri::command]
fn create_workspace(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用目录: {}", e))?;

    let project_dir = base_dir.join("workspaces").join(&project_name);

    // 创建目录（递归）
    fs::create_dir_all(&project_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // 创建 .xt 配置文件夹（如果不存在）
    let xt_dir = project_dir.join(".xt");
    if !xt_dir.exists() {
        fs::create_dir_all(&xt_dir).map_err(|e| format!("创建配置文件夹失败: {}", e))?;

        // 创建默认子文件夹
        let subdirs = ["configs", "logs", "cache"];
        for sub in &subdirs {
            fs::create_dir_all(xt_dir.join(sub))
                .map_err(|e| format!("创建子文件夹 {} 失败: {}", sub, e))?;
        }

        // 创建默认配置文件
        let config_file = xt_dir.join("config.json");
        let default_config = r#"{
  "project": "",
  "version": "0.1.1",
  "files": [],
  "canvasDirectory": {
    "nodes": [],
    "edges": [],
    "updatedAt": ""
  }
}"#;
        fs::write(&config_file, default_config).map_err(|e| format!("创建配置文件失败: {}", e))?;
    }

    Ok(project_dir.to_string_lossy().to_string())
}

/// 从外部文件夹路径打开项目
#[tauri::command]
fn open_project_is_dir(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).is_dir())
}

/// 从外部文件夹路径打开项目
#[tauri::command]
fn open_project_from_path(
    folder_path: String,
    _app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err("文件夹不存在".to_string());
    }
    if !path.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    // 取文件夹名作为项目名称
    let project_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未命名项目")
        .to_string();

    // 确保 .xt 配置目录存在
    let xt_dir = path.join(".xt");
    if !xt_dir.exists() {
        fs::create_dir_all(&xt_dir).map_err(|e| format!("创建配置文件夹失败: {}", e))?;
        let subdirs = ["configs", "logs", "cache"];
        for sub in &subdirs {
            fs::create_dir_all(xt_dir.join(sub))
                .map_err(|e| format!("创建子文件夹 {} 失败: {}", sub, e))?;
        }
        let config_file = xt_dir.join("config.json");
        let default_config = r#"{
  "project": "",
  "version": "0.1.1",
  "files": [],
  "canvasDirectory": {
    "nodes": [],
    "edges": [],
    "updatedAt": ""
  }
}"#;
        fs::write(&config_file, default_config).map_err(|e| format!("创建配置文件失败: {}", e))?;
    }

    Ok(serde_json::json!({
        "name": project_name,
        "path": folder_path
    })
    .to_string())
}

/// 检查工作区是否存在
#[tauri::command]
fn workspace_exists(project_name: String, app_handle: tauri::AppHandle) -> Result<bool, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let project_dir = base_dir.join("workspaces").join(&project_name);
    Ok(project_dir.exists())
}

/// 获取所有工作区列表
#[tauri::command]
fn list_workspaces(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let workspaces_dir = base_dir.join("workspaces");
    if !workspaces_dir.exists() {
        return Ok(vec![]);
    }

    let mut projects = vec![];
    let entries = fs::read_dir(&workspaces_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                projects.push(name.to_string());
            }
        }
    }

    Ok(projects)
}

/// 检查并补全 .xt 配置文件夹
/// 如果项目文件夹存在但缺少 .xt 文件夹，则自动创建
#[tauri::command]
fn ensure_xt_config(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let xt_dir = project_dir.join(".xt");

    if !xt_dir.exists() {
        fs::create_dir_all(&xt_dir).map_err(|e| format!("创建配置文件夹失败: {}", e))?;

        // 创建默认子文件夹
        let subdirs = ["configs", "logs", "cache"];
        for sub in &subdirs {
            fs::create_dir_all(xt_dir.join(sub))
                .map_err(|e| format!("创建子文件夹 {} 失败: {}", sub, e))?;
        }

        // 创建默认配置文件
        let config_file = xt_dir.join("config.json");
        let default_config = r#"{
  "project": "",
  "version": "0.1.1",
  "files": [],
  "canvasDirectory": {
    "nodes": [],
    "edges": [],
    "updatedAt": ""
  }
}"#;
        fs::write(&config_file, default_config).map_err(|e| format!("创建配置文件失败: {}", e))?;
    }

    Ok(xt_dir.to_string_lossy().to_string())
}

/// 扫描项目目录结构（用于可视化目录和结构分析，排除工作台元数据目录）
#[tauri::command]
fn scan_project_structure(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let root_name = project_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&project_name)
        .to_string();
    let mut structure = vec![DirEntry {
        path: ".".to_string(),
        name: root_name,
        is_dir: true,
    }];
    scan_dir_recursive(&project_dir, &project_dir, &mut structure)?;

    Ok(serde_json::to_string(&structure).map_err(|e| e.to_string())?)
}

#[derive(Serialize)]
struct DirEntry {
    path: String,
    name: String,
    is_dir: bool,
}

/// 结构扫描跳过目录集合
const SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "__pycache__",
    "venv",
    ".venv",
    "build",
    ".next",
    "coverage",
    "vendor",
    ".gradle",
    "gradle",
    "obj",
    "bin",
    "out",
    "packages",
    ".nuget",
    "Pods",
    "DerivedData",
    ".dart_tool",
    ".pub-cache",
    "bower_components",
    "jspm_packages",
    ".cache",
    ".parcel-cache",
    ".terraform",
    ".serverless",
    "logs",
    "tmp",
    "temp",
    ".xt",
    ".git",
];

/// 最大扫描条目数
const MAX_SCAN_ENTRIES: usize = 20_000;

fn scan_dir_recursive(
    base: &std::path::Path,
    current: &std::path::Path,
    result: &mut Vec<DirEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;

    for entry in entries {
        // 总量保护
        if result.len() >= MAX_SCAN_ENTRIES {
            return Ok(());
        }

        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // 可视化目录只展示用户项目内容，排除 .xt/.git 等隐藏元数据
        if name.starts_with('.') {
            continue;
        }

        let is_dir = path.is_dir();

        // 跳过常见无关目录
        if is_dir && (path.is_symlink() || SCAN_SKIP_DIRS.contains(&name.as_str())) {
            continue;
        }

        let relative_path = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        result.push(DirEntry {
            path: relative_path,
            name,
            is_dir,
        });

        if is_dir {
            scan_dir_recursive(base, &path, result)?;
        }
    }

    Ok(())
}

/// 分析项目依赖关系（调用 DeepSeek）
#[tauri::command]
async fn analyze_project_dependencies(
    project_name: String,
    api_key: String,
    model: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // 1. 扫描目录结构
    let structure_json = scan_project_structure(project_name.clone(), app_handle)?;

    // 2. 调用 DeepSeek 分析依赖
    let client = reqwest::Client::new();
    let prompt = format!(
        r#"你是一个项目结构分析专家。请分析以下项目目录结构，识别文件夹和文件之间的依赖关系。

项目目录结构（JSON格式）：
{}

请返回一个JSON数组，格式如下：
[
  {{"id": "唯一标识", "type": "folder|file", "name": "显示名称", "x": 0, "y": 0}},
  ...
]

以及一个依赖关系数组：
[
  {{"from": "源节点id", "to": "目标节点id"}},
  ...
]

注意：
1. 节点位置(x,y)请合理分布，避免重叠
2. 文件夹用橙色(#FF8C42)，文件用绿色(#4CAF50)
3. 依赖关系表示文件属于哪个文件夹，或文件之间的引用关系
4. 只返回JSON数据，不要其他解释

请返回完整JSON格式：{{"nodes": [...], "edges": [...]}}"#,
        structure_json
    );

    let request_body = DeepSeekRequest {
        model,
        messages: vec![DeepSeekMessage {
            role: "user".to_string(),
            content: prompt,
        }],
        stream: false,
        max_tokens: Some(1200),
        temperature: Some(0.1),
    };

    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, text));
    }

    let result: DeepSeekResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if let Some(choice) = result.choices.first() {
        Ok(choice.message.content.clone())
    } else {
        Err("API 返回空内容".to_string())
    }
}

/// 保存项目列表到本地
#[tauri::command]
fn save_projects(projects: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let projects_file = base_dir.join("projects.json");
    fs::write(&projects_file, projects).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从本地加载项目列表
#[tauri::command]
fn load_projects(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let projects_file = base_dir.join("projects.json");
    if !projects_file.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&projects_file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存草稿数据到 .xt/draft.json
#[tauri::command]
fn save_draft(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let draft_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("draft.json");

    if let Some(parent) = draft_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&draft_file, data).map_err(|e| format!("写入草稿文件失败: {}", e))?;
    Ok(())
}

/// 从 .xt/draft.json 加载草稿数据
#[tauri::command]
fn load_draft(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let draft_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("draft.json");

    if !draft_file.exists() {
        return Ok("null".to_string());
    }

    let content =
        fs::read_to_string(&draft_file).map_err(|e| format!("读取草稿文件失败: {}", e))?;
    Ok(content)
}

/// 保存应用状态（最后打开的项目等）
#[tauri::command]
fn save_app_state(state: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let state_file = base_dir.join("app_state.json");
    fs::write(&state_file, state).map_err(|e| e.to_string())?;
    Ok(())
}

/// 加载应用状态
#[tauri::command]
fn load_app_state(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let state_file = base_dir.join("app_state.json");
    if !state_file.exists() {
        return Ok("{}".to_string());
    }
    let content = fs::read_to_string(&state_file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存密钥池到本地
#[tauri::command]
fn save_key_pool(items: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("key_pool.json");
    fs::write(&file, items).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从本地加载密钥池
#[tauri::command]
fn load_key_pool(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("key_pool.json");
    if !file.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存专家团配置到本地
#[tauri::command]
fn save_experts(config: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("experts.json");
    fs::write(&file, config).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从本地加载专家团配置
#[tauri::command]
fn load_experts(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("experts.json");
    if !file.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 获取沙箱项目路径（优先使用显式路径，再从 projects.json 解析外部项目路径）
fn resolve_sandbox_project_dir(
    project_name: &str,
    project_path: Option<&str>,
    app_handle: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    // 1. 最高优先级：前端显式传入的 workspacePath
    if let Some(pp) = project_path {
        let pp_trimmed = pp.trim();
        if !pp_trimmed.is_empty() {
            let path = PathBuf::from(pp_trimmed);
            if path.exists() {
                match path.canonicalize() {
                    Ok(canon) => return Ok(canon),
                    Err(_) => return Ok(dunce::simplified(&path).to_path_buf()),
                }
            } else {
                // 路径不存在时自动创建，确保工作目录可用
                fs::create_dir_all(&path)
                    .map_err(|e| format!("工作目录不存在且创建失败: {}", e))?;
                match path.canonicalize() {
                    Ok(canon) => return Ok(canon),
                    Err(_) => return Ok(dunce::simplified(&path).to_path_buf()),
                }
            }
        }
    }
    // 2. Fallback：从 projects.json 查找
    get_project_dir(project_name, app_handle)
}

/// 获取项目工作区路径（从 projects.json 解析外部项目路径）
fn get_project_dir(project_name: &str, app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    // 从 projects.json 查找外部项目的 workspacePath
    let projects_file = base_dir.join("projects.json");
    if projects_file.exists() {
        if let Ok(content) = fs::read_to_string(&projects_file) {
            if let Ok(projects) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                for p in &projects {
                    if p["name"].as_str() == Some(project_name) {
                        if let Some(wp) = p["workspacePath"].as_str() {
                            if !wp.is_empty() {
                                let path = PathBuf::from(wp);
                                if path.exists() {
                                    // 返回规范化路径，避免反斜杠/大小写不一致问题
                                    match path.canonicalize() {
                                        Ok(canon) => return Ok(canon),
                                        Err(_) => {
                                            // 如果 canonicalize 失败（如网络路径），
                                            // 至少统一使用正斜杠并解析 . 和 ..
                                            return Ok(dunce::simplified(&path).to_path_buf());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let fallback = base_dir.join("workspaces").join(project_name);
    // 对默认路径同样做规范化
    match fallback.canonicalize() {
        Ok(canon) => Ok(canon),
        Err(_) => Ok(dunce::simplified(&fallback).to_path_buf()),
    }
}

/// 校验沙箱路径（确保不越界）
fn validate_sandbox_path(base: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    // 检查是否包含 ..
    let target_str = target.to_string_lossy();
    if target_str.contains("..") {
        return Err("路径包含非法字符 ..".to_string());
    }

    // 检查是否在 base 目录下（使用 dunce::simplified 规范化后比较，避免反斜杠问题）
    let canonical_base = dunce::simplified(base);
    let canonical_target = dunce::simplified(target);
    if !canonical_target.starts_with(canonical_base) {
        return Err("路径超出沙箱范围".to_string());
    }

    // 禁止访问 .xt 配置文件夹
    let xt_path = canonical_base.join(".xt");
    let xt_path_str = xt_path.to_string_lossy().to_string();
    let target_str = canonical_target.to_string_lossy().to_string();
    if target_str.starts_with(&xt_path_str) {
        return Err("禁止访问 .xt 配置文件夹".to_string());
    }

    Ok(())
}

/// 沙箱：创建文件夹
#[tauri::command]
fn sandbox_create_folder(
    project_name: String,
    relative_path: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    fs::create_dir_all(&target).map_err(|e| format!("创建文件夹失败: {}", e))?;
    // 验证目录真实存在
    if !target.exists() {
        return Err(format!("创建文件夹失败：目录 {} 未实际落盘", relative_path));
    }
    Ok(target.to_string_lossy().to_string())
}

/// 沙箱：创建文件
#[tauri::command]
fn sandbox_create_file(
    project_name: String,
    relative_path: String,
    content: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    // 确保父目录存在
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
    }

    fs::write(&target, &content).map_err(|e| format!("创建文件失败: {}", e))?;
    // 写入后验证：确认文件真实落盘
    if !target.exists() {
        return Err(format!("创建文件失败：文件 {} 未实际落盘", relative_path));
    }
    // 验证内容一致性
    let written = fs::read_to_string(&target).unwrap_or_default();
    if written.len() != content.len() {
        return Err(format!(
            "创建文件校验失败：预期 {} 字节，实际 {} 字节",
            content.len(),
            written.len()
        ));
    }
    Ok(target.to_string_lossy().to_string())
}

/// 沙箱：读取文件（文本）
#[tauri::command]
fn sandbox_read_file(
    project_name: String,
    relative_path: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() {
        return Err("文件不存在".to_string());
    }

    let content = fs::read_to_string(&target).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(content)
}

/// 沙箱：读取文件为 Base64（用于图片等二进制文件预览）
#[tauri::command]
fn sandbox_read_file_base64(
    project_name: String,
    relative_path: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() {
        return Err("文件不存在".to_string());
    }

    let bytes = fs::read(&target).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(BASE64.encode(&bytes))
}

/// 沙箱：编辑文件（局部替换）
/// 在现有文件中查找 search_text 并替换为 replace_text
#[tauri::command]
fn sandbox_edit_file(
    project_name: String,
    relative_path: String,
    search_text: String,
    replace_text: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() {
        return Err(format!("文件 {} 不存在，无法执行局部编辑", relative_path));
    }

    let content = fs::read_to_string(&target).map_err(|e| format!("读取文件失败: {}", e))?;

    let new_content = apply_text_replacement(&content, &search_text, &replace_text).map_err(|_| {
        format!(
            "在 {} 中未找到待替换的文本，请检查 search_text 是否与文件中内容一致（已自动兼容 LF/CRLF/空白差异）",
            relative_path
        )
    })?;

    fs::write(&target, &new_content).map_err(|e| format!("写入文件失败: {}", e))?;
    // 写入后验证
    if !target.exists() {
        return Err(format!("编辑文件失败：文件 {} 未实际落盘", relative_path));
    }
    Ok(())
}

/// 沙箱：写入文件
#[tauri::command]
fn sandbox_write_file(
    project_name: String,
    relative_path: String,
    content: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    // 自动创建父目录
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }

    fs::write(&target, &content).map_err(|e| format!("写入文件失败: {}", e))?;
    // 写入后验证：确认文件真实落盘
    if !target.exists() {
        return Err(format!("写入文件失败：文件 {} 未实际落盘", relative_path));
    }
    // 验证内容一致性
    let written = fs::read_to_string(&target).unwrap_or_default();
    if written.len() != content.len() {
        return Err(format!(
            "写入文件校验失败：预期 {} 字节，实际 {} 字节",
            content.len(),
            written.len()
        ));
    }
    Ok(())
}

// ========== 受保护变更会话 ==========

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangeSet {
    operation: String,
    path: String,
    search_text: Option<String>,
    replace_text: Option<String>,
    content: Option<String>,
    rationale: Option<String>,
    risk: Option<String>,
    allow_overwrite: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredChange {
    change: ChangeSet,
    before_content: Option<String>,
    after_content: Option<String>,
    before_hash: Option<String>,
    diff: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangeSessionMetrics {
    files_changed: usize,
    full_overwrite_count: usize,
    missing_required_files: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangeSession {
    id: String,
    project_name: String,
    task_description: String,
    status: String,
    required_files: Vec<String>,
    changes: Vec<StoredChange>,
    diff: String,
    errors: Vec<String>,
    metrics: ChangeSessionMetrics,
    created_at: String,
    applied_at: Option<String>,
    rolled_back_at: Option<String>,
}

fn change_sessions_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".xt").join("change_sessions")
}

fn change_session_path(project_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    if session_id.contains("..") || session_id.contains('/') || session_id.contains('\\') {
        return Err("非法变更会话 ID".to_string());
    }
    Ok(change_sessions_dir(project_dir).join(format!("{}.json", session_id)))
}

fn now_rfc3339() -> String {
    chrono::Local::now().to_rfc3339()
}

fn content_hash(content: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn load_change_session(project_dir: &Path, session_id: &str) -> Result<ChangeSession, String> {
    let path = change_session_path(project_dir, session_id)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取变更会话失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析变更会话失败: {}", e))
}

fn save_change_session(project_dir: &Path, session: &ChangeSession) -> Result<(), String> {
    let dir = change_sessions_dir(project_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("创建变更会话目录失败: {}", e))?;
    let path = change_session_path(project_dir, &session.id)?;
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("保存变更会话失败: {}", e))
}

fn append_change_metric(
    project_dir: &Path,
    session: &ChangeSession,
    event: &str,
) -> Result<(), String> {
    let path = project_dir.join(".xt").join("change_metrics.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建指标目录失败: {}", e))?;
    }
    let mut records: Vec<serde_json::Value> = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    records.push(serde_json::json!({
        "event": event,
        "sessionId": session.id,
        "status": session.status,
        "filesChanged": session.metrics.files_changed,
        "fullOverwriteCount": session.metrics.full_overwrite_count,
        "missingRequiredFiles": session.metrics.missing_required_files,
        "timestamp": now_rfc3339(),
    }));
    let json = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("写入变更指标失败: {}", e))
}

fn line_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0usize;
    for segment in text.split_inclusive('\n') {
        let end = start + segment.len();
        spans.push((start, end));
        start = end;
    }
    if start < text.len() {
        spans.push((start, text.len()));
    }
    spans
}

fn trim_search_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.lines().collect();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines
}

fn replace_unique_trimmed_line_block(
    normalized_content: &str,
    normalized_search: &str,
    normalized_replace: &str,
) -> Option<String> {
    let search_lines = trim_search_lines(normalized_search);
    if search_lines.is_empty() {
        return None;
    }

    let spans = line_spans(normalized_content);
    if spans.len() < search_lines.len() {
        return None;
    }

    let mut matched_range: Option<(usize, usize)> = None;
    for start_idx in 0..=spans.len() - search_lines.len() {
        let is_match = search_lines
            .iter()
            .enumerate()
            .all(|(offset, search_line)| {
                let (line_start, line_end) = spans[start_idx + offset];
                let line = normalized_content[line_start..line_end]
                    .trim_end_matches('\n')
                    .trim();
                line == search_line.trim()
            });
        if !is_match {
            continue;
        }
        let candidate = (
            spans[start_idx].0,
            spans[start_idx + search_lines.len() - 1].1,
        );
        if matched_range.is_some() {
            return None;
        }
        matched_range = Some(candidate);
    }

    matched_range.map(|(start, end)| {
        let before = &normalized_content[..start];
        let after = &normalized_content[end..];
        format!("{}{}{}", before, normalized_replace, after)
    })
}

fn apply_text_replacement(
    content: &str,
    search_text: &str,
    replace_text: &str,
) -> Result<String, String> {
    if search_text.is_empty() {
        return Err("局部编辑缺少 searchText，拒绝生成不可定位补丁".to_string());
    }
    if let Some(merged) = try_apply_text_replacement_variants(content, search_text, replace_text) {
        return Ok(merged);
    }

    let stripped_search = strip_leading_descriptive_comments(search_text);
    let stripped_replace = strip_leading_descriptive_comments(replace_text);
    if stripped_search != search_text || stripped_replace != replace_text {
        if let Some(merged) =
            try_apply_text_replacement_variants(content, &stripped_search, &stripped_replace)
        {
            return Ok(merged);
        }
        if let Some(merged) = replace_unique_css_rule(content, &stripped_search, &stripped_replace)
        {
            return Ok(merged);
        }
    }

    Err("局部编辑未找到 searchText，拒绝静默失败或全量重写".to_string())
}

fn try_apply_text_replacement_variants(
    content: &str,
    search_text: &str,
    replace_text: &str,
) -> Option<String> {
    let replace_already_present = |haystack: &str, replacement: &str| -> bool {
        if replacement.is_empty() {
            return false;
        }
        if haystack.contains(replacement) {
            return true;
        }
        let trimmed_replacement = replacement.trim();
        !trimmed_replacement.is_empty() && haystack.contains(trimmed_replacement)
    };

    if search_text.is_empty() {
        return None;
    }
    if let Some(pos) = content.find(search_text) {
        let before = &content[..pos];
        let after = &content[pos + search_text.len()..];
        return Some(format!("{}{}{}", before, replace_text, after));
    }

    let normalized_content = content.replace("\r\n", "\n");
    let normalized_search = search_text.replace("\r\n", "\n");
    let normalized_replace = replace_text.replace("\r\n", "\n");
    if let Some(pos) = normalized_content.find(&normalized_search) {
        let before = &normalized_content[..pos];
        let after = &normalized_content[pos + normalized_search.len()..];
        let merged = format!("{}{}{}", before, normalized_replace, after);
        return Some(if content.contains("\r\n") {
            merged.replace('\n', "\r\n")
        } else {
            merged
        });
    }

    if replace_already_present(content, replace_text)
        || replace_already_present(&normalized_content, &normalized_replace)
    {
        return Some(content.to_string());
    }

    if normalized_search.trim().is_empty() {
        return None;
    }

    let trimmed_search = normalized_search.trim();
    let mut matches = normalized_content.match_indices(trimmed_search);
    let first = matches.next();
    let second = matches.next();
    if let (Some((pos, _)), None) = (first, second) {
        let before = &normalized_content[..pos];
        let after = &normalized_content[pos + trimmed_search.len()..];
        let merged = format!("{}{}{}", before, normalized_replace, after);
        return Some(if content.contains("\r\n") {
            merged.replace('\n', "\r\n")
        } else {
            merged
        });
    }

    if let Some(merged) = replace_unique_trimmed_line_block(
        &normalized_content,
        &normalized_search,
        &normalized_replace,
    ) {
        return Some(if content.contains("\r\n") {
            merged.replace('\n', "\r\n")
        } else {
            merged
        });
    }

    if replace_already_present(content, replace_text)
        || replace_already_present(&normalized_content, &normalized_replace)
    {
        return Some(content.to_string());
    }

    None
}

fn strip_leading_descriptive_comments(text: &str) -> String {
    let comment_prefix_re =
        Regex::new(r"(?s)^\s*(?:(?:/\*.*?\*/|<!--.*?-->)[ \t\r\n]*)+").expect("comment prefix regex");
    comment_prefix_re.replace(text, "").to_string()
}

fn replace_unique_css_rule(content: &str, search_text: &str, replace_text: &str) -> Option<String> {
    let normalized_content = content.replace("\r\n", "\n");
    let normalized_search = search_text.replace("\r\n", "\n");
    let normalized_replace = replace_text.replace("\r\n", "\n");
    let search_selector = extract_css_rule_selector(&normalized_search)?;
    let replace_selector = extract_css_rule_selector(&normalized_replace)?;
    if search_selector != replace_selector {
        return None;
    }

    let rule_re = Regex::new(&format!(
        r"(?ms)^[ \t]*{}\s*\{{[\s\S]*?^[ \t]*\}}",
        regex::escape(&search_selector)
    ))
    .ok()?;
    let mut matches = rule_re.find_iter(&normalized_content);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    let mut merged = String::with_capacity(normalized_content.len() + normalized_replace.len());
    merged.push_str(&normalized_content[..first.start()]);
    merged.push_str(normalized_replace.trim());
    merged.push_str(&normalized_content[first.end()..]);
    Some(if content.contains("\r\n") {
        merged.replace('\n', "\r\n")
    } else {
        merged
    })
}

fn extract_css_rule_selector(snippet: &str) -> Option<String> {
    let trimmed = snippet.trim();
    let brace_index = trimmed.find('{')?;
    if !trimmed.ends_with('}') {
        return None;
    }
    let selector = trimmed[..brace_index].trim();
    if selector.is_empty() || selector.contains('\n') {
        return None;
    }
    Some(selector.to_string())
}

fn build_simple_diff(path: &str, before: Option<&str>, after: Option<&str>) -> String {
    let mut diff = format!("--- {}\n+++ {}\n", path, path);
    if before == after {
        diff.push_str("(no changes)\n");
        return diff;
    }
    if let Some(old) = before {
        for line in old.lines().take(200) {
            diff.push('-');
            diff.push_str(line);
            diff.push('\n');
        }
        if old.lines().count() > 200 {
            diff.push_str("-...(old content truncated)\n");
        }
    }
    if let Some(new) = after {
        for line in new.lines().take(200) {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        if new.lines().count() > 200 {
            diff.push_str("+(new content truncated)\n");
        }
    }
    diff
}

fn normalize_change_operation(op: &str) -> String {
    op.trim().to_ascii_lowercase().replace('-', "_")
}

fn prepare_change_with_before_content(
    project_dir: &Path,
    change: ChangeSet,
    before_content_override: Option<Option<String>>,
) -> Result<StoredChange, String> {
    let relative = change.path.trim().to_string();
    if relative.is_empty() {
        return Err("变更缺少 path".to_string());
    }
    let target = project_dir.join(&relative);
    validate_sandbox_path(project_dir, &target)?;

    let operation = normalize_change_operation(&change.operation);
    if operation == "create_folder" {
        return Ok(StoredChange {
            change,
            before_content: None,
            after_content: None,
            before_hash: None,
            diff: format!("create folder {}\n", relative),
        });
    }

    let before_content = match before_content_override {
        Some(content) => content,
        None => {
            if target.exists() {
                Some(
                    fs::read_to_string(&target)
                        .map_err(|e| format!("读取 {} 失败: {}", relative, e))?,
                )
            } else {
                None
            }
        }
    };
    let before_hash = before_content.as_ref().map(|c| content_hash(c));
    let allow_overwrite = change.allow_overwrite.unwrap_or(false);

    let after_content = match operation.as_str() {
        "create_file" => {
            if before_content.is_some() && !allow_overwrite {
                return Err(format!(
                    "{} 已存在，CREATE_FILE 不允许覆盖已有文件",
                    relative
                ));
            }
            Some(change.content.clone().unwrap_or_default())
        }
        "write_file" => {
            Some(change.content.clone().unwrap_or_default())
        }
        "edit_file" => {
            let current = before_content
                .as_ref()
                .ok_or_else(|| format!("{} 不存在，无法执行局部编辑", relative))?;
            let search = change.search_text.as_deref().unwrap_or("");
            let replace = change.replace_text.as_deref().unwrap_or("");
            Some(apply_text_replacement(current, search, replace)?)
        }
        "delete" => None,
        _ => return Err(format!("未知变更操作: {}", change.operation)),
    };

    let diff = build_simple_diff(
        &relative,
        before_content.as_deref(),
        after_content.as_deref(),
    );
    Ok(StoredChange {
        change,
        before_content,
        after_content,
        before_hash,
        diff,
    })
}

fn prepare_change(project_dir: &Path, change: ChangeSet) -> Result<StoredChange, String> {
    prepare_change_with_before_content(project_dir, change, None)
}

fn prepare_changes_sequentially(
    project_dir: &Path,
    changes: Vec<ChangeSet>,
) -> (Vec<StoredChange>, Vec<String>) {
    let mut stored_changes = Vec::new();
    let mut errors = Vec::new();
    let mut current_contents: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();

    for change in changes {
        let relative = change.path.trim().to_string();
        let operation = normalize_change_operation(&change.operation);
        let before_override = if operation == "create_folder" {
            None
        } else {
            current_contents.get(&relative).cloned().map(Some).unwrap_or(None)
        };

        match prepare_change_with_before_content(project_dir, change.clone(), before_override) {
            Ok(stored) => {
                if operation != "create_folder" {
                    current_contents.insert(relative, stored.after_content.clone());
                }
                stored_changes.push(stored);
            }
            Err(e) => errors.push(format!("{}: {}", change.path, e)),
        }
    }

    (stored_changes, errors)
}

#[tauri::command]
fn create_change_session(
    project_name: String,
    task_description: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let session = ChangeSession {
        id: format!("change-{}", uuid::Uuid::new_v4()),
        project_name,
        task_description,
        status: "draft".to_string(),
        required_files: vec![],
        changes: vec![],
        diff: String::new(),
        errors: vec![],
        metrics: ChangeSessionMetrics {
            files_changed: 0,
            full_overwrite_count: 0,
            missing_required_files: vec![],
        },
        created_at: now_rfc3339(),
        applied_at: None,
        rolled_back_at: None,
    };
    save_change_session(&project_dir, &session)?;
    serde_json::to_string(&session).map_err(|e| e.to_string())
}

#[tauri::command]
fn propose_patch(
    project_name: String,
    task_description: String,
    changes: Vec<ChangeSet>,
    required_files: Option<Vec<String>>,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let required_files = required_files.unwrap_or_default();
    let attempted_files: std::collections::HashSet<String> = changes
        .iter()
        .map(|change| change.path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect();
    let (stored_changes, mut errors) = prepare_changes_sequentially(&project_dir, changes);

    let changed_files: std::collections::HashSet<String> = stored_changes
        .iter()
        .map(|c| c.change.path.clone())
        .collect();
    let missing_required_files: Vec<String> = required_files
        .iter()
        .filter(|p| !changed_files.contains(*p) && !attempted_files.contains(*p))
        .cloned()
        .collect();
    if !missing_required_files.is_empty() {
        errors.push(format!(
            "变更覆盖不足，以下必检文件未被修改或明确处理: {}",
            missing_required_files.join(", ")
        ));
    }

    let full_overwrite_count = stored_changes
        .iter()
        .filter(|c| {
            normalize_change_operation(&c.change.operation) == "write_file"
                && c.before_content.is_some()
        })
        .count();
    let diff = stored_changes
        .iter()
        .map(|c| c.diff.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let status = if errors.is_empty() {
        "proposed"
    } else {
        "blocked"
    }
    .to_string();

    let session = ChangeSession {
        id: format!("change-{}", uuid::Uuid::new_v4()),
        project_name,
        task_description,
        status,
        required_files,
        changes: stored_changes,
        diff,
        errors,
        metrics: ChangeSessionMetrics {
            files_changed: changed_files.len(),
            full_overwrite_count,
            missing_required_files,
        },
        created_at: now_rfc3339(),
        applied_at: None,
        rolled_back_at: None,
    };

    save_change_session(&project_dir, &session)?;
    let _ = append_change_metric(&project_dir, &session, "proposed");
    serde_json::to_string(&session).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_approved_patch(
    project_name: String,
    session_id: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let mut session = load_change_session(&project_dir, &session_id)?;
    if session.status == "blocked" {
        return Err(format!(
            "变更会话被阻断，不能合入: {}",
            session.errors.join("；")
        ));
    }
    if session.status == "applied" {
        return Ok(serde_json::to_string(&session).map_err(|e| e.to_string())?);
    }

    let mut staged_contents: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for stored in &session.changes {
        let relative = stored.change.path.trim();
        let target = project_dir.join(relative);
        validate_sandbox_path(&project_dir, &target)?;
        let operation = normalize_change_operation(&stored.change.operation);

        if operation == "create_folder" {
            continue;
        }

        let current = if let Some(existing) = staged_contents.get(relative) {
            existing.clone()
        } else if target.exists() {
            Some(fs::read_to_string(&target).map_err(|e| format!("合入前读取 {} 失败: {}", relative, e))?)
        } else {
            None
        };

        if current != stored.before_content {
            let conflict_message = match (&stored.before_content, &current) {
                (Some(_), Some(_)) => format!("{} 已被修改，合入停止以避免覆盖用户变更", relative),
                (None, Some(_)) if operation != "delete" => {
                    format!("{} 在提案后被创建，合入停止以避免覆盖", relative)
                }
                (Some(_), None) => format!("{} 在提案后丢失，合入停止", relative),
                _ => format!("{} 当前内容与提案基底不一致，合入停止", relative),
            };
            return Err(conflict_message);
        }

        staged_contents.insert(relative.to_string(), stored.after_content.clone());
    }

    for stored in &session.changes {
        let relative = stored.change.path.trim();
        let target = project_dir.join(relative);
        let operation = normalize_change_operation(&stored.change.operation);
        match operation.as_str() {
            "create_folder" => {
                fs::create_dir_all(&target)
                    .map_err(|e| format!("创建目录 {} 失败: {}", relative, e))?;
            }
            "delete" => {
                if target.is_dir() {
                    fs::remove_dir(&target)
                        .map_err(|e| format!("删除目录 {} 失败: {}", relative, e))?;
                } else if target.exists() {
                    fs::remove_file(&target)
                        .map_err(|e| format!("删除文件 {} 失败: {}", relative, e))?;
                }
            }
            _ => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
                }
                let after = stored.after_content.as_deref().unwrap_or("");
                fs::write(&target, after).map_err(|e| format!("写入 {} 失败: {}", relative, e))?;
            }
        }
    }

    session.status = "applied".to_string();
    session.applied_at = Some(now_rfc3339());
    save_change_session(&project_dir, &session)?;
    let _ = append_change_metric(&project_dir, &session, "applied");
    serde_json::to_string(&session).map_err(|e| e.to_string())
}

#[tauri::command]
fn rollback_change_session(
    project_name: String,
    session_id: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let mut session = load_change_session(&project_dir, &session_id)?;
    if session.status != "applied" {
        return Err("只有已合入的变更会话可以回滚".to_string());
    }

    for stored in session.changes.iter().rev() {
        let relative = stored.change.path.trim();
        let target = project_dir.join(relative);
        validate_sandbox_path(&project_dir, &target)?;
        let operation = normalize_change_operation(&stored.change.operation);

        if operation == "create_folder" {
            if target.is_dir() {
                let _ = fs::remove_dir(&target);
            }
            continue;
        }

        match &stored.before_content {
            Some(before) => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
                }
                fs::write(&target, before).map_err(|e| format!("回滚 {} 失败: {}", relative, e))?;
            }
            None => {
                if target.is_file() {
                    fs::remove_file(&target)
                        .map_err(|e| format!("回滚删除 {} 失败: {}", relative, e))?;
                }
            }
        }
    }

    session.status = "rolled_back".to_string();
    session.rolled_back_at = Some(now_rfc3339());
    save_change_session(&project_dir, &session)?;
    let _ = append_change_metric(&project_dir, &session, "rolled_back");
    serde_json::to_string(&session).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct TreeEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    children: Option<Vec<TreeEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(rename = "modifiedAtMs", skip_serializing_if = "Option::is_none")]
    modified_at_ms: Option<u64>,
}

/// 词元使用记录
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TokenUsageRecord {
    id: String,
    expert_id: String,
    expert_name: String,
    model: String,
    key_id: String,
    timestamp: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}

/// 词元配额配置
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TokenAllocation {
    expert_id: String,
    daily_limit: Option<u64>,
    monthly_limit: Option<u64>,
    yearly_limit: Option<u64>,
}

/// 词元数据（记录 + 配额）
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TokenData {
    records: Vec<TokenUsageRecord>,
    allocations: Vec<TokenAllocation>,
    last_reset_daily: String,
    last_reset_monthly: String,
    last_reset_yearly: String,
}

/// 沙箱：列出目录内容
#[tauri::command]
fn sandbox_list_dir(
    project_name: String,
    relative_path: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() || !target.is_dir() {
        return Err("目录不存在".to_string());
    }

    /// 目录树条目上限
    const MAX_TREE_ENTRIES: usize = 10_000;

    fn read_dir_recursive(
        base: &PathBuf,
        current: &PathBuf,
        counter: &mut usize,
    ) -> Result<Vec<TreeEntry>, String> {
        let mut entries = vec![];
        for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
            if *counter >= MAX_TREE_ENTRIES {
                break;
            }

            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();

            // 可视化目录只展示用户项目内容，排除 .xt/.git 等隐藏元数据
            if name.starts_with('.') {
                continue;
            }

            let full_path = entry.path();

            // 跳过常见无关目录
            if full_path.is_dir()
                && (full_path.is_symlink() || SCAN_SKIP_DIRS.contains(&name.as_str()))
            {
                continue;
            }

            let relative = full_path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string()
                .replace("\\", "/");

            let is_dir = full_path.is_dir();
            let metadata = entry.metadata().ok();
            let mut tree_entry = TreeEntry {
                name,
                path: relative,
                entry_type: if is_dir {
                    "folder".to_string()
                } else {
                    "file".to_string()
                },
                children: None,
                size: metadata.as_ref().map(|value| value.len()),
                modified_at_ms: metadata
                    .as_ref()
                    .and_then(|value| value.modified().ok())
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|value| value.as_millis() as u64),
            };

            *counter += 1;

            if is_dir {
                match read_dir_recursive(base, &full_path, counter) {
                    Ok(children) => {
                        tree_entry.children = Some(children);
                    }
                    Err(_) => {
                        tree_entry.children = Some(vec![]);
                    }
                }
            }

            entries.push(tree_entry);
        }

        // 文件夹在前，文件在后，各自按名称排序
        entries.sort_by(|a, b| {
            let a_is_dir = a.entry_type == "folder";
            let b_is_dir = b.entry_type == "folder";
            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(entries)
    }

    let mut counter = 0usize;
    let entries = read_dir_recursive(&project_dir, &target, &mut counter)?;
    Ok(serde_json::to_string(&entries).map_err(|e| e.to_string())?)
}

/// 沙箱：删除文件或空文件夹
#[tauri::command]
fn sandbox_delete(
    project_name: String,
    relative_path: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if target.is_dir() {
        fs::remove_dir(&target).map_err(|e| format!("删除文件夹失败: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    Ok(())
}

/// 工作目录连接验证：确认路径可达、可读写，并返回真实规范化路径
#[tauri::command]
fn validate_workspace_connection(
    project_name: String,
    project_path: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir =
        resolve_sandbox_project_dir(&project_name, project_path.as_deref(), &app_handle)?;

    // 检查目录存在
    if !project_dir.exists() {
        return Err(format!("工作目录不存在: {}", project_dir.display()));
    }
    if !project_dir.is_dir() {
        return Err(format!("工作路径不是目录: {}", project_dir.display()));
    }

    // 尝试写入+读取测试文件
    let test_file = project_dir.join(".xt").join(".connection_test");
    if let Some(parent) = test_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let test_content = format!(
        "xt-connection-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    fs::write(&test_file, &test_content).map_err(|e| format!("工作目录不可写: {}", e))?;
    let read_back = fs::read_to_string(&test_file).map_err(|e| format!("工作目录不可读: {}", e))?;
    let _ = fs::remove_file(&test_file); // 清理测试文件

    if read_back != test_content {
        return Err("工作目录读写验证失败：写入与读回内容不一致".to_string());
    }

    // 返回规范化路径信息
    Ok(serde_json::json!({
        "path": project_dir.to_string_lossy(),
        "exists": true,
        "readable": true,
        "writable": true,
    })
    .to_string())
}

/// 保存可视化目录数据到 .xt/config.json
/// data 格式: { mode: "structure" | "logic", nodes, edges, updatedAt, directorySnapshot }
/// 会按 mode 分别存入 canvasDirectory.structure 或 canvasDirectory.logic
#[tauri::command]
fn save_canvas_directory(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let config_file = project_dir.join(".xt").join("config.json");

    if !config_file.exists() {
        ensure_xt_config(project_name.clone(), app_handle.clone())?;
    }

    let content =
        fs::read_to_string(&config_file).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let mut config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {}", e))?;

    let dir_data: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("解析目录数据失败: {}", e))?;

    // 获取 mode，决定存到 structure 还是 logic 子字段
    let mode = dir_data
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("structure");

    if let Some(obj) = config.as_object_mut() {
        let canvas_dir = obj
            .entry("canvasDirectory")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(canvas_obj) = canvas_dir.as_object_mut() {
            canvas_obj.insert(mode.to_string(), dir_data);
        }
    }

    let updated = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_file, updated).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 从 .xt/config.json 加载可视化目录数据
/// 返回整个 canvasDirectory 对象（包含 structure 和 logic 两个子字段），如果不存在返回 null
#[tauri::command]
fn load_canvas_directory(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let config_file = project_dir.join(".xt").join("config.json");

    if !config_file.exists() {
        return Ok("null".to_string());
    }

    let content =
        fs::read_to_string(&config_file).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {}", e))?;

    // 返回整个 canvasDirectory 对象（包含 structure 和 logic），如果不存在返回 null
    if let Some(dir) = config.get("canvasDirectory") {
        Ok(dir.to_string())
    } else {
        Ok("null".to_string())
    }
}

/// 保存项目到数据库
#[tauri::command]
async fn db_save_project(
    id: i64,
    name: String,
    icon_color: String,
    workspace_path: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO projects (id, name, icon_color, workspace_path) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(name)
        .bind(icon_color)
        .bind(workspace_path)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 从数据库加载所有项目
#[tauri::command]
async fn db_load_projects(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT id, name, icon_color, workspace_path FROM projects ORDER BY created_at",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    let projects: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "id": row.get::<i64, _>("id"),
                "name": row.get::<String, _>("name"),
                "iconColor": row.get::<String, _>("icon_color"),
                "workspacePath": row.get::<Option<String>, _>("workspace_path"),
            })
        })
        .collect();

    Ok(serde_json::to_string(&projects).map_err(|e| e.to_string())?)
}

/// 保存会话到数据库
#[tauri::command]
async fn db_save_session(
    project_id: i64,
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<i64, String> {
    let result = sqlx::query("INSERT INTO sessions (project_id, name) VALUES (?, ?)")
        .bind(project_id)
        .bind(name)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result.last_insert_rowid())
}

/// 保存消息到数据库
#[tauri::command]
async fn db_save_message(
    session_id: i64,
    role: String,
    content: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .bind(session_id)
        .bind(role)
        .bind(content)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清除某个会话的所有消息（用于重新保存时去重）
#[tauri::command]
async fn db_clear_messages(
    session_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM messages WHERE session_id = ?")
        .bind(session_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除某个会话（级联删除其消息）
#[tauri::command]
async fn db_delete_session(
    session_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(session_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存项目聊天会话到 .xt/chat_sessions.json（项目级持久化）
#[tauri::command]
fn save_chat_sessions(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let sessions_file = project_dir.join(".xt").join("chat_sessions.json");

    // 确保 .xt 目录存在
    if let Some(parent) = sessions_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&sessions_file, &data).map_err(|e| format!("写入会话文件失败: {}", e))?;
    Ok(())
}

/// 从项目 .xt/chat_sessions.json 加载聊天会话
#[tauri::command]
fn load_chat_sessions(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let sessions_file = project_dir.join(".xt").join("chat_sessions.json");

    if !sessions_file.exists() {
        return Ok("null".to_string());
    }

    let content =
        fs::read_to_string(&sessions_file).map_err(|e| format!("读取会话文件失败: {}", e))?;
    Ok(content)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptModuleTraceRecord {
    expert_id: String,
    scene: String,
    task_description: String,
    module_ids: Vec<String>,
    trigger_sources: Vec<String>,
    created_at: i64,
}

#[tauri::command]
fn load_prompt_module_traces(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let trace_file = project_dir.join(".xt").join("prompt_module_traces.json");

    if !trace_file.exists() {
        return Ok("[]".to_string());
    }

    let content =
        fs::read_to_string(&trace_file).map_err(|e| format!("读取提示模块轨迹失败: {}", e))?;
    Ok(content)
}

#[tauri::command]
fn save_prompt_module_traces(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let trace_file = project_dir.join(".xt").join("prompt_module_traces.json");

    if let Some(parent) = trace_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&trace_file, data).map_err(|e| format!("写入提示模块轨迹失败: {}", e))?;
    Ok(())
}

#[tauri::command]
fn append_prompt_module_trace(
    project_name: String,
    trace: PromptModuleTraceRecord,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let trace_file = project_dir.join(".xt").join("prompt_module_traces.json");

    if let Some(parent) = trace_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let mut traces: Vec<PromptModuleTraceRecord> = if trace_file.exists() {
        match fs::read_to_string(&trace_file) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };

    traces.push(trace);
    if traces.len() > 500 {
        let drain_count = traces.len() - 500;
        traces.drain(0..drain_count);
    }

    let data =
        serde_json::to_string(&traces).map_err(|e| format!("序列化提示模块轨迹失败: {}", e))?;
    fs::write(&trace_file, data).map_err(|e| format!("写入提示模块轨迹失败: {}", e))?;
    Ok(())
}

/// 保存词元数据到 .xt/token_data.json
#[tauri::command]
fn save_token_data(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("token_data.json");

    if let Some(parent) = token_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&token_file, data).map_err(|e| format!("写入词元数据失败: {}", e))?;
    Ok(())
}

/// 从 .xt/token_data.json 加载词元数据
#[tauri::command]
fn load_token_data(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("token_data.json");

    if !token_file.exists() {
        let default = TokenData {
            records: vec![],
            allocations: vec![],
            last_reset_daily: String::new(),
            last_reset_monthly: String::new(),
            last_reset_yearly: String::new(),
        };
        return Ok(serde_json::to_string(&default).map_err(|e| e.to_string())?);
    }

    let content =
        fs::read_to_string(&token_file).map_err(|e| format!("读取词元数据失败: {}", e))?;
    Ok(content)
}

/// 保存用户级词元数据到 app_data_dir/user_token_data.json
#[tauri::command]
fn save_user_token_data(data: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir.join("user_token_data.json");

    if let Some(parent) = token_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&token_file, data).map_err(|e| format!("写入用户词元数据失败: {}", e))?;
    Ok(())
}

/// 从 app_data_dir/user_token_data.json 加载用户级词元数据
#[tauri::command]
fn load_user_token_data(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir.join("user_token_data.json");

    if !token_file.exists() {
        let default = TokenData {
            records: vec![],
            allocations: vec![],
            last_reset_daily: String::new(),
            last_reset_monthly: String::new(),
            last_reset_yearly: String::new(),
        };
        return Ok(serde_json::to_string(&default).map_err(|e| e.to_string())?);
    }

    let content =
        fs::read_to_string(&token_file).map_err(|e| format!("读取用户词元数据失败: {}", e))?;
    Ok(content)
}

/// 从数据库加载项目的所有会话和消息
#[tauri::command]
async fn db_load_project_data(
    project_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    // 加载会话
    let session_rows =
        sqlx::query("SELECT id, name FROM sessions WHERE project_id = ? ORDER BY created_at")
            .bind(project_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;

    let mut sessions: Vec<serde_json::Value> = vec![];
    for session_row in &session_rows {
        let session_id: i64 = session_row.get("id");
        let session_name: String = session_row.get("name");

        // 加载消息
        let msg_rows = sqlx::query(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at",
        )
        .bind(session_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

        let messages: Vec<serde_json::Value> = msg_rows
            .iter()
            .map(|row| {
                serde_json::json!({
                    "role": row.get::<String, _>("role"),
                    "content": row.get::<String, _>("content"),
                })
            })
            .collect();

        sessions.push(serde_json::json!({
            "id": session_id,
            "name": session_name,
            "messages": messages,
        }));
    }

    Ok(serde_json::to_string(&sessions).map_err(|e| e.to_string())?)
}

/// 删除项目（级联删除会话和消息）
#[tauri::command]
async fn db_delete_project(id: i64, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)",
    )
    .bind(id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM sessions WHERE project_id = ?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM app_state WHERE key = 'lastProjectId' AND value = ?")
        .bind(id.to_string())
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存应用状态
#[tauri::command]
async fn db_save_state(
    key: String,
    value: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)")
        .bind(key)
        .bind(value)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 加载应用状态
#[tauri::command]
async fn db_load_state(
    key: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let row = sqlx::query("SELECT value FROM app_state WHERE key = ?")
        .bind(key)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(r) = row {
        Ok(r.get::<String, _>("value"))
    } else {
        Ok("".to_string())
    }
}

/// ========== 记忆系统命令 ==========

#[derive(Serialize, Deserialize)]
struct MemorySaveRequest {
    project_name: String,
    entry: memory::MemoryEntry,
}

#[tauri::command]
fn memory_save(req: MemorySaveRequest, app_handle: tauri::AppHandle) -> Result<(), String> {
    let project_dir = get_project_dir(&req.project_name, &app_handle)?;
    memory::save_memory(&project_dir, &req.entry)
}

#[derive(Serialize, Deserialize)]
struct MemorySearchRequest {
    project_name: String,
    query: memory::MemoryQuery,
}

#[tauri::command]
fn memory_search(req: MemorySearchRequest, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&req.project_name, &app_handle)?;
    let results = memory::search_memories(&project_dir, &req.query)?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_delete(
    project_name: String,
    memory_type: String,
    id: String,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    memory::delete_memory(&project_dir, &memory_type, &id)
}

#[tauri::command]
fn memory_clear_type(
    project_name: String,
    memory_type: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    memory::clear_memory_type(&project_dir, &memory_type)
}

#[tauri::command]
fn memory_run_lifecycle(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    memory::run_memory_lifecycle(&project_dir)
}

#[tauri::command]
fn memory_get_stats(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let ephemeral = memory::load_memory_entries(&project_dir, "ephemeral")?.len();
    let working = memory::load_memory_entries(&project_dir, "working")?.len();
    let longterm = memory::load_memory_entries(&project_dir, "longterm")?.len();
    let stats = serde_json::json!({
        "ephemeral": ephemeral,
        "working": working,
        "longterm": longterm,
        "total": ephemeral + working + longterm,
    });
    serde_json::to_string(&stats).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_search_enhanced(
    project_name: String,
    query: memory::MemoryQuery,
    expert_id_filter: Option<String>,
    max_tokens: Option<usize>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let results = memory::search_memories_enhanced(
        &project_dir,
        &query,
        expert_id_filter.as_deref(),
        max_tokens,
    )?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

/// 解析项目目录：优先使用 DB 中的 workspace_path（支持外部项目），否则 fallback 到 workspaces/
async fn resolve_project_dir(
    project_name: &str,
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, Arc<AppState>>,
) -> Result<PathBuf, String> {
    let row = sqlx::query("SELECT workspace_path FROM projects WHERE name = ?")
        .bind(project_name)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| format!("查询项目路径失败: {}", e))?;

    if let Some(row) = row {
        let workspace_path: Option<String> = row.get("workspace_path");
        if let Some(path) = workspace_path {
            if !path.is_empty() {
                let p = PathBuf::from(&path);
                if p.exists() {
                    return Ok(p);
                }
                eprintln!("[INDEX] 外部项目路径不存在，尝试 fallback: {}", path);
            }
        }
    }

    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(base_dir.join("workspaces").join(project_name))
}

/// 构建感知索引（异步，避免阻塞线程池）
#[tauri::command]
async fn perceptual_index_build(
    project_name: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    eprintln!("[INDEX] 构建索引: {}", project_dir.display());
    let status = tokio::task::spawn_blocking(move || perceptual_index::build_index(&project_dir))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::to_string(&status).map_err(|e| e.to_string())?)
}

/// 感知索引融合搜索（返回格式化文本供 AI 上下文使用）
#[tauri::command]
async fn perceptual_index_search(
    project_name: String,
    query: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    perceptual_index::search_formatted(&project_dir, &query)
}

/// 读取项目级逻辑图（供目录画布与自动链路分析使用）
#[tauri::command]
async fn perceptual_index_project_logic_graph(
    project_name: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let result = tokio::task::spawn_blocking(move || {
        perceptual_index::build_project_logic_canvas(&project_dir)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::to_string(&result).map_err(|e| e.to_string())?)
}

/// 读取文件级逻辑图（供文件预览画布与链路验证使用）
#[tauri::command]
async fn perceptual_index_file_logic_graph(
    project_name: String,
    relative_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let result = tokio::task::spawn_blocking(move || {
        perceptual_index::build_file_logic_canvas(&project_dir, &relative_path)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::to_string(&result).map_err(|e| e.to_string())?)
}

/// 查询感知索引状态
#[tauri::command]
async fn perceptual_index_status(
    project_name: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let status = perceptual_index::get_index_status(&project_dir);
    Ok(serde_json::to_string(&status).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn perceptual_index_incremental_update(
    project_name: String,
    changed_files: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let count = tokio::task::spawn_blocking(move || {
        perceptual_index::incremental_update(&project_dir, &changed_files)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "updated_files": count }).to_string())
}

#[tauri::command]
async fn fuzzy_file_search(
    project_name: String,
    query: String,
    max_results: Option<usize>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let max = max_results.unwrap_or(15);
    let results = tokio::task::spawn_blocking(move || {
        perceptual_index::fuzzy_file_search(&project_dir, &query, max)
    })
    .await
    .map_err(|e| e.to_string())?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

// ========== Wiki 知识库命令 ==========

/// 列出仓库导航项
#[tauri::command]
fn repo_list_items(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let items = repo_wiki::list_repo_items(&project_dir);
    Ok(serde_json::to_string(&items).map_err(|e| e.to_string())?)
}

/// 读取知识卡片
#[tauri::command]
fn repo_read_cards(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let cards = repo_wiki::read_cards(&project_dir)?;
    Ok(serde_json::to_string(&cards).map_err(|e| e.to_string())?)
}

/// 读取 Wiki 文章
#[tauri::command]
fn repo_read_wiki(
    project_name: String,
    name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    repo_wiki::read_wiki(&project_dir, &name)
}

/// 全量生成 Knowledge Cards（调用 AI）
#[tauri::command]
async fn repo_generate_cards(
    project_name: String,
    api_key: String,
    model: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let cards = repo_wiki::generate_cards(&project_dir, &api_key, &model).await?;
    Ok(serde_json::to_string(&cards).map_err(|e| e.to_string())?)
}

/// 从卡片二次凝练 Wiki 文章（调用 AI）
#[tauri::command]
async fn repo_synthesize_wiki(
    project_name: String,
    api_key: String,
    model: String,
    name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let wiki = repo_wiki::synthesize_wiki(&project_dir, &api_key, &model, &name).await?;
    Ok(serde_json::to_string(&wiki).map_err(|e| e.to_string())?)
}

/// 增量迭代：对比文件快照，只更新变化的卡片
#[tauri::command]
async fn repo_incremental_update(
    project_name: String,
    api_key: String,
    model: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    repo_wiki::incremental_update(&project_dir, &api_key, &model).await
}

// ========== 交付清单命令 ==========

#[derive(Serialize, Deserialize)]
struct GenerateDeliverableRequest {
    project_name: String,
    task_id: String,
    task_description: String,
    expert_outputs: Vec<ExpertOutputItem>,
}

#[derive(Serialize, Deserialize)]
struct ExpertOutputItem {
    expert_id: String,
    expert_name: String,
    status: String,
    output: String,
}

#[tauri::command]
fn generate_deliverable(
    req: GenerateDeliverableRequest,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&req.project_name, &app_handle)?;

    let outputs: Vec<(String, String, String, String)> = req
        .expert_outputs
        .into_iter()
        .map(|item| (item.expert_id, item.expert_name, item.status, item.output))
        .collect();

    let deliverable =
        deliverables::generate_deliverable(&req.task_id, &req.task_description, &outputs);
    deliverables::save_deliverable(&project_dir, &deliverable)?;

    serde_json::to_string(&deliverable).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_deliverables(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let list = deliverables::list_deliverables(&project_dir)?;
    serde_json::to_string(&list).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_deliverable(
    project_name: String,
    task_id: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    match deliverables::load_deliverable(&project_dir, &task_id)? {
        Some(d) => serde_json::to_string(&d).map_err(|e| e.to_string()),
        None => Ok("null".to_string()),
    }
}

// ---- 健康度评分命令 ----

#[tauri::command]
fn evaluate_project_health(project_path: String) -> Result<String, String> {
    let score = health_score::evaluate_health(&project_path);
    serde_json::to_string(&score).map_err(|e| e.to_string())
}

// ---- 代码保留率命令 ----

#[tauri::command]
fn evaluate_code_retention(project_name: String, project_path: String) -> Result<String, String> {
    let report = code_retention::evaluate_retention(&project_name, &project_path)?;
    serde_json::to_string(&report).map_err(|e| e.to_string())
}

#[tauri::command]
fn register_generated_snippet(
    project_name: String,
    expert_id: String,
    expert_name: String,
    file_path: String,
    content: String,
) -> Result<String, String> {
    let id = code_retention::register_generated_code(
        &project_name,
        &expert_id,
        &expert_name,
        &file_path,
        &content,
    )?;
    Ok(id)
}

#[tauri::command]
fn list_retention_snippets(project_name: String) -> Result<String, String> {
    let snippets = code_retention::list_snippets(&project_name)?;
    serde_json::to_string(&snippets).map_err(|e| e.to_string())
}

// ---- RBAC 权限命令 ----

#[tauri::command]
fn check_expert_permission(expert_id: String, permission: String) -> Result<String, String> {
    let perm = match permission.as_str() {
        "ReadFiles" => rbac::Permission::ReadFiles,
        "WriteFiles" => rbac::Permission::WriteFiles,
        "DeleteFiles" => rbac::Permission::DeleteFiles,
        "ExecuteCode" => rbac::Permission::ExecuteCode,
        "CallExternalApi" => rbac::Permission::CallExternalApi,
        "AccessMemory" => rbac::Permission::AccessMemory,
        "ModifyMemory" => rbac::Permission::ModifyMemory,
        "AccessTokenData" => rbac::Permission::AccessTokenData,
        "SupervisorOverride" => rbac::Permission::SupervisorOverride,
        _ => return Err(format!("未知权限: {}", permission)),
    };
    let decision = rbac::check_permission(&expert_id, perm);
    serde_json::to_string(&decision).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_expert_path_access(expert_id: String, path: String) -> Result<String, String> {
    let decision = rbac::check_path_access(&expert_id, &path);
    serde_json::to_string(&decision).map_err(|e| e.to_string())
}

// ---- 经验沉淀命令 ----

#[tauri::command]
fn get_experience_沉淀(expert_id: String, expert_name: String) -> Result<String, String> {
    // 简化版：返回基于专家ID的默认经验沉淀
    let exp = experience::generate_experience_沉淀(&expert_id, &expert_name, &[], &[]);
    serde_json::to_string(&exp).map_err(|e| e.to_string())
}

// ========== Git 集成命令 ==========

/// 保存 Git 配置到 .xt/git_config.json
#[tauri::command]
fn save_git_config(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let config_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("git_config.json");

    if let Some(parent) = config_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&config_file, &data).map_err(|e| format!("写入Git配置失败: {}", e))?;
    Ok(())
}

/// 从 .xt/git_config.json 加载 Git 配置
#[tauri::command]
fn load_git_config(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let config_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("git_config.json");

    if !config_file.exists() {
        return Ok("null".to_string());
    }

    let content =
        fs::read_to_string(&config_file).map_err(|e| format!("读取Git配置失败: {}", e))?;
    Ok(content)
}

/// 列出项目中所有可上传文件（排除隐藏目录和常见忽略目录）
/// 最大扫描条目数
const MAX_LIST_ENTRIES: usize = 20_000;

#[tauri::command]
fn list_project_files_all(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let mut files: Vec<String> = vec![];
    list_files_recursive(&project_dir, &project_dir, &mut files, &mut 0usize)?;
    // 按路径排序
    files.sort();
    Ok(serde_json::to_string(&files).map_err(|e| e.to_string())?)
}

fn list_files_recursive(
    base: &std::path::Path,
    current: &std::path::Path,
    result: &mut Vec<String>,
    counter: &mut usize,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;

    for entry in entries {
        // 上限保护，防止大项目栈溢出或内存耗尽
        if *counter >= MAX_LIST_ENTRIES {
            return Ok(());
        }
        *counter += 1;

        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过所有隐藏文件/目录（包括 .git、.xt 等）
        if name.starts_with('.') {
            continue;
        }

        let is_dir = path.is_dir();

        // 跳过符号链接和常见忽略目录
        if is_dir && (path.is_symlink() || SCAN_SKIP_DIRS.contains(&name.as_str())) {
            continue;
        }

        if is_dir {
            list_files_recursive(base, &path, result, counter)?;
        } else {
            let relative = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string()
                .replace("\\", "/");
            result.push(relative);
        }
    }

    Ok(())
}

/// 执行 Git 推送：初始化/设置远程仓库、暂存文件、提交和推送
/// 使用 GIT_ASKPASS 环境变量传递凭证，避免 token 写入 .git/config
#[tauri::command]
async fn git_push(
    project_name: String,
    repo_url: String,
    token: String,
    commit_message: String,
    files: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    // 防御性检查
    if files.is_empty() {
        return Err("没有选择任何文件".to_string());
    }
    let commit_msg = if commit_message.trim().is_empty() {
        "更新项目文件".to_string()
    } else {
        commit_message.trim().to_string()
    };

    let project_dir_str = project_dir.to_string_lossy().to_string();

    // 验证 repo_url 协议
    if !repo_url.starts_with("https://") && !repo_url.starts_with("http://") {
        return Err("仓库地址必须以 http:// 或 https:// 开头".to_string());
    }

    // 辅助函数：在项目目录下执行 git 命令
    let run_git = |args: &[&str]| -> Result<String, String> {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&project_dir)
            .output()
            .map_err(|e| format!("无法执行 git 命令: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            let err_msg = if stderr.is_empty() { stdout } else { stderr };
            // 识别常见推送失败原因
            if err_msg.contains("rejected") || err_msg.contains("non-fast-forward") {
                return Err(format!(
                    "推送被拒绝：远程仓库有更新的提交，请先拉取远程变更后再推送"
                ));
            }
            return Err(format!("Git 命令失败: {}", err_msg));
        }
        Ok(stdout)
    };

    // 1. 初始化 Git 仓库（如果尚未初始化）
    let git_dir = project_dir.join(".git");
    if !git_dir.exists() {
        run_git(&["init"])?;
        eprintln!("[GIT] 初始化仓库: {}", project_dir_str);
    }

    // 确保本地 git 用户身份已配置（commit 必需）
    run_git(&["config", "user.name", "星图专家团"])?;
    run_git(&["config", "user.email", "expert@starchart.dev"])?;

    // 2. 设置或更新远程仓库（不嵌入 token）
    let remote_check = run_git(&["remote", "get-url", "origin"]);
    match remote_check {
        Ok(_) => {
            run_git(&["remote", "set-url", "origin", &repo_url])?;
            eprintln!("[GIT] 更新远程仓库 URL");
        }
        Err(_) => {
            run_git(&["remote", "add", "origin", &repo_url])?;
            eprintln!("[GIT] 添加远程仓库 origin");
        }
    }

    // 3. 暂存指定文件（带沙箱路径校验）
    for file in &files {
        let target = project_dir.join(file);
        validate_sandbox_path(&project_dir, &target)?;
    }
    let mut add_args: Vec<&str> = vec!["add"];
    for file in &files {
        add_args.push(file.as_str());
    }
    run_git(&add_args)?;
    eprintln!("[GIT] 暂存 {} 个文件", files.len());

    // 4. 提交
    let status = run_git(&["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Ok("没有需要提交的变更".to_string());
    }
    run_git(&["commit", "-m", &commit_msg])?;
    eprintln!("[GIT] 提交: {}", commit_msg);

    // 5. 推送 — 使用 GIT_ASKPASS 环境变量传递凭证，不写入 .git/config
    let branch = run_git(&["branch", "--show-current"])?.trim().to_string();
    let branch = if branch.is_empty() { "master" } else { &branch };

    // 通过环境变量传递 token，git 需要认证时读取 GIT_PASSWORD
    let push_output = std::process::Command::new("git")
        .args(&["push", "-u", "origin", branch])
        .current_dir(&project_dir)
        .env("GIT_ASKPASS", "echo")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_USERNAME", "oauth2")
        .env("GIT_PASSWORD", &token)
        .output()
        .map_err(|e| format!("无法执行 git push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&push_output.stdout).to_string();
        let err_msg = if stderr.is_empty() { stdout } else { stderr };
        if err_msg.contains("rejected") || err_msg.contains("non-fast-forward") {
            return Err(format!(
                "推送被拒绝：远程仓库有更新的提交，请先拉取远程变更后再推送"
            ));
        }
        return Err(format!("推送失败: {}", err_msg));
    }

    eprintln!("[GIT] 推送成功到 {}", branch);
    Ok(format!(
        "推送成功！已上传 {} 个文件到 {}",
        files.len(),
        branch
    ))
}

#[tauri::command]
async fn web_search_query(query: String, max_results: Option<usize>) -> Result<String, String> {
    let results = web_search::search(&query, max_results.unwrap_or(5)).await?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

#[tauri::command]
async fn web_search_enhanced(
    query: String,
    max_results: Option<usize>,
    max_tokens: Option<usize>,
) -> Result<String, String> {
    let results =
        web_search::web_search_enhanced(&query, max_results.unwrap_or(5), max_tokens).await?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_webpage_content(url: String) -> Result<String, String> {
    web_search::fetch_page(&url).await
}

#[tauri::command]
async fn check_command_safety(
    command: String,
    args: Vec<String>,
    working_dir: String,
    project_dir: String,
) -> Result<String, String> {
    let result = shell_executor::check_safety(&command, &args, &working_dir, &project_dir);
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
async fn execute_command(
    command: String,
    args: Vec<String>,
    working_dir: String,
) -> Result<String, String> {
    let result = shell_executor::execute(&command, &args, &working_dir)?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
async fn dispatch_tool(
    tool_name: String,
    args_json: String,
    project_dir: String,
    expert_id: String,
) -> Result<String, String> {
    let args: serde_json::Value = serde_json::from_str(&args_json).map_err(|e| e.to_string())?;
    let ctx = tool_system::ToolContext {
        working_dir: project_dir.clone(),
        project_dir: project_dir.clone(),
        expert_id,
        session_id: uuid::Uuid::new_v4().to_string(),
    };
    let router = tool_system::ToolRouter::with_builtin_tools(&project_dir);
    let result = router
        .dispatch(&tool_name, args, &ctx)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_tools(expert_id: String) -> Result<String, String> {
    let router = tool_system::ToolRouter::with_builtin_tools(".");
    let tools = router.registry.get_tools_for_expert(&expert_id);
    serde_json::to_string(&tools).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_tool_approval(command: String) -> Result<String, String> {
    let store = approval_store::ApprovalStore::new();
    let result = store.check_approval(&command);
    let decision = match result {
        approval_store::ApprovalCheckResult::Auto => {
            serde_json::json!({ "decision": "auto" })
        }
        approval_store::ApprovalCheckResult::NeedsConfirmation => {
            serde_json::json!({ "decision": "needs_confirmation" })
        }
        approval_store::ApprovalCheckResult::Blocked(reason) => {
            serde_json::json!({ "decision": "blocked", "reason": reason })
        }
    };
    serde_json::to_string(&decision).map_err(|e| e.to_string())
}

#[tauri::command]
async fn record_tool_approval(command: String, decision: String) -> Result<String, String> {
    let store = approval_store::ApprovalStore::new();
    let approval_decision = match decision.as_str() {
        "approved" => approval_store::ApprovalDecision::Approved,
        "approved_always" => approval_store::ApprovalDecision::ApprovedAlways,
        "denied" => approval_store::ApprovalDecision::Denied,
        _ => return Err(format!("Unknown decision: {}", decision)),
    };
    store.record_decision(&command, approval_decision);
    Ok(serde_json::json!({ "success": true }).to_string())
}

#[tauri::command]
async fn read_document(file_path: String) -> Result<String, String> {
    let content = doc_processor::read_doc(&file_path)?;
    serde_json::to_string(&content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_document(
    file_path: String,
    content: String,
    format: String,
) -> Result<String, String> {
    doc_processor::write_doc(&file_path, &content, &format)
}

/// 多模态聊天（支持图文混合消息）
#[tauri::command]
async fn chat_multimodal(
    messages: Vec<MultimodalMessage>,
    api_key: String,
    model: String,
    endpoint: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let request_body = MultimodalRequest {
        model: model.clone(),
        messages,
        stream: false,
        max_tokens: Some(4096),
    };

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("API错误 {}: {}", status, body));
    }

    let parsed: DeepSeekResponse =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {}", e))?;

    let content = parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();

    let usage = parsed.usage;

    let result = serde_json::json!({
        "content": content,
        "usage": usage
    });

    Ok(result.to_string())
}

/// 图像生成
#[tauri::command]
async fn generate_image(
    prompt: String,
    api_key: String,
    model: String,
    endpoint: String,
    size: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let request_body = ImageGenerationRequest {
        model,
        prompt,
        n: 1,
        size: size.unwrap_or_else(|| "1024x1024".to_string()),
    };

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("API错误 {}: {}", status, body));
    }

    Ok(body)
}

/// 音频转文字
#[tauri::command]
async fn transcribe_audio(
    file_path: String,
    api_key: String,
    model: String,
    endpoint: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let file_bytes = std::fs::read(&file_path).map_err(|e| format!("读取音频文件失败: {}", e))?;

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("audio/mpeg")
        .map_err(|e| format!("MIME错误: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("model", model)
        .part("file", part);

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("API错误 {}: {}", status, body));
    }

    Ok(body)
}

/// 文字转语音
#[tauri::command]
async fn text_to_speech(
    text: String,
    api_key: String,
    model: String,
    endpoint: String,
    voice: Option<String>,
    output_path: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let request_body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice.unwrap_or_else(|| "alloy".to_string()),
    });

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API错误 {}: {}", status, body));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取音频数据失败: {}", e))?;

    std::fs::write(&output_path, &bytes).map_err(|e| format!("保存音频文件失败: {}", e))?;

    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai_experts_test_{}_{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp project dir");
        dir
    }

    #[test]
    fn edit_change_requires_matching_search_text() {
        let dir = temp_project_dir("edit_match");
        let file = dir.join("main.ts");
        fs::write(&file, "const value = 1;\n").expect("write fixture");

        let change = ChangeSet {
            operation: "edit_file".to_string(),
            path: "main.ts".to_string(),
            search_text: Some("const value = 1;".to_string()),
            replace_text: Some("const value = 2;".to_string()),
            content: None,
            rationale: None,
            risk: None,
            allow_overwrite: None,
        };
        let prepared = prepare_change(&dir, change).expect("prepare edit");
        assert_eq!(
            prepared.before_content.as_deref(),
            Some("const value = 1;\n")
        );
        assert_eq!(
            prepared.after_content.as_deref(),
            Some("const value = 2;\n")
        );

        let missing = ChangeSet {
            operation: "edit_file".to_string(),
            path: "main.ts".to_string(),
            search_text: Some("does not exist".to_string()),
            replace_text: Some("replacement".to_string()),
            content: None,
            rationale: None,
            risk: None,
            allow_overwrite: None,
        };
        assert!(prepare_change(&dir, missing).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_change_tolerates_blank_line_and_whitespace_differences_when_unique() {
        let dir = temp_project_dir("edit_whitespace");
        let file = dir.join("style.css");
        fs::write(
            &file,
            ".hero {\r\n  color: #111;\r\n  background: white;\r\n}\r\n",
        )
        .expect("write fixture");

        let change = ChangeSet {
            operation: "edit_file".to_string(),
            path: "style.css".to_string(),
            search_text: Some("\n.hero {\ncolor: #111;\nbackground: white;\n}\n".to_string()),
            replace_text: Some(
                ".hero {\n  color: #0f172a;\n  background: linear-gradient(#fff, #dbeafe);\n}\n"
                    .to_string(),
            ),
            content: None,
            rationale: None,
            risk: None,
            allow_overwrite: None,
        };

        let prepared = prepare_change(&dir, change).expect("prepare edit with tolerant match");
        assert_eq!(
            prepared.after_content.as_deref(),
            Some(".hero {\r\n  color: #0f172a;\r\n  background: linear-gradient(#fff, #dbeafe);\r\n}\r\n")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_file_can_stage_existing_file_without_force_flag_when_base_matches() {
        let dir = temp_project_dir("write_file_existing_ok");
        fs::write(dir.join("app.rs"), "fn main() {}\n").expect("write fixture");

        let change = ChangeSet {
            operation: "write_file".to_string(),
            path: "app.rs".to_string(),
            search_text: None,
            replace_text: None,
            content: Some("fn main() { println!(\"new\"); }\n".to_string()),
            rationale: None,
            risk: None,
            allow_overwrite: None,
        };
        let prepared = prepare_change(&dir, change).expect("prepare write file");
        assert_eq!(
            prepared.before_content.as_deref(),
            Some("fn main() {}\n")
        );
        assert_eq!(
            prepared.after_content.as_deref(),
            Some("fn main() { println!(\"new\"); }\n")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn website_task_creates_new_folder_and_html_file() {
        let dir = temp_project_dir("website_task");

        let create_folder = ChangeSet {
            operation: "create_folder".to_string(),
            path: "landing-page".to_string(),
            search_text: None,
            replace_text: None,
            content: None,
            rationale: Some("create target folder".to_string()),
            risk: Some("low".to_string()),
            allow_overwrite: None,
        };
        let prepared_folder = prepare_change(&dir, create_folder).expect("prepare folder");
        let folder_target = dir.join(prepared_folder.change.path.trim());
        fs::create_dir_all(&folder_target).expect("apply folder");
        assert!(dir.join("landing-page").is_dir());

        let html = "<!doctype html>\n<html><head><meta charset=\"UTF-8\"><title>Demo</title></head><body><h1>Hello Expert Team</h1></body></html>\n";
        let create_html = ChangeSet {
            operation: "create_file".to_string(),
            path: "landing-page/index.html".to_string(),
            search_text: None,
            replace_text: None,
            content: Some(html.to_string()),
            rationale: Some("create website entry file".to_string()),
            risk: Some("low".to_string()),
            allow_overwrite: None,
        };
        let prepared_html = prepare_change(&dir, create_html).expect("prepare html file");
        let html_target = dir.join(prepared_html.change.path.trim());
        if let Some(parent) = html_target.parent() {
            fs::create_dir_all(parent).expect("create html parent");
        }
        fs::write(
            &html_target,
            prepared_html
                .after_content
                .clone()
                .expect("missing prepared html content"),
        )
        .expect("apply html file");
        let written = fs::read_to_string(dir.join("landing-page/index.html")).expect("read html");
        assert_eq!(written, html);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sequential_changes_on_same_file_compose_against_latest_buffer() {
        let dir = temp_project_dir("sequential_changes");
        let file = dir.join("index.html");
        fs::write(
            &file,
            "<h1>待办事项</h1>\n<div class=\"instructions\">\n  <ul>\n    <li>长说明</li>\n  </ul>\n</div>\n",
        )
        .expect("write fixture");

        let changes = vec![
            ChangeSet {
                operation: "edit_file".to_string(),
                path: "index.html".to_string(),
                search_text: Some("<h1>待办事项</h1>".to_string()),
                replace_text: Some("<h1>小事清单</h1>".to_string()),
                content: None,
                rationale: None,
                risk: None,
                allow_overwrite: None,
            },
            ChangeSet {
                operation: "edit_file".to_string(),
                path: "index.html".to_string(),
                search_text: Some(
                    "<div class=\"instructions\">\n  <ul>\n    <li>长说明</li>\n  </ul>\n</div>\n"
                        .to_string(),
                ),
                replace_text: Some(
                    "<div class=\"instructions\">\n  <p>短说明</p>\n</div>\n".to_string(),
                ),
                content: None,
                rationale: None,
                risk: None,
                allow_overwrite: None,
            },
        ];

        let (prepared, errors) = prepare_changes_sequentially(&dir, changes);
        assert!(errors.is_empty(), "unexpected errors: {:?}", errors);
        assert_eq!(prepared.len(), 2);
        assert_eq!(
            prepared[1].before_content.as_deref(),
            prepared[0].after_content.as_deref()
        );
        let final_content = prepared[1]
            .after_content
            .as_deref()
            .expect("missing final content");
        assert!(final_content.contains("<h1>小事清单</h1>"));
        assert!(final_content.contains("<p>短说明</p>"));
        assert!(!final_content.contains("<li>长说明</li>"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_change_strips_leading_annotation_comments_before_matching() {
        let dir = temp_project_dir("edit_comment_prefix");
        let file = dir.join("index.html");
        fs::write(
            &file,
            "<div class=\"instructions\">\n    <p>输入内容按 Enter 添加，勾选标记完成，悬停删除，数据自动保存</p>\n</div>\n",
        )
        .expect("write fixture");

        let change = ChangeSet {
            operation: "edit_file".to_string(),
            path: "index.html".to_string(),
            search_text: Some(
                "<!-- 搜索块：使用说明 p 标签的完整内容 -->\n    <p>输入内容按 Enter 添加，勾选标记完成，悬停删除，数据自动保存</p>"
                    .to_string(),
            ),
            replace_text: Some(
                "<!-- 搜索块：使用说明缩短后的简洁版本 -->\n    <p>输入添加，勾选完成，悬停删除，数据自动保存</p>"
                    .to_string(),
            ),
            content: None,
            rationale: None,
            risk: None,
            allow_overwrite: None,
        };

        let prepared = prepare_change(&dir, change).expect("prepare annotated html edit");
        assert_eq!(
            prepared.after_content.as_deref(),
            Some("<div class=\"instructions\">\n    <p>输入添加，勾选完成，悬停删除，数据自动保存</p>\n</div>\n")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_change_can_replace_unique_css_rule_by_selector_when_block_drifted() {
        let dir = temp_project_dir("edit_css_selector");
        let file = dir.join("styles.css");
        fs::write(
            &file,
            "h1 {\n    font-size: 1.8rem;\n    margin-bottom: 1.2rem;\n    color: #8a8a8a;\n    font-weight: 400;\n    text-shadow: none;\n    text-align: center;\n}\n",
        )
        .expect("write fixture");

        let change = ChangeSet {
            operation: "edit_file".to_string(),
            path: "styles.css".to_string(),
            search_text: Some(
                "/* 搜索块：h1 当前样式 */\nh1 {\n    font-size: 1.5rem;\n    color: #333;\n    margin-bottom: 1rem;\n    font-weight: bold;\n}"
                    .to_string(),
            ),
            replace_text: Some(
                "/* 搜索块：h1 调整后样式 —— 字重调低、颜色变浅 */\nh1 {\n    font-size: 1.5rem;\n    color: #555;\n    margin-bottom: 1rem;\n    font-weight: 500;\n}"
                    .to_string(),
            ),
            content: None,
            rationale: None,
            risk: None,
            allow_overwrite: None,
        };

        let prepared = prepare_change(&dir, change).expect("prepare selector based css edit");
        let after = prepared.after_content.as_deref().expect("missing after content");
        assert!(after.contains("color: #555;"));
        assert!(after.contains("font-weight: 500;"));
        assert!(!after.contains("font-weight: 400;"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_command_safety_allows_in_workspace_command() {
        let dir = temp_project_dir("workspace_command_guard");
        let dir_str = dir.to_string_lossy().to_string();
        let raw = tauri::async_runtime::block_on(check_command_safety(
            "net user".to_string(),
            vec![],
            dir_str.clone(),
            dir_str.clone(),
        ))
        .expect("check command safety");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse safety json");
        assert_eq!(parsed["requires_auth"].as_bool(), Some(false));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_command_safety_flags_outside_workspace_target() {
        let dir = temp_project_dir("outside_workspace_guard");
        let dir_str = dir.to_string_lossy().to_string();
        let raw = tauri::async_runtime::block_on(check_command_safety(
            "type C:\\Windows\\System32\\drivers\\etc\\hosts".to_string(),
            vec![],
            dir_str.clone(),
            dir_str.clone(),
        ))
        .expect("check command safety");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse safety json");
        assert_eq!(parsed["requires_auth"].as_bool(), Some(true));
        assert!(parsed["auth_reason"]
            .as_str()
            .unwrap_or_default()
            .contains("工作区之外"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "live interface test"]
    fn live_execute_command_interface_returns_stdout() {
        let dir = std::env::current_dir().expect("current dir");
        let dir_str = dir.to_string_lossy().to_string();
        let raw = tauri::async_runtime::block_on(execute_command(
            "echo interface-command-ok".to_string(),
            vec![],
            dir_str,
        ))
        .expect("execute command");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse command json");
        let stdout = parsed["stdout"].as_str().unwrap_or_default().to_lowercase();
        assert!(stdout.contains("interface-command-ok"));
    }

    #[test]
    #[ignore = "live interface test"]
    fn live_web_search_interface_returns_results() {
        let raw =
            tauri::async_runtime::block_on(web_search_query("OpenAI API".to_string(), Some(3)))
                .expect("web search query");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse search json");
        let results = parsed.as_array().expect("search results array");
        assert!(!results.is_empty(), "expected at least one search result");
        let first_url = results[0]["url"].as_str().unwrap_or_default();
        assert!(
            !first_url.is_empty(),
            "expected first result to contain url"
        );
    }
}

#[tauri::command]
async fn load_config(project_dir: Option<String>) -> Result<String, String> {
    let cfg = config::ConfigLoader::load(project_dir.as_deref());
    serde_json::to_string(&cfg).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_config(
    config_json: String,
    scope: String,
    project_dir: Option<String>,
) -> Result<String, String> {
    let cfg: config::AppConfig = serde_json::from_str(&config_json).map_err(|e| e.to_string())?;
    let path = match scope.as_str() {
        "global" => config::ConfigLoader::global_config_path(),
        "project" => {
            let dir = project_dir.ok_or("project_dir required for project scope")?;
            config::ConfigLoader::project_config_path(&dir)
        }
        _ => return Err("Invalid scope: use 'global' or 'project'".into()),
    };
    config::ConfigLoader::save_config(&cfg, &path)?;
    Ok("saved".into())
}

#[tauri::command]
async fn get_default_config() -> Result<String, String> {
    Ok(config::ConfigLoader::get_default_json())
}

#[tauri::command]
async fn run_hooks(context_json: String) -> Result<String, String> {
    let ctx: hooks::HookContext = serde_json::from_str(&context_json).map_err(|e| e.to_string())?;
    hooks::ensure_hooks_initialized().await;
    let manager = hooks::get_hook_manager();
    let decisions = manager.run_hooks(&ctx).await;
    serde_json::to_string(&decisions).map_err(|e| e.to_string())
}

// ============== 新版多Provider流式LLM命令 ==============

/// 流式调用LLM，通过Tauri Event推送token到前端
#[tauri::command]
async fn llm_call_streaming(
    request_json: String,
    stream_id: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let request: llm_provider::LLMRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("请求JSON解析失败: {}", e))?;

    let registry = llm_provider::ProviderRegistry::new();
    let provider = registry
        .get_provider(&request.provider_id)
        .ok_or_else(|| format!("Provider不存在: {}", request.provider_id))?;

    let client = llm_stream::StreamingLLMClient::new(None);
    let response = client
        .call_streaming(&app_handle, provider, &request, &stream_id)
        .await?;

    serde_json::to_string(&response).map_err(|e| e.to_string())
}

/// 非流式调用LLM（兼容短回复场景）
#[tauri::command]
async fn llm_call_blocking(request_json: String) -> Result<String, String> {
    let request: llm_provider::LLMRequest =
        serde_json::from_str(&request_json).map_err(|e| format!("请求JSON解析失败: {}", e))?;

    let registry = llm_provider::ProviderRegistry::new();
    let provider = registry
        .get_provider(&request.provider_id)
        .ok_or_else(|| format!("Provider不存在: {}", request.provider_id))?;

    let client = llm_stream::StreamingLLMClient::new(None);
    let response = client.call_blocking(provider, &request).await?;

    serde_json::to_string(&response).map_err(|e| e.to_string())
}

/// 列出所有可用的LLM Provider
#[tauri::command]
async fn list_llm_providers() -> Result<String, String> {
    let registry = llm_provider::ProviderRegistry::new();
    let providers = registry.list_providers();
    serde_json::to_string(&providers).map_err(|e| e.to_string())
}

#[tauri::command]
async fn apply_file_patch(patch_text: String, project_dir: String) -> Result<String, String> {
    let result = file_patch::parse_and_apply_patch(&patch_text, &project_dir)
        .map_err(|e| format!("Patch解析失败: {}", e))?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[tauri::command]
async fn verify_file_patch(patch_text: String, project_dir: String) -> Result<String, String> {
    let patch =
        file_patch::parse_patch(&patch_text).map_err(|e| format!("Patch解析失败: {}", e))?;
    match file_patch::verify_patch(&patch, &project_dir) {
        Ok(()) => Ok(r#"{"valid": true, "errors": []}"#.into()),
        Err(errors) => {
            let json = serde_json::to_string(&errors).unwrap_or_default();
            Ok(format!(r#"{{"valid": false, "errors": {}}}"#, json))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 使用block_on阻塞初始化数据库，确保前端调用前DB已就绪
            tauri::async_runtime::block_on(async move {
                match init_db_pool(&handle).await {
                    Ok(pool) => {
                        handle.manage(Arc::new(AppState { db: pool }));
                        eprintln!("[DB] 数据库初始化成功");
                    }
                    Err(e) => {
                        eprintln!("[DB] 数据库初始化失败: {}", e);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_data_dir,
            read_frontend_e2e_control,
            clear_frontend_e2e_control,
            save_frontend_e2e_status,
            append_frontend_e2e_log,
            verify_workspace_delivery,
            analyze_agent_delivery,
            apply_agent_delivery_changes,
            supervisor_analyze_dispatch,
            supervisor_review_delivery,
            supervisor_quick_answer,
            supervisor_analyze_followup,
            supervisor_analyze_dispatch_runtime,
            supervisor_prepare_and_analyze_dispatch_runtime,
            supervisor_review_delivery_runtime,
            finalize_pipeline_delivery_runtime,
            supervisor_quick_answer_runtime,
            supervisor_prepare_quick_answer_runtime,
            supervisor_analyze_followup_runtime,
            supervisor_mid_check,
            finalize_pipeline_step_without_supervisor,
            finalize_pipeline_step_with_supervisor,
            prepare_pipeline_launch,
            get_current_pipeline_execution_round,
            get_current_pipeline_followup_execution_round,
            settle_pipeline_execution_round,
            build_token_dashboard_snapshot,
            build_pipeline_progress_snapshot,
            build_expert_context,
            start_expert_task_runtime,
            continue_expert_task_runtime,
            resolve_expert_prompt_plan,
            build_expert_tool_plan,
            execute_expert_tool_request,
            evaluate_tool_reminder,
            build_tool_followup_message,
            create_workspace,
            workspace_exists,
            open_project_is_dir,
            open_project_from_path,
            list_workspaces,
            ensure_xt_config,
            chat_with_deepseek,
            chat_with_expert,
            test_api_key,
            scan_project_structure,
            analyze_project_dependencies,
            save_projects,
            load_projects,
            save_app_state,
            load_app_state,
            save_key_pool,
            load_key_pool,
            save_experts,
            load_experts,
            sandbox_create_folder,
            sandbox_create_file,
            sandbox_read_file,
            sandbox_read_file_base64,
            sandbox_write_file,
            sandbox_edit_file,
            sandbox_list_dir,
            sandbox_delete,
            validate_workspace_connection,
            create_change_session,
            propose_patch,
            apply_approved_patch,
            rollback_change_session,
            save_canvas_directory,
            load_canvas_directory,
            db_save_project,
            db_load_projects,
            db_save_session,
            db_save_message,
            db_clear_messages,
            db_delete_session,
            db_load_project_data,
            db_delete_project,
            db_save_state,
            db_load_state,
            save_chat_sessions,
            load_chat_sessions,
            load_prompt_module_traces,
            save_prompt_module_traces,
            append_prompt_module_trace,
            perceptual_index_build,
            perceptual_index_search,
            perceptual_index_project_logic_graph,
            perceptual_index_file_logic_graph,
            perceptual_index_status,
            perceptual_index_incremental_update,
            fuzzy_file_search,
            repo_list_items,
            repo_read_cards,
            repo_read_wiki,
            repo_generate_cards,
            repo_synthesize_wiki,
            repo_incremental_update,
            save_draft,
            load_draft,
            save_token_data,
            load_token_data,
            save_user_token_data,
            load_user_token_data,
            memory_save,
            memory_search,
            memory_search_enhanced,
            memory_delete,
            memory_clear_type,
            memory_run_lifecycle,
            memory_get_stats,
            generate_deliverable,
            list_deliverables,
            load_deliverable,
            evaluate_project_health,
            evaluate_code_retention,
            register_generated_snippet,
            list_retention_snippets,
            check_expert_permission,
            check_expert_path_access,
            get_experience_沉淀,
            save_git_config,
            load_git_config,
            list_project_files_all,
            git_push,
            web_search_query,
            web_search_enhanced,
            fetch_webpage_content,
            check_command_safety,
            execute_command,
            dispatch_tool,
            list_tools,
            check_tool_approval,
            record_tool_approval,
            read_document,
            write_document,
            chat_multimodal,
            generate_image,
            transcribe_audio,
            text_to_speech,
            load_config,
            save_config,
            get_default_config,
            run_hooks,
            llm_call_streaming,
            llm_call_blocking,
            list_llm_providers,
            apply_file_patch,
            verify_file_patch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
