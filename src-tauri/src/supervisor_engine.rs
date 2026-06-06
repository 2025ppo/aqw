use crate::expert_identity::{
    is_implementation_expert, is_review_expert, normalize_expert_id, normalize_expert_ids,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const SUPPORTED_PROMPT_MODULES: &[&str] = &[
    "code-tool-primer",
    "web-search-guidance",
    "command-guidance",
    "document-tool-primer",
    "media-tool-primer",
    "video-workflow",
];

const INFORMATION_SCIENCE_EXPERT: &str = "discipline-120";
const ARCHITECTURE_ENGINEERING_EXPERT: &str = "discipline-413";
const GENERAL_ENGINEERING_EXPERT: &str = "discipline-520";
const QUALITY_REVIEW_EXPERT: &str = "discipline-620";
const MANAGEMENT_EXPERT: &str = "discipline-630";
const TRANSLATION_EXPERT: &str = "discipline-740";
const WRITING_EXPERT: &str = "discipline-750";
const DESIGN_EXPERT: &str = "discipline-760";
const COMPLIANCE_REVIEW_EXPERT: &str = "discipline-820";
const DOCUMENTATION_EXPERT: &str = "discipline-870";
const DATA_ANALYSIS_EXPERT: &str = "discipline-910";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorExpertInfo {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub code: Option<String>,
    pub category_id: Option<String>,
    pub category_label: Option<String>,
    pub tool_profile: Option<String>,
    pub system_role: Option<bool>,
    pub activation_score: Option<i32>,
    pub activation_level: Option<String>,
    pub activation_probability: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorDispatchPlan {
    pub scene: String,
    pub task_description: String,
    pub expert_ids: Vec<String>,
    pub requires_design: Option<bool>,
    pub prompt_module_hints: Option<HashMap<String, Vec<String>>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorExpertResult {
    pub expert_name: String,
    pub expert_title: String,
    pub status: String,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FollowupIntentRequest {
    pub followup_message: String,
    pub current_scene: String,
    pub current_task_description: String,
    pub current_step_summary: String,
    pub remaining_expert_summary: String,
    pub progress_report: String,
    pub active_task_summary: String,
    pub allowed_expert_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FollowupIntentDecision {
    pub action: String,
    pub task_description: Option<String>,
    pub reply: Option<String>,
    pub target_expert_ids: Vec<String>,
    pub delivery_mode: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MidCheckRequest {
    pub step_index: usize,
    pub total_steps: usize,
    pub task_description: String,
    pub followup_context: String,
    pub results_summary: String,
    pub remaining_desc: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MidCheckDecision {
    pub action: String,
    pub reason: Option<String>,
}

pub fn fallback_dispatch_plan(user_message: &str) -> SupervisorDispatchPlan {
    SupervisorDispatchPlan {
        scene: "quick-answer".to_string(),
        task_description: user_message.to_string(),
        expert_ids: vec![],
        requires_design: None,
        prompt_module_hints: None,
    }
}

pub fn build_supervisor_prompt(available_experts: &[SupervisorExpertInfo]) -> String {
    let expert_list = available_experts
        .iter()
        .map(|expert| {
            let mut tags = Vec::new();
            if let Some(code) = expert.code.as_deref().filter(|value| !value.trim().is_empty()) {
                tags.push(format!("代码 {}", code));
            }
            if let Some(category) = expert
                .category_label
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                tags.push(category.to_string());
            }
            if let Some(profile) = expert
                .tool_profile
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                tags.push(format!("能力画像 {}", profile));
            }
            if expert.system_role.unwrap_or(false) {
                tags.push("系统角色".to_string());
            }
            if let Some(level) = expert
                .activation_level
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                let probability = expert
                    .activation_probability
                    .map(|value| format!("{:.0}%", value * 100.0))
                    .unwrap_or_else(|| "未知".to_string());
                let score = expert
                    .activation_score
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "?".to_string());
                tags.push(format!("职责触发 {} / {} / {}", level, probability, score));
            }
            let tag_text = if tags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", tags.join(" / "))
            };
            format!(
                "- {}（{}）{}：{}",
                expert.name, expert.title, tag_text, expert.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "你是「江星图」，主项目的专家团主管。你的职责是理解用户需求，压缩上下文，并从候选学科专家中挑出最少但足够的一组。\n\n【核心原则】\n1. 你自己不直接做专业执行，所有专业工作都交给专家。\n2. 专家派发必须克制，通常 1 到 3 位足够；只有高风险或明显跨学科时才继续加人。\n3. 当前给你的只是已经过预筛的候选专家，请优先在这些候选里选，不要发散想象不存在的角色。\n4. 所有专家工具权限平等，但职责触发概率不同；优先选择高触发概率的主责专家，把中低触发专家放在辅助或补充位置。\n5. 如果用户要直接改项目、重构代码、改引擎、补实现，一律优先使用 code-development，而不是只给方案。\n6. 如果用户主要是在要解释、比较、研究、综述、论证，优先用 disciplinary-analysis 或 technical-research。\n7. quick-answer 只用于无需派专家也能直接回答的闲聊或非常短的问题。\n8. 若任务明显带有翻译、写作、文档整理、数据分析、视觉创意、合规审查特征，可分别使用 translation、writing、document-processing、data-analysis、design/media-creation、code-review 等更贴切场景。\n\n【候选专家】\n{}\n\n【场景说明】\n- code-development：需要直接修改主项目或产物。\n- code-review：需要审查、验收、风险检查、合规判断。\n- technical-research：需要技术调研、资料收集、现状摸底。\n- disciplinary-analysis：需要某个或多个学科专家做分析、论证、建模、方案判断。\n- design：需要视觉、交互、创意方案，但不直接改现有产物。\n- quick-answer：无需派专家。\n- translation：翻译任务。\n- writing：写作或润色任务。\n- office：流程、管理、事务性整理。\n- data-analysis：统计、指标、实验、量化分析。\n- document-processing：文档提取、整理、重组、编目。\n- media-creation：图像、海报、创意媒体内容。\n- video-production：视频脚本、镜头、视频流程。\n- research-with-search：明确需要联网搜索的调研。\n\n【派发要求】\n- expertIds 只保留最关键的专家，默认不超过 3 位。\n- 如果任务是代码/系统重构，优先考虑 520、413、120、620 这类候选中的最小组合。\n- 如果任务是跨学科分析，先给出主要学科，再视需要补 1 位辅助学科，不要把整组候选全派出去。\n- 若多个候选权限相同但职责触发概率不同，优先把高概率者放在前面，避免让低概率专家越责主导。\n- 如果用户明确说“只改主项目，不同步官网”，taskDescription 里要保留这个约束。\n\n【按需能力模块提示】\n你可以额外输出 promptModuleHints，告诉系统某位专家应优先加载哪些能力模块。\n- 不确定就留空；只给真正大概率会用到的模块。\n- 可选模块 ID 仅限：code-tool-primer、web-search-guidance、command-guidance、document-tool-primer、media-tool-primer、video-workflow。\n\n【输出格式】\n必须输出合法 JSON，不要输出其他内容：\n{{\"scene\":\"场景名\",\"taskDescription\":\"具体任务描述\",\"expertIds\":[\"专家ID1\",\"专家ID2\"],\"requiresDesign\":false,\"promptModuleHints\":{{\"专家ID\":[\"模块ID\"]}}}}",
        expert_list
    )
}

pub fn build_review_prompt() -> &'static str {
    "你是「江星图」，项目主管。专家团已完成任务，现在要像正常聊天助手那样，直接向用户汇报结果。\n\n## 输出要求\n\n1. 输出 **一个自然中文短段落**，通常 2 到 4 句，不要只给一句口号式结论。\n2. 第一 句直接告诉用户结果：完成了什么，或者为什么还没完成。\n3. 如果已经完成，后面用 1 到 3 句自然说明这次具体改了什么、用户接下来看到的变化是什么。语气要像正常大模型回复用户，不要像系统广播。\n4. 如果没有完成，要自然说明卡点和下一步需要继续修什么。\n5. 文件变更会由系统直接执行；你不要复写、保留或解释任何 ACTION/ChangeSet/代码块。\n\n## 严禁以下行为\n- 输出“各位专家已汇总”“经审查确认”“主管报告如下”这类元数据过渡语\n- 提及任何专家名字、头衔或分工\n- 输出逐文件清单、代码细节、补丁说明、JSON、Markdown 标题、列表或代码块\n- 输出空泛的一句“已完成”就结束\n\n最终只输出给用户看的自然聊天式结果段落。"
}

pub fn build_followup_prompt(request: &FollowupIntentRequest) -> String {
    format!(
        "你是项目主管。当前正在执行任务：\n场景：{}\n任务：{}\n\n当前正在处理的专家：\n{}\n\n当前任务可继续协作的专家：\n{}\n\n当前进度：\n{}\n\n阶段性专家信息：\n{}\n\n用户发来了中途消息：「{}」\n\n判断：\n1. 如果是对当前任务的补充，输出 {{\"action\":\"append\",\"taskDescription\":\"补充说明\",\"targetExpertIds\":[\"专家ID\"],\"deliveryMode\":\"current-step|next-relevant|all-remaining\"}}\n2. 如果用户是在修正错误要求、撤销前述要求或明显改变主意，但仍属于当前这轮工作，输出 {{\"action\":\"replace\",\"taskDescription\":\"更新后的当前任务描述\",\"targetExpertIds\":[\"专家ID\"],\"deliveryMode\":\"current-step|next-relevant|all-remaining\"}}\n3. 如果用户是在询问当前进度、原因、已经发现的问题，主管必须直接回答，输出 {{\"action\":\"respond\",\"reply\":\"直接给用户的话\"}}\n4. 如果既要先回答用户，又要把补充要求转交给专家，输出 {{\"action\":\"respond-and-append\",\"reply\":\"直接给用户的话\",\"taskDescription\":\"补充说明\",\"targetExpertIds\":[\"专家ID\"],\"deliveryMode\":\"current-step|next-relevant|all-remaining\"}}\n5. 如果既要先回答用户，又要用新的任务描述覆盖当前方向，输出 {{\"action\":\"respond-and-replace\",\"reply\":\"直接给用户的话\",\"taskDescription\":\"更新后的当前任务描述\",\"targetExpertIds\":[\"专家ID\"],\"deliveryMode\":\"current-step|next-relevant|all-remaining\"}}\n\n规则：\n- 主管直接和用户对话，不要把用户问题原样丢给子专家。\n- 中途插话一律并入当前流水线，不要输出 new-plan，不要让用户“等这轮结束后再发一次”。\n- 如果当前有正在处理的专家，优先把补充/更正直接交给对应专家，deliveryMode 优先用 current-step。\n- reply 必须是自然中文，基于当前已知进度和专家输出；未知就坦诚说明，不要编造。\n- targetExpertIds 必须从上面列出的专家 ID 中选择；如果影响所有后续专家，可传空数组并用 all-remaining。\n\n仅输出 JSON。",
        request.current_scene,
        request.current_task_description,
        request.current_step_summary,
        request.remaining_expert_summary,
        request.progress_report,
        request.active_task_summary,
        request.followup_message
    )
}

pub fn build_mid_check_prompt(request: &MidCheckRequest) -> String {
    format!(
        "你是「江星图」，项目主管。你正在监督专家团流水线执行（第 {}/{} 步刚完成）。\n\n原始任务：「{}」{}\n\n已完成专家的输出：\n{}\n{}\n\n请判断下一步行动（仅输出 JSON）：\n1. 如果当前步骤输出质量合格，后续步骤仍合理 → {{\"action\":\"continue\"}}\n2. 如果当前步骤输出有问题，需要该专家重新执行 → {{\"action\":\"retry\",\"reason\":\"具体反馈\"}}\n3. 如果下一步不再需要（如设计方案已足够明确）→ {{\"action\":\"skip-next\",\"reason\":\"原因\"}}\n4. 如果当前输出已完全满足需求，或出现严重问题需终止 → {{\"action\":\"abort\",\"reason\":\"原因\"}}\n\n默认行为是 continue，仅在确有必要时选择其他操作。\n只输出 JSON，不要输出其他内容。",
        request.step_index + 1,
        request.total_steps,
        request.task_description,
        request.followup_context,
        request.results_summary,
        request.remaining_desc
    )
}

pub fn build_review_summary(expert_results: &[SupervisorExpertResult]) -> String {
    expert_results
        .iter()
        .map(|result| {
            let status = match result.status.as_str() {
                "done" => "完成",
                "error" => "失败",
                _ => "未知",
            };
            format!(
                "### {}（{}）[{}]\n{}",
                result.expert_name,
                result.expert_title,
                status,
                result
                    .output
                    .clone()
                    .or_else(|| result.error.clone())
                    .unwrap_or_else(|| "无输出".to_string())
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn has_file_action(expert_results: &[SupervisorExpertResult]) -> bool {
    let file_action_regex =
        Regex::new(r"\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|DELETE)\b")
            .expect("file action regex");
    expert_results
        .iter()
        .filter_map(|result| result.output.as_deref())
        .any(|output| file_action_regex.is_match(output))
}

pub fn build_review_user_message(
    task_description: &str,
    expert_results: &[SupervisorExpertResult],
) -> String {
    let summary = build_review_summary(expert_results);
    let fact_check_suffix = if has_file_action(expert_results) {
        String::new()
    } else {
        "\n\n【事实校验（必须遵守）】黑板记录显示：本轮所有专家输出中未出现任何 [ACTION:CREATE_FILE]/[ACTION:WRITE_FILE]/[ACTION:EDIT_FILE]，本次任务**未实际创建或修改任何项目文件**。你必须在最终回复里诚实告诉用户这轮还没真正落盘，并自然说明阻塞点；严禁使用“已完成”“已交付”“已保存”。".to_string()
    };
    format!(
        "任务描述：{}\n\n专家工作结果（其中可能包含结构化 ChangeSet 或 ACTION，系统会直接执行对应文件动作）：\n\n{}\n\n请审核并综合为最终回复。重要：最终回复必须像正常聊天助手那样直接对用户说话，用一个简短自然段落说明结果，不要复写任何代码、JSON 或 ACTION 标记。{}",
        task_description, summary, fact_check_suffix
    )
}

pub fn enforce_review_fact(reply: &str, expert_results: &[SupervisorExpertResult]) -> String {
    if has_file_action(expert_results) {
        return reply.trim().to_string();
    }
    let blocked_claim_regex =
        Regex::new(r"(已完成|已交付|已保存|任务已完成)").expect("blocked claim regex");
    if blocked_claim_regex.is_match(reply) {
        "未实际修改项目文件，当前前端工作流仍有阻塞，请重试。".to_string()
    } else {
        reply.trim().to_string()
    }
}

pub fn parse_followup_intent(raw: &str, request: &FollowupIntentRequest) -> FollowupIntentDecision {
    let parsed = extract_json(raw);
    let allowed_expert_ids = normalize_expert_ids(&request.allowed_expert_ids);
    let target_expert_ids = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("targetExpertIds")
                .or_else(|| value.get("target_expert_ids"))
        })
        .and_then(Value::as_array)
        .map(|items| {
            let mut normalized = Vec::new();
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| normalize_expert_id(item).into_owned())
                .filter(|item| allowed_expert_ids.iter().any(|allowed| allowed == item))
                .for_each(|item| {
                    if !normalized.iter().any(|existing| existing == &item) {
                        normalized.push(item);
                    }
                });
            normalized
        })
        .unwrap_or_default();
    let delivery_mode = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("deliveryMode")
                .or_else(|| value.get("delivery_mode"))
        })
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "current-step" | "next-relevant" | "all-remaining"))
        .unwrap_or("next-relevant")
        .to_string();
    let action = parsed
        .as_ref()
        .and_then(|value| value.get("action"))
        .and_then(Value::as_str)
        .unwrap_or("append")
        .to_string();
    let task_description = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("taskDescription")
                .or_else(|| value.get("task_description"))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let reply = parsed
        .as_ref()
        .and_then(|value| value.get("reply"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    FollowupIntentDecision {
        action,
        task_description,
        reply,
        target_expert_ids,
        delivery_mode,
    }
}

pub fn parse_mid_check_decision(raw: &str) -> MidCheckDecision {
    let parsed = extract_json(raw);
    let valid_actions = ["continue", "retry", "skip-next", "abort"];
    let action = parsed
        .as_ref()
        .and_then(|value| value.get("action"))
        .and_then(Value::as_str)
        .filter(|value| valid_actions.contains(value))
        .unwrap_or("continue")
        .to_string();
    let reason = parsed
        .as_ref()
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    MidCheckDecision { action, reason }
}

pub fn parse_dispatch_plan(raw: &str, user_message: &str) -> SupervisorDispatchPlan {
    let Some(parsed) = extract_json(raw) else {
        return fallback_dispatch_plan(user_message);
    };

    let scene = parsed
        .get("scene")
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("quick-answer")
        .to_string();
    let valid_scenes = [
        "code-development",
        "code-review",
        "technical-research",
        "disciplinary-analysis",
        "design",
        "quick-answer",
        "translation",
        "writing",
        "office",
        "data-analysis",
        "document-processing",
        "media-creation",
        "video-production",
        "research-with-search",
    ];
    let normalized_scene = if valid_scenes.contains(&scene.as_str()) {
        scene
    } else {
        "quick-answer".to_string()
    };
    let task_description = parsed
        .get("taskDescription")
        .or_else(|| parsed.get("task_description"))
        .and_then(Value::as_str)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(user_message)
        .to_string();
    let requested_expert_ids = parsed
        .get("expertIds")
        .or_else(|| parsed.get("expert_ids"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let requires_design = parsed
        .get("requiresDesign")
        .or_else(|| parsed.get("requires_design"))
        .and_then(Value::as_bool);
    let normalization_user_message = extract_normalization_user_demand(user_message);
    let expert_ids = normalize_dynamic_expert_ids(
        &normalized_scene,
        &normalization_user_message,
        &task_description,
        requested_expert_ids,
        requires_design,
    );
    let prompt_module_hints = parsed
        .get("promptModuleHints")
        .or_else(|| parsed.get("prompt_module_hints"))
        .and_then(parse_prompt_module_hints)
        .map(|hints| {
            hints
                .into_iter()
                .filter(|(expert_id, modules)| {
                    expert_ids.iter().any(|id| id == expert_id) && !modules.is_empty()
                })
                .collect::<HashMap<_, _>>()
        })
        .filter(|hints| !hints.is_empty());

    SupervisorDispatchPlan {
        scene: normalized_scene,
        task_description,
        expert_ids,
        requires_design,
        prompt_module_hints,
    }
}

fn normalize_dynamic_expert_ids(
    scene: &str,
    user_message: &str,
    task_description: &str,
    requested_expert_ids: Vec<String>,
    _requires_design: Option<bool>,
) -> Vec<String> {
    let requested = dedupe_expert_ids(
        requested_expert_ids
            .into_iter()
            .map(|id| normalize_expert_id(&id).into_owned())
            .collect(),
    );
    let joined = format!("{}\n{}", user_message, task_description).to_lowercase();
    match scene {
        "quick-answer" => vec![],
        "translation" | "writing" | "office" | "document-processing" | "media-creation"
        | "video-production" | "data-analysis" | "design" => {
            requested_or_default(&requested, scene_default_expert_ids(scene))
        }
        "code-review" => build_dynamic_review_team(&requested, &joined),
        "code-development" => build_dynamic_development_team(&requested, &joined),
        "technical-research" | "research-with-search" | "disciplinary-analysis" => {
            build_dynamic_research_team(scene, &requested, &joined)
        }
        _ => clamp_expert_ids(requested),
    }
}

fn dedupe_expert_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    let mut deduped = Vec::<String>::new();
    for id in ids {
        if id.trim().is_empty() || seen.iter().any(|value| value == &id) {
            continue;
        }
        seen.push(id.clone());
        deduped.push(id);
    }
    deduped
}

fn contains_any_keyword(joined: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| joined.contains(keyword))
}

fn requested_or_default(requested: &[String], defaults: Vec<&str>) -> Vec<String> {
    if requested.is_empty() {
        defaults.into_iter().map(str::to_string).collect()
    } else {
        clamp_expert_ids(requested.to_vec())
    }
}

fn clamp_expert_ids(ids: Vec<String>) -> Vec<String> {
    dedupe_expert_ids(ids).into_iter().take(3).collect()
}

fn is_engineering_expert_id(expert_id: &str) -> bool {
    is_implementation_expert(expert_id)
}

fn is_design_expert_id(expert_id: &str) -> bool {
    normalize_expert_id(expert_id).as_ref() == DESIGN_EXPERT
}

fn is_quality_review_expert_id(expert_id: &str) -> bool {
    normalize_expert_id(expert_id).as_ref() == QUALITY_REVIEW_EXPERT
}

fn is_compliance_review_expert_id(expert_id: &str) -> bool {
    normalize_expert_id(expert_id).as_ref() == COMPLIANCE_REVIEW_EXPERT
}

fn scene_default_expert_ids(scene: &str) -> Vec<&'static str> {
    match scene {
        "translation" => vec![TRANSLATION_EXPERT],
        "writing" => vec![WRITING_EXPERT],
        "office" => vec![MANAGEMENT_EXPERT, DOCUMENTATION_EXPERT],
        "document-processing" => vec![DOCUMENTATION_EXPERT],
        "media-creation" | "video-production" => vec![DESIGN_EXPERT],
        "data-analysis" => vec![DATA_ANALYSIS_EXPERT],
        "design" => vec![DESIGN_EXPERT, "discipline-190"],
        _ => vec![],
    }
}

fn default_development_team(joined: &str) -> Vec<String> {
    let mut experts = vec![GENERAL_ENGINEERING_EXPERT.to_string()];
    if ["调度", "工作流", "系统", "架构", "引擎", "路由"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        experts.push(ARCHITECTURE_ENGINEERING_EXPERT.to_string());
    }
    if ["信息科学", "系统科学", "模型", "抽象", "方法论"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        experts.push(INFORMATION_SCIENCE_EXPERT.to_string());
    }
    if ["安全", "风险", "权限", "合规", "审查"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        experts.push(QUALITY_REVIEW_EXPERT.to_string());
    }
    clamp_expert_ids(experts)
}

fn build_dynamic_development_team(requested: &[String], joined: &str) -> Vec<String> {
    let small_incremental = contains_any_keyword(
        joined,
        &[
            "顺手", "小改", "小功能", "小需求", "简单", "轻量", "顺便", "润一下", "润一润",
            "改一下", "调整一下", "按钮", "标题", "文案", "样式", "边角", "圆角", "颜色", "间距",
        ],
    );
    let needs_research = requested
        .iter()
        .any(|id| normalize_expert_id(id).as_ref() == INFORMATION_SCIENCE_EXPERT)
        || contains_any_keyword(
            joined,
            &["先调研", "先分析", "先看下", "看看现状", "陌生项目", "技术栈", "目录结构", "运行环境", "代码结构"],
        );
    let needs_design = requested.iter().any(|id| is_design_expert_id(id))
        || contains_any_keyword(joined, &["设计稿", "视觉方案", "交互规范", "品牌感", "风格探索", "布局方案"]);
    let explicit_review = contains_any_keyword(joined, &["审核", "审查", "review", "复查", "验收", "合规"]);
    let high_risk = contains_any_keyword(
        joined,
        &["安全", "性能", "重构", "架构", "数据库", "迁移", "部署", "鉴权", "支付", "权限", "大范围", "全局"],
    );

    if small_incremental && !needs_research && !needs_design && !explicit_review && !high_risk {
        return vec![GENERAL_ENGINEERING_EXPERT.to_string()];
    }

    let mut experts = Vec::new();
    if needs_research {
        experts.push(INFORMATION_SCIENCE_EXPERT.to_string());
    }
    if needs_design {
        experts.push(DESIGN_EXPERT.to_string());
    }
    let primary_engineer = requested
        .iter()
        .find(|id| {
            is_engineering_expert_id(id)
                && normalize_expert_id(id).as_ref() != ARCHITECTURE_ENGINEERING_EXPERT
        })
        .cloned()
        .unwrap_or_else(|| GENERAL_ENGINEERING_EXPERT.to_string());
    experts.push(primary_engineer.clone());

    let needs_architecture = requested
        .iter()
        .any(|id| normalize_expert_id(id).as_ref() == ARCHITECTURE_ENGINEERING_EXPERT)
        || contains_any_keyword(joined, &["调度", "工作流", "系统", "引擎", "路由", "架构"])
        || primary_engineer == ARCHITECTURE_ENGINEERING_EXPERT;
    if needs_architecture {
        experts.push(ARCHITECTURE_ENGINEERING_EXPERT.to_string());
    }

    let should_add_general_engineer = primary_engineer != GENERAL_ENGINEERING_EXPERT
        && (contains_any_keyword(joined, &["代码", "前端", "后端", "实现", "重构", "主项目"])
            || requested
                .iter()
                .any(|id| normalize_expert_id(id).as_ref() == GENERAL_ENGINEERING_EXPERT));
    if should_add_general_engineer {
        experts.push(GENERAL_ENGINEERING_EXPERT.to_string());
    }

    if (explicit_review || high_risk)
        && !experts.iter().any(|id| is_quality_review_expert_id(id) || is_review_expert(id))
    {
        experts.push(QUALITY_REVIEW_EXPERT.to_string());
    }
    clamp_expert_ids(experts)
}

fn default_review_team(joined: &str) -> Vec<String> {
    let mut experts = vec![QUALITY_REVIEW_EXPERT.to_string()];
    if ["法律", "合规", "条款", "责任", "审计"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        experts.push(COMPLIANCE_REVIEW_EXPERT.to_string());
    }
    if ["代码", "系统", "实现", "架构", "引擎", "前端", "后端"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        experts.push(GENERAL_ENGINEERING_EXPERT.to_string());
    }
    clamp_expert_ids(experts)
}

fn build_dynamic_review_team(requested: &[String], joined: &str) -> Vec<String> {
    let mut experts = Vec::new();
    let explicit_quality = requested.iter().any(|id| is_quality_review_expert_id(id))
        || contains_any_keyword(joined, &["质量", "正确性", "稳定性", "风险", "review"]);
    let explicit_compliance = requested.iter().any(|id| is_compliance_review_expert_id(id))
        || contains_any_keyword(joined, &["法律", "合规", "条款", "责任", "审计"]);
    let explicit_code = requested
        .iter()
        .any(|id| normalize_expert_id(id).as_ref() == GENERAL_ENGINEERING_EXPERT)
        || contains_any_keyword(joined, &["代码", "系统", "实现", "架构", "引擎", "前端", "后端"]);

    if explicit_quality || (!explicit_compliance && !explicit_code) {
        experts.push(QUALITY_REVIEW_EXPERT.to_string());
    }
    if explicit_compliance {
        experts.push(COMPLIANCE_REVIEW_EXPERT.to_string());
    }
    if explicit_code {
        experts.push(GENERAL_ENGINEERING_EXPERT.to_string());
    }
    clamp_expert_ids(experts)
}

fn default_research_team(joined: &str) -> Vec<String> {
    if ["代码", "前端", "后端", "架构", "引擎", "系统重构", "工作流"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        return clamp_expert_ids(vec![
            GENERAL_ENGINEERING_EXPERT.to_string(),
            ARCHITECTURE_ENGINEERING_EXPERT.to_string(),
            INFORMATION_SCIENCE_EXPERT.to_string(),
        ]);
    }
    if ["数据", "统计", "实验", "样本", "指标"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        return clamp_expert_ids(vec![
            DATA_ANALYSIS_EXPERT.to_string(),
            INFORMATION_SCIENCE_EXPERT.to_string(),
        ]);
    }
    if ["法律", "合规", "条款", "政策"]
        .iter()
        .any(|keyword| joined.contains(keyword))
    {
        return clamp_expert_ids(vec![
            COMPLIANCE_REVIEW_EXPERT.to_string(),
            MANAGEMENT_EXPERT.to_string(),
        ]);
    }
    clamp_expert_ids(vec![
        INFORMATION_SCIENCE_EXPERT.to_string(),
        MANAGEMENT_EXPERT.to_string(),
    ])
}

fn build_dynamic_research_team(scene: &str, requested: &[String], joined: &str) -> Vec<String> {
    if requested.is_empty() {
        return clamp_expert_ids(default_research_team(joined));
    }

    let mut experts = Vec::new();
    let mut remaining = requested.to_vec();

    let is_analysis_heavy = contains_any_keyword(
        joined,
        &[
            "分析", "论证", "评估", "建模", "比较", "框架", "机制", "解释", "推演", "判断",
        ],
    ) || scene == "disciplinary-analysis";
    let is_search_heavy = contains_any_keyword(
        joined,
        &["搜索", "联网", "最新", "资料", "调研", "现状", "文献", "搜集"],
    ) || scene == "research-with-search";
    let is_data_heavy =
        contains_any_keyword(joined, &["统计", "数据", "指标", "实验", "样本", "回归"]);
    let is_compliance_heavy =
        contains_any_keyword(joined, &["法律", "合规", "条款", "政策", "责任", "审查"]);

    if let Some(index) = remaining.iter().position(|id| {
        (normalize_expert_id(id).as_ref() == DATA_ANALYSIS_EXPERT && is_data_heavy)
            || (is_compliance_review_expert_id(id) && is_compliance_heavy)
            || (normalize_expert_id(id).as_ref() == INFORMATION_SCIENCE_EXPERT
                && (is_analysis_heavy || is_search_heavy))
    }) {
        experts.push(remaining.remove(index));
    } else {
        experts.push(remaining.remove(0));
    }

    if is_search_heavy
        && !experts
            .iter()
            .any(|id| normalize_expert_id(id).as_ref() == INFORMATION_SCIENCE_EXPERT)
    {
        if let Some(index) = remaining
            .iter()
            .position(|id| normalize_expert_id(id).as_ref() == INFORMATION_SCIENCE_EXPERT)
        {
            experts.push(remaining.remove(index));
        }
    }

    if is_data_heavy
        && !experts
            .iter()
            .any(|id| normalize_expert_id(id).as_ref() == DATA_ANALYSIS_EXPERT)
    {
        if let Some(index) = remaining
            .iter()
            .position(|id| normalize_expert_id(id).as_ref() == DATA_ANALYSIS_EXPERT)
        {
            experts.push(remaining.remove(index));
        }
    }

    if is_compliance_heavy && !experts.iter().any(|id| is_compliance_review_expert_id(id)) {
        if let Some(index) = remaining
            .iter()
            .position(|id| is_compliance_review_expert_id(id))
        {
            experts.push(remaining.remove(index));
        }
    }

    for id in remaining {
        if experts.len() >= 3 {
            break;
        }
        experts.push(id);
    }

    clamp_expert_ids(experts)
}

fn parse_prompt_module_hints(value: &Value) -> Option<HashMap<String, Vec<String>>> {
    let object = value.as_object()?;
    let mut hints = HashMap::new();
    for (expert_id, modules_value) in object {
        let Some(modules) = modules_value.as_array() else {
            continue;
        };
        let filtered = modules
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|module| SUPPORTED_PROMPT_MODULES.contains(module))
            .map(str::to_string)
            .collect::<Vec<_>>();
        if !filtered.is_empty() {
            hints.insert(normalize_expert_id(expert_id).into_owned(), filtered);
        }
    }
    if hints.is_empty() {
        None
    } else {
        Some(hints)
    }
}

