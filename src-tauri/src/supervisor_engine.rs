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
        .map(|expert| {
            format!(
                "- {}（{}）：{}",
                expert.name, expert.title, expert.description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "你是「江星图」，项目主管兼资质调研员。你的职责是分析用户需求，制定任务计划并分配最合适、最少但足够的专家处理。\n\n【核心原则】\n1. 你绝对不直接编写代码、审查代码、进行技术调研或设计\n2. 你的工作是：理解需求 → 判断是否需要专家 → 动态选择最合适的专家 → 审核结果\n3. 所有实际工作必须交由专家完成\n4. 用自然、亲切的语言与用户交流，这款软件面向各类用户，并非只有专业程序员\n5. 专家分配必须最小化，避免为了一个很小的改动机械地派出一整串固定角色\n6. 不要为了“更稳妥”而默认补测试、审查或设计；只有在用户明确要求，或风险明显升高时才加人\n\n【可用专家】\n{}\n\n【场景与动态分配规则】\n\n1. code-development（代码开发 / 直接改产物）\n   - 工程师从 江青澜（通用）/ 江予墨（前端）/ 江素白（后端）中选择最贴合的一位\n   - 默认先考虑“单专家可完成”\n   - 小型前端/文案/样式/按钮/标题/间距/圆角类增量修改，通常只派 1 位最贴合的工程师\n   - 只有在以下情况才额外加人：\n     - 需要先摸清陌生代码或环境时，再加调研员\n     - 用户明确要设计方案、视觉规范或交互说明时，再加设计师\n     - 用户明确要求测试/回归/验证时，再加测试专家\n     - 改动高风险、涉及安全/性能/架构/大范围回归时，再加质量审核专家\n     - 只有当用户明确要求审查/验收/合规把关时，才加审查员\n   - 如果用户是在已有网站、网页、代码产物基础上提出修改要求，一律视为增量开发任务，必须选择 code-development，不能只分配 design\n\n2. code-review（代码审查）\n   - 只在用户明确要求 review / 审核 / 测试 / 复查时使用\n   - 按需从 质量审核专家 / 测试专家 / 审查员 中选择，不要默认三人全上\n\n3. technical-research（技术调研）\n   - 只需调研员：expertIds: [\"jiang-ruoxi\"]\n\n4. design（设计方案）\n   - 仅当用户明确要求“方案/规范/文档”，且不要求直接修改现有产物时，才使用该场景\n   - expertIds 通常为 [\"jiang-dingchu\"] 或 [\"jiang-ruoxi\", \"jiang-dingchu\"]\n\n5. quick-answer（简单问题/闲聊）\n   - 无需专家：expertIds: []\n\n6. translation（翻译任务）\n   - expertIds: [\"jiang-lingyu\"]\n\n7. writing（写作任务）\n   - 按需从 [\"jiang-ruoxi\", \"jiang-moxian\"] 中选择 1-2 人，不要机械全派\n\n8. office（办公事务）\n   - expertIds: [\"jiang-wenshu\"]\n\n9. data-analysis（数据分析）\n   - 通常 [\"jiang-shuyan\"] 即可；需要先理解业务上下文再加 [\"jiang-ruoxi\"]\n\n10. document-processing（文档处理）\n    - expertIds: [\"jiang-zhilan\"]\n\n11. media-creation（媒体创作）\n    - expertIds: [\"jiang-huaying\"]\n\n12. video-production（视频创作）\n    - 需要分镜/调研时再加 [\"jiang-ruoxi\"]，否则以 [\"jiang-huaying\"] 为主\n\n13. research-with-search（需要网络搜索的调研）\n    - expertIds: [\"jiang-ruoxi\"]\n\n【按需能力模块提示】\n你可以额外输出 promptModuleHints，告诉系统某位专家应优先加载哪些能力模块。\n- 只在你有较高把握该专家大概率会用到时才填写；不确定就留空。\n- 只能给与该专家职责相符的模块，不要把视频工作流塞给前端工程师，也不要把文档模块塞给审查员。\n- 可选模块 ID 仅限：\n  - code-tool-primer\n  - web-search-guidance\n  - command-guidance\n  - document-tool-primer\n  - media-tool-primer\n  - video-workflow\n- 示例：\n  \"promptModuleHints\": {{\n    \"jiang-ruoxi\": [\"web-search-guidance\"],\n    \"jiang-yumo\": [\"command-guidance\"]\n  }}\n\n【输出格式】（必须是合法 JSON，不要输出其他内容）\n{{\"scene\":\"场景名\",\"taskDescription\":\"具体任务描述\",\"expertIds\":[\"专家ID1\",\"专家ID2\"],\"requiresDesign\":false,\"promptModuleHints\":{{\"专家ID\":[\"模块ID\"]}}}}",
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
    let allowed_expert_ids = &request.allowed_expert_ids;
    let target_expert_ids = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("targetExpertIds")
                .or_else(|| value.get("target_expert_ids"))
        })
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
    requires_design: Option<bool>,
) -> Vec<String> {
    let requested = dedupe_expert_ids(requested_expert_ids);
    let joined = format!("{}\n{}", user_message, task_description).to_lowercase();
    match scene {
        "quick-answer" => vec![],
        "technical-research" | "research-with-search" => vec!["jiang-ruoxi".to_string()],
        "translation" => vec!["jiang-lingyu".to_string()],
        "office" => vec!["jiang-wenshu".to_string()],
        "document-processing" => vec!["jiang-zhilan".to_string()],
        "media-creation" => vec!["jiang-huaying".to_string()],
        "video-production" => {
            let mut experts = vec!["jiang-huaying".to_string()];
            if requested.iter().any(|id| id == "jiang-ruoxi")
                || joined.contains("分镜")
                || joined.contains("脚本")
                || joined.contains("调研")
            {
                experts.insert(0, "jiang-ruoxi".to_string());
            }
            experts
        }
        "data-analysis" => {
            let mut experts = vec!["jiang-shuyan".to_string()];
            if requested.iter().any(|id| id == "jiang-ruoxi")
                || joined.contains("先分析需求")
                || joined.contains("业务背景")
                || joined.contains("上下文")
            {
                experts.insert(0, "jiang-ruoxi".to_string());
            }
            experts
        }
        "writing" => {
            let mut experts = Vec::new();
            if requested.iter().any(|id| id == "jiang-ruoxi")
                || joined.contains("调研")
                || joined.contains("背景资料")
            {
                experts.push("jiang-ruoxi".to_string());
            }
            experts.push("jiang-moxian".to_string());
            dedupe_expert_ids(experts)
        }
        "design" => {
            let mut experts = Vec::new();
            if requested.iter().any(|id| id == "jiang-ruoxi")
                || joined.contains("调研")
                || joined.contains("先看现状")
            {
                experts.push("jiang-ruoxi".to_string());
            }
            experts.push("jiang-dingchu".to_string());
            dedupe_expert_ids(experts)
        }
        "code-review" => build_dynamic_review_team(&requested, &joined),
        "code-development" => build_dynamic_development_team(&requested, &joined, requires_design),
        _ => requested,
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

fn choose_engineer_id(requested: &[String], joined: &str) -> String {
    if let Some(existing) = requested
        .iter()
        .find(|id| ["jiang-qinglan", "jiang-yumo", "jiang-subai"].contains(&id.as_str()))
    {
        return existing.clone();
    }
    if looks_frontend_task(joined) {
        "jiang-yumo".to_string()
    } else if looks_backend_task(joined) {
        "jiang-subai".to_string()
    } else {
        "jiang-qinglan".to_string()
    }
}

fn looks_frontend_task(joined: &str) -> bool {
    [
        "前端", "页面", "网页", "ui", "ux", "样式", "css", "html", "组件", "按钮", "交互", "文案",
    ]
    .iter()
    .any(|keyword| joined.contains(keyword))
}

fn looks_backend_task(joined: &str) -> bool {
    [
        "后端",
        "接口",
        "api",
        "数据库",
        "sql",
        "服务端",
        "路由",
        "鉴权",
        "缓存",
        "中间件",
    ]
    .iter()
    .any(|keyword| joined.contains(keyword))
}

fn build_dynamic_development_team(
    requested: &[String],
    joined: &str,
    requires_design: Option<bool>,
) -> Vec<String> {
    let mut experts = Vec::new();
    let engineer_id = choose_engineer_id(requested, joined);
    let small_incremental = [
        "顺手",
        "小改",
        "小功能",
        "小需求",
        "简单",
        "轻量",
        "顺便",
        "润一下",
        "润一润",
        "改一下",
        "调整一下",
        "按钮",
        "标题",
        "文案",
        "样式",
        "边角",
        "圆角",
        "颜色",
        "间距",
    ]
    .iter()
    .any(|keyword| joined.contains(keyword));
    let needs_research = requested.iter().any(|id| id == "jiang-ruoxi")
        || joined.contains("先调研")
        || joined.contains("先分析")
        || joined.contains("先看下")
        || joined.contains("看看现状")
        || (!small_incremental
            && ["陌生项目", "技术栈", "目录结构", "运行环境", "代码结构"]
                .iter()
                .any(|keyword| joined.contains(keyword)));
    let needs_design = requested.iter().any(|id| id == "jiang-dingchu")
        || requires_design.unwrap_or(false)
        || [
            "设计稿",
            "视觉方案",
            "交互规范",
            "品牌感",
            "风格探索",
            "布局方案",
        ]
        .iter()
        .any(|keyword| joined.contains(keyword));
    let user_explicit_test = ["测试", "验证", "回归", "冒烟", "单测", "e2e", "自动化测试"]
        .iter()
        .any(|keyword| joined.contains(keyword));
    let explicit_test = requested.iter().any(|id| id == "jiang-cexun")
        || user_explicit_test;
    let user_explicit_review = ["审核", "审查", "review", "复查", "验收", "合规"]
        .iter()
        .any(|keyword| joined.contains(keyword));
    let explicit_review = requested
        .iter()
        .any(|id| id == "jiang-jianheng" || id == "jiang-yingqiu")
        || user_explicit_review;
    let high_risk = [
        "安全",
        "性能",
        "重构",
        "架构",
        "数据库",
        "迁移",
        "部署",
        "鉴权",
        "支付",
        "权限",
        "大范围",
        "全局",
    ]
    .iter()
    .any(|keyword| joined.contains(keyword));
    if small_incremental
        && !needs_research
        && !needs_design
        && !user_explicit_test
        && !user_explicit_review
        && !high_risk
    {
        return vec![engineer_id];
    }

    if needs_research {
        experts.push("jiang-ruoxi".to_string());
    }
    if needs_design {
        experts.push("jiang-dingchu".to_string());
    }
    experts.push(engineer_id);

    if explicit_review || high_risk {
        experts.push("jiang-jianheng".to_string());
    }
    if explicit_test {
        experts.push("jiang-cexun".to_string());
    }
    if requested.iter().any(|id| id == "jiang-yingqiu")
        || ["合规", "审计", "验收", "把关"]
            .iter()
            .any(|keyword| joined.contains(keyword))
    {
        experts.push("jiang-yingqiu".to_string());
    }

    dedupe_expert_ids(experts)
}

fn build_dynamic_review_team(requested: &[String], joined: &str) -> Vec<String> {
    let mut experts = Vec::new();
    let explicit_quality = requested.iter().any(|id| id == "jiang-jianheng")
        || ["质量", "正确性", "稳定性", "风险", "review"]
            .iter()
            .any(|keyword| joined.contains(keyword));
    let explicit_test = requested.iter().any(|id| id == "jiang-cexun")
        || ["测试", "回归", "验证", "冒烟"]
            .iter()
            .any(|keyword| joined.contains(keyword));
    let explicit_review = requested.iter().any(|id| id == "jiang-yingqiu")
        || ["审查", "验收", "合规"]
            .iter()
            .any(|keyword| joined.contains(keyword));

    if explicit_quality || (!explicit_test && !explicit_review) {
        experts.push("jiang-jianheng".to_string());
    }
    if explicit_test {
        experts.push("jiang-cexun".to_string());
    }
    if explicit_review {
        experts.push("jiang-yingqiu".to_string());
    }

    dedupe_expert_ids(experts)
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
            vec!["jiang-ruoxi".to_string(), "jiang-yumo".to_string()]
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
    fn small_incremental_frontend_change_prefers_single_engineer() {
        let raw = r#"{"scene":"code-development","taskDescription":"把按钮圆一点","expertIds":["jiang-yumo"]}"#;
        let plan = parse_dispatch_plan(raw, "这个按钮顺手圆一点");
        assert_eq!(plan.expert_ids, vec!["jiang-yumo".to_string()]);
    }

    #[test]
    fn small_incremental_change_ignores_model_overdispatch() {
        let raw = r#"{"scene":"code-development","taskDescription":"把标题和按钮顺手润一下","expertIds":["jiang-yumo","jiang-cexun","jiang-yingqiu"]}"#;
        let plan = parse_dispatch_plan(raw, "这个小页子再顺手润一下吧，标题温和一点，按钮圆一点。");
        assert_eq!(plan.expert_ids, vec!["jiang-yumo".to_string()]);
    }

    #[test]
    fn enriched_dispatch_context_does_not_force_tester_for_small_incremental_change() {
        let raw = r#"{"scene":"code-development","taskDescription":"把标题和按钮顺手润一下","expertIds":["jiang-yumo","jiang-cexun"]}"#;
        let enriched_user_message = "[当前项目]\n项目名称：前端重测项目-0604L\n\n[工作区预检]\n测试记录：暂无\n\n[项目相关代码]\n命令测试与回归说明\n\n[用户需求]\n这个小页子再顺手润一下吧，标题温和一点，按钮圆一点，说明别那么长。";
        let plan = parse_dispatch_plan(raw, enriched_user_message);
        assert_eq!(plan.expert_ids, vec!["jiang-yumo".to_string()]);
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
        let decision =
            parse_mid_check_decision(r#"{"action":"retry","reason":"补充真实文件动作"}"#);
        assert_eq!(decision.action, "retry");
        assert_eq!(decision.reason.as_deref(), Some("补充真实文件动作"));
        let fallback = parse_mid_check_decision("not json");
        assert_eq!(fallback.action, "continue");
    }
}
