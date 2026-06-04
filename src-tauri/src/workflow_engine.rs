use dunce;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

static FUNCTION_CALCULATOR_TITLE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"functioncalculator\s*:\s*['"]函数计算器['"]"#)
        .expect("valid function title regex")
});
static FUNCTION_CALCULATOR_CASE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"case\s*'functioncalculator'\s*:\s*renderFunctionCalculator\s*\("#)
        .expect("valid function case regex")
});
static FUNCTION_CALCULATOR_RENDER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"function\s+renderFunctionCalculator\s*\("#).expect("valid function render regex")
});
static FUNCTION_CALCULATOR_ICON_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"functioncalculator\s*:\s*'icon-functioncalculator\.svg'"#)
        .expect("valid function icon regex")
});
static FUNCTION_CALCULATOR_ENTRY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"data-app="functioncalculator""#).expect("valid function entry regex")
});
static EMOJI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\p{Extended_Pictographic}"#).expect("valid emoji regex"));
static GLOBAL_EMOJI_TASK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?:所有|全部).*(?:表情|emoji)|(?:表情|emoji).*(?:svg|SVG|替换|换成)"#)
        .expect("valid emoji task regex")
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInputSource {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMutationPath {
    pub action_type: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowChangeSet {
    pub operation: String,
    pub path: String,
    pub search_text: Option<String>,
    pub replace_text: Option<String>,
    pub content: Option<String>,
    pub rationale: Option<String>,
    pub risk: Option<String>,
    pub allow_overwrite: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryAnalysis {
    pub parsed_action_count: usize,
    pub structured_change_count: usize,
    pub required_files: Vec<String>,
    pub executable_mutations: Vec<WorkflowMutationPath>,
    pub has_executable_mutation: bool,
    pub has_source_mutation: bool,
    pub workspace_issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedDeliveryPayload {
    pub parsed_action_count: usize,
    pub structured_change_count: usize,
    pub required_files: Vec<String>,
    pub executable_mutations: Vec<WorkflowMutationPath>,
    pub change_sets: Vec<WorkflowChangeSet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDeliverableTask {
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDeliverableGuardRequest {
    pub step_expert_ids: Vec<String>,
    pub has_workspace_context: bool,
    pub tasks: Vec<StepDeliverableTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDeliverableGuardDecision {
    pub requires_real_artifact: bool,
    pub has_real_artifact: bool,
    pub blocker_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertReplyGuardRequest {
    pub expert_id: String,
    pub has_workspace_context: bool,
    pub workspace_looks_empty: bool,
    pub reply: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertReplyGuardDecision {
    pub should_enforce: bool,
    pub requires_retry: bool,
    pub phase_detail: Option<String>,
    pub reminder_prompt: Option<String>,
    pub final_failure_message: Option<String>,
}

fn read_workspace_relative_file(
    workspace_path: &str,
    relative_path: &str,
) -> Result<String, String> {
    let workspace_root = dunce::canonicalize(PathBuf::from(workspace_path))
        .map_err(|e| format!("解析工作区失败: {}", e))?;
    let target = workspace_root.join(relative_path);
    let canonical_target =
        dunce::canonicalize(&target).map_err(|e| format!("读取 {} 失败: {}", relative_path, e))?;
    if !canonical_target.starts_with(&workspace_root) {
        return Err(format!("文件路径越界: {}", relative_path));
    }
    fs::read_to_string(&canonical_target).map_err(|e| format!("读取 {} 失败: {}", relative_path, e))
}

pub fn verify_workspace_delivery(
    user_task_text: &str,
    workspace_path: &str,
) -> Result<Vec<String>, String> {
    let mut issues: Vec<String> = Vec::new();
    let wants_function_calculator = user_task_text.contains("函数计算器");
    let wants_global_emoji_replacement = GLOBAL_EMOJI_TASK_RE.is_match(user_task_text);

    if wants_function_calculator {
        match (
            read_workspace_relative_file(workspace_path, "app.js"),
            read_workspace_relative_file(workspace_path, "index.html"),
        ) {
            (Ok(app_js), Ok(index_html)) => {
                let mut missing: Vec<&str> = Vec::new();
                if !FUNCTION_CALCULATOR_TITLE_RE.is_match(&app_js) {
                    missing.push("app.js 的标题映射");
                }
                if !FUNCTION_CALCULATOR_CASE_RE.is_match(&app_js) {
                    missing.push("app.js 的应用入口分支");
                }
                if !FUNCTION_CALCULATOR_RENDER_RE.is_match(&app_js) {
                    missing.push("app.js 的渲染函数");
                }
                if !FUNCTION_CALCULATOR_ICON_RE.is_match(&app_js) {
                    missing.push("任务栏图标映射");
                }
                if !FUNCTION_CALCULATOR_ENTRY_RE.is_match(&index_html) {
                    missing.push("index.html 的桌面入口");
                }
                if !missing.is_empty() {
                    issues.push(format!("函数计算器仍未完整接入：{}", missing.join("、")));
                }
            }
            (Err(error), _) | (_, Err(error)) => {
                issues.push(format!("无法验证函数计算器接入状态：{}", error));
            }
        }
    }

    if wants_global_emoji_replacement {
        let mut residues: Vec<String> = Vec::new();
        for relative_path in ["index.html", "styles.css", "app.js"] {
            match read_workspace_relative_file(workspace_path, relative_path) {
                Ok(content) => {
                    let count = EMOJI_RE.find_iter(&content).count();
                    if count > 0 {
                        residues.push(format!("{} 仍有 {} 处", relative_path, count));
                    }
                }
                Err(error) => residues.push(format!("{} 无法读取（{}）", relative_path, error)),
            }
        }
        if !residues.is_empty() {
            issues.push(format!("表情替换尚未全局完成：{}", residues.join("，")));
        }
    }

    Ok(issues)
}

fn decode_action_param_value(value: &str) -> String {
    value
        .replace("'\\''", "'")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\r", "\r")
        .replace("\\n", "\n")
}

fn has_structured_mutation_deliverable_text(text: &str) -> bool {
    Regex::new(r#""operation"\s*:\s*"(?:create_file|write_file|edit_file|create_folder|delete)""#)
        .expect("structured op regex")
        .is_match(text)
        && Regex::new(r#""path"\s*:\s*"[^"]+""#)
            .expect("structured path regex")
            .is_match(text)
}

fn has_file_mutation_deliverable_text(text: &str) -> bool {
    let extracted = extract_delivery_payload(&[WorkflowInputSource {
        content: text.to_string(),
    }]);
    extracted.structured_change_count > 0 || has_structured_mutation_deliverable_text(text)
}

fn has_source_file_mutation_deliverable_text(text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    let extracted = extract_delivery_payload(&[WorkflowInputSource {
        content: text.to_string(),
    }]);
    let source_action = extracted.change_sets.iter().any(|entry| {
        ["create_file", "write_file", "edit_file"].contains(&entry.operation.as_str())
            && Regex::new(r"(?:app\.js|index\.html|styles\.css|src/|src\\|public/|public\\|components/|components\\|pages/|pages\\|assets/|assets\\)")
                .expect("source path regex")
                .is_match(&entry.path)
    });
    source_action
        || Regex::new(r#""path"\s*:\s*"[^"]*\.(?:html|css|scss|sass|js|jsx|ts|tsx|vue|svelte|astro)""#)
            .expect("source structured path regex")
            .is_match(text)
        || Regex::new(
            r#""operation"\s*:\s*"(?:create_file|write_file|edit_file)"[\s\S]{0,240}"path"\s*:\s*"[^"]*\.(?:html|css|scss|sass|js|jsx|ts|tsx|vue|svelte|astro)""#,
        )
        .expect("source op regex")
        .is_match(text)
}

fn has_unexecutable_file_mutation_declaration(text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    let extracted = extract_delivery_payload(&[WorkflowInputSource {
        content: text.to_string(),
    }]);
    !extracted.executable_mutations.is_empty() && extracted.structured_change_count == 0
}

fn has_approximate_file_mutation_payload(text: &str) -> bool {
    if text.trim().is_empty() || !has_file_mutation_deliverable_text(text) {
        return false;
    }
    [
        Regex::new(r#"\b(?:searchText|replaceText|content)\s*=\s*["'][^"'`\r\n]{0,240}\.\.\.[^"'`\r\n]{0,40}["']"#)
            .expect("approx eq regex"),
        Regex::new(r#"\b(?:searchText|replaceText|content)\s*=\s*["'][^"'`\r\n]{0,240}(?:truncated|省略|略去)[^"'`\r\n]{0,40}["']"#)
            .expect("approx eq trunc regex"),
        Regex::new(r#"\b(?:searchText|replaceText|content)\s*:\s*["'][^"'`\r\n]{0,240}\.\.\.[^"'`\r\n]{0,40}["']"#)
            .expect("approx colon regex"),
        Regex::new(r#"\b(?:searchText|replaceText|content)\s*:\s*["'][^"'`\r\n]{0,240}(?:truncated|省略|略去)[^"'`\r\n]{0,40}["']"#)
            .expect("approx colon trunc regex"),
        Regex::new(r#"\[ACTION:(?:EDIT_FILE|WRITE_FILE|CREATE_FILE)[^\]]{0,800}(?:\.\.\.|…|\(truncated\)|（省略）)"#)
            .expect("approx action regex"),
    ]
    .iter()
    .any(|pattern| pattern.is_match(text))
}

fn has_unstructured_diff_edit_payload(text: &str) -> bool {
    if text.trim().is_empty() || !has_file_mutation_deliverable_text(text) {
        return false;
    }
    Regex::new(
        r"(?is)\[ACTION:EDIT_FILE(?::[^\]]+|\s+[^\]]+)\](?:\*\*)?\s*```diff\b[\s\S]*?(?:```|$)",
    )
    .expect("diff edit regex")
    .is_match(text)
        || Regex::new(r"(?is)\[ACTION:EDIT_FILE[\s\S]{0,1200}---\s+a/[\s\S]{0,1200}\+\+\+\s+b/")
            .expect("unified diff regex")
            .is_match(text)
}

fn mentions_saved_artifact_without_action(text: &str) -> bool {
    if text.trim().is_empty() || has_file_mutation_deliverable_text(text) {
        return false;
    }
    Regex::new(r"(已保存至|已输出到|已写入|已创建|文档已保存|方案已保存|已完成设计方案的输出|已输出完整的设计方案文档)")
        .expect("saved artifact text regex")
        .is_match(text)
        && Regex::new(r"[A-Za-z0-9_\-./\\]+\.(?:md|html|css|js|ts|json)")
            .expect("saved artifact path regex")
            .is_match(text)
}

pub fn evaluate_step_deliverable_guard(
    request: &StepDeliverableGuardRequest,
) -> StepDeliverableGuardDecision {
    let designer_step = request
        .step_expert_ids
        .iter()
        .any(|id| id == "jiang-dingchu");
    let implementation_step = request
        .step_expert_ids
        .iter()
        .any(|id| ["jiang-qinglan", "jiang-yumo", "jiang-subai"].contains(&id.as_str()));
    let requires_real_artifact =
        request.has_workspace_context && (designer_step || implementation_step);
    if !requires_real_artifact {
        return StepDeliverableGuardDecision {
            requires_real_artifact,
            has_real_artifact: true,
            blocker_message: None,
        };
    }

    let has_real_artifact = request.tasks.iter().any(|task| {
        let output = task.output.as_deref().unwrap_or("");
        let deliverable_ok = if designer_step {
            has_file_mutation_deliverable_text(output)
        } else {
            has_source_file_mutation_deliverable_text(output)
        };
        deliverable_ok
            && !has_approximate_file_mutation_payload(output)
            && !has_unstructured_diff_edit_payload(output)
    });

    let blocker_message = if has_real_artifact {
        None
    } else if designer_step {
        Some("设计步骤未产出任何真实落盘文档动作，禁止推进到实现/审核阶段。".to_string())
    } else {
        Some("实现步骤未产出任何真实且精确的文件变更，禁止推进到审核/测试/审查阶段。".to_string())
    };

    StepDeliverableGuardDecision {
        requires_real_artifact,
        has_real_artifact,
        blocker_message,
    }
}

pub fn evaluate_expert_reply_guard(request: &ExpertReplyGuardRequest) -> ExpertReplyGuardDecision {
    let implementation_expert =
        ["jiang-qinglan", "jiang-yumo", "jiang-subai"].contains(&request.expert_id.as_str());
    let requires_real_artifact = request.has_workspace_context
        && (implementation_expert || request.expert_id == "jiang-dingchu");
    if !requires_real_artifact {
        return ExpertReplyGuardDecision {
            should_enforce: false,
            requires_retry: false,
            phase_detail: None,
            reminder_prompt: None,
            final_failure_message: None,
        };
    }

    let reply = request.reply.as_str();
    let has_file_mutation = has_file_mutation_deliverable_text(reply);
    let has_source_mutation = has_source_file_mutation_deliverable_text(reply);
    let has_approximate = has_approximate_file_mutation_payload(reply);
    let has_diff_payload = has_unstructured_diff_edit_payload(reply);
    let has_unexecutable_declaration = has_unexecutable_file_mutation_declaration(reply);
    let mentions_saved = mentions_saved_artifact_without_action(reply);
    let requires_retry = !has_file_mutation
        || (implementation_expert && !has_source_mutation)
        || mentions_saved
        || has_approximate
        || has_diff_payload
        || has_unexecutable_declaration;
    if !requires_retry {
        return ExpertReplyGuardDecision {
            should_enforce: true,
            requires_retry: false,
            phase_detail: None,
            reminder_prompt: None,
            final_failure_message: None,
        };
    }

    let reminder_prompt = if request.expert_id == "jiang-dingchu" {
        "你当前声称已经输出/保存了设计文件，但回复里没有任何真实落盘动作，这在 code-development 场景里等同于未完成。请立刻通过 [ACTION:CREATE_FILE] / [ACTION:WRITE_FILE] 真正写出设计文档；如果你并没有保存成功，就必须明确撤回“已保存/已输出文档”的说法，禁止继续空口声称文件已存在。".to_string()
    } else if request.workspace_looks_empty && !has_file_mutation {
        "当前工作区几乎是空目录（例如只有 .xt 或没有现成业务源码），这类场景不需要继续探测旧文件，也不要继续讨论技术选型/框架选择。请直接交付最小可运行文件集合，并优先拆成较短的小文件动作：至少创建 [ACTION:CREATE_FILE:index.html]、[ACTION:CREATE_FILE:styles.css]、[ACTION:CREATE_FILE:app.js]，必要时再补 [ACTION:CREATE_FILE:README.md]。创建新文件时优先用代码块格式（例如 [ACTION:CREATE_FILE:styles.css] 后跟 ```css 代码块），不要把大段源码塞进单行 content=\"...\" 内联字符串。只有在内容很短时才允许单文件 index.html 方案。禁止继续只做目录探测、只写分析、只说“需要先读取文件”。".to_string()
    } else if has_unexecutable_declaration {
        "你已经声明了文件动作，但没有提供系统可直接执行的精确变更主体。不要再输出“代码块片段 + 解释箭头/说明文字”这种格式。EDIT_FILE 必须直接给完整 searchText / replaceText：可以使用两段独立代码块，或在单代码块中使用 <searchText>...</searchText> 和 <replaceText>...</replaceText>；CREATE_FILE / WRITE_FILE 必须直接给完整文件内容代码块。对于 index.html / styles.css / README.md 这类短小静态文件，优先改用 WRITE_FILE 直接给完整最新文件内容。禁止只写“替换原来的某块/整个区域”这种口头描述。".to_string()
    } else if has_diff_payload {
        "你刚才给出的是 unified diff / ```diff 补丁格式，这不是当前执行链可可靠落盘的格式。不要再输出 --- a/+++ b/@@ 这种补丁。请改用严格结构化的可执行变更：优先使用 [ACTION:EDIT_FILE ...] + search/replace 两段代码块，或输出结构化 JSON changes（包含 operation/path/searchText/replaceText 或 content）。".to_string()
    } else if has_approximate {
        "你刚才给出的文件动作仍然是近似/截断补丁（例如带省略号、truncated、略去等占位），系统无法可靠落盘，这在 code-development 场景里等同于未完成。请基于真实文件内容重新输出精确可执行的文件动作：searchText / replaceText / content 必须是完整原文，不允许出现 ...、…、(truncated)、（省略）等占位。如果目标文件内容仍不完整，必须先用 [ACTION:READ_FILE path=\"相对路径\" start_line=\"起始行\" end_line=\"结束行\"] 继续分段读取后再改。".to_string()
    } else if implementation_expert && !has_source_mutation {
        "你当前只交付了目录动作、资源文件或其它非源码文件，这对本次代码改造任务仍然等同于未完成。请至少对一个真实源码文件直接交付可执行变更：优先修改 app.js / index.html / styles.css，其次才是 icons/*.svg 等资源文件。禁止只创建 icons 目录、只写单个 SVG、只补资源而不改源码。".to_string()
    } else {
        "你当前还没有交付任何真实文件变更，这在 code-development 场景里等同于未完成。请立刻基于已有证据输出至少一个可执行文件动作（[ACTION:EDIT_FILE] / [ACTION:WRITE_FILE] / [ACTION:CREATE_FILE] / 结构化 changes）来真正修改代码；如果仍然缺少具体文件内容，你的回复里必须直接包含 [ACTION:READ_FILE:相对路径]。已知目标源码文件（如 app.js / index.html / styles.css）时，禁止用 [ACTION:EXECUTE_CMD] 的 grep/rg/Select-String/Get-Content 代替源码读取。对于 index.html / styles.css / README.md 这类短小静态文件，优先直接交付 WRITE_FILE 完整内容。禁止继续重复目录探测、只给设计文档，或只输出命令列表。".to_string()
    };

    let final_failure_message = if request.expert_id == "jiang-dingchu" {
        "未实际创建或写入设计文档，当前设计交付失败，需要重试。".to_string()
    } else {
        "未交付任何可执行文件变更，当前实现失败，需要重试。".to_string()
    };

    ExpertReplyGuardDecision {
        should_enforce: true,
        requires_retry: true,
        phase_detail: Some("补交真实文件变更中...".to_string()),
        reminder_prompt: Some(reminder_prompt),
        final_failure_message: Some(final_failure_message),
    }
}

fn normalize_action_path(raw_path: &str) -> String {
    if raw_path.trim().is_empty() {
        return String::new();
    }

    let mut value = decode_action_param_value(raw_path).trim().to_string();
    for pattern in [
        Regex::new(r"\r?\n\s*(?:searchText|replaceText|content|reason|dir)\s*:")
            .expect("marker regex"),
        Regex::new(r"\s+(?:searchText|replaceText|content|reason|dir)\s*:").expect("marker regex"),
    ] {
        if let Some(found) = pattern.find(&value) {
            value = value[..found.start()].trim().to_string();
        }
    }

    value
        .split('\n')
        .next()
        .unwrap_or("")
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | ',' | ']'))
        .trim()
        .to_string()
}

fn parse_action_params(params_str: &str) -> std::collections::HashMap<String, String> {
    const ACTION_PARAM_KEYS: &[&str] = &[
        "path",
        "content",
        "searchText",
        "replaceText",
        "dir",
        "reason",
        "rationale",
        "query",
        "recursive",
        "startLine",
        "endLine",
        "command",
        "format",
        "prompt",
        "size",
        "target",
        "type",
        "src",
        "from",
        "to",
        "track",
        "at",
        "duration",
        "file",
    ];

    let key_pattern = ACTION_PARAM_KEYS.join("|");
    let matcher =
        Regex::new(&format!(r#"(?:^|\s)({})=(["'])"#, key_pattern)).expect("valid param regex");
    let matches: Vec<(String, String, usize, usize)> = matcher
        .captures_iter(params_str)
        .filter_map(|caps| {
            let full = caps.get(0)?;
            let key = caps.get(1)?.as_str().to_string();
            let quote = caps.get(2)?.as_str().to_string();
            let prefix_length = full.as_str().len().saturating_sub(key.len() + 2);
            let key_start = full.start() + prefix_length;
            Some((
                key,
                quote,
                key_start,
                key_start + caps.get(1)?.as_str().len() + 2,
            ))
        })
        .collect();

    let mut params = std::collections::HashMap::new();
    for (index, current) in matches.iter().enumerate() {
        let next = matches.get(index + 1);
        let raw_segment = if let Some((_, _, next_key_start, _)) = next {
            params_str[current.3..next_key_start.saturating_sub(1)].trim_end()
        } else {
            params_str[current.3..].trim_end()
        };
        let value = if raw_segment.ends_with(&current.1) {
            &raw_segment[..raw_segment.len().saturating_sub(1)]
        } else {
            raw_segment
        };
        params.insert(current.0.clone(), value.to_string());
    }
    params
}

fn parse_labeled_edit_payload(payload: &str) -> Option<(String, String)> {
    let normalized = payload.replace("\r\n", "\n").trim().to_string();
    let regex = Regex::new(r"(?is)^\s*searchText:\s*([\s\S]*?)\n\s*replaceText:\s*([\s\S]*)$")
        .expect("labeled edit regex");
    let captures = regex.captures(&normalized)?;
    let search_text = captures.get(1)?.as_str().trim_end().to_string();
    let replace_text = captures.get(2)?.as_str().trim_end().to_string();
    Some((search_text, replace_text))
}

fn parse_tagged_edit_payload(payload: &str) -> Option<(String, String)> {
    let normalized = payload.replace("\r\n", "\n").trim().to_string();
    let regex = Regex::new(
        r"(?is)^\s*<searchText>\s*([\s\S]*?)\s*</searchText>\s*<replaceText>\s*([\s\S]*?)\s*</replaceText>\s*$",
    )
    .expect("tagged edit regex");
    let captures = regex.captures(&normalized)?;
    let search_text = captures.get(1)?.as_str().trim_end().to_string();
    let replace_text = captures.get(2)?.as_str().trim_end().to_string();
    if search_text.is_empty() || replace_text.is_empty() {
        return None;
    }
    Some((search_text, replace_text))
}

fn parse_annotated_edit_payload(payload: &str) -> Option<(String, String)> {
    let normalized = payload.replace("\r\n", "\n").trim().to_string();
    let regex = Regex::new(
        r"(?is)^\s*(?:(?:/\*|<!--)\s*[^\n]*(?:搜索块|当前|原始|旧|before|search)[^\n]*(?:\*/|-->)\s*)([\s\S]*?)\s*(?:(?:/\*|<!--)\s*[^\n]*(?:替换|改为|修改后|after|replace)[^\n]*(?:\*/|-->)\s*)([\s\S]*)$",
    )
    .expect("annotated edit regex");
    let captures = regex.captures(&normalized)?;
    let search_text = captures.get(1)?.as_str().trim_end().to_string();
    let replace_text = captures.get(2)?.as_str().trim_end().to_string();
    if search_text.is_empty() || replace_text.is_empty() {
        return None;
    }
    Some((search_text, replace_text))
}

fn append_fenced_file_change_sets(
    text: &str,
    action_name: &str,
    operation: &str,
    risk: &str,
    changes: &mut Vec<WorkflowChangeSet>,
) {
    let closed_regex = Regex::new(&format!(
        r"(?is)\[ACTION:{action_name}(?::([^\]]+)|(\s+[^\]]+))\]\s*```(?:\w*\r?\n)?([\s\S]*?)```"
    ))
    .expect("closed file regex");
    for caps in closed_regex.captures_iter(text) {
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: operation.to_string(),
            path,
            search_text: None,
            replace_text: None,
            content: caps.get(3).map(|m| m.as_str().trim_end().to_string()),
            rationale: None,
            risk: Some(risk.to_string()),
            allow_overwrite: None,
        });
    }

    let unterminated_regex = Regex::new(&format!(
        r"(?is)\[ACTION:{action_name}(?::([^\]]+)|(\s+[^\]]+))\]\s*```(?:\w*\r?\n)?([\s\S]*)$"
    ))
    .expect("unterminated file regex");
    for caps in unterminated_regex.captures_iter(text) {
        let Some(content_match) = caps.get(3) else {
            continue;
        };
        let content = content_match.as_str().trim_end();
        if content.is_empty() || content.contains("\n```") {
            continue;
        }
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: operation.to_string(),
            path,
            search_text: None,
            replace_text: None,
            content: Some(content.to_string()),
            rationale: None,
            risk: Some(risk.to_string()),
            allow_overwrite: None,
        });
    }
}

fn parse_inline_action_change_sets(text: &str) -> Vec<WorkflowChangeSet> {
    let mut changes = Vec::new();
    if text.trim().is_empty() {
        return changes;
    }

    append_fenced_file_change_sets(text, "CREATE_FILE", "create_file", "medium", &mut changes);
    append_fenced_file_change_sets(text, "WRITE_FILE", "write_file", "high", &mut changes);

    let edit_regex = Regex::new(
        r"(?is)\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?\s*```(?:search|SEARCH)\r?\n([\s\S]*?)```\s*```(?:replace|REPLACE)\r?\n([\s\S]*?)```",
    )
    .expect("edit regex");
    for caps in edit_regex.captures_iter(text) {
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: "edit_file".to_string(),
            path,
            search_text: caps.get(3).map(|m| m.as_str().trim_end().to_string()),
            replace_text: caps.get(4).map(|m| m.as_str().trim_end().to_string()),
            content: None,
            rationale: None,
            risk: Some("medium".to_string()),
            allow_overwrite: None,
        });
    }

    let labeled_edit_regex = Regex::new(
        r"(?is)\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?[\s\S]*?`?searchText`?:\s*```(?:\w*\r?\n)?([\s\S]*?)```\s*`?replaceText`?:\s*```(?:\w*\r?\n)?([\s\S]*?)```",
    )
    .expect("labeled edit regex");
    for caps in labeled_edit_regex.captures_iter(text) {
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: "edit_file".to_string(),
            path,
            search_text: caps.get(3).map(|m| m.as_str().trim_end().to_string()),
            replace_text: caps.get(4).map(|m| m.as_str().trim_end().to_string()),
            content: None,
            rationale: None,
            risk: Some("medium".to_string()),
            allow_overwrite: None,
        });
    }

    let replace_marker_edit_regex = Regex::new(
        r"(?is)\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?\s*```(?:\w*\r?\n)?([\s\S]*?)```\s*(?:替换为|替换成|replace(?:\s+with)?)[：: ]*\s*```(?:\w*\r?\n)?([\s\S]*?)```",
    )
    .expect("replace marker edit regex");
    for caps in replace_marker_edit_regex.captures_iter(text) {
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: "edit_file".to_string(),
            path,
            search_text: caps.get(3).map(|m| m.as_str().trim_end().to_string()),
            replace_text: caps.get(4).map(|m| m.as_str().trim_end().to_string()),
            content: None,
            rationale: None,
            risk: Some("medium".to_string()),
            allow_overwrite: None,
        });
    }

    let compact_edit_regex =
        Regex::new(r"(?is)\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?\s*```(?:\w+)?\r?\n([\s\S]*?)```").expect("compact edit regex");
    for caps in compact_edit_regex.captures_iter(text) {
        let Some((search_text, replace_text)) = caps.get(3).and_then(|m| {
            parse_labeled_edit_payload(m.as_str())
                .or_else(|| parse_tagged_edit_payload(m.as_str()))
                .or_else(|| parse_annotated_edit_payload(m.as_str()))
        }) else {
            continue;
        };
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: "edit_file".to_string(),
            path,
            search_text: Some(search_text),
            replace_text: Some(replace_text),
            content: None,
            rationale: None,
            risk: Some("medium".to_string()),
            allow_overwrite: None,
        });
    }

    let delete_regex =
        Regex::new(r"(?is)\[ACTION:DELETE(?::([^\]]+)|(\s+[^\]]+))\]").expect("delete regex");
    for caps in delete_regex.captures_iter(text) {
        let legacy_path = caps.get(1).map(|m| m.as_str());
        let param_str = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let params = parse_action_params(param_str);
        let raw_path = legacy_path
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| params.get("path").cloned())
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        changes.push(WorkflowChangeSet {
            operation: "delete".to_string(),
            path,
            search_text: None,
            replace_text: None,
            content: None,
            rationale: None,
            risk: Some("high".to_string()),
            allow_overwrite: None,
        });
    }

    let seen_inline_blocks = Regex::new(r#"(?is)\[ACTION:(CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|DELETE)((?:\s+\w+=(?:"[^"]*"|'[\s\S]*?'))*)\]"#)
        .expect("inline block regex");
    for caps in seen_inline_blocks.captures_iter(text) {
        let action_type = caps
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let params = parse_action_params(caps.get(2).map(|m| m.as_str()).unwrap_or(""));
        let raw_path = params
            .get("path")
            .or_else(|| params.get("file"))
            .or_else(|| params.get("target"))
            .cloned()
            .unwrap_or_default();
        let path = normalize_action_path(&raw_path);
        if path.is_empty() {
            continue;
        }
        let content = params
            .get("content")
            .map(|value| decode_action_param_value(value));
        let search_text = params
            .get("searchText")
            .map(|value| decode_action_param_value(value));
        let replace_text = params
            .get("replaceText")
            .map(|value| decode_action_param_value(value));
        let rationale = params
            .get("reason")
            .or_else(|| params.get("rationale"))
            .map(|value| decode_action_param_value(value));

        let change = match action_type.as_str() {
            "create_folder" => WorkflowChangeSet {
                operation: "create_folder".to_string(),
                path,
                search_text: None,
                replace_text: None,
                content: None,
                rationale,
                risk: Some("low".to_string()),
                allow_overwrite: None,
            },
            "create_file" if content.is_some() => WorkflowChangeSet {
                operation: "create_file".to_string(),
                path,
                search_text: None,
                replace_text: None,
                content,
                rationale,
                risk: Some("medium".to_string()),
                allow_overwrite: None,
            },
            "write_file" if content.is_some() => WorkflowChangeSet {
                operation: "write_file".to_string(),
                path,
                search_text: None,
                replace_text: None,
                content,
                rationale,
                risk: Some("high".to_string()),
                allow_overwrite: None,
            },
            "edit_file" if search_text.is_some() => WorkflowChangeSet {
                operation: "edit_file".to_string(),
                path,
                search_text,
                replace_text,
                content: None,
                rationale,
                risk: Some("medium".to_string()),
                allow_overwrite: None,
            },
            "delete" => WorkflowChangeSet {
                operation: "delete".to_string(),
                path,
                search_text: None,
                replace_text: None,
                content: None,
                rationale,
                risk: Some("high".to_string()),
                allow_overwrite: None,
            },
            _ => continue,
        };
        changes.push(change);
    }

    let mut seen = std::collections::BTreeSet::new();
    changes.retain(|change| {
        let signature = format!(
            "{}|{}|{}|{}|{}",
            change.operation,
            change.path,
            change.search_text.as_deref().unwrap_or(""),
            change.replace_text.as_deref().unwrap_or(""),
            change.content.as_deref().unwrap_or("")
        );
        seen.insert(signature)
    });

    changes
}

fn collect_executable_mutation_paths(text: &str) -> Vec<WorkflowMutationPath> {
    let mut paths: Vec<WorkflowMutationPath> = Vec::new();
    if text.trim().is_empty() {
        return paths;
    }

    let legacy_regex =
        Regex::new(r"\[ACTION:(CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|DELETE):([^\]]+)\]")
            .expect("legacy regex");
    for caps in legacy_regex.captures_iter(text) {
        let action_type = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_uppercase();
        let path = normalize_action_path(caps.get(2).map(|m| m.as_str()).unwrap_or(""));
        if !path.is_empty() {
            paths.push(WorkflowMutationPath { action_type, path });
        }
    }

    let param_regex = Regex::new(
        r#"\[ACTION:(CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|DELETE)((?:\s+\w+="[^"]*")*)\]"#,
    )
    .expect("param regex");
    for caps in param_regex.captures_iter(text) {
        let action_type = caps.get(1).map(|m| m.as_str()).unwrap_or("").to_uppercase();
        let params = parse_action_params(caps.get(2).map(|m| m.as_str()).unwrap_or(""));
        let raw_path = params
            .get("path")
            .or_else(|| params.get("file"))
            .or_else(|| params.get("target"))
            .map(String::as_str)
            .unwrap_or("");
        let path = normalize_action_path(raw_path);
        if !path.is_empty() {
            paths.push(WorkflowMutationPath { action_type, path });
        }
    }

    paths
}

fn parse_changes_from_value(value: &serde_json::Value, changes: &mut Vec<WorkflowChangeSet>) {
    let raw_changes = if let Some(array) = value.as_array() {
        Some(array)
    } else {
        value.get("changes").and_then(|entry| entry.as_array())
    };
    let Some(raw_changes) = raw_changes else {
        return;
    };

    for raw in raw_changes {
        let Some(path) = raw.get("path").and_then(|entry| entry.as_str()) else {
            continue;
        };
        let operation = raw
            .get("operation")
            .or_else(|| raw.get("type"))
            .and_then(|entry| entry.as_str())
            .unwrap_or("")
            .to_lowercase()
            .replace('-', "_");
        if ![
            "create_folder",
            "create_file",
            "write_file",
            "edit_file",
            "delete",
        ]
        .contains(&operation.as_str())
        {
            continue;
        }

        changes.push(WorkflowChangeSet {
            operation,
            path: path.to_string(),
            search_text: raw
                .get("searchText")
                .or_else(|| raw.get("search_text"))
                .and_then(|entry| entry.as_str())
                .map(|value| value.to_string()),
            replace_text: raw
                .get("replaceText")
                .or_else(|| raw.get("replace_text"))
                .and_then(|entry| entry.as_str())
                .map(|value| value.to_string()),
            content: raw
                .get("content")
                .and_then(|entry| entry.as_str())
                .map(|value| value.to_string()),
            rationale: raw
                .get("rationale")
                .and_then(|entry| entry.as_str())
                .map(|value| value.to_string()),
            risk: raw
                .get("risk")
                .and_then(|entry| entry.as_str())
                .map(|value| value.to_string()),
            allow_overwrite: raw
                .get("allowOverwrite")
                .or_else(|| raw.get("allow_overwrite"))
                .and_then(|entry| entry.as_bool()),
        });
    }
}

fn try_parse_json(raw: &str) -> Option<serde_json::Value> {
    for candidate in [
        raw.to_string(),
        Regex::new(r",\s*([}\]])")
            .expect("cleanup regex")
            .replace_all(raw, "$1")
            .to_string(),
    ] {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&candidate) {
            return Some(value);
        }
    }
    None
}

fn extract_structured_change_sets(text: &str) -> Vec<WorkflowChangeSet> {
    let mut changes = Vec::new();
    let json_fence_regex = Regex::new(r"```(?:json)?\s*([\s\S]*?)```").expect("json fence regex");
    for caps in json_fence_regex.captures_iter(text) {
        if let Some(parsed) = caps.get(1).and_then(|m| try_parse_json(m.as_str())) {
            parse_changes_from_value(&parsed, &mut changes);
        }
    }

    let raw_json_regex = Regex::new(r#"(\{[\s\S]*?"changes"\s*:\s*\[[\s\S]*?\][\s\S]*?\})"#)
        .expect("raw json regex");
    for caps in raw_json_regex.captures_iter(text) {
        if let Some(parsed) = caps.get(1).and_then(|m| try_parse_json(m.as_str())) {
            parse_changes_from_value(&parsed, &mut changes);
        }
    }

    let mut seen = std::collections::BTreeSet::new();
    changes.retain(|change| {
        let signature = format!(
            "{}|{}|{}|{}|{}",
            change.operation,
            change.path,
            change.search_text.as_deref().unwrap_or(""),
            change.replace_text.as_deref().unwrap_or(""),
            change.content.as_deref().unwrap_or("")
        );
        seen.insert(signature)
    });

    changes
}

fn extract_required_files(text: &str) -> Vec<String> {
    let mut files = std::collections::BTreeSet::new();
    let json_fence_regex = Regex::new(r"```(?:json)?\s*([\s\S]*?)```").expect("json fence regex");
    for caps in json_fence_regex.captures_iter(text) {
        let Some(parsed) = caps.get(1).and_then(|m| try_parse_json(m.as_str())) else {
            continue;
        };
        let has_valid_changes = parsed
            .get("changes")
            .and_then(|entry| entry.as_array())
            .map(|entries| {
                entries.iter().any(|raw| {
                    raw.get("path").and_then(|entry| entry.as_str()).is_some()
                        && raw
                            .get("operation")
                            .or_else(|| raw.get("type"))
                            .and_then(|entry| entry.as_str())
                            .map(|value| {
                                [
                                    "create_folder",
                                    "create_file",
                                    "write_file",
                                    "edit_file",
                                    "delete",
                                ]
                                .contains(&value.to_lowercase().replace('-', "_").as_str())
                            })
                            .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if !has_valid_changes {
            continue;
        }

        let Some(raw_files) = parsed
            .get("requiredFiles")
            .or_else(|| parsed.get("required_files"))
            .and_then(|entry| entry.as_array())
        else {
            continue;
        };

        for file in raw_files {
            if let Some(value) = file.as_str() {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    files.insert(trimmed.to_string());
                }
            }
        }
    }

    files.into_iter().collect()
}

pub fn analyze_agent_delivery(
    sources: &[WorkflowInputSource],
    user_task_text: &str,
    workspace_path: Option<&str>,
) -> Result<DeliveryAnalysis, String> {
    let extracted = extract_delivery_payload(sources);
    let has_executable_mutation =
        !extracted.executable_mutations.is_empty() || extracted.structured_change_count > 0;
    let has_source_mutation = extracted.executable_mutations.iter().any(|entry| {
        ["CREATE_FILE", "WRITE_FILE", "EDIT_FILE"].contains(&entry.action_type.as_str())
            && Regex::new(r"(?:app\.js|index\.html|styles\.css|src/|src\\|public/|public\\|components/|components\\|pages/|pages\\|assets/|assets\\)")
                .expect("source path regex")
                .is_match(&entry.path)
    });

    let workspace_issues = if let Some(path) = workspace_path {
        verify_workspace_delivery(user_task_text, path)?
    } else {
        Vec::new()
    };

    Ok(DeliveryAnalysis {
        parsed_action_count: extracted.parsed_action_count,
        structured_change_count: extracted.structured_change_count,
        required_files: extracted.required_files,
        executable_mutations: extracted.executable_mutations,
        has_executable_mutation,
        has_source_mutation,
        workspace_issues,
    })
}

pub fn extract_delivery_payload(sources: &[WorkflowInputSource]) -> ExtractedDeliveryPayload {
    let mut executable_mutations = Vec::new();
    let mut change_sets = Vec::new();
    let mut required_files = std::collections::BTreeSet::new();

    for source in sources {
        executable_mutations.extend(collect_executable_mutation_paths(&source.content));
        change_sets.extend(parse_inline_action_change_sets(&source.content));
        change_sets.extend(extract_structured_change_sets(&source.content));
        for file in extract_required_files(&source.content) {
            required_files.insert(file);
        }
    }

    ExtractedDeliveryPayload {
        parsed_action_count: executable_mutations.len(),
        structured_change_count: change_sets.len(),
        required_files: required_files.into_iter().collect(),
        executable_mutations,
        change_sets,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_agent_delivery, evaluate_step_deliverable_guard, extract_delivery_payload,
        StepDeliverableGuardRequest, StepDeliverableTask, WorkflowInputSource,
    };

    #[test]
    fn parses_inline_mutation_actions() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:EDIT_FILE path="app.js" searchText="a" replaceText="b"]"#
                .to_string(),
        }];
        let analysis = analyze_agent_delivery(&sources, "", None).expect("analysis");
        assert_eq!(analysis.parsed_action_count, 1);
        assert!(analysis.has_executable_mutation);
        assert!(analysis.has_source_mutation);
    }

    #[test]
    fn ignores_broken_actions_without_path() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:EDIT_FILE searchText="a" replaceText="b"]"#.to_string(),
        }];
        let analysis = analyze_agent_delivery(&sources, "", None).expect("analysis");
        assert_eq!(analysis.parsed_action_count, 0);
        assert!(!analysis.has_executable_mutation);
    }

    #[test]
    fn parses_structured_change_sets_and_required_files() {
        let sources = vec![WorkflowInputSource {
            content: r#"```json
{"changes":[{"operation":"edit_file","path":"index.html","searchText":"old","replaceText":"new"}],"requiredFiles":["index.html","styles.css"]}
```"#
                .to_string(),
        }];
        let analysis = analyze_agent_delivery(&sources, "", None).expect("analysis");
        assert_eq!(analysis.structured_change_count, 1);
        assert!(analysis.has_executable_mutation);
        assert_eq!(
            analysis.required_files,
            vec!["index.html".to_string(), "styles.css".to_string()]
        );
    }

    #[test]
    fn extracts_inline_change_sets_for_backend_execution() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:EDIT_FILE path="app.js" searchText="old" replaceText="new"]
[ACTION:CREATE_FILE path="icons/a.svg" content='<svg></svg>']
[ACTION:CREATE_FOLDER path="icons"]"#
                .to_string(),
        }];
        let extracted = extract_delivery_payload(&sources);
        assert_eq!(extracted.change_sets.len(), 3);
        assert!(extracted
            .change_sets
            .iter()
            .any(|change| change.operation == "edit_file" && change.path == "app.js"));
        assert!(extracted
            .change_sets
            .iter()
            .any(|change| change.operation == "create_file" && change.path == "icons/a.svg"));
        assert!(extracted
            .change_sets
            .iter()
            .any(|change| change.operation == "create_folder" && change.path == "icons"));
    }

    #[test]
    fn extracts_unterminated_create_file_fence() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:CREATE_FILE path="index.html"]
```html
<!DOCTYPE html>
<html>
  <body>todo</body>
</html>"#
                .to_string(),
        }];
        let extracted = extract_delivery_payload(&sources);
        assert!(extracted
            .change_sets
            .iter()
            .any(|change| change.operation == "create_file"
                && change.path == "index.html"
                && change
                    .content
                    .as_deref()
                    .unwrap_or("")
                    .contains("<body>todo</body>")));
    }

    #[test]
    fn extracts_annotated_compact_edit_blocks() {
        let sources = vec![WorkflowInputSource {
            content: r#"**[ACTION:EDIT_FILE:styles.css]**
```css
/* 搜索块：h1 当前样式 */
h1 {
    color: #333;
}

/* 替换为更温和的标题颜色 */
h1 {
    color: #4a5568;
}
```"#
                .to_string(),
        }];
        let extracted = extract_delivery_payload(&sources);
        assert!(extracted.change_sets.iter().any(|change| {
            change.operation == "edit_file"
                && change.path == "styles.css"
                && change
                    .search_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("color: #333;")
                && change
                    .replace_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("color: #4a5568;")
        }));
    }

    #[test]
    fn extracts_annotated_compact_edit_blocks_with_marker_comments() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:EDIT_FILE:styles.css]
