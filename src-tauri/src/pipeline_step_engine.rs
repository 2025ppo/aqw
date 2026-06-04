use crate::blackboard_engine::{advance_blackboard_progress, BlackboardTask};
use crate::pipeline_engine::{build_remaining_step_descriptions, PipelineExpertInfo, PipelineLayout, PipelinePlanInput};
use crate::pipeline_runtime_engine::{
    apply_decision, PipelineRuntimeDecisionRequest, PipelineRuntimeState, PipelineRuntimeTransition,
};
use crate::pipeline_session_engine::PipelineSessionState;
use crate::supervisor_engine;
use crate::workflow_engine::{
    evaluate_step_deliverable_guard, StepDeliverableGuardRequest, StepDeliverableTask,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTaskSnapshot {
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub dispatch_wave: Option<usize>,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorStepResult {
    pub expert_id: String,
    pub name: String,
    pub title: String,
    pub output: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStepFinalizeRequest {
    pub scene: String,
    pub task_description: String,
    pub step_index: usize,
    pub total_steps: usize,
    pub step_expert_ids: Vec<String>,
    pub has_workspace_context: bool,
    pub current_step_tasks: Vec<PipelineTaskSnapshot>,
    pub runtime_state: PipelineRuntimeState,
    pub blackboard: BlackboardTask,
    pub completed_results: Vec<SupervisorStepResult>,
    pub remaining_step_descs: Vec<String>,
    pub followup_context: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStepFinalizeDecision {
    pub blackboard: BlackboardTask,
    pub runtime_transition: PipelineRuntimeTransition,
    pub blocker_task: Option<PipelineTaskSnapshot>,
    pub supervisor_action: Option<String>,
    pub supervisor_reason: Option<String>,
    pub should_stop: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStepRuntimeFinalizeRequest {
    pub plan: PipelinePlanInput,
    pub layout: PipelineLayout,
    pub session_state: PipelineSessionState,
    pub has_workspace_context: bool,
    pub experts: Vec<PipelineExpertInfo>,
}

pub fn finalize_step_without_supervisor(
    request: &PipelineStepFinalizeRequest,
) -> PipelineStepFinalizeDecision {
    let mut blackboard = request.blackboard.clone();
    let task_outputs = request
        .current_step_tasks
        .iter()
        .map(|task| StepDeliverableTask {
            output: task.output.clone(),
        })
        .collect::<Vec<_>>();
    let guard = evaluate_step_deliverable_guard(&StepDeliverableGuardRequest {
        step_expert_ids: request.step_expert_ids.clone(),
        has_workspace_context: request.has_workspace_context,
        tasks: task_outputs,
    });

    if guard.requires_real_artifact && !guard.has_real_artifact {
        let blocker_message = guard
            .blocker_message
            .clone()
            .unwrap_or_else(|| "当前步骤缺少真实交付物".to_string());
        blackboard
            .blockers
            .push(format!("协作门禁: {}", blocker_message));
        let transition = apply_decision(&PipelineRuntimeDecisionRequest {
            state: request.runtime_state.clone(),
            action: "artifact-missing".to_string(),
            current_step_expert_ids: request.step_expert_ids.clone(),
        });
        return PipelineStepFinalizeDecision {
            blackboard,
            runtime_transition: transition.clone(),
            blocker_task: Some(PipelineTaskSnapshot {
                expert_id: "deliverable-guard".to_string(),
                expert_name: "流水线熔断".to_string(),
                expert_title: "协作门禁".to_string(),
                dispatch_wave: Some(request.step_index + 1),
                output: None,
                error: Some(blocker_message),
            }),
            supervisor_action: None,
            supervisor_reason: None,
            should_stop: transition.should_stop,
        };
    }

    if request.scene == "code-development" {
        let progress = advance_blackboard_progress(&blackboard, &request.scene);
        blackboard = progress.blackboard.clone();
        if progress.should_stop {
            let blocker_message = progress
                .blocker_message
                .clone()
                .unwrap_or_else(|| "黑板协作长期无进展，终止执行".to_string());
            return PipelineStepFinalizeDecision {
                blackboard,
                runtime_transition: request.runtime_state.clone().into(),
                blocker_task: Some(PipelineTaskSnapshot {
                    expert_id: "blackboard-guard".to_string(),
                    expert_name: "黑板守卫".to_string(),
                    expert_title: "协作门禁".to_string(),
                    dispatch_wave: Some(request.step_index + 1),
                    output: None,
                    error: Some(blocker_message),
                }),
                supervisor_action: None,
                supervisor_reason: None,
                should_stop: true,
            };
        }
    }

    let transition = apply_decision(&PipelineRuntimeDecisionRequest {
        state: request.runtime_state.clone(),
        action: "continue".to_string(),
        current_step_expert_ids: request.step_expert_ids.clone(),
    });
    PipelineStepFinalizeDecision {
        blackboard,
        runtime_transition: transition.clone(),
        blocker_task: None,
        supervisor_action: None,
        supervisor_reason: None,
        should_stop: transition.should_stop,
    }
}

impl From<PipelineRuntimeState> for PipelineRuntimeTransition {
    fn from(state: PipelineRuntimeState) -> Self {
        PipelineRuntimeTransition {
            state,
            repeated_step: false,
            advanced_steps: 0,
            should_stop: true,
            breaker_message: None,
        }
    }
}

pub fn build_midcheck_request(
    request: &PipelineStepFinalizeRequest,
    blackboard_context: &str,
) -> supervisor_engine::MidCheckRequest {
    let followup_context = request.followup_context.clone().unwrap_or_default();
    let results_summary = request
        .completed_results
        .iter()
        .map(|result| {
            let output = if result.output.chars().count() > 500 {
                let truncated: String = result.output.chars().take(500).collect();
                format!("{truncated}...(截断)")
            } else {
                result.output.clone()
            };
            format!("### {}（{}）\n{}", result.name, result.title, output)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let remaining_desc = if request.remaining_step_descs.is_empty() {
        "\n剩余步骤：无（最后一步）".to_string()
    } else {
        format!(
            "\n剩余步骤：{}",
            request
                .remaining_step_descs
                .iter()
                .enumerate()
                .map(|(index, desc)| format!("{}. {}", index + 1, desc))
                .collect::<Vec<_>>()
                .join("；")
        )
    };
    supervisor_engine::MidCheckRequest {
        step_index: request.step_index,
        total_steps: request.total_steps,
        task_description: if request.scene == "code-development" {
            format!("{}{}", request.task_description, blackboard_context)
        } else {
            request.task_description.clone()
        },
        followup_context,
        results_summary,
        remaining_desc,
    }
}

pub fn build_finalize_request(
    request: &PipelineStepRuntimeFinalizeRequest,
) -> PipelineStepFinalizeRequest {
    let step_index = request.session_state.runtime_state.current_step_index;
    let step_expert_ids = request
        .layout
        .steps
        .get(step_index)
        .map(|step| step.expert_ids.clone())
        .unwrap_or_default();
    let remaining_step_descs =
        build_remaining_step_descriptions(&request.layout, step_index, &request.experts);
    let followup_context = build_followup_context(&request.session_state.pending_followups, &request.experts);
    let current_step_tasks = request
        .session_state
        .task_history
        .iter()
        .filter(|task| {
            task.dispatch_wave == Some(step_index + 1) && step_expert_ids.contains(&task.expert_id)
        })
        .cloned()
        .collect();

    PipelineStepFinalizeRequest {
        scene: request.plan.scene.clone(),
        task_description: request.plan.task_description.clone(),
        step_index,
        total_steps: request.layout.steps.len(),
        step_expert_ids,
        has_workspace_context: request.has_workspace_context,
        current_step_tasks,
        runtime_state: request.session_state.runtime_state.clone(),
        blackboard: request.session_state.blackboard.clone(),
        completed_results: request
            .session_state
            .completed_results
            .iter()
            .map(|item| SupervisorStepResult {
                expert_id: item.expert_id.clone(),
                name: item.name.clone(),
                title: item.title.clone(),
                output: item.output.clone(),
            })
            .collect(),
        remaining_step_descs,
        followup_context,
    }
}

fn build_followup_context(
    followups: &[crate::collaboration_engine::PipelineFollowup],
    experts: &[PipelineExpertInfo],
) -> Option<String> {
    if followups.is_empty() {
        return None;
    }

    let content = followups
        .iter()
        .map(|item| {
            let target_text = if item.target_expert_ids.is_empty() {
                String::new()
            } else {
                let labels = item
                    .target_expert_ids
                    .iter()
                    .map(|expert_id| {
                        experts
                            .iter()
                            .find(|expert| expert.id == *expert_id)
                            .map(|expert| format!("{}（{}）", expert.name, expert.title))
                            .unwrap_or_else(|| expert_id.clone())
                    })
                    .collect::<Vec<_>>();
                format!(" -> {}", labels.join("、"))
            };
            format!("{}{}", item.message, target_text)
        })
        .collect::<Vec<_>>()
        .join("；");

    Some(format!("\n\n【用户中途补充要求】\n{}", content))
}

#[cfg(test)]
mod tests {
    use super::{
        build_finalize_request, build_midcheck_request, finalize_step_without_supervisor, PipelineStepFinalizeRequest,
        PipelineStepRuntimeFinalizeRequest, PipelineTaskSnapshot,
    };
    use crate::blackboard_engine::{new_blackboard, BlackboardTask};
    use crate::collaboration_engine::{CompletedExpertResult, PipelineFollowup};
    use crate::pipeline_engine::{PipelineExpertInfo, PipelineLayout, PipelinePlanInput, PipelineStepLayout};
    use crate::pipeline_runtime_engine::PipelineRuntimeState;
    use crate::pipeline_session_engine::PipelineSessionState;

    fn sample_blackboard() -> BlackboardTask {
        new_blackboard("修界面", vec!["src/app.js".to_string()], vec!["src".to_string()], 1)
    }

    #[test]
    fn builds_midcheck_request_with_remaining_steps() {
        let request = PipelineStepFinalizeRequest {
            scene: "code-development".to_string(),
            task_description: "修界面".to_string(),
            step_index: 0,
            total_steps: 2,
            step_expert_ids: vec!["jiang-yumo".to_string()],
            has_workspace_context: true,
            current_step_tasks: vec![],
            runtime_state: PipelineRuntimeState {
                current_step_index: 0,
                total_steps: 2,
                max_step_retry: 2,
                step_retry_counts: std::collections::HashMap::new(),
                finished: false,
            },
            blackboard: sample_blackboard(),
            completed_results: vec![super::SupervisorStepResult {
                expert_id: "jiang-ruoxi".to_string(),
                name: "江若溪".to_string(),
                title: "调研员".to_string(),
                output: "已调研".to_string(),
            }],
            remaining_step_descs: vec!["2. 江映秋（审查员）".to_string()],
            followup_context: Some("\n\n【用户中途补充要求】\n补一个按钮".to_string()),
        };

        let midcheck = build_midcheck_request(&request, "\n\n【共享黑板】...");
        assert!(midcheck.followup_context.contains("补一个按钮"));
        assert!(midcheck.remaining_desc.contains("江映秋"));
        assert!(midcheck.task_description.contains("共享黑板"));
    }

    #[test]
    fn finalizes_without_supervisor_when_deliverable_exists() {
        let request = PipelineStepFinalizeRequest {
            scene: "code-development".to_string(),
            task_description: "修界面".to_string(),
            step_index: 0,
            total_steps: 1,
            step_expert_ids: vec!["jiang-yumo".to_string()],
            has_workspace_context: true,
            current_step_tasks: vec![PipelineTaskSnapshot {
                expert_id: "jiang-yumo".to_string(),
                expert_name: "江予墨".to_string(),
                expert_title: "前端工程师".to_string(),
                dispatch_wave: Some(1),
                output: Some("[ACTION:EDIT_FILE path=\"app.js\" searchText=\"a\" replaceText=\"b\"]".to_string()),
                error: None,
            }],
            runtime_state: PipelineRuntimeState {
                current_step_index: 0,
                total_steps: 1,
                max_step_retry: 2,
                step_retry_counts: std::collections::HashMap::new(),
                finished: false,
            },
            blackboard: sample_blackboard(),
            completed_results: vec![],
            remaining_step_descs: vec![],
            followup_context: None,
        };

        let decision = finalize_step_without_supervisor(&request);
        assert!(decision.blocker_task.is_none());
    }

    #[test]
    fn builds_runtime_finalize_request_from_session_state() {
        let finalize_request = build_finalize_request(&PipelineStepRuntimeFinalizeRequest {
            plan: PipelinePlanInput {
                scene: "code-development".to_string(),
                task_description: "修界面".to_string(),
                expert_ids: vec!["jiang-yumo".to_string(), "jiang-yingqiu".to_string()],
                requires_design: Some(false),
            },
            layout: PipelineLayout {
                scene: "code-development".to_string(),
                description: "测试".to_string(),
                steps: vec![
                    PipelineStepLayout {
                        expert_ids: vec!["jiang-yumo".to_string()],
                        optional: Some(false),
                    },
                    PipelineStepLayout {
                        expert_ids: vec!["jiang-yingqiu".to_string()],
                        optional: Some(false),
                    },
                ],
                waves: vec![],
            },
            session_state: PipelineSessionState {
                pipeline_id: "pipeline-1".to_string(),
                scene: "code-development".to_string(),
                task_description: "修界面".to_string(),
                steps: vec![],
                runtime_state: PipelineRuntimeState {
                    current_step_index: 0,
                    total_steps: 2,
                    max_step_retry: 2,
                    step_retry_counts: std::collections::HashMap::new(),
                    finished: false,
                },
                blackboard: sample_blackboard(),
                completed_results: vec![CompletedExpertResult {
                    expert_id: "jiang-ruoxi".to_string(),
                    name: "江若溪".to_string(),
                    title: "调研员".to_string(),
                    output: "已调研".to_string(),
                }],
                pending_followups: vec![PipelineFollowup {
                    id: "f1".to_string(),
                    message: "补一个按钮".to_string(),
                    target_expert_ids: vec!["jiang-yumo".to_string()],
                    delivery_mode: "current-step".to_string(),
                    consumed_by: vec![],
                    created_at: 1,
                }],
                task_history: vec![PipelineTaskSnapshot {
                    expert_id: "jiang-yumo".to_string(),
                    expert_name: "江予墨".to_string(),
                    expert_title: "前端工程师".to_string(),
                    dispatch_wave: Some(1),
                    output: Some("已修改".to_string()),
                    error: None,
                }],
            },
            has_workspace_context: true,
            experts: vec![
                PipelineExpertInfo {
                    id: "jiang-yumo".to_string(),
                    name: "江予墨".to_string(),
                    title: "前端工程师".to_string(),
                },
                PipelineExpertInfo {
                    id: "jiang-yingqiu".to_string(),
                    name: "江映秋".to_string(),
                    title: "审查员".to_string(),
                },
            ],
        });

        assert_eq!(finalize_request.step_index, 0);
        assert_eq!(finalize_request.step_expert_ids, vec!["jiang-yumo".to_string()]);
        assert_eq!(finalize_request.current_step_tasks.len(), 1);
        assert_eq!(finalize_request.completed_results.len(), 1);
        assert!(finalize_request
            .followup_context
            .unwrap_or_default()
            .contains("江予墨（前端工程师）"));
        assert_eq!(finalize_request.remaining_step_descs.len(), 1);
    }
}
