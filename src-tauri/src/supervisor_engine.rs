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

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorExpertInfo {
    pub id: String,
    pub name: String,
    pub title: String,
    pub description: String,
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
        .map(|expert| format!("- {}（{}）：{}", expert.name, expert.title, expert.description))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "你是「江星图」，项目主管兼资质调研员。你的职责是分析用户需求，制定任务计划并分配专家处理。\n\n【核心原则】\n1. 你绝对不直接编写代码、审查代码、进行技术调研或设计\n2. 你的工作是：理解需求 → 选择场景 → 派遣专家 → 审核结果\n3. 所有实际工作必须交由专家完成\n4. 用自然、亲切的语言与用户交流，这款软件面向各类用户，并非只有专业程序员\n\n【可用专家】\n{}\n\n【场景与派遣规则】\n\n1. code-development（代码开发）\n   - 流程：调研员 → [设计师（可选）] → 工程师 → 质量审核专家 → 测试专家 → 审查员\n   - 工程师从 江青澜（通用）/ 江予墨（前端）/ 江素白（后端）中选择\n   - 复杂度较高时设置 requiresDesign=true 引入设计师\n   - 如果用户是在已有网站、网页、代码产物基础上提出修改要求，一律视为增量开发任务，必须选择 code-development，不能只分配 design\n   - expertIds 顺序建议：[\"jiang-ruoxi\", 工程师ID, \"jiang-jianheng\", \"jiang-cexun\", \"jiang-yingqiu\"]\n\n2. code-review（代码审查）\n   - 质量审核 + 命令测试 + 审查结论：expertIds: [\"jiang-jianheng\", \"jiang-cexun\", \"jiang-yingqiu\"]\n\n3. technical-research（技术调研）\n   - 只需调研员：expertIds: [\"jiang-ruoxi\"]\n\n4. design（设计方案）\n   - 调研员 + 设计师：expertIds: [\"jiang-ruoxi\", \"jiang-dingchu\"]\n   - 仅当用户明确要求“方案/规范/文档”，且不要求直接修改现有产物时，才使用该场景\n\n5. quick-answer（简单问题/闲聊）\n   - 无需专家：expertIds: []\n\n6. translation（翻译任务）\n   - 将内容翻译成其他语言：expertIds: [\"jiang-lingyu\"]\n\n7. writing（写作任务）\n   - 创意写作、文案、报告撰写、文本润色：expertIds: [\"jiang-ruoxi\", \"jiang-moxian\"]\n\n8. office（办公事务）\n   - 邮件撰写、会议纪要、日程管理、通知公告：expertIds: [\"jiang-wenshu\"]\n\n9. data-analysis（数据分析）\n   - 数据解读、统计分析、图表生成、数据报告：expertIds: [\"jiang-ruoxi\", \"jiang-shuyan\"]\n\n10. document-processing（文档处理）\n    - 读取/转换/生成文档文件：expertIds: [\"jiang-zhilan\"]\n\n11. media-creation（媒体创作）\n    - 图像生成/编辑、音频处理：expertIds: [\"jiang-huaying\"]\n\n12. video-production（视频创作）\n    - 视频制作，需调研+镜头分段+逐段生成+拼接：expertIds: [\"jiang-ruoxi\", \"jiang-huaying\"]\n\n13. research-with-search（需要网络搜索的调研）\n    - 需获取最新外部信息时：expertIds: [\"jiang-ruoxi\"]\n\n【按需能力模块提示】\n你可以额外输出 promptModuleHints，告诉系统某位专家应优先加载哪些能力模块。\n- 只在你有较高把握该专家大概率会用到时才填写；不确定就留空。\n- 只能给与该专家职责相符的模块，不要把视频工作流塞给前端工程师，也不要把文档模块塞给审查员。\n- 可选模块 ID 仅限：\n  - code-tool-primer\n  - web-search-guidance\n  - command-guidance\n  - document-tool-primer\n  - media-tool-primer\n  - video-workflow\n- 示例：\n  \"promptModuleHints\": {{\n    \"jiang-ruoxi\": [\"web-search-guidance\"],\n    \"jiang-yumo\": [\"command-guidance\"]\n  }}\n\n【输出格式】（必须是合法 JSON，不要输出其他内容）\n{{\"scene\":\"场景名\",\"taskDescription\":\"具体任务描述\",\"expertIds\":[\"专家ID1\",\"专家ID2\"],\"requiresDesign\":false,\"promptModuleHints\":{{\"专家ID\":[\"模块ID\"]}}}}",
        expert_list
    )
}

pub fn build_review_prompt() -> &'static str {
    "你是「江星图」，项目主管。专家团已完成任务，现在向用户交付结果。\n\n## 严格输出规则\n\n1. **仅输出一句不超过50字的自然语言交付语**，描述完成了什么（如\"已完成登录页面重构并写入源码\"）。\n\n2. 文件变更会由系统直接执行；你不要转述、复写或保留任何 ACTION/ChangeSet/代码块。\n\n3. **严禁以下行为：**\n   - 复述、重复、摘要化任何专家已输出的代码内容\n   - 输出\"工作亮点\"、\"改进建议\"及其相关段落\n   - 输出\"各位专家已汇总\"、\"经审查确认\"、\"调研员…工程师…\"等元数据过渡语\n   - 对代码内容做任何形式的总结、罗列或逐文件说明\n   - 提及任何专家的名字、头衔或分工\n   - 输出任何以 ### 开头的章节标题\n   - 输出任何 [ACTION:...] 标记或 JSON 代码块\n\n4. **最终输出结构：** 一句交付语（≤50字）。"
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
        Regex::new(r"\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|DELETE)\b").expect("file action regex");
    expert_results
        .iter()
        .filter_map(|result| result.output.as_deref())
        .any(|output| file_action_regex.is_match(output))
}

