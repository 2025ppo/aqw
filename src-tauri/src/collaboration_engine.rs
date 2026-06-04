use serde::{Deserialize, Serialize};

use crate::blackboard_engine::{render_blackboard_context, BlackboardTask};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineFollowup {
    pub id: String,
    pub message: String,
    pub target_expert_ids: Vec<String>,
    pub delivery_mode: String,
    pub consumed_by: Vec<String>,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompletedExpertResult {
    pub expert_id: String,
    pub name: String,
    pub title: String,
    pub output: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertTaskBuildRequest {
    pub base_task_description: String,
    pub expert_id: String,
    pub current_step_expert_ids: Vec<String>,
    pub pending_followups: Vec<PipelineFollowup>,
    pub current_step_only: bool,
    pub blackboard_context: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertTaskBuildResponse {
    pub text: String,
    pub followup_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionStateRequest {
    pub completed_results: Vec<CompletedExpertResult>,
    pub pending_followups: Vec<PipelineFollowup>,
    pub task: TaskCompletionSummary,
    pub followup_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionSummary {
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub output: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskCompletionStateResponse {
    pub completed_results: Vec<CompletedExpertResult>,
    pub pending_followups: Vec<PipelineFollowup>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FollowupRoundPlanRequest {
    pub scene: String,
    pub base_task_description: String,
    pub current_step_expert_ids: Vec<String>,
    pub pending_followups: Vec<PipelineFollowup>,
    pub blackboard: Option<BlackboardTask>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FollowupTaskPlan {
    pub expert_id: String,
    pub text: String,
    pub followup_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FollowupRoundPlanResponse {
    pub tasks: Vec<FollowupTaskPlan>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepTaskPlanRequest {
    pub scene: String,
    pub base_task_description: String,
    pub current_step_expert_ids: Vec<String>,
    pub pending_followups: Vec<PipelineFollowup>,
    pub blackboard: Option<BlackboardTask>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepTaskPlanResponse {
    pub tasks: Vec<FollowupTaskPlan>,
}

fn get_relevant_followups_for_expert<'a>(
    expert_id: &str,
    current_step_expert_ids: &[String],
    followups: &'a [PipelineFollowup],
    current_step_only: bool,
) -> Vec<&'a PipelineFollowup> {
    followups
        .iter()
        .filter(|followup| {
            if followup.consumed_by.iter().any(|item| item == expert_id) {
                return false;
            }
            if !followup.target_expert_ids.is_empty()
                && !followup.target_expert_ids.iter().any(|item| item == expert_id)
            {
                return false;
            }
            if current_step_only && followup.delivery_mode == "next-relevant" {
                return false;
            }
            if followup.delivery_mode == "current-step" {
                return current_step_expert_ids.iter().any(|item| item == expert_id);
            }
            true
        })
        .collect()
}

pub fn build_expert_task_payload(request: &ExpertTaskBuildRequest) -> ExpertTaskBuildResponse {
    let relevant_followups = get_relevant_followups_for_expert(
        &request.expert_id,
        &request.current_step_expert_ids,
        &request.pending_followups,
        request.current_step_only,
    );
    let followup_context = if relevant_followups.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n【主管刚收到用户的中途修正，请你直接处理】\n{}\n",
            relevant_followups
                .iter()
                .enumerate()
                .map(|(index, item)| format!("{}. {}", index + 1, item.message))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let blackboard_context = request.blackboard_context.clone().unwrap_or_default();
    ExpertTaskBuildResponse {
        text: format!("{}{}{}", request.base_task_description, followup_context, blackboard_context),
        followup_ids: relevant_followups.iter().map(|item| item.id.clone()).collect(),
    }
}

pub fn apply_task_completion_state(request: &TaskCompletionStateRequest) -> TaskCompletionStateResponse {
    let mut completed_results = request.completed_results.clone();
    let mut pending_followups = request.pending_followups.clone();

    if let Some(output) = request.task.output.clone() {
        let next = CompletedExpertResult {
            expert_id: request.task.expert_id.clone(),
            name: request.task.expert_name.clone(),
            title: request.task.expert_title.clone(),
            output,
        };
        if let Some(existing) = completed_results
            .iter_mut()
            .find(|item| item.expert_id == request.task.expert_id)
        {
            *existing = next;
        } else {
            completed_results.push(next);
        }
    }

    if !request.followup_ids.is_empty() {
        for followup in &mut pending_followups {
            if !request.followup_ids.iter().any(|id| id == &followup.id) {
                continue;
            }
            if !followup
                .consumed_by
                .iter()
                .any(|expert_id| expert_id == &request.task.expert_id)
            {
                followup.consumed_by.push(request.task.expert_id.clone());
            }
        }
    }

    TaskCompletionStateResponse {
        completed_results,
        pending_followups,
    }
}

pub fn plan_step_followup_round(request: &FollowupRoundPlanRequest) -> FollowupRoundPlanResponse {
    if request.pending_followups.is_empty() {
        return FollowupRoundPlanResponse { tasks: vec![] };
    }

    let blackboard_context = if request.scene == "code-development" {
        request
            .blackboard
            .as_ref()
            .map(render_blackboard_context)
            .unwrap_or_default()
    } else {
        String::new()
    };

    let base_task_description = format!(
        "{}\n\n【说明】你刚才已开始处理该任务。现在主管基于用户插话，要求你在现有基础上直接修正/补充。",
        request.base_task_description
    );

    let tasks = request
        .current_step_expert_ids
        .iter()
        .filter_map(|expert_id| {
            let payload = build_expert_task_payload(&ExpertTaskBuildRequest {
                base_task_description: base_task_description.clone(),
                expert_id: expert_id.clone(),
                current_step_expert_ids: request.current_step_expert_ids.clone(),
                pending_followups: request.pending_followups.clone(),
                current_step_only: true,
                blackboard_context: Some(blackboard_context.clone()),
            });
            if payload.followup_ids.is_empty() {
                None
            } else {
                Some(FollowupTaskPlan {
                    expert_id: expert_id.clone(),
                    text: payload.text,
                    followup_ids: payload.followup_ids,
                })
            }
        })
        .collect();

    FollowupRoundPlanResponse { tasks }
}

pub fn plan_current_step_tasks(request: &StepTaskPlanRequest) -> StepTaskPlanResponse {
    let blackboard_context = if request.scene == "code-development" {
        request
            .blackboard
            .as_ref()
            .map(render_blackboard_context)
            .unwrap_or_default()
    } else {
        String::new()
    };

    let tasks = request
        .current_step_expert_ids
        .iter()
        .map(|expert_id| {
            let payload = build_expert_task_payload(&ExpertTaskBuildRequest {
                base_task_description: request.base_task_description.clone(),
                expert_id: expert_id.clone(),
                current_step_expert_ids: request.current_step_expert_ids.clone(),
                pending_followups: request.pending_followups.clone(),
                current_step_only: false,
                blackboard_context: Some(blackboard_context.clone()),
            });
            FollowupTaskPlan {
                expert_id: expert_id.clone(),
                text: payload.text,
                followup_ids: payload.followup_ids,
            }
        })
        .collect();

    StepTaskPlanResponse { tasks }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_task_completion_state, build_expert_task_payload, plan_current_step_tasks, plan_step_followup_round,
        CompletedExpertResult, ExpertTaskBuildRequest, FollowupRoundPlanRequest, PipelineFollowup,
        StepTaskPlanRequest, TaskCompletionStateRequest, TaskCompletionSummary,
    };
    use crate::blackboard_engine::BlackboardTask;

    #[test]
    fn builds_expert_task_payload_with_matching_followups() {
        let response = build_expert_task_payload(&ExpertTaskBuildRequest {
            base_task_description: "修一下".to_string(),
            expert_id: "jiang-yumo".to_string(),
            current_step_expert_ids: vec!["jiang-yumo".to_string()],
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "顺便修文案".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            current_step_only: true,
            blackboard_context: Some("\n黑板".to_string()),
        });
        assert!(response.text.contains("顺便修文案"));
        assert!(response.text.contains("黑板"));
        assert_eq!(response.followup_ids, vec!["f1".to_string()]);
    }

    #[test]
    fn applies_task_completion_and_consumes_followups() {
        let response = apply_task_completion_state(&TaskCompletionStateRequest {
            completed_results: vec![CompletedExpertResult {
                expert_id: "jiang-ruoxi".to_string(),
                name: "江若溪".to_string(),
                title: "调研员".to_string(),
                output: "旧".to_string(),
            }],
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "修文案".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            task: TaskCompletionSummary {
                expert_id: "jiang-yumo".to_string(),
                expert_name: "江予墨".to_string(),
                expert_title: "前端工程师".to_string(),
                output: Some("已修改".to_string()),
            },
            followup_ids: vec!["f1".to_string()],
        });
        assert_eq!(response.completed_results.len(), 2);
        assert_eq!(response.pending_followups[0].consumed_by, vec!["jiang-yumo".to_string()]);
    }

    #[test]
    fn plans_current_step_followups_only_for_matching_experts() {
        let response = plan_step_followup_round(&FollowupRoundPlanRequest {
            scene: "code-development".to_string(),
            base_task_description: "修一下".to_string(),
            current_step_expert_ids: vec!["jiang-yumo".to_string(), "jiang-ruoxi".to_string()],
            pending_followups: vec![
                PipelineFollowup {
                    id: "f1".to_string(),
                    message: "补上函数计算器".to_string(),
                    target_expert_ids: vec!["jiang-yumo".to_string()],
                    delivery_mode: "current-step".to_string(),
                    consumed_by: vec![],
                    created_at: 1,
                },
                PipelineFollowup {
                    id: "f2".to_string(),
                    message: "下轮再看".to_string(),
                    target_expert_ids: vec![],
                    delivery_mode: "next-relevant".to_string(),
                    consumed_by: vec![],
                    created_at: 2,
                },
            ],
            blackboard: Some(BlackboardTask {
                id: "bb-1".to_string(),
                goal: "修一下".to_string(),
                workspace_files: vec![],
                workspace_roots: vec![],
                required_files: crate::blackboard_engine::RequiredFileSet {
                    files: vec![],
                    unresolved: vec![],
                    exclusions: vec![],
                },
                evidence: vec![],
                assumptions: vec![],
                open_questions: vec![],
                patch_proposals: vec![],
                validation_runs: vec![],
                review_decisions: vec![],
                blockers: vec![],
                rounds_without_progress: 0,
                progress_signature: None,
            }),
        });
        assert_eq!(response.tasks.len(), 1);
        assert_eq!(response.tasks[0].expert_id, "jiang-yumo");
        assert!(response.tasks[0].text.contains("补上函数计算器"));
        assert_eq!(response.tasks[0].followup_ids, vec!["f1".to_string()]);
    }

    #[test]
    fn plans_current_step_tasks_for_all_experts() {
        let response = plan_current_step_tasks(&StepTaskPlanRequest {
            scene: "quick-answer".to_string(),
            base_task_description: "请先调研再实现".to_string(),
            current_step_expert_ids: vec!["jiang-ruoxi".to_string(), "jiang-yumo".to_string()],
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "补充一句说明".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            blackboard: None,
        });
        assert_eq!(response.tasks.len(), 2);
        assert_eq!(response.tasks[0].expert_id, "jiang-ruoxi");
        assert_eq!(response.tasks[0].followup_ids.len(), 0);
        assert_eq!(response.tasks[1].expert_id, "jiang-yumo");
        assert_eq!(response.tasks[1].followup_ids, vec!["f1".to_string()]);
    }
}
