use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolReminderRequest {
    pub reply: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolReminderDecision {
    pub needs_retry: bool,
    pub reminder_targets: Vec<String>,
    pub reminder_message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolFollowupMessageRequest {
    pub tool_contexts: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolFollowupMessage {
    pub content: String,
}

const VIDEO_TRIGGER_KEYWORDS: &[&str] = &[
    "视频",
    "分镜",
    "镜头",
    "片段",
    "segment",
    "timeline",
    "storyboard",
];
const SEARCH_INTENT_PATTERNS: &[&str] = &[
    r"需要.*搜索",
    r"建议.*搜索",
    r"需要.*查",
    r"建议.*查",
    r"需要.*联网",
    r"建议.*联网",
    r"查一下",
    r"搜索一下",
    r"查找",
];
const COMMAND_INTENT_PATTERNS: &[&str] = &[
    r"需要.*(?:运行|执行)",
    r"建议.*(?:运行|执行)",
    r"通过命令",
    r"运行.*(?:测试|命令|npm|pnpm|yarn|cargo)",
    r"执行.*(?:测试|命令|npm|pnpm|yarn|cargo)",
    r"终端",
];

fn detect_tool_intent_without_action(reply: &str) -> (bool, bool, bool) {
    let needs_web_search = SEARCH_INTENT_PATTERNS.iter().any(|pattern| {
        Regex::new(pattern)
            .expect("search intent regex")
            .is_match(reply)
    });
    let needs_command = COMMAND_INTENT_PATTERNS.iter().any(|pattern| {
        Regex::new(pattern)
            .expect("command intent regex")
            .is_match(reply)
    });
    let needs_video_workflow = VIDEO_TRIGGER_KEYWORDS
        .iter()
        .any(|keyword| reply.contains(keyword));
    (needs_web_search, needs_command, needs_video_workflow)
}

pub fn evaluate_tool_reminder(
    request: &ToolReminderRequest,
    has_tool_requests: bool,
) -> ToolReminderDecision {
    if has_tool_requests {
        return ToolReminderDecision {
            needs_retry: false,
            reminder_targets: vec![],
            reminder_message: None,
        };
    }
    let (needs_web_search, needs_command, needs_video_workflow) =
        detect_tool_intent_without_action(&request.reply);
    let mut reminder_targets = Vec::new();
    if needs_web_search {
        reminder_targets.push("网络搜索".to_string());
    }
    if needs_command {
        reminder_targets.push("命令执行".to_string());
    }
    if needs_video_workflow {
        reminder_targets.push("视频工作流".to_string());
    }
    if reminder_targets.is_empty() {
        return ToolReminderDecision {
            needs_retry: false,
            reminder_targets,
            reminder_message: None,
        };
    }
    ToolReminderDecision {
        needs_retry: true,
        reminder_message: Some(format!(
            "你刚才提到了可能会用到{}。如果你判断确实需要，就直接输出标准 ACTION 发起；如果不需要，就直接给出最终结果，不要停留在“建议后续再查/再跑命令”的层面。",
            reminder_targets.join("、")
        )),
        reminder_targets,
    }
}

pub fn build_tool_followup_message(request: &ToolFollowupMessageRequest) -> ToolFollowupMessage {
    ToolFollowupMessage {
        content: format!(
            "以下是你请求的工具执行结果，请基于这些信息继续完成任务，并不要重复发起已经执行过的同类请求：\n\n{}",
            request.tool_contexts.join("\n\n")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_tool_followup_message, evaluate_tool_reminder, ToolFollowupMessageRequest,
        ToolReminderRequest,
    };

    #[test]
    fn requests_retry_when_reply_explicitly_requests_search_without_action() {
        let decision = evaluate_tool_reminder(
            &ToolReminderRequest {
                reply: "我先查一下这个版本兼容性，再继续给结论".to_string(),
            },
            false,
        );
        assert!(decision.needs_retry);
        assert!(decision.reminder_targets.contains(&"网络搜索".to_string()));
    }

    #[test]
    fn does_not_force_retry_for_plain_official_docs_reference() {
        let decision = evaluate_tool_reminder(
            &ToolReminderRequest {
                reply: "这个实现可以参考官方文档里的写法，我先直接给出可行方案。".to_string(),
            },
            false,
        );
        assert!(!decision.needs_retry);
    }

    #[test]
    fn skips_retry_when_tool_request_already_present() {
        let decision = evaluate_tool_reminder(
            &ToolReminderRequest {
                reply: "[ACTION:WEB_SEARCH query=\"rust\" reason=\"查资料\"]".to_string(),
            },
            true,
        );
        assert!(!decision.needs_retry);
    }

    #[test]
    fn builds_followup_message_from_tool_contexts() {
        let message = build_tool_followup_message(&ToolFollowupMessageRequest {
            tool_contexts: vec!["[命令执行结果]".to_string(), "[文件读取结果]".to_string()],
        });
        assert!(message.content.contains("工具执行结果"));
        assert!(message.content.contains("[文件读取结果]"));
    }
}
