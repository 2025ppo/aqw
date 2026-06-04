use crate::expert_postprocess_engine::ExpertPostprocessState;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviousExpertResult {
    pub name: String,
    pub title: String,
    pub output: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartExpertSessionRequest {
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: String,
    pub base_prompt: String,
    pub scene: String,
    pub task_description: String,
    pub previous_results: Vec<PreviousExpertResult>,
    pub api_key: String,
    pub model: String,
    pub project_name: Option<String>,
    pub project_id: Option<i64>,
    pub project_path: Option<String>,
    pub hint_module_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartExpertSessionResponse {
    pub state: ExpertPostprocessState,
    pub prompt_char_count: usize,
    pub module_ids: Vec<String>,
    pub history_hint_module_ids: Vec<String>,
}
