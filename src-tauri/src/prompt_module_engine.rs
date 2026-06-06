use crate::expert_identity::{
    is_creative_expert as is_catalog_creative_expert,
    is_documentation_expert as is_catalog_documentation_expert,
    is_implementation_expert as is_catalog_implementation_expert,
    is_review_expert as is_catalog_review_expert,
    normalize_expert_id,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const CODE_TOOL_PRIMER: &str = "code-tool-primer";
const WEB_SEARCH_GUIDANCE: &str = "web-search-guidance";
const COMMAND_GUIDANCE: &str = "command-guidance";
const DOCUMENT_TOOL_PRIMER: &str = "document-tool-primer";
const MEDIA_TOOL_PRIMER: &str = "media-tool-primer";
const VIDEO_WORKFLOW: &str = "video-workflow";
const PATCH_GUIDANCE: &str = "patch-guidance";
const DELIVERABLE_GUIDANCE: &str = "deliverable-guidance";

const WEB_SEARCH_TRIGGER_KEYWORDS: &[&str] = &[
    "最新",
    "最近",
    "官网",
    "官方",
    "文档",
    "release",
    "changelog",
    "版本",
    "兼容",
    "api",
    "接口",
    "框架",
    "库",
    "标准",
    "规范",
    "搜索",
    "联网",
    "外部",
    "资料",
    "新闻",
    "cve",
    "漏洞",
];
const COMMAND_TRIGGER_KEYWORDS: &[&str] = &[
    "测试",
    "test",
    "build",
    "lint",
    "运行",
    "run",
    "启动",
    "日志",
    "环境",
    "依赖",
    "版本",
    "编译",
    "打包",
    "安装",
    "npm",
    "pnpm",
    "yarn",
    "cargo",
    "python",
    "node",
    "git",
    "shell",
    "cmd",
    "powershell",
    "bash",
    "终端",
    "命令",
    "控制台",
    "迁移",
    "server",
    "复现",
    "验证",
];
const VIDEO_TRIGGER_KEYWORDS: &[&str] = &[
    "视频",
    "分镜",
    "镜头",
    "片段",
    "segment",
    "timeline",
    "storyboard",
];
const SEARCH_NEGATION_PATTERNS: &[&str] = &[
    "不需要联网",
    "不需要搜索",
    "不需要外部资料",
    "不需要官方文档",
    "不需要最新资料",
    "无需联网",
    "无需搜索",
    "无需外部资料",
    "无需官方文档",
    "无需最新资料",
    "不用联网",
    "不用搜索",
    "不用外部资料",
    "不用官方文档",
    "不用最新资料",
    "不必联网",
    "不必搜索",
    "不必外部资料",
    "不必官方文档",
    "不必最新资料",
    "不要联网",
    "不要搜索",
    "不要外部资料",
    "不要官方文档",
    "不要最新资料",
];
const COMMAND_NEGATION_PATTERNS: &[&str] = &[
    "不需要运行",
    "不需要执行",
    "不需要命令",
    "不需要测试",
    "不需要构建",
    "不需要build",
    "不需要lint",
    "无需运行",
    "无需执行",
    "无需命令",
    "无需测试",
    "无需构建",
    "无需build",
    "无需lint",
    "不用运行",
    "不用执行",
    "不用命令",
    "不用测试",
    "不用构建",
    "不用build",
    "不用lint",
    "不必运行",
    "不必执行",
    "不必命令",
    "不必测试",
    "不必构建",
    "不必build",
    "不必lint",
    "不要运行",
    "不要执行",
    "不要命令",
    "不要测试",
    "不要构建",
    "不要build",
    "不要lint",
];
const VIDEO_NEGATION_PATTERNS: &[&str] = &[
    "不需要视频",
    "无需视频",
    "不要视频",
    "不需要分镜",
    "无需分镜",
    "不要分镜",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptModuleTrace {
    pub expert_id: String,
    pub scene: String,
    pub task_description: String,
    pub module_ids: Vec<String>,
    pub trigger_sources: Vec<String>,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptPlanRequest {
    pub project_name: Option<String>,
    pub expert_id: String,
    pub base_prompt: String,
    pub scene: String,
    pub task_description: String,
    pub hint_module_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptPlanResponse {
    pub prompt: String,
    pub module_ids: Vec<String>,
    pub history_hint_module_ids: Vec<String>,
    pub sanitized_task_description: String,
}

pub fn sanitize_task_description(task_description: &str) -> String {
    task_description
        .split("【共享黑板")
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

pub fn normalize_module_ids(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        if is_prompt_module_id(value) && seen.insert(value.clone()) {
            normalized.push(value.clone());
        }
    }
    normalized
}

pub fn build_prompt_plan(
    request: &PromptPlanRequest,
    traces: &[PromptModuleTrace],
) -> PromptPlanResponse {
    let normalized_expert_id = normalize_expert_id(&request.expert_id).to_string();
    let supported = supported_modules_for_expert(&normalized_expert_id);
    let history_hint_module_ids = suggest_history_hints(
        traces,
        &normalized_expert_id,
        &request.scene,
        &request.task_description,
        2,
    )
    .into_iter()
    .filter(|module_id| supported.contains(module_id))
    .collect::<Vec<String>>();
    let explicit_hints = normalize_module_ids(&request.hint_module_ids)
        .into_iter()
        .filter(|module_id| supported.contains(module_id))
        .collect::<Vec<String>>();
    let mut module_ids = select_prompt_modules(
        &normalized_expert_id,
        &request.scene,
        &request.task_description,
    );
    for module_id in history_hint_module_ids.iter().chain(explicit_hints.iter()) {
        if !module_ids.iter().any(|existing| existing == module_id) {
            module_ids.push(module_id.clone());
        }
    }
    let prompt = assemble_prompt(&request.base_prompt, &module_ids);
    PromptPlanResponse {
        prompt,
        module_ids,
        history_hint_module_ids,
        sanitized_task_description: sanitize_task_description(&request.task_description),
    }
}

fn supported_modules_for_expert(expert_id: &str) -> HashSet<String> {
    prompt_module_map(false)
        .get(expert_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.to_string())
        .collect()
}

fn select_prompt_modules(expert_id: &str, scene: &str, task_description: &str) -> Vec<String> {
    let mut modules: Vec<String> = prompt_module_map(true)
        .get(expert_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.to_string())
        .collect();
    let has_code_tool_primer = modules
        .iter()
        .any(|module_id| module_id == CODE_TOOL_PRIMER);

    if has_code_tool_primer {
        let needs_search = scene == "research-with-search"
            || (includes_keyword(task_description, WEB_SEARCH_TRIGGER_KEYWORDS)
                && !matches_phrase(task_description, SEARCH_NEGATION_PATTERNS));
        let needs_command = scene == "code-review"
            || (includes_keyword(task_description, COMMAND_TRIGGER_KEYWORDS)
                && !matches_phrase(task_description, COMMAND_NEGATION_PATTERNS));
        if needs_search
            && !modules
                .iter()
                .any(|module_id| module_id == WEB_SEARCH_GUIDANCE)
        {
            modules.push(WEB_SEARCH_GUIDANCE.to_string());
        }
        if needs_command
            && !modules
                .iter()
                .any(|module_id| module_id == COMMAND_GUIDANCE)
        {
            modules.push(COMMAND_GUIDANCE.to_string());
        }
    }

    if normalize_expert_id(expert_id) == "discipline-760" {
        let needs_video = scene == "video-production"
            || (includes_keyword(task_description, VIDEO_TRIGGER_KEYWORDS)
                && !matches_phrase(task_description, VIDEO_NEGATION_PATTERNS));
        if needs_video && !modules.iter().any(|module_id| module_id == VIDEO_WORKFLOW) {
            modules.push(VIDEO_WORKFLOW.to_string());
        }
    }

    modules
}

fn assemble_prompt(base_prompt: &str, module_ids: &[String]) -> String {
    let mut sections = vec![base_prompt.trim().to_string()];
    for module_id in module_ids {
        if let Some(text) = prompt_text(module_id) {
            sections.push(text.to_string());
        }
    }
    sections.join("\n\n")
}

fn prompt_text(module_id: &str) -> Option<&'static str> {
    match module_id {
        CODE_TOOL_PRIMER => Some(
            "【按需工具总则】\n- 只有在结论依赖外部最新信息或本地验证时才调用工具，不需要就不要主动提工具。\n- 一旦确定需要工具，不要只给建议，直接输出标准动作。\n- 所有工具动作都必须带 reason，系统会把发起专家和理由展示给用户。\n\n最小动作格式：\n- 网络搜索：[ACTION:WEB_SEARCH query=\"搜索关键词\" reason=\"为什么必须搜索\"]\n- 命令执行：[ACTION:EXECUTE_CMD command=\"具体命令\" dir=\"工作目录\" reason=\"为什么必须执行\"]"
        ),
        WEB_SEARCH_GUIDANCE => Some(
            "【网络搜索细则】\n- 仅在需要最新信息、外部事实、官方文档、版本兼容性或互联网资料时使用。\n- 先想清楚最小必要查询，再搜索；关键词尽量具体，优先“产品/框架名 + 目标问题”。\n- 搜索结果会自动注入你的后续推理，你应基于结果继续完成任务。"
        ),
        COMMAND_GUIDANCE => Some(
            "【命令执行细则】\n- 适用于测试、构建、lint、依赖检查、日志排查、环境确认、版本核验与复现问题。\n- dir 填最小必要工作目录，并且只能写 `.`、`src`、`src/components` 这种真实相对目录；不要写“项目根目录”“当前项目”“工作区”这类展示用描述。\n- 如果要在项目根目录执行，dir 直接写 `.`。\n- 当前环境如果明显是 Windows 路径（如 `C:\\...`），优先使用 `rg`、`dir`、`Get-ChildItem`、`Get-Content`、`Select-String` 等可在 Windows 直接运行的命令；不要默认使用 `grep`、`sed`、`awk`、`bash`。\n- 命令可能涉及受限或管理员授权，系统会拦截，你只需如实提出。\n- 收到执行结果后，要把结果转化为结论，不要只复述输出。"
        ),
        DOCUMENT_TOOL_PRIMER => Some(
            "【文档工具模块】\n- 读取文档：[ACTION:READ_DOCUMENT path=\"文档路径\"]\n- 写入文档：[ACTION:WRITE_DOCUMENT path=\"文档路径\" format=\"md|txt|docx\" content=\"正文内容\"]\n- 仅在确实需要读取或生成文档文件时使用。"
        ),
        MEDIA_TOOL_PRIMER => Some(
            "【媒体工具模块】\n- 生成图像：[ACTION:GENERATE_IMAGE prompt=\"图像提示词\" size=\"1024x1024\"]\n- 画布加节点：[ACTION:CANVAS_ADD_NODE type=\"file|note|image\" src=\"说明或路径\"]\n- 画布连线：[ACTION:CANVAS_CONNECT from=\"节点ID\" to=\"节点ID\"]\n- 只有在确实需要生成媒体或组织画布时使用。"
        ),
        VIDEO_WORKFLOW => Some("【视频工作流模块】\n当收到视频创作任务时，先做镜头分段规划，再逐段生成，最后输出拼接方案。"),
        PATCH_GUIDANCE => Some("【精确修改细则】\n- 当前系统不会执行 `file_patch` / `*** Begin Patch` 这类补丁文本；不要输出补丁语法。\n- 你必须输出系统可直接落盘的文件动作。\n- 修改已有文件前，先读取真实文件内容，再给出精确的 `searchText` / `replaceText`。"),
        DELIVERABLE_GUIDANCE => Some("【交付物落盘硬约束】\n- 不能只在文字里宣称完成；需要文件时必须真实落盘。\n- 不要用 shell 重定向创建交付文件，直接使用文件动作。"),
        _ => None,
    }
}

fn is_prompt_module_id(value: &str) -> bool {
    matches!(
        value,
        CODE_TOOL_PRIMER
            | WEB_SEARCH_GUIDANCE
            | COMMAND_GUIDANCE
            | DOCUMENT_TOOL_PRIMER
            | MEDIA_TOOL_PRIMER
            | VIDEO_WORKFLOW
            | PATCH_GUIDANCE
            | DELIVERABLE_GUIDANCE
    )
}

fn is_engineering_expert(expert_id: &str) -> bool {
    is_catalog_implementation_expert(expert_id)
}

fn is_review_expert(expert_id: &str) -> bool {
    is_catalog_review_expert(expert_id)
}

fn is_documentation_expert(expert_id: &str) -> bool {
    is_catalog_documentation_expert(expert_id)
        || normalize_expert_id(expert_id).as_ref() == "discipline-860"
}

fn is_creative_expert(expert_id: &str) -> bool {
    matches!(
        normalize_expert_id(expert_id).as_ref(),
        "discipline-750"
    )
        || is_catalog_creative_expert(expert_id)
}

fn is_analysis_expert(expert_id: &str) -> bool {
    matches!(
        normalize_expert_id(expert_id).as_ref(),
        "discipline-110"
            | "discipline-120"
            | "discipline-190"
            | "discipline-630"
            | "discipline-720"
            | "discipline-790"
            | "discipline-810"
            | "discipline-830"
            | "discipline-840"
            | "discipline-880"
            | "discipline-890"
            | "discipline-910"
    )
}

fn prompt_module_map(static_only: bool) -> HashMap<&'static str, Vec<&'static str>> {
    let mut map = HashMap::new();
    for expert_id in [
        "discipline-110", "discipline-120", "discipline-130", "discipline-140", "discipline-150",
        "discipline-160", "discipline-170", "discipline-180", "discipline-190", "discipline-210",
        "discipline-220", "discipline-230", "discipline-240", "discipline-310", "discipline-320",
        "discipline-330", "discipline-340", "discipline-350", "discipline-360", "discipline-410",
        "discipline-413", "discipline-416", "discipline-420", "discipline-430", "discipline-440",
        "discipline-450", "discipline-460", "discipline-470", "discipline-480", "discipline-490",
        "discipline-510", "discipline-520", "discipline-530", "discipline-535", "discipline-540",
        "discipline-550", "discipline-560", "discipline-570", "discipline-580", "discipline-590",
        "discipline-610", "discipline-620", "discipline-630", "discipline-710", "discipline-720",
        "discipline-730", "discipline-740", "discipline-750", "discipline-760", "discipline-770",
        "discipline-780", "discipline-790", "discipline-810", "discipline-820", "discipline-830",
        "discipline-840", "discipline-850", "discipline-860", "discipline-870", "discipline-880",
        "discipline-890", "discipline-910",
    ] {
        let modules = if is_engineering_expert(expert_id) {
            if static_only {
                vec![CODE_TOOL_PRIMER, PATCH_GUIDANCE, DELIVERABLE_GUIDANCE]
            } else {
                vec![
                    CODE_TOOL_PRIMER,
                    WEB_SEARCH_GUIDANCE,
                    COMMAND_GUIDANCE,
                    PATCH_GUIDANCE,
                    DELIVERABLE_GUIDANCE,
                ]
            }
        } else if is_review_expert(expert_id) {
            if static_only {
                vec![CODE_TOOL_PRIMER, DELIVERABLE_GUIDANCE]
            } else {
                vec![
                    CODE_TOOL_PRIMER,
                    WEB_SEARCH_GUIDANCE,
                    COMMAND_GUIDANCE,
                    DELIVERABLE_GUIDANCE,
                ]
            }
        } else if is_documentation_expert(expert_id) {
            if expert_id == "discipline-740" {
                if static_only {
                    vec![CODE_TOOL_PRIMER]
                } else {
                    vec![CODE_TOOL_PRIMER, WEB_SEARCH_GUIDANCE]
                }
            } else if static_only {
                vec![DOCUMENT_TOOL_PRIMER]
            } else {
                vec![DOCUMENT_TOOL_PRIMER, WEB_SEARCH_GUIDANCE]
            }
        } else if is_creative_expert(expert_id) {
            if expert_id == "discipline-760" {
                if static_only {
                    vec![MEDIA_TOOL_PRIMER]
                } else {
                    vec![MEDIA_TOOL_PRIMER, WEB_SEARCH_GUIDANCE, VIDEO_WORKFLOW]
                }
            } else if static_only {
                vec![CODE_TOOL_PRIMER, DELIVERABLE_GUIDANCE]
            } else {
                vec![CODE_TOOL_PRIMER, WEB_SEARCH_GUIDANCE, DELIVERABLE_GUIDANCE]
            }
        } else if is_analysis_expert(expert_id) {
            if static_only {
                vec![CODE_TOOL_PRIMER, COMMAND_GUIDANCE]
            } else {
                vec![CODE_TOOL_PRIMER, WEB_SEARCH_GUIDANCE, COMMAND_GUIDANCE]
            }
        } else if static_only {
            vec![CODE_TOOL_PRIMER]
        } else {
            vec![CODE_TOOL_PRIMER, WEB_SEARCH_GUIDANCE, COMMAND_GUIDANCE]
        };
        map.insert(expert_id, modules);
    }
    map
}

fn includes_keyword(text: &str, keywords: &[&str]) -> bool {
    let normalized = text.to_lowercase();
    keywords
        .iter()
        .any(|keyword| normalized.contains(&keyword.to_lowercase()))
}

fn matches_phrase(text: &str, phrases: &[&str]) -> bool {
    let normalized = text.to_lowercase();
    phrases
        .iter()
        .any(|phrase| normalized.contains(&phrase.to_lowercase()))
}

fn tokenize_prompt_text(text: &str) -> Vec<String> {
    let normalized = text.to_lowercase();
    let mut tokens = Vec::new();
    let mut current_ascii = String::new();
    let chinese_chars: Vec<char> = normalized.chars().collect();
    for ch in &chinese_chars {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '#' | '-') {
            current_ascii.push(*ch);
        } else if !current_ascii.is_empty() {
            if current_ascii.len() >= 2 {
                tokens.push(current_ascii.clone());
            }
            current_ascii.clear();
        }
    }
    if current_ascii.len() >= 2 {
        tokens.push(current_ascii);
    }

    let blocks: Vec<String> = normalized
        .split(|ch: char| !('\u{4e00}' <= ch && ch <= '\u{9fff}'))
        .filter(|block| !block.is_empty())
        .map(|block| block.to_string())
        .collect();
    for block in blocks {
        let chars: Vec<char> = block.chars().collect();
        for index in 0..chars.len() {
            tokens.push(chars[index].to_string());
            if index + 1 < chars.len() {
                tokens.push(chars[index..=index + 1].iter().collect());
            }
            if index + 2 < chars.len() {
                tokens.push(chars[index..=index + 2].iter().collect());
            }
        }
    }
    tokens.into_iter().take(120).collect()
}

fn build_trace_signature(trace: &PromptModuleTrace) -> String {
    let mut module_ids = normalize_module_ids(&trace.module_ids);
    module_ids.sort();
    let mut trigger_sources = trace.trigger_sources.clone();
    trigger_sources.sort();
    trigger_sources.dedup();
    format!(
        "{}||{}||{}||{}||{}",
        trace.expert_id,
        trace.scene,
        sanitize_task_description(&trace.task_description).to_lowercase(),
        module_ids.join(","),
        trigger_sources.join(",")
    )
}

pub fn dedupe_traces(traces: Vec<PromptModuleTrace>) -> Vec<PromptModuleTrace> {
    let mut trace_map: HashMap<String, PromptModuleTrace> = HashMap::new();
    for trace in traces {
        let signature = build_trace_signature(&trace);
        match trace_map.get(&signature) {
            Some(existing) if existing.created_at > trace.created_at => {}
            _ => {
                trace_map.insert(signature, trace);
            }
        }
    }
    let mut values: Vec<PromptModuleTrace> = trace_map.into_values().collect();
    values.sort_by_key(|trace| trace.created_at);
    if values.len() > 500 {
        values = values.split_off(values.len() - 500);
    }
    values
}

pub fn suggest_history_hints(
    traces: &[PromptModuleTrace],
    expert_id: &str,
    scene: &str,
    task_description: &str,
    max_modules: usize,
) -> Vec<String> {
    let normalized_expert_id = normalize_expert_id(expert_id);
    let relevant_traces = traces
        .iter()
        .filter(|trace| normalize_expert_id(&trace.expert_id) == normalized_expert_id)
        .collect::<Vec<&PromptModuleTrace>>();
    if relevant_traces.is_empty() {
        return vec![];
    }
    let current_tokens = tokenize_prompt_text(task_description)
        .into_iter()
        .collect::<HashSet<String>>();
    let mut module_scores: HashMap<String, f64> = HashMap::new();

    for trace in relevant_traces {
        let trace_tokens = tokenize_prompt_text(&trace.task_description)
            .into_iter()
            .collect::<HashSet<String>>();
        let overlap_count = current_tokens
            .iter()
            .filter(|token| trace_tokens.contains(*token))
            .count();
        let scene_score = if trace.scene == scene {
            1.0
        } else if trace.scene.starts_with("code") && scene.starts_with("code") {
            0.35
        } else {
            0.0
        };
        let overlap_score = if overlap_count == 0 {
            0.0
        } else {
            overlap_count as f64
                / std::cmp::max(
                    4,
                    std::cmp::min(current_tokens.len() + trace_tokens.len(), 18),
                ) as f64
        };
        let total_score = scene_score + overlap_score * 4.0;
        if total_score < 0.9 {
            continue;
        }
        for module_id in normalize_module_ids(&trace.module_ids) {
            *module_scores.entry(module_id).or_insert(0.0) += total_score;
        }
    }

    let mut scored = module_scores.into_iter().collect::<Vec<(String, f64)>>();
    scored.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
        .into_iter()
        .filter(|(_, score)| *score >= 0.9)
        .take(max_modules)
        .map(|(module_id, _)| module_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_prompt_plan_with_history_hints() {
        let traces = vec![PromptModuleTrace {
            expert_id: "discipline-520".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复登录页白屏并运行 pnpm build 验证".to_string(),
            module_ids: vec![COMMAND_GUIDANCE.to_string()],
            trigger_sources: vec!["command".to_string()],
            created_at: 1,
        }];
        let request = PromptPlanRequest {
            project_name: Some("demo".to_string()),
            expert_id: "discipline-520".to_string(),
            base_prompt: "BASE".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复白屏并验证 build 结果".to_string(),
            hint_module_ids: vec![],
        };
        let plan = build_prompt_plan(&request, &traces);
        assert!(plan
            .module_ids
            .iter()
            .any(|module_id| module_id == COMMAND_GUIDANCE));
        assert!(plan.prompt.contains("BASE"));
    }

    #[test]
    fn dedupes_prompt_traces_by_signature() {
        let traces = vec![
            PromptModuleTrace {
                expert_id: "discipline-520".to_string(),
                scene: "code-development".to_string(),
                task_description: "修复白屏".to_string(),
                module_ids: vec![COMMAND_GUIDANCE.to_string()],
                trigger_sources: vec!["command".to_string()],
                created_at: 1,
            },
            PromptModuleTrace {
                expert_id: "discipline-520".to_string(),
                scene: "code-development".to_string(),
                task_description: "修复白屏".to_string(),
                module_ids: vec![COMMAND_GUIDANCE.to_string()],
                trigger_sources: vec!["command".to_string()],
                created_at: 2,
            },
        ];
        let deduped = dedupe_traces(traces);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].created_at, 2);
    }

    #[test]
    fn analysis_and_documentation_disciplines_receive_matching_modules() {
        let request = PromptPlanRequest {
            project_name: Some("demo".to_string()),
            expert_id: "discipline-630".to_string(),
            base_prompt: "BASE".to_string(),
            scene: "disciplinary-analysis".to_string(),
            task_description: "分析多专家调度机制".to_string(),
            hint_module_ids: vec![],
        };
        let plan = build_prompt_plan(&request, &[]);
        assert!(plan
            .module_ids
            .iter()
            .any(|module_id| module_id == COMMAND_GUIDANCE));

        let doc_request = PromptPlanRequest {
            project_name: Some("demo".to_string()),
            expert_id: "discipline-860".to_string(),
            base_prompt: "BASE".to_string(),
            scene: "writing".to_string(),
            task_description: "整理传播稿资料".to_string(),
            hint_module_ids: vec![],
        };
        let doc_plan = build_prompt_plan(&doc_request, &[]);
        assert!(doc_plan
            .module_ids
            .iter()
            .any(|module_id| module_id == DOCUMENT_TOOL_PRIMER));
    }
}
