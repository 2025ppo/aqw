use crate::expert_tool_engine::ExpertToolRequest;
use crate::expert_tool_runtime_engine::{
    ExpertToolCommandAuthorization, ExpertToolEventPayload, ExpertToolExecutionRequest,
};
use crate::{DeepSeekMessage, DeepSeekUsage};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertPostprocessProgressEvent {
    pub expert_id: String,
    pub phase: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertPostprocessState {
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub scene: String,
    pub base_prompt: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    pub has_workspace_context: bool,
    pub messages: Vec<DeepSeekMessage>,
    pub reply: String,
    pub usage: Option<DeepSeekUsage>,
    pub tool_round: usize,
    pub max_tool_rounds: usize,
    pub current_tool_requests: Vec<ExpertToolRequest>,
    pub current_tool_index: usize,
    pub current_tool_contexts: Vec<String>,
    pub pending_request: Option<ExpertToolRequest>,
    pub deliverable_attempt: usize,
    pub max_deliverable_attempts: usize,
    pub completed: bool,
    pub learned_module_ids: Vec<String>,
    pub trigger_sources: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertPostprocessRequest {
    pub state: ExpertPostprocessState,
    pub approval_decision: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertPostprocessInitRequest {
    pub state: ExpertPostprocessState,
    pub explicit_hint_module_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertPostprocessResponse {
    pub state: ExpertPostprocessState,
    pub completed: bool,
    pub pending_authorization: Option<ExpertToolCommandAuthorization>,
    pub tool_events: Vec<ExpertToolEventPayload>,
    pub progress_events: Vec<ExpertPostprocessProgressEvent>,
}

impl ExpertPostprocessState {
    pub fn merge_usage(&mut self, next_usage: Option<DeepSeekUsage>) {
        let Some(next_usage) = next_usage else {
            return;
        };
        if let Some(current) = self.usage.as_mut() {
            current.prompt_tokens += next_usage.prompt_tokens;
            current.completion_tokens += next_usage.completion_tokens;
            current.total_tokens += next_usage.total_tokens;
        } else {
            self.usage = Some(next_usage);
        }
    }

    pub fn push_progress(
        &self,
        events: &mut Vec<ExpertPostprocessProgressEvent>,
        phase: &str,
        detail: &str,
    ) {
        events.push(ExpertPostprocessProgressEvent {
            expert_id: self.expert_id.clone(),
            phase: phase.to_string(),
            detail: detail.to_string(),
        });
    }

    pub fn note_tool_kind(&mut self, request: &ExpertToolRequest) {
        match request {
            ExpertToolRequest::WebSearch { .. } => {
                push_unique(&mut self.learned_module_ids, "web-search-guidance");
                push_unique(&mut self.trigger_sources, "web-search");
            }
            ExpertToolRequest::Command { .. } => {
                push_unique(&mut self.learned_module_ids, "command-guidance");
                push_unique(&mut self.trigger_sources, "command");
            }
            _ => {}
        }
    }

    pub fn pending_execution_request(
        &self,
        request: ExpertToolRequest,
        approval_decision: Option<bool>,
    ) -> ExpertToolExecutionRequest {
        ExpertToolExecutionRequest {
            request,
            expert_id: self.expert_id.clone(),
            expert_name: self.expert_name.clone(),
            expert_title: self.expert_title.clone(),
            project_name: self.project_name.clone(),
            project_path: self.project_path.clone(),
            approval_decision,
        }
    }
}

fn push_unique(items: &mut Vec<String>, value: &str) {
    if items.iter().any(|item| item == value) {
        return;
    }
    items.push(value.to_string());
}
