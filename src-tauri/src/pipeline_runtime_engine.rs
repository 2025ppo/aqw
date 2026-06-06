use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRuntimeState {
    pub current_step_index: usize,
    pub total_steps: usize,
    pub max_step_retry: usize,
    pub step_retry_counts: HashMap<usize, usize>,
    pub finished: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRuntimeInitRequest {
    pub total_steps: usize,
    pub max_step_retry: Option<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRuntimeDecisionRequest {
    pub state: PipelineRuntimeState,
    pub action: String,
    pub current_step_expert_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRuntimeTransition {
    pub state: PipelineRuntimeState,
    pub repeated_step: bool,
    pub advanced_steps: usize,
    pub should_stop: bool,
    pub breaker_message: Option<String>,
}

pub fn init_runtime(request: &PipelineRuntimeInitRequest) -> PipelineRuntimeState {
    PipelineRuntimeState {
        current_step_index: 0,
        total_steps: request.total_steps,
        max_step_retry: request.max_step_retry.unwrap_or(2),
        step_retry_counts: HashMap::new(),
        finished: request.total_steps == 0,
    }
}

pub fn apply_decision(request: &PipelineRuntimeDecisionRequest) -> PipelineRuntimeTransition {
    let mut state = request.state.clone();
    if state.finished || state.current_step_index >= state.total_steps {
        state.finished = true;
        return PipelineRuntimeTransition {
            state,
            repeated_step: false,
            advanced_steps: 0,
            should_stop: true,
            breaker_message: None,
        };
    }

    let action = request.action.trim().to_ascii_lowercase();
    match action.as_str() {
        "retry" | "artifact-missing" => {
            let retried = state
                .step_retry_counts
                .entry(state.current_step_index)
                .or_insert(0);
            *retried += 1;
            let retry_count = *retried;
            let exceeded = retry_count > state.max_step_retry;
            let breaker_message = if exceeded && action == "retry" {
                let expert_names = request.current_step_expert_ids.join(",");
                Some(format!(
                    "步骤 {}（{}）已连续重试 {} 次仍未交付，强制推进以避免原地空转。",
                    state.current_step_index + 1,
                    expert_names,
                    state.max_step_retry
                ))
            } else {
                None
            };

            if exceeded {
                if action == "artifact-missing" {
                    state.current_step_index = state.total_steps;
                    state.finished = true;
                    return PipelineRuntimeTransition {
                        state,
                        repeated_step: false,
                        advanced_steps: 0,
                        should_stop: true,
                        breaker_message,
                    };
                }

                state.current_step_index = (state.current_step_index + 1).min(state.total_steps);
                state.finished = state.current_step_index >= state.total_steps;
                let should_stop = state.finished;
                return PipelineRuntimeTransition {
                    state,
                    repeated_step: false,
                    advanced_steps: 1,
                    should_stop,
                    breaker_message,
                };
            }

            PipelineRuntimeTransition {
                state,
                repeated_step: true,
                advanced_steps: 0,
                should_stop: false,
                breaker_message: None,
            }
        }
        "skip-next" => {
            state.current_step_index = (state.current_step_index + 2).min(state.total_steps);
            state.finished = state.current_step_index >= state.total_steps;
            let should_stop = state.finished;
            PipelineRuntimeTransition {
                state,
                repeated_step: false,
                advanced_steps: 2,
                should_stop,
                breaker_message: None,
            }
        }
        "abort" => {
            state.current_step_index = state.total_steps;
            state.finished = true;
            PipelineRuntimeTransition {
                state,
                repeated_step: false,
                advanced_steps: 0,
                should_stop: true,
                breaker_message: None,
            }
        }
        _ => {
            state.current_step_index = (state.current_step_index + 1).min(state.total_steps);
            state.finished = state.current_step_index >= state.total_steps;
            let should_stop = state.finished;
            PipelineRuntimeTransition {
                state,
                repeated_step: false,
                advanced_steps: 1,
                should_stop,
                breaker_message: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_decision, init_runtime, PipelineRuntimeDecisionRequest, PipelineRuntimeInitRequest,
    };

    #[test]
    fn retries_current_step_until_limit() {
        let state = init_runtime(&PipelineRuntimeInitRequest {
            total_steps: 3,
            max_step_retry: Some(2),
        });
        let retried_once = apply_decision(&PipelineRuntimeDecisionRequest {
            state,
            action: "retry".to_string(),
            current_step_expert_ids: vec!["discipline-520".to_string()],
        });
        assert!(retried_once.repeated_step);
        assert_eq!(retried_once.state.current_step_index, 0);
        assert_eq!(retried_once.state.step_retry_counts.get(&0), Some(&1));
    }

    #[test]
    fn retry_over_limit_advances_with_breaker() {
        let state = init_runtime(&PipelineRuntimeInitRequest {
            total_steps: 3,
            max_step_retry: Some(1),
        });
        let retried_once = apply_decision(&PipelineRuntimeDecisionRequest {
            state,
            action: "retry".to_string(),
            current_step_expert_ids: vec!["discipline-520".to_string()],
        });
        let retried_twice = apply_decision(&PipelineRuntimeDecisionRequest {
            state: retried_once.state,
            action: "retry".to_string(),
            current_step_expert_ids: vec!["discipline-520".to_string()],
        });
        assert!(!retried_twice.repeated_step);
        assert_eq!(retried_twice.state.current_step_index, 1);
        assert!(retried_twice.breaker_message.is_some());
    }

    #[test]
    fn artifact_missing_over_limit_stops_pipeline() {
        let state = init_runtime(&PipelineRuntimeInitRequest {
            total_steps: 2,
            max_step_retry: Some(0),
        });
        let transition = apply_decision(&PipelineRuntimeDecisionRequest {
            state,
            action: "artifact-missing".to_string(),
            current_step_expert_ids: vec!["discipline-520".to_string()],
        });
        assert!(transition.should_stop);
        assert!(transition.state.finished);
        assert_eq!(transition.state.current_step_index, 2);
    }
}