fn extract_json(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Some(value);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&text[start..=end]).ok()
}

fn extract_normalization_user_demand(text: &str) -> String {
    if let Some((_, demand)) = text.split_once("[用户需求]\n") {
        return demand.trim().to_string();
    }
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        build_review_user_message, enforce_review_fact, has_file_action, parse_dispatch_plan,
        parse_followup_intent, parse_mid_check_decision, FollowupIntentRequest, MidCheckRequest,
        SupervisorExpertResult,
    };

    #[test]
    fn parses_dispatch_plan_from_wrapped_json() {
        let raw = "好的，计划如下：\n{\"scene\":\"code-development\",\"taskDescription\":\"修复前端\",\"expertIds\":[\"jiang-ruoxi\",\"jiang-yumo\"],\"promptModuleHints\":{\"jiang-yumo\":[\"command-guidance\",\"unknown\"]}}";
        let plan = parse_dispatch_plan(raw, "原始任务");
        assert_eq!(plan.scene, "code-development");
        assert_eq!(plan.task_description, "修复前端");
        assert_eq!(
            plan.expert_ids,
            vec!["discipline-120".to_string(), "discipline-520".to_string()]
        );
        assert_eq!(
            plan.prompt_module_hints
                .and_then(|hints| hints.get("discipline-520").cloned())
                .unwrap_or_default(),
            vec!["command-guidance".to_string()]
        );
    }

    #[test]
    fn falls_back_when_dispatch_plan_is_invalid() {
        let plan = parse_dispatch_plan("not json", "继续当前任务");
        assert_eq!(plan.scene, "quick-answer");
        assert_eq!(plan.task_description, "继续当前任务");
        assert!(plan.expert_ids.is_empty());
    }

    #[test]
    fn small_incremental_frontend_change_prefers_single_engineer() {
        let raw = r#"{"scene":"code-development","taskDescription":"把按钮圆一点","expertIds":["jiang-yumo"]}"#;
        let plan = parse_dispatch_plan(raw, "这个按钮顺手圆一点");
        assert_eq!(plan.expert_ids, vec!["discipline-520".to_string()]);
    }

    #[test]
    fn small_incremental_change_ignores_model_overdispatch() {
        let raw = r#"{"scene":"code-development","taskDescription":"把标题和按钮顺手润一下","expertIds":["jiang-yumo","jiang-cexun","jiang-yingqiu"]}"#;
        let plan = parse_dispatch_plan(raw, "这个小页子再顺手润一下吧，标题温和一点，按钮圆一点。");
        assert_eq!(plan.expert_ids, vec!["discipline-520".to_string()]);
    }

    #[test]
    fn enriched_dispatch_context_does_not_force_tester_for_small_incremental_change() {
        let raw = r#"{"scene":"code-development","taskDescription":"把标题和按钮顺手润一下","expertIds":["jiang-yumo","jiang-cexun"]}"#;
        let enriched_user_message = "[当前项目]\n项目名称：前端重测项目-0604L\n\n[工作区预检]\n测试记录：暂无\n\n[项目相关代码]\n命令测试与回归说明\n\n[用户需求]\n这个小页子再顺手润一下吧，标题温和一点，按钮圆一点，说明别那么长。";
        let plan = parse_dispatch_plan(raw, enriched_user_message);
        assert_eq!(plan.expert_ids, vec!["discipline-520".to_string()]);
    }

    #[test]
    fn disciplinary_analysis_keeps_requested_primary_expert_order() {
        let raw = r#"{"scene":"disciplinary-analysis","taskDescription":"分析多专家调度的量化瓶颈","expertIds":["discipline-910","discipline-120","discipline-630"]}"#;
        let plan = parse_dispatch_plan(raw, "请从统计和系统科学角度分析多专家调度的量化瓶颈");
        assert_eq!(
            plan.expert_ids,
            vec![
                "discipline-910".to_string(),
                "discipline-120".to_string(),
                "discipline-630".to_string()
            ]
        );
    }

    #[test]
    fn research_with_search_promotes_information_science_when_requested() {
        let raw = r#"{"scene":"research-with-search","taskDescription":"联网调研这个系统架构的最新方案","expertIds":["discipline-630","discipline-120","discipline-910"]}"#;
        let plan = parse_dispatch_plan(raw, "联网调研这个系统架构的最新方案，并分析现状");
        assert_eq!(
            plan.expert_ids,
            vec![
                "discipline-120".to_string(),
                "discipline-630".to_string(),
                "discipline-910".to_string()
            ]
        );
    }

    #[test]
    fn code_development_preserves_requested_engineering_specialist() {
        let raw = r#"{"scene":"code-development","taskDescription":"把主项目应用层做产品化改造","expertIds":["discipline-535","discipline-520"]}"#;
        let plan = parse_dispatch_plan(raw, "把主项目应用层做产品化改造，并补实际代码实现");
        assert_eq!(
            plan.expert_ids,
            vec!["discipline-535".to_string(), "discipline-520".to_string()]
        );
    }

    #[test]
    fn review_fact_guard_rewrites_false_success() {
        let results = vec![SupervisorExpertResult {
            expert_name: "江予墨".to_string(),
            expert_title: "前端工程师".to_string(),
            status: "done".to_string(),
            output: Some("这里只是说明，没有任何文件动作".to_string()),
            error: None,
        }];
        assert!(!has_file_action(&results));
        assert_eq!(
            enforce_review_fact("已完成并交付。", &results),
            "未实际修改项目文件，当前前端工作流仍有阻塞，请重试。"
        );
        let review_message = build_review_user_message("补一个功能", &results);
        assert!(review_message.contains("未实际创建或修改任何项目文件"));
    }

    #[test]
    fn parses_followup_intent_and_filters_experts() {
        let request = FollowupIntentRequest {
            followup_message: "顺便把文案也改了".to_string(),
            current_scene: "code-development".to_string(),
            current_task_description: "修前端".to_string(),
            current_step_summary: "- jiang-yumo: 江予墨".to_string(),
            remaining_expert_summary: "- jiang-yumo: 江予墨\n- jiang-yingqiu: 江映秋".to_string(),
            progress_report: "当前任务进度：...".to_string(),
            active_task_summary: "暂无".to_string(),
            allowed_expert_ids: vec!["jiang-yumo".to_string(), "jiang-yingqiu".to_string()],
        };
        let decision = parse_followup_intent(
            r#"{"action":"respond-and-append","reply":"我来继续处理。","taskDescription":"补充修改文案","targetExpertIds":["jiang-yumo","other"],"deliveryMode":"current-step"}"#,
            &request,
        );
        assert_eq!(decision.action, "respond-and-append");
        assert_eq!(decision.reply.as_deref(), Some("我来继续处理。"));
        assert_eq!(decision.task_description.as_deref(), Some("补充修改文案"));
        assert_eq!(decision.target_expert_ids, vec!["discipline-520".to_string()]);
        assert_eq!(decision.delivery_mode, "current-step");
    }

    #[test]
    fn parses_mid_check_decision() {
        let _prompt = super::build_mid_check_prompt(&MidCheckRequest {
            step_index: 1,
            total_steps: 5,
            task_description: "修复前端".to_string(),
            followup_context: "".to_string(),
            results_summary: "### 江予墨（前端工程师）\n已修改".to_string(),
            remaining_desc: "剩余步骤：1. 质量审核".to_string(),
        });
        let decision =
            parse_mid_check_decision(r#"{"action":"retry","reason":"补充真实文件动作"}"#);
        assert_eq!(decision.action, "retry");
        assert_eq!(decision.reason.as_deref(), Some("补充真实文件动作"));
        let fallback = parse_mid_check_decision("not json");
        assert_eq!(fallback.action, "continue");
    }
}