pub fn build_review_user_message(task_description: &str, expert_results: &[SupervisorExpertResult]) -> String {
    let summary = build_review_summary(expert_results);
    let fact_check_suffix = if has_file_action(expert_results) {
        String::new()
    } else {
        "\n\n【事实校验（必须遵守）】黑板记录显示：本轮所有专家输出中未出现任何 [ACTION:CREATE_FILE]/[ACTION:WRITE_FILE]/[ACTION:EDIT_FILE]，本次任务**未实际创建或修改任何项目文件**。你必须在一句交付语中诚实表达这一事实（例如：“未实际修改项目文件，设计师未输出落盘动作，请重试”），严禁使用“已完成”“已交付”“已保存”。".to_string()
    };
    format!(
        "任务描述：{}\n\n专家工作结果（其中可能包含结构化 ChangeSet 或 ACTION，系统会直接执行对应文件动作）：\n\n{}\n\n请审核并综合为最终回复。重要：最终回复只给用户一句自然交付语，不要复写任何代码、JSON 或 ACTION 标记。{}",
        task_description, summary, fact_check_suffix
    )
}

pub fn enforce_review_fact(reply: &str, expert_results: &[SupervisorExpertResult]) -> String {
    if has_file_action(expert_results) {
        return reply.trim().to_string();
    }
    let blocked_claim_regex = Regex::new(r"(已完成|已交付|已保存|任务已完成)").expect("blocked claim regex");
    if blocked_claim_regex.is_match(reply) {
        "未实际修改项目文件，当前前端工作流仍有阻塞，请重试。".to_string()
    } else {
        reply.trim().to_string()
    }
}

pub fn parse_followup_intent(raw: &str, request: &FollowupIntentRequest) -> FollowupIntentDecision {
    let parsed = extract_json(raw);
    let allowed_expert_ids = &request.allowed_expert_ids;
    let target_expert_ids = parsed
        .as_ref()
        .and_then(|value| value.get("targetExpertIds").or_else(|| value.get("target_expert_ids")))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| allowed_expert_ids.iter().any(|allowed| allowed == item))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let delivery_mode = parsed
        .as_ref()
        .and_then(|value| value.get("deliveryMode").or_else(|| value.get("delivery_mode")))
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
        .and_then(|value| value.get("taskDescription").or_else(|| value.get("task_description")))
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
    let engineer_candidates = ["jiang-qinglan", "jiang-yumo", "jiang-subai"];
    let mut expert_ids = requested_expert_ids;
    if normalized_scene == "code-development" {
        let selected_engineer = expert_ids
            .iter()
            .find(|id| engineer_candidates.contains(&id.as_str()))
            .cloned()
            .unwrap_or_else(|| "jiang-qinglan".to_string());
        let include_designer = requires_design.unwrap_or(false) || expert_ids.iter().any(|id| id == "jiang-dingchu");
        expert_ids = vec!["jiang-ruoxi".to_string()];
        if include_designer {
            expert_ids.push("jiang-dingchu".to_string());
        }
        expert_ids.extend([
            selected_engineer,
            "jiang-jianheng".to_string(),
            "jiang-cexun".to_string(),
            "jiang-yingqiu".to_string(),
        ]);
    } else if normalized_scene == "code-review" {
        expert_ids = vec![
            "jiang-jianheng".to_string(),
            "jiang-cexun".to_string(),
            "jiang-yingqiu".to_string(),
        ];
    }
    let prompt_module_hints = parsed
        .get("promptModuleHints")
        .or_else(|| parsed.get("prompt_module_hints"))
        .and_then(parse_prompt_module_hints)
        .map(|hints| {
            hints
                .into_iter()
                .filter(|(expert_id, modules)| expert_ids.iter().any(|id| id == expert_id) && !modules.is_empty())
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
            hints.insert(expert_id.clone(), filtered);
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
            vec![
                "jiang-ruoxi".to_string(),
                "jiang-yumo".to_string(),
                "jiang-jianheng".to_string(),
                "jiang-cexun".to_string(),
                "jiang-yingqiu".to_string()
            ]
        );
        assert_eq!(
            plan.prompt_module_hints
                .and_then(|hints| hints.get("jiang-yumo").cloned())
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
        assert_eq!(decision.target_expert_ids, vec!["jiang-yumo".to_string()]);
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
        let decision = parse_mid_check_decision(r#"{"action":"retry","reason":"补充真实文件动作"}"#);
        assert_eq!(decision.action, "retry");
        assert_eq!(decision.reason.as_deref(), Some("补充真实文件动作"));
        let fallback = parse_mid_check_decision("not json");
        assert_eq!(fallback.action, "continue");
    }
}
