use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressExpertLabel {
    pub id: String,
    pub name: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressTask {
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub status: String,
    pub input: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub phase_detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressSnapshotRequest {
    pub active_tasks: Vec<PipelineProgressTask>,
    pub active_step_expert_ids: Vec<String>,
    pub planned_expert_ids: Vec<String>,
    pub expert_labels: Vec<PipelineProgressExpertLabel>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressSnapshot {
    pub progress_report: String,
    pub current_step_summary: String,
    pub remaining_expert_summary: String,
    pub active_task_summary: String,
    pub active_task_count: usize,
}

pub fn build_progress_snapshot(
    request: &PipelineProgressSnapshotRequest,
) -> PipelineProgressSnapshot {
    PipelineProgressSnapshot {
        progress_report: build_progress_report(&request.active_tasks),
        current_step_summary: build_expert_summary(
            &request.active_step_expert_ids,
            &request.expert_labels,
        ),
        remaining_expert_summary: build_expert_summary(
            &request.planned_expert_ids,
            &request.expert_labels,
        ),
        active_task_summary: build_active_task_summary(&request.active_tasks),
        active_task_count: request
            .active_tasks
            .iter()
            .filter(|task| task.status == "running")
            .count(),
    }
}

fn build_progress_report(tasks: &[PipelineProgressTask]) -> String {
    if tasks.is_empty() {
        return "当前没有正在执行的任务。".to_string();
    }

    let lines = tasks
        .iter()
        .map(|task| {
            let icon = match task.status.as_str() {
                "done" => "✓",
                "running" => "⟳",
                "error" => "✗",
                _ => "○",
            };
            let status = match task.status.as_str() {
                "done" => "已完成",
                "running" => "执行中",
                "error" => "失败",
                _ => "等待中",
            };
            format!(
                "{icon} {}（{}）：{status}",
                task.expert_name, task.expert_title
            )
        })
        .collect::<Vec<_>>();

    format!("当前任务进度：\n{}", lines.join("\n"))
}

fn build_expert_summary(expert_ids: &[String], labels: &[PipelineProgressExpertLabel]) -> String {
    if expert_ids.is_empty() {
        return "- 当前没有可识别的执行中专家".to_string();
    }

    expert_ids
        .iter()
        .map(|expert_id| {
            let label = labels
                .iter()
                .find(|item| item.id == *expert_id)
                .map(|item| format!("{}（{}）", item.name, item.title))
                .unwrap_or_else(|| expert_id.clone());
            format!("- {expert_id}: {label}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_active_task_summary(tasks: &[PipelineProgressTask]) -> String {
    if tasks.is_empty() {
        return "暂无可用的阶段性结果。".to_string();
    }

    tasks
        .iter()
        .map(|task| {
            let status = match task.status.as_str() {
                "done" => "已完成".to_string(),
                "running" => "执行中".to_string(),
                "error" => format!(
                    "失败：{}",
                    task.error.clone().unwrap_or_else(|| "未知错误".to_string())
                ),
                _ => "等待中".to_string(),
            };
            let detail = task
                .output
                .clone()
                .or(task.phase_detail.clone())
                .or(task.error.clone())
                .unwrap_or_else(|| task.input.clone());
            let detail = if detail.chars().count() > 180 {
                let truncated: String = detail.chars().take(180).collect();
                format!("{truncated}...")
            } else {
                detail
            };
            format!(
                "- {}: {}（{}）：{}；{}",
                task.expert_id, task.expert_name, task.expert_title, status, detail
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::{
        build_progress_snapshot, PipelineProgressExpertLabel, PipelineProgressSnapshotRequest,
        PipelineProgressTask,
    };

    #[test]
    fn builds_progress_snapshot_with_labels_and_reports() {
        let snapshot = build_progress_snapshot(&PipelineProgressSnapshotRequest {
            active_tasks: vec![
                PipelineProgressTask {
                    expert_id: "discipline-520".to_string(),
                    expert_name: "520 计算机科学技术".to_string(),
                    expert_title: "一级学科专家".to_string(),
                    status: "running".to_string(),
                    input: "修界面".to_string(),
                    output: None,
                    error: None,
                    phase_detail: Some("正在读取 app.js".to_string()),
                },
                PipelineProgressTask {
                    expert_id: "discipline-120".to_string(),
                    expert_name: "120 信息科学与系统科学".to_string(),
                    expert_title: "一级学科专家".to_string(),
                    status: "done".to_string(),
                    input: "调研".to_string(),
                    output: Some("已完成调研".to_string()),
                    error: None,
                    phase_detail: None,
                },
            ],
            active_step_expert_ids: vec!["discipline-520".to_string()],
            planned_expert_ids: vec!["discipline-520".to_string(), "discipline-120".to_string()],
            expert_labels: vec![
                PipelineProgressExpertLabel {
                    id: "discipline-520".to_string(),
                    name: "520 计算机科学技术".to_string(),
                    title: "一级学科专家".to_string(),
                },
                PipelineProgressExpertLabel {
                    id: "discipline-120".to_string(),
                    name: "120 信息科学与系统科学".to_string(),
                    title: "一级学科专家".to_string(),
                },
            ],
        });

        assert_eq!(snapshot.active_task_count, 1);
        assert!(snapshot
            .progress_report
            .contains("520 计算机科学技术（一级学科专家）：执行中"));
        assert!(snapshot
            .current_step_summary
            .contains("discipline-520: 520 计算机科学技术（一级学科专家）"));
        assert!(snapshot
            .remaining_expert_summary
            .contains("discipline-120: 120 信息科学与系统科学（一级学科专家）"));
        assert!(snapshot.active_task_summary.contains("正在读取 app.js"));
    }
}
