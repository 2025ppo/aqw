use crate::blackboard_engine::{update_blackboard_from_task, BlackboardTask, ExpertTaskSummary};
use crate::collaboration_engine::{
    apply_task_completion_state, plan_current_step_tasks, plan_step_followup_round,
    CompletedExpertResult, FollowupRoundPlanRequest, FollowupRoundPlanResponse, PipelineFollowup,
    StepTaskPlanRequest, TaskCompletionStateRequest, TaskCompletionSummary,
};
use crate::pipeline_engine::{PipelineLayout, PipelinePlanInput, PipelineStepLayout};
use crate::pipeline_runtime_engine::{
    init_runtime, PipelineRuntimeInitRequest, PipelineRuntimeState,
};
use crate::pipeline_step_engine::PipelineTaskSnapshot;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSessionState {
    pub pipeline_id: String,
    pub scene: String,
    pub task_description: String,
    pub steps: Vec<PipelineStepLayout>,
    pub runtime_state: PipelineRuntimeState,
    pub blackboard: BlackboardTask,
    pub completed_results: Vec<CompletedExpertResult>,
    pub pending_followups: Vec<PipelineFollowup>,
    pub task_history: Vec<PipelineTaskSnapshot>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSessionInitRequest {
    pub pipeline_id: String,
    pub scene: String,
    pub task_description: String,
    pub steps: Vec<PipelineStepLayout>,
    pub blackboard: BlackboardTask,
    pub pending_followups: Vec<PipelineFollowup>,
    pub max_step_retry: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSessionBootstrapRequest {
    pub pipeline_id: String,
    pub plan: PipelinePlanInput,
    pub layout: PipelineLayout,
    pub blackboard: BlackboardTask,
    pub pending_followups: Vec<PipelineFollowup>,
    pub max_step_retry: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSessionBootstrapResponse {
    pub pipeline_id: String,
    pub layout: PipelineLayout,
    pub state: PipelineSessionState,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineExecutionRoundPlan {
    pub finished: bool,
    pub current_step_index: usize,
    pub step_expert_ids: Vec<String>,
    pub execution_mode: String,
    pub tasks: Vec<crate::collaboration_engine::FollowupTaskPlan>,
    pub completed_results: Vec<CompletedExpertResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineFollowupExecutionRoundPlan {
    pub has_pending_followups: bool,
    pub tasks: Vec<crate::collaboration_engine::FollowupTaskPlan>,
    pub completed_results: Vec<CompletedExpertResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTaskOutcomeRequest {
    pub state: PipelineSessionState,
    pub task: PipelineTaskOutcome,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTaskOutcomeBatchRequest {
    pub state: PipelineSessionState,
    pub tasks: Vec<PipelineTaskOutcome>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRoundOutcomeBatch {
    pub current_tasks: Vec<PipelineTaskOutcome>,
    pub followup_tasks: Vec<PipelineTaskOutcome>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTaskOutcome {
    pub id: String,
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub dispatch_wave: Option<usize>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub followup_ids: Vec<String>,
}

pub fn init_pipeline_session(request: &PipelineSessionInitRequest) -> PipelineSessionState {
    PipelineSessionState {
        pipeline_id: request.pipeline_id.clone(),
        scene: request.scene.clone(),
        task_description: request.task_description.clone(),
        steps: request.steps.clone(),
        runtime_state: init_runtime(&PipelineRuntimeInitRequest {
            total_steps: request.steps.len(),
            max_step_retry: request.max_step_retry,
        }),
        blackboard: request.blackboard.clone(),
        completed_results: vec![],
        pending_followups: request.pending_followups.clone(),
        task_history: vec![],
    }
}

pub fn bootstrap_pipeline_session(
    request: &PipelineSessionBootstrapRequest,
) -> PipelineSessionBootstrapResponse {
    let state = init_pipeline_session(&PipelineSessionInitRequest {
        pipeline_id: request.pipeline_id.clone(),
        scene: request.plan.scene.clone(),
        task_description: request.plan.task_description.clone(),
        steps: request.layout.steps.clone(),
        blackboard: request.blackboard.clone(),
        pending_followups: request.pending_followups.clone(),
        max_step_retry: request.max_step_retry,
    });
    PipelineSessionBootstrapResponse {
        pipeline_id: request.pipeline_id.clone(),
        layout: request.layout.clone(),
        state,
    }
}

pub fn get_current_execution_round_plan(
    state: &PipelineSessionState,
) -> PipelineExecutionRoundPlan {
    if state.runtime_state.finished || state.runtime_state.current_step_index >= state.steps.len() {
        return PipelineExecutionRoundPlan {
            finished: true,
            current_step_index: state.runtime_state.current_step_index,
            step_expert_ids: vec![],
            execution_mode: "serial".to_string(),
            tasks: vec![],
            completed_results: state.completed_results.clone(),
        };
    }

    let step = &state.steps[state.runtime_state.current_step_index];
    let tasks = plan_current_step_tasks(&StepTaskPlanRequest {
        scene: state.scene.clone(),
        base_task_description: state.task_description.clone(),
        current_step_expert_ids: step.expert_ids.clone(),
        pending_followups: state.pending_followups.clone(),
        blackboard: Some(state.blackboard.clone()),
    })
    .tasks;

    PipelineExecutionRoundPlan {
        finished: false,
        current_step_index: state.runtime_state.current_step_index,
        step_expert_ids: step.expert_ids.clone(),
        execution_mode: if step.expert_ids.len() <= 1 {
            "serial".to_string()
        } else {
            "parallel".to_string()
        },
        tasks,
        completed_results: state.completed_results.clone(),
    }
}

pub fn get_current_followup_plan(state: &PipelineSessionState) -> FollowupRoundPlanResponse {
    if state.runtime_state.finished || state.runtime_state.current_step_index >= state.steps.len() {
        return FollowupRoundPlanResponse { tasks: vec![] };
    }
    let step = &state.steps[state.runtime_state.current_step_index];
    plan_step_followup_round(&FollowupRoundPlanRequest {
        scene: state.scene.clone(),
        base_task_description: state.task_description.clone(),
        current_step_expert_ids: step.expert_ids.clone(),
        pending_followups: state.pending_followups.clone(),
        blackboard: Some(state.blackboard.clone()),
    })
}

pub fn get_current_followup_execution_round_plan(
    state: &PipelineSessionState,
) -> PipelineFollowupExecutionRoundPlan {
    let tasks = get_current_followup_plan(state).tasks;
    PipelineFollowupExecutionRoundPlan {
        has_pending_followups: !state.pending_followups.is_empty(),
        tasks,
        completed_results: state.completed_results.clone(),
    }
}

pub fn apply_pipeline_task_outcome(request: &PipelineTaskOutcomeRequest) -> PipelineSessionState {
    let mut state = request.state.clone();
    let task = &request.task;

    update_blackboard_from_task(
        &mut state.blackboard,
        &ExpertTaskSummary {
            id: task.id.clone(),
            expert_name: task.expert_name.clone(),
            expert_title: task.expert_title.clone(),
            output: task.output.clone(),
            error: task.error.clone(),
        },
        now_ms(),
    );

    let next_state = apply_task_completion_state(&TaskCompletionStateRequest {
        completed_results: state.completed_results.clone(),
        pending_followups: state.pending_followups.clone(),
        task: TaskCompletionSummary {
            expert_id: task.expert_id.clone(),
            expert_name: task.expert_name.clone(),
            expert_title: task.expert_title.clone(),
            output: task.output.clone(),
        },
        followup_ids: task.followup_ids.clone(),
    });
    state.completed_results = next_state.completed_results;
    state.pending_followups = next_state.pending_followups;
    state.task_history.push(PipelineTaskSnapshot {
        expert_id: task.expert_id.clone(),
        expert_name: task.expert_name.clone(),
        expert_title: task.expert_title.clone(),
        dispatch_wave: task.dispatch_wave,
        output: task.output.clone(),
        error: task.error.clone(),
    });
    state
}

pub fn apply_pipeline_task_outcomes(
    request: &PipelineTaskOutcomeBatchRequest,
) -> PipelineSessionState {
    let mut state = request.state.clone();
    for task in &request.tasks {
        state = apply_pipeline_task_outcome(&PipelineTaskOutcomeRequest {
            state,
            task: task.clone(),
        });
    }
    state
}

pub fn apply_pipeline_round_outcomes(
    state: &PipelineSessionState,
    batch: &PipelineRoundOutcomeBatch,
) -> PipelineSessionState {
    let after_current = apply_pipeline_task_outcomes(&PipelineTaskOutcomeBatchRequest {
        state: state.clone(),
        tasks: batch.current_tasks.clone(),
    });
    apply_pipeline_task_outcomes(&PipelineTaskOutcomeBatchRequest {
        state: after_current,
        tasks: batch.followup_tasks.clone(),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_pipeline_round_outcomes, apply_pipeline_task_outcome, apply_pipeline_task_outcomes,
        bootstrap_pipeline_session, get_current_execution_round_plan,
        get_current_followup_execution_round_plan, get_current_followup_plan,
        init_pipeline_session, PipelineRoundOutcomeBatch, PipelineSessionBootstrapRequest,
        PipelineSessionInitRequest, PipelineTaskOutcome, PipelineTaskOutcomeBatchRequest,
        PipelineTaskOutcomeRequest,
    };
    use crate::blackboard_engine::{BlackboardTask, RequiredFileSet};
    use crate::collaboration_engine::PipelineFollowup;
    use crate::pipeline_engine::{PipelineLayout, PipelinePlanInput, PipelineStepLayout};

    fn sample_blackboard() -> BlackboardTask {
        BlackboardTask {
            id: "bb-1".to_string(),
            goal: "实现功能".to_string(),
            workspace_files: vec![],
            workspace_roots: vec![],
            required_files: RequiredFileSet {
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
        }
    }

    #[test]
    fn initializes_and_plans_current_step() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![],
            max_step_retry: Some(2),
        });
        let plan = get_current_execution_round_plan(&state);
        assert!(!plan.finished);
        assert_eq!(plan.current_step_index, 0);
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(plan.tasks[0].expert_id, "jiang-yumo");
        assert_eq!(plan.execution_mode, "serial");
    }

    #[test]
    fn updates_state_after_task_outcome() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "补一行文案".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            max_step_retry: Some(2),
        });
        let next = apply_pipeline_task_outcome(&PipelineTaskOutcomeRequest {
            state,
            task: PipelineTaskOutcome {
                id: "task-1".to_string(),
                expert_id: "jiang-yumo".to_string(),
                expert_name: "江予墨".to_string(),
                expert_title: "前端工程师".to_string(),
                dispatch_wave: Some(1),
                output: Some("[ACTION:EDIT_FILE path=\"app.js\"]".to_string()),
                error: None,
                followup_ids: vec!["f1".to_string()],
            },
        });
        assert_eq!(next.completed_results.len(), 1);
        assert_eq!(
            next.pending_followups[0].consumed_by,
            vec!["jiang-yumo".to_string()]
        );
        assert_eq!(next.task_history.len(), 1);
        assert_eq!(next.task_history[0].dispatch_wave, Some(1));
        assert!(!next.blackboard.patch_proposals.is_empty());
    }

    #[test]
    fn plans_followups_from_session() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "补一行文案".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            max_step_retry: Some(2),
        });
        let plan = get_current_followup_plan(&state);
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(plan.tasks[0].expert_id, "jiang-yumo");
        assert_eq!(plan.tasks[0].followup_ids, vec!["f1".to_string()]);
    }

    #[test]
    fn bootstraps_layout_and_session_together() {
        let response = bootstrap_pipeline_session(&PipelineSessionBootstrapRequest {
            pipeline_id: "pipeline-bootstrap".to_string(),
            plan: PipelinePlanInput {
                scene: "code-development".to_string(),
                task_description: "修复界面".to_string(),
                expert_ids: vec!["jiang-ruoxi".to_string(), "jiang-yumo".to_string()],
                requires_design: Some(false),
            },
            layout: PipelineLayout {
                scene: "code-development".to_string(),
                description: "测试布局".to_string(),
                steps: vec![PipelineStepLayout {
                    expert_ids: vec!["jiang-yumo".to_string()],
                    optional: Some(false),
                }],
                waves: vec![],
            },
            blackboard: sample_blackboard(),
            pending_followups: vec![],
            max_step_retry: Some(2),
        });

        assert_eq!(response.pipeline_id, "pipeline-bootstrap");
        assert_eq!(response.layout.steps.len(), 1);
        assert_eq!(response.state.pipeline_id, "pipeline-bootstrap");
        assert_eq!(response.state.steps.len(), 1);
    }

    #[test]
    fn applies_task_outcome_batch() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string(), "jiang-yingqiu".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![],
            max_step_retry: Some(2),
        });
        let next = apply_pipeline_task_outcomes(&PipelineTaskOutcomeBatchRequest {
            state,
            tasks: vec![
                PipelineTaskOutcome {
                    id: "task-1".to_string(),
                    expert_id: "jiang-yumo".to_string(),
                    expert_name: "江予墨".to_string(),
                    expert_title: "前端工程师".to_string(),
                    dispatch_wave: Some(1),
                    output: Some("[ACTION:EDIT_FILE path=\"app.js\"]".to_string()),
                    error: None,
                    followup_ids: vec![],
                },
                PipelineTaskOutcome {
                    id: "task-2".to_string(),
                    expert_id: "jiang-yingqiu".to_string(),
                    expert_name: "江映秋".to_string(),
                    expert_title: "审查员".to_string(),
                    dispatch_wave: Some(1),
                    output: Some("通过".to_string()),
                    error: None,
                    followup_ids: vec![],
                },
            ],
        });
        assert_eq!(next.completed_results.len(), 2);
        assert_eq!(next.task_history.len(), 2);
        assert!(!next.blackboard.patch_proposals.is_empty());
        assert_eq!(next.blackboard.review_decisions.len(), 1);
    }

    #[test]
    fn derives_parallel_execution_round_plan() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string(), "jiang-yingqiu".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![],
            max_step_retry: Some(2),
        });
        let plan = get_current_execution_round_plan(&state);
        assert_eq!(plan.execution_mode, "parallel");
        assert_eq!(plan.step_expert_ids.len(), 2);
        assert_eq!(plan.tasks.len(), 2);
    }

    #[test]
    fn derives_followup_execution_round_plan() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "补一行文案".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            max_step_retry: Some(2),
        });
        let plan = get_current_followup_execution_round_plan(&state);
        assert!(plan.has_pending_followups);
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(plan.tasks[0].expert_id, "jiang-yumo");
    }

    #[test]
    fn applies_pipeline_round_outcomes_in_order() {
        let state = init_pipeline_session(&PipelineSessionInitRequest {
            pipeline_id: "pipeline-1".to_string(),
            scene: "code-development".to_string(),
            task_description: "修复界面".to_string(),
            steps: vec![PipelineStepLayout {
                expert_ids: vec!["jiang-yumo".to_string()],
                optional: Some(false),
            }],
            blackboard: sample_blackboard(),
            pending_followups: vec![PipelineFollowup {
                id: "f1".to_string(),
                message: "补一行文案".to_string(),
                target_expert_ids: vec!["jiang-yumo".to_string()],
                delivery_mode: "current-step".to_string(),
                consumed_by: vec![],
                created_at: 1,
            }],
            max_step_retry: Some(2),
        });
        let next = apply_pipeline_round_outcomes(
            &state,
            &PipelineRoundOutcomeBatch {
                current_tasks: vec![PipelineTaskOutcome {
                    id: "task-1".to_string(),
                    expert_id: "jiang-yumo".to_string(),
                    expert_name: "江予墨".to_string(),
                    expert_title: "前端工程师".to_string(),
                    dispatch_wave: Some(1),
                    output: Some("[ACTION:EDIT_FILE path=\"app.js\"]".to_string()),
                    error: None,
                    followup_ids: vec![],
                }],
                followup_tasks: vec![PipelineTaskOutcome {
                    id: "task-2".to_string(),
                    expert_id: "jiang-yumo".to_string(),
                    expert_name: "江予墨".to_string(),
                    expert_title: "前端工程师".to_string(),
                    dispatch_wave: Some(1),
                    output: Some("已补充 followup".to_string()),
                    error: None,
                    followup_ids: vec!["f1".to_string()],
                }],
            },
        );
        assert_eq!(next.completed_results.len(), 1);
        assert_eq!(next.task_history.len(), 2);
        assert_eq!(
            next.pending_followups[0].consumed_by,
            vec!["jiang-yumo".to_string()]
        );
    }
}