```css
/* 🎯 搜索块 2: #add-btn 原始 border-radius */
#add-btn {
    padding: 0.65rem 1.5rem;
    font-size: 1rem;
    background-color: #4a90d9;
    color: #fff;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.2s;
    white-space: nowrap;
}

/* 替换为加大圆角 */
#add-btn {
    padding: 0.65rem 1.5rem;
    font-size: 1rem;
    background-color: #4a90d9;
    color: #fff;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    transition: background-color 0.2s;
    white-space: nowrap;
}
```"#
                .to_string(),
        }];
        let extracted = extract_delivery_payload(&sources);
        assert!(extracted.change_sets.iter().any(|change| {
            change.operation == "edit_file"
                && change.path == "styles.css"
                && change
                    .search_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("border-radius: 6px;")
                && change
                    .replace_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("border-radius: 12px;")
        }));
    }

    #[test]
    fn extracts_tagged_compact_edit_blocks() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:EDIT_FILE:index.html]
```html
<searchText>
<h1>待办事项</h1>
</searchText>
<replaceText>
<h1>我的小记</h1>
</replaceText>
```"#
                .to_string(),
        }];
        let extracted = extract_delivery_payload(&sources);
        assert!(extracted.change_sets.iter().any(|change| {
            change.operation == "edit_file"
                && change.path == "index.html"
                && change
                    .search_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("<h1>待办事项</h1>")
                && change
                    .replace_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("<h1>我的小记</h1>")
        }));
    }

    #[test]
    fn extracts_replace_marker_edit_blocks() {
        let sources = vec![WorkflowInputSource {
            content: r#"[ACTION:EDIT_FILE:index.html]
```html
<h1>待办事项</h1>
```
替换为：
```html
<h1>📋 待办事项</h1>
```"#
                .to_string(),
        }];
        let extracted = extract_delivery_payload(&sources);
        assert!(extracted.change_sets.iter().any(|change| {
            change.operation == "edit_file"
                && change.path == "index.html"
                && change
                    .search_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("<h1>待办事项</h1>")
                && change
                    .replace_text
                    .as_deref()
                    .unwrap_or("")
                    .contains("<h1>📋 待办事项</h1>")
        }));
    }

    #[test]
    fn guards_implementation_steps_without_real_source_mutations() {
        let decision = evaluate_step_deliverable_guard(&StepDeliverableGuardRequest {
            step_expert_ids: vec!["jiang-yumo".to_string()],
            has_workspace_context: true,
            tasks: vec![StepDeliverableTask {
                output: Some(r#"[ACTION:CREATE_FILE path="notes.md"]"#.to_string()),
            }],
        });
        assert!(decision.requires_real_artifact);
        assert!(!decision.has_real_artifact);
        assert!(decision.blocker_message.is_some());
    }

    #[test]
    fn accepts_precise_source_mutations_for_implementation_steps() {
        let decision = evaluate_step_deliverable_guard(&StepDeliverableGuardRequest {
            step_expert_ids: vec!["jiang-yumo".to_string()],
            has_workspace_context: true,
            tasks: vec![StepDeliverableTask {
                output: Some(
                    r#"[ACTION:EDIT_FILE path="app.js" searchText="old" replaceText="new"]"#
                        .to_string(),
                ),
            }],
        });
        assert!(decision.has_real_artifact);
        assert!(decision.blocker_message.is_none());
    }

    #[test]
    fn expert_reply_guard_requests_retry_for_approximate_patch() {
        let decision = super::evaluate_expert_reply_guard(&super::ExpertReplyGuardRequest {
            expert_id: "jiang-yumo".to_string(),
            has_workspace_context: true,
            workspace_looks_empty: false,
            reply: r#"[ACTION:EDIT_FILE path="app.js" searchText="old..." replaceText="new"]"#
                .to_string(),
        });
        assert!(decision.should_enforce);
        assert!(decision.requires_retry);
        assert!(decision
            .reminder_prompt
            .as_deref()
            .unwrap_or("")
            .contains("近似/截断补丁"));
    }

    #[test]
    fn expert_reply_guard_retries_on_unexecutable_edit_declaration() {
        let decision = super::evaluate_expert_reply_guard(&super::ExpertReplyGuardRequest {
            expert_id: "jiang-yumo".to_string(),
            has_workspace_context: true,
            workspace_looks_empty: false,
            reply: r#"[ACTION:EDIT_FILE:index.html]
```html
<h1>我的待办</h1>
```
→ 替换原来的 `<h1>待办事项</h1>`"#
                .to_string(),
        });
        assert!(decision.should_enforce);
        assert!(decision.requires_retry);
        assert!(decision
            .reminder_prompt
            .as_deref()
            .unwrap_or("")
            .contains("精确变更主体"));
    }

    #[test]
    fn expert_reply_guard_accepts_precise_source_patch() {
        let decision = super::evaluate_expert_reply_guard(&super::ExpertReplyGuardRequest {
            expert_id: "jiang-yumo".to_string(),
            has_workspace_context: true,
            workspace_looks_empty: false,
            reply: r#"[ACTION:EDIT_FILE path="app.js" searchText="old" replaceText="new"]"#
                .to_string(),
        });
        assert!(decision.should_enforce);
        assert!(!decision.requires_retry);
    }

    #[test]
    fn expert_reply_guard_pushes_empty_workspace_to_create_files() {
        let decision = super::evaluate_expert_reply_guard(&super::ExpertReplyGuardRequest {
            expert_id: "jiang-yumo".to_string(),
            has_workspace_context: true,
            workspace_looks_empty: true,
            reply: "我建议先做一个轻量单页便签板，再细化实现。".to_string(),
        });
        assert!(decision.should_enforce);
        assert!(decision.requires_retry);
        assert!(decision
            .reminder_prompt
            .as_deref()
            .unwrap_or("")
            .contains("CREATE_FILE:index.html"));
    }
}
