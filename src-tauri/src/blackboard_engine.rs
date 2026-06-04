use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceItem {
    pub id: String,
    pub source: String,
    pub summary: String,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequiredFileSet {
    pub files: Vec<String>,
    pub unresolved: Vec<String>,
    pub exclusions: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PatchProposal {
    pub id: String,
    pub files: Vec<String>,
    pub risk: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRun {
    pub command: String,
    pub passed: bool,
    pub summary: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecision {
    pub reviewer: String,
    pub decision: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlackboardTask {
    pub id: String,
    pub goal: String,
    pub workspace_files: Vec<String>,
    pub workspace_roots: Vec<String>,
    pub required_files: RequiredFileSet,
    pub evidence: Vec<EvidenceItem>,
    pub assumptions: Vec<String>,
    pub open_questions: Vec<String>,
    pub patch_proposals: Vec<PatchProposal>,
    pub validation_runs: Vec<ValidationRun>,
    pub review_decisions: Vec<ReviewDecision>,
    pub blockers: Vec<String>,
    pub rounds_without_progress: u32,
    pub progress_signature: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertTaskSummary {
    pub id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlackboardProgressDecision {
    pub blackboard: BlackboardTask,
    pub made_progress: bool,
    pub should_stop: bool,
    pub blocker_message: Option<String>,
}

pub fn new_blackboard(goal: &str, workspace_files: Vec<String>, workspace_roots: Vec<String>, now_ms: u64) -> BlackboardTask {
    BlackboardTask {
        id: format!("blackboard-{}-seed", now_ms),
        goal: goal.to_string(),
        workspace_files,
        workspace_roots: workspace_roots.clone(),
        required_files: RequiredFileSet {
            files: vec![],
            unresolved: vec![],
            exclusions: vec![],
        },
        evidence: if workspace_roots.is_empty() {
            vec![]
        } else {
            vec![EvidenceItem {
                id: format!("workspace-{}", now_ms),
                source: "当前工作区".to_string(),
                summary: format!(
                    "根目录条目：{}",
                    workspace_roots.iter().take(24).cloned().collect::<Vec<_>>().join(", ")
                ),
                created_at: now_ms,
            }]
        },
        assumptions: vec![],
        open_questions: vec![],
        patch_proposals: vec![],
        validation_runs: vec![],
        review_decisions: vec![],
        blockers: vec![],
        rounds_without_progress: 0,
        progress_signature: None,
    }
}

pub fn update_blackboard_from_task(blackboard: &mut BlackboardTask, task: &ExpertTaskSummary, now_ms: u64) {
    let output = task.output.clone().or_else(|| task.error.clone()).unwrap_or_default();
    if output.trim().is_empty() {
        return;
    }

    let changed_files = extract_change_files(&output)
        .into_iter()
        .map(|file| resolve_workspace_file_path(&file, &blackboard.workspace_files).unwrap_or_else(|| normalize_workspace_path_token(&file)))
        .filter(|file| !file.is_empty())
        .collect::<Vec<_>>();
    let changed_file_set = changed_files.iter().cloned().collect::<HashSet<_>>();

    let file_mentions = extract_file_mentions(&output)
        .into_iter()
        .map(|file| {
            resolve_workspace_file_path(&file, &blackboard.workspace_files).unwrap_or_else(|| {
                let normalized = normalize_workspace_path_token(&file);
                if changed_file_set.contains(&normalized) { normalized } else { String::new() }
            })
        })
        .filter(|file| !file.is_empty())
        .collect::<Vec<_>>();

    for file in file_mentions {
        if !blackboard.required_files.files.contains(&file) {
            blackboard.required_files.files.push(file.clone());
            blackboard.required_files.unresolved.push(file);
        }
    }

    if !changed_files.is_empty() {
        blackboard.patch_proposals.push(PatchProposal {
            id: format!("{}-patch-{}", task.id, blackboard.patch_proposals.len() + 1),
            files: changed_files.clone(),
            risk: if output.contains("allowOverwrite") || output.contains("WRITE_FILE") {
                "high".to_string()
            } else {
                "medium".to_string()
            },
            status: "draft".to_string(),
        });
        blackboard.required_files.unresolved = blackboard
            .required_files
            .unresolved
            .iter()
            .filter(|file| !changed_files.contains(file))
            .cloned()
            .collect();
    }

    if task.expert_title.contains("调研") || task.expert_title.contains("设计") {
        blackboard.evidence.push(EvidenceItem {
            id: format!("{}-evidence-{}", task.id, blackboard.evidence.len() + 1),
            source: format!("{}（{}）", task.expert_name, task.expert_title),
            summary: strip_think_tags(&output).chars().take(360).collect(),
            created_at: now_ms,
        });
    }

    if task.expert_title.contains("测试") {
        let summary: String = strip_think_tags(&output).chars().take(220).collect();
        let command_regex = Regex::new(r"(?:npm|pnpm|yarn|cargo|python|pytest|go test|mvn|gradle|dotnet)\s+[^\n]+").expect("command regex");
        let commands = command_regex
            .find_iter(&output)
            .map(|m| m.as_str().trim().to_string())
            .take(6)
            .collect::<Vec<_>>();
        if commands.is_empty() {
            blackboard.validation_runs.push(ValidationRun {
                command: "未提取到命令".to_string(),
                passed: !Regex::new(r"(失败|error|未通过|阻断)").expect("failure regex").is_match(&summary),
                summary: summary.clone(),
            });
        } else {
            for command in commands {
                blackboard.validation_runs.push(ValidationRun {
                    command,
                    passed: !Regex::new(r"(失败|error|未通过|阻断)").expect("failure regex").is_match(&summary),
                    summary: summary.clone(),
                });
            }
        }
        if Regex::new(r"(失败|error|未通过|阻断|不可交付|是否可交付[：:]\s*否)")
            .expect("block regex")
            .is_match(&summary)
        {
            blackboard
                .blockers
                .push(format!("{}: 测试阶段发现阻断问题 - {}", task.expert_name, summary));
        }
    }

    if task.expert_title.contains("审查") || task.expert_title.contains("审核") {
        let decision = if Regex::new(r"(不通过|阻断|block)").expect("block review regex").is_match(&output) {
            "block"
        } else if Regex::new(r"(修改|返工|revise)").expect("revise review regex").is_match(&output) {
            "revise"
        } else {
            "pass"
        };
        let reason: String = strip_think_tags(&output).chars().take(240).collect();
        blackboard.review_decisions.push(ReviewDecision {
            reviewer: task.expert_name.clone(),
            decision: decision.to_string(),
            reason: reason.clone(),
        });
        if decision != "pass" {
            blackboard.blockers.push(format!("{}: {}", task.expert_name, reason));
        }
    }
}

pub fn advance_blackboard_progress(blackboard: &BlackboardTask, scene: &str) -> BlackboardProgressDecision {
    let mut next = blackboard.clone();
    if scene != "code-development" {
        return BlackboardProgressDecision {
            blackboard: next,
            made_progress: true,
            should_stop: false,
            blocker_message: None,
        };
    }

    let signature = format!(
        "{}:{}:{}:{}:{}:{}",
        next.required_files.files.len(),
        next.evidence.len(),
        next.patch_proposals.len(),
        next.validation_runs.len(),
        next.review_decisions.len(),
        next.blockers.len()
    );
    let previous_signature = next.progress_signature.clone().unwrap_or_default();
    let made_progress = signature != previous_signature;
    if made_progress {
        next.rounds_without_progress = 0;
    } else {
        next.rounds_without_progress = next.rounds_without_progress.saturating_add(1);
    }
    next.progress_signature = Some(signature);

    let blocker_message = if next.rounds_without_progress >= 3 {
        Some("连续三轮没有新增证据、文件清单、文件变更动作或审查进展，已停止当前策略以避免空转。".to_string())
    } else {
        None
    };
    let should_stop = blocker_message.is_some();
    if let Some(message) = blocker_message.clone() {
        next.blockers.push(message.clone());
    }

    BlackboardProgressDecision {
        blackboard: next,
        made_progress,
        should_stop,
        blocker_message,
    }
}

pub fn render_blackboard_context(blackboard: &BlackboardTask) -> String {
    let workspace_looks_empty = !blackboard.workspace_roots.is_empty()
        && blackboard
            .workspace_roots
            .iter()
            .all(|entry| entry.starts_with('.') || entry == ".xt" || entry == ".git");
    let workspace_roots = if blackboard.workspace_roots.is_empty() {
        "- 当前未拿到工作区目录快照".to_string()
    } else {
        blackboard.workspace_roots.iter().take(16).map(|file| format!("- {}", file)).collect::<Vec<_>>().join("\n")
    };
    let required = if blackboard.required_files.files.is_empty() {
        "- 尚未锁定，当前专家必须先根据证据提出候选文件或说明无法锁定".to_string()
    } else {
        blackboard.required_files.files.iter().take(24).map(|file| format!("- {}", file)).collect::<Vec<_>>().join("\n")
    };
    let evidence = if blackboard.evidence.is_empty() {
        "- 暂无，当前专家需要补充可验证证据".to_string()
    } else {
        blackboard
            .evidence
            .iter()
            .rev()
            .take(4)
            .map(|item| format!("- {}: {}", item.source, summarize_context_text(&item.summary, 220)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let patches = if blackboard.patch_proposals.is_empty() {
        "- 暂无文件变更动作".to_string()
    } else {
        blackboard
            .patch_proposals
            .iter()
            .rev()
            .take(4)
            .map(|proposal| format!("- {}: {} ({})", proposal.id, summarize_file_list(&proposal.files, 8), proposal.risk))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let validations = if blackboard.validation_runs.is_empty() {
        "- 暂无测试记录".to_string()
    } else {
        blackboard
            .validation_runs
            .iter()
            .rev()
            .take(4)
            .map(|run| {
                format!(
                    "- {} => {}；{}",
                    summarize_context_text(&run.command, 120),
                    if run.passed { "通过" } else { "失败" },
                    summarize_context_text(&run.summary, 140)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let blockers = if blackboard.blockers.is_empty() {
        "- 暂无".to_string()
    } else {
        blackboard
            .blockers
            .iter()
            .rev()
            .take(4)
            .map(|blocker| format!("- {}", summarize_context_text(blocker, 180)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let workspace_note = if workspace_looks_empty {
        "- 当前工作区几乎为空目录；如果任务要求落地页面或功能，请优先直接创建最小可运行文件集合。默认推荐拆成 index.html / styles.css / app.js / README.md 这类小文件交付，而不是继续查找不存在的旧源码、讨论技术选型，或一次性输出超长单文件。".to_string()
    } else {
        "- 若已存在业务源码，先读取真实文件内容，再做精确增量修改。".to_string()
    };
    let pending_action_note = if !blackboard.patch_proposals.is_empty() {
        "- 当前黑板里已经存在待执行的文件变更动作；在最终合入前，磁盘上的目标文件可能暂时还不存在。质量/测试/审查专家不得仅因 Test-Path 或 Get-Content 发现文件未落盘就判定工程实现失败，必须先基于黑板中的文件变更动作和前置专家输出评估 proposed changes；只有在确认动作已执行、或工作区本来就应存在该文件时，才能把磁盘缺失当成阻断。".to_string()
    } else {
        "- 如果黑板里还没有任何文件变更动作，才可以把目标文件缺失视为实现阶段尚未开始或实现失败的证据。".to_string()
    };

    format!(
        "\n\n【共享黑板 · 所有专家必须围绕它协作】\n任务目标：{}\n\n当前工作区已知条目：\n{}\n\n必检/候选文件：\n{}\n\n证据：\n{}\n\n文件变更动作：\n{}\n\n测试记录：\n{}\n\n阻塞项：\n{}\n\n协作规则：\n- 不要假装看过未列入证据的文件；需要文件时先把它加入必检/候选文件。\n- 工程实现必须输出可执行文件动作（ACTION 或结构化 changes），系统会直接执行。\n- {}\n- {}\n- 除非某个补丁/报告文件已经通过 ACTION 明确创建，否则不要引用像 task-3-patch-1.md、task-8-patch-3.md 这类假想文件名，更不能让后续专家基于不存在的文件继续审查。\n- 设计文档里的文件名、模块名如果和当前工作区/现有源码引用不一致，只能当作设计建议；必须优先服从真实工作区文件名、真实源码引用和已执行动作。\n- 不要把已有文件名擅自改写成另一种命名（例如把 functioncalculator 写成 function-calculator）；如果黑板/文件列表里没有这个名字，就不能把它当成必需文件或阻断项。\n- 测试专家必须通过命令验证关键路径，不得只给口头建议；但如果动作仍处于待执行状态，命令验证的目标应是确认“当前磁盘尚未合入”，而不是据此否定已提出的文件动作。\n- 审查必须审查文件动作覆盖范围、局部编辑可定位性、是否存在漏改文件。\n",
        blackboard.goal, workspace_roots, required, evidence, patches, validations, blockers, workspace_note, pending_action_note
    )
}

fn strip_think_tags(text: &str) -> String {
    Regex::new(r"(?s)<think>.*?</think>").expect("think regex").replace_all(text, "").to_string()
}

fn normalize_workspace_path_token(raw_path: &str) -> String {
    raw_path
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | '(' | ')' | ',' | '.' | ';' | ':'))
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn simplify_file_token(path: &str) -> String {
    let normalized = normalize_workspace_path_token(path).to_lowercase();
    let file = normalized.split('/').last().unwrap_or(&normalized);
    Regex::new(r"[^a-z0-9.]+").expect("simplify regex").replace_all(file, "").to_string()
}

fn resolve_workspace_file_path(raw_path: &str, workspace_files: &[String]) -> Option<String> {
    let normalized = normalize_workspace_path_token(raw_path);
    if normalized.is_empty() {
        return None;
    }
    let lowered = normalized.to_lowercase();
    if let Some(exact) = workspace_files.iter().find(|file| file.to_lowercase() == lowered) {
        return Some(exact.clone());
    }
    let basename = lowered.split('/').last().unwrap_or(&lowered).to_string();
    let basename_matches = workspace_files
        .iter()
        .filter(|file| {
            let lowered_file = file.to_lowercase();
            lowered_file.ends_with(&format!("/{}", basename)) || lowered_file == basename
        })
        .cloned()
        .collect::<Vec<_>>();
    if basename_matches.len() == 1 {
        return basename_matches.into_iter().next();
    }
    let simplified = simplify_file_token(&normalized);
    if simplified.is_empty() {
        return None;
    }
    let simplified_matches = workspace_files
        .iter()
        .filter(|file| simplify_file_token(file) == simplified)
        .cloned()
        .collect::<Vec<_>>();
    if simplified_matches.len() == 1 {
        return simplified_matches.into_iter().next();
    }
    None
}

fn extract_file_mentions(text: &str) -> Vec<String> {
    Regex::new(r#"(?m)(?:^|[\s`"'(])([A-Za-z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|rs|py|go|java|kt|swift|c|cpp|h|hpp|css|html|json|md|toml|yaml|yml|sql))"#)
        .expect("file mention regex")
        .captures_iter(text)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().replace('\\', "/")))
        .take(80)
        .collect::<Vec<_>>()
}

fn extract_change_files(text: &str) -> Vec<String> {
    let mut files = HashSet::new();
    let action_regex = Regex::new(r"\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|DELETE):([^\]]+)\]").expect("change action regex");
    for caps in action_regex.captures_iter(text) {
        if let Some(path) = caps.get(1) {
            files.insert(path.as_str().trim().replace('\\', "/"));
        }
    }
    let param_action_regex =
        Regex::new(r#"\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|DELETE)\s+[^\]]*?path="([^"]+)""#).expect("change param regex");
    for caps in param_action_regex.captures_iter(text) {
        if let Some(path) = caps.get(1) {
            files.insert(path.as_str().trim().replace('\\', "/"));
        }
    }
    let json_path_regex = Regex::new(r#""path"\s*:\s*"([^"]+)""#).expect("json path regex");
    for caps in json_path_regex.captures_iter(text) {
        if let Some(path) = caps.get(1) {
            files.insert(path.as_str().trim().replace('\\', "/"));
        }
    }
    files.into_iter().take(80).collect()
}

fn summarize_context_text(text: &str, max_chars: usize) -> String {
    let normalized = Regex::new(r"\s+").expect("whitespace regex").replace_all(text, " ").trim().to_string();
    let char_count = normalized.chars().count();
    if char_count <= max_chars {
        return normalized;
    }
    let keep = max_chars.saturating_sub(24);
    let truncated: String = normalized.chars().take(keep).collect();
    format!("{}...[已截断 {} 字符]", truncated, char_count.saturating_sub(keep))
}

fn summarize_file_list(files: &[String], max_items: usize) -> String {
    if files.len() <= max_items {
        return files.join(", ");
    }
    format!("{} 等 {} 个文件", files[..max_items].join(", "), files.len())
}

#[cfg(test)]
mod tests {
    use super::{
        advance_blackboard_progress, new_blackboard, render_blackboard_context, update_blackboard_from_task,
        ExpertTaskSummary,
    };

    #[test]
    fn seeds_blackboard_with_workspace_snapshot() {
        let blackboard = new_blackboard(
            "修前端",
            vec!["src/app.js".to_string()],
            vec!["src".to_string(), "README.md".to_string()],
            1,
        );
        assert_eq!(blackboard.goal, "修前端");
        assert_eq!(blackboard.workspace_roots.len(), 2);
        assert_eq!(blackboard.evidence.len(), 1);
    }

    #[test]
    fn updates_blackboard_with_changed_files_and_review() {
        let mut blackboard = new_blackboard(
            "修前端",
            vec!["src/app.js".to_string(), "README.md".to_string()],
            vec!["src".to_string()],
            1,
        );
        update_blackboard_from_task(
            &mut blackboard,
            &ExpertTaskSummary {
                id: "task-1".to_string(),
                expert_name: "江予墨".to_string(),
                expert_title: "前端工程师".to_string(),
                output: Some(r#"[ACTION:EDIT_FILE path="src/app.js" searchText="a" replaceText="b"]"#.to_string()),
                error: None,
            },
            2,
        );
        assert_eq!(blackboard.patch_proposals.len(), 1);
        update_blackboard_from_task(
            &mut blackboard,
            &ExpertTaskSummary {
                id: "task-2".to_string(),
                expert_name: "江映秋".to_string(),
                expert_title: "审查员".to_string(),
                output: Some("建议返工，当前方案不通过".to_string()),
                error: None,
            },
            3,
        );
        assert_eq!(blackboard.review_decisions.len(), 1);
        assert!(!blackboard.blockers.is_empty());
    }

    #[test]
    fn renders_blackboard_context() {
        let blackboard = new_blackboard(
            "补一个功能",
            vec!["src/app.js".to_string()],
            vec!["src".to_string()],
            1,
        );
        let rendered = render_blackboard_context(&blackboard);
        assert!(rendered.contains("共享黑板"));
        assert!(rendered.contains("补一个功能"));
    }

    #[test]
    fn stops_after_three_rounds_without_progress() {
        let blackboard = new_blackboard("补一个功能", vec!["src/app.js".to_string()], vec!["src".to_string()], 1);
        let round1 = advance_blackboard_progress(&blackboard, "code-development");
        let round2 = advance_blackboard_progress(&round1.blackboard, "code-development");
        let round3 = advance_blackboard_progress(&round2.blackboard, "code-development");
        let round4 = advance_blackboard_progress(&round3.blackboard, "code-development");
        assert!(round4.should_stop);
        assert!(round4.blocker_message.is_some());
    }
}
