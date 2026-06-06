use crate::expert_identity::normalize_expert_id;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelinePlanInput {
    pub scene: String,
    pub task_description: String,
    pub expert_ids: Vec<String>,
    pub requires_design: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStepLayout {
    pub expert_ids: Vec<String>,
    pub optional: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DispatchWaveLayout {
    pub wave: usize,
    pub expert_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineLayout {
    pub scene: String,
    pub description: String,
    pub steps: Vec<PipelineStepLayout>,
    pub waves: Vec<DispatchWaveLayout>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineExpertInfo {
    pub id: String,
    pub name: String,
    pub title: String,
}

const RESEARCH_IDS: &[&str] = &[
    "discipline-110", "discipline-120", "discipline-130", "discipline-140", "discipline-150",
    "discipline-160", "discipline-170", "discipline-180", "discipline-190", "discipline-210",
    "discipline-220", "discipline-230", "discipline-240", "discipline-310", "discipline-320",
    "discipline-330", "discipline-340", "discipline-350", "discipline-360", "discipline-630",
    "discipline-710", "discipline-720", "discipline-730", "discipline-740", "discipline-750",
    "discipline-770", "discipline-780", "discipline-790", "discipline-810", "discipline-830",
    "discipline-840", "discipline-850", "discipline-860", "discipline-870", "discipline-880",
    "discipline-890", "discipline-910",
];
const DESIGN_IDS: &[&str] = &["discipline-760"];
const ENGINEER_IDS: &[&str] = &[
    "discipline-410", "discipline-413", "discipline-416", "discipline-420", "discipline-430",
    "discipline-440", "discipline-450", "discipline-460", "discipline-470", "discipline-480",
    "discipline-490", "discipline-510", "discipline-520", "discipline-530", "discipline-535",
    "discipline-540", "discipline-550", "discipline-560", "discipline-570", "discipline-580",
    "discipline-590", "discipline-610",
];
const REVIEW_IDS: &[&str] = &["discipline-620", "discipline-820"];

fn is_research_expert(expert_id: &str) -> bool {
    let expert_id = normalize_expert_id(expert_id);
    RESEARCH_IDS.contains(&expert_id.as_ref())
}

fn is_design_expert(expert_id: &str) -> bool {
    let expert_id = normalize_expert_id(expert_id);
    DESIGN_IDS.contains(&expert_id.as_ref())
}

fn is_engineering_expert(expert_id: &str) -> bool {
    let expert_id = normalize_expert_id(expert_id);
    ENGINEER_IDS.contains(&expert_id.as_ref())
}

fn is_review_expert(expert_id: &str) -> bool {
    let expert_id = normalize_expert_id(expert_id);
    REVIEW_IDS.contains(&expert_id.as_ref())
}

fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    let mut deduped = Vec::new();
    for id in ids {
        let trimmed = id.trim();
        let normalized = normalize_expert_id(trimmed);
        if normalized.is_empty() || seen.iter().any(|item| item == normalized.as_ref()) {
            continue;
        }
        seen.push(normalized.to_string());
        deduped.push(normalized.to_string());
    }
    deduped
}

fn expert_label(expert_id: &str, experts: &[PipelineExpertInfo]) -> String {
    experts
        .iter()
        .find(|expert| expert.id == expert_id)
        .map(|expert| format!("{}（{}）", expert.name, expert.title))
        .unwrap_or_else(|| expert_id.to_string())
}

fn build_code_development_steps(
    expert_ids: &[String],
    requires_design: Option<bool>,
) -> Vec<PipelineStepLayout> {
    let expert_ids = dedupe(expert_ids.to_vec());
    if expert_ids.is_empty() {
        return vec![];
    }

    let mut steps = Vec::new();
    let research_ids = expert_ids
        .iter()
        .filter(|id| is_research_expert(id))
        .cloned()
        .collect::<Vec<_>>();
    let design_ids = expert_ids
        .iter()
        .filter(|id| is_design_expert(id))
        .cloned()
        .collect::<Vec<_>>();
    let has_research = !research_ids.is_empty();
    let has_design = !design_ids.is_empty() && requires_design.unwrap_or(true);

    if has_research {
        steps.push(PipelineStepLayout {
            expert_ids: research_ids,
            optional: None,
        });
    }

    if has_design {
        steps.push(PipelineStepLayout {
            expert_ids: design_ids,
            optional: None,
        });
    }

    let implementation_ids = expert_ids
        .iter()
        .filter(|id| is_engineering_expert(id))
        .cloned()
        .collect::<Vec<_>>();
    let miscellaneous_ids = expert_ids
        .iter()
        .filter(|id| {
            let value = id.as_str();
            !is_research_expert(value)
                && !is_design_expert(value)
                && !is_engineering_expert(value)
                && !is_review_expert(value)
        })
        .cloned()
        .collect::<Vec<_>>();
    let implementation_step = dedupe([implementation_ids, miscellaneous_ids].concat());
    if !implementation_step.is_empty() {
        steps.push(PipelineStepLayout {
            expert_ids: implementation_step,
            optional: None,
        });
    }

    let review_step = expert_ids
        .iter()
        .filter(|id| is_review_expert(id))
        .cloned()
        .collect::<Vec<_>>();
    if !review_step.is_empty() {
        steps.push(PipelineStepLayout {
            expert_ids: review_step,
            optional: None,
        });
    }

    if steps.is_empty() {
        vec![PipelineStepLayout {
            expert_ids,
            optional: None,
        }]
    } else {
        steps
    }
}

fn build_disciplinary_analysis_steps(expert_ids: &[String]) -> Vec<PipelineStepLayout> {
    let expert_ids = dedupe(expert_ids.to_vec());
    if expert_ids.is_empty() {
        return vec![];
    }
    if expert_ids.len() == 1 {
        return vec![PipelineStepLayout {
            expert_ids,
            optional: None,
        }];
    }

    let lead = expert_ids[0].clone();
    let support_ids = expert_ids
        .iter()
        .skip(1)
        .filter(|id| !is_review_expert(id))
        .cloned()
        .collect::<Vec<_>>();
    let review_ids = expert_ids
        .iter()
        .skip(1)
        .filter(|id| is_review_expert(id))
        .cloned()
        .collect::<Vec<_>>();

    let mut steps = vec![PipelineStepLayout {
        expert_ids: vec![lead],
        optional: None,
    }];
    if !support_ids.is_empty() {
        steps.push(PipelineStepLayout {
            expert_ids: support_ids,
            optional: None,
        });
    }
    if !review_ids.is_empty() {
        steps.push(PipelineStepLayout {
            expert_ids: review_ids,
            optional: None,
        });
    }
    steps
}

fn build_research_steps(expert_ids: &[String], search_heavy: bool) -> Vec<PipelineStepLayout> {
    let expert_ids = dedupe(expert_ids.to_vec());
    if expert_ids.is_empty() {
        return vec![];
    }
    if expert_ids.len() == 1 {
        return vec![PipelineStepLayout {
            expert_ids,
            optional: None,
        }];
    }

    let lead = expert_ids[0].clone();
    let support_ids = expert_ids
        .iter()
        .skip(1)
        .filter(|id| !is_review_expert(id))
        .cloned()
        .collect::<Vec<_>>();
    let review_ids = expert_ids
        .iter()
        .skip(1)
        .filter(|id| is_review_expert(id))
        .cloned()
        .collect::<Vec<_>>();

    let mut steps = vec![PipelineStepLayout {
        expert_ids: vec![lead],
        optional: None,
    }];
    if !support_ids.is_empty() {
        steps.push(PipelineStepLayout {
            expert_ids: support_ids,
            optional: Some(search_heavy),
        });
    }
    if !review_ids.is_empty() {
        steps.push(PipelineStepLayout {
            expert_ids: review_ids,
            optional: Some(true),
        });
    }
    steps
}

fn build_generic_steps(expert_ids: &[String]) -> Vec<PipelineStepLayout> {
    let expert_ids = dedupe(expert_ids.to_vec());
    if expert_ids.is_empty() {
        return vec![];
    }
    vec![PipelineStepLayout {
        expert_ids,
        optional: None,
    }]
}

fn build_layout_description(scene: &str, steps: &[PipelineStepLayout]) -> String {
    if steps.is_empty() {
        return String::new();
    }
    if steps.len() == 1 && steps[0].expert_ids.len() == 1 {
        return "单专家直接处理".to_string();
    }
    match scene {
        "code-development" => {
            let mut phases = Vec::new();
            if steps.iter().any(|step| step.expert_ids.iter().any(|id| is_research_expert(id))) {
                phases.push("先快速摸清现状");
            }
            if steps.iter().any(|step| step.expert_ids.iter().any(|id| is_design_expert(id))) {
                phases.push("补必要方案");
            }
            if steps.iter().any(|step| {
                step.expert_ids
                    .iter()
                    .any(|id| is_engineering_expert(id))
            }) {
                phases.push("由主力专家直接修改");
            }
            if steps.iter().any(|step| {
                step.expert_ids
                    .iter()
                    .any(|id| is_review_expert(id))
            }) {
                phases.push("最后按需复核");
            }
            if phases.is_empty() {
                "按需邀请专家协作处理".to_string()
            } else {
                phases.join("，")
            }
        }
        "code-review" => "按需邀请审查专家协作复核".to_string(),
        "disciplinary-analysis" => {
            if steps.len() <= 1 {
                "由主学科专家直接分析判断".to_string()
            } else if steps.len() == 2 {
                "先由主学科专家定主判断，再补辅助学科交叉论证".to_string()
            } else {
                "先由主学科专家定主判断，再补辅助学科交叉论证，最后做风险复核".to_string()
            }
        }
        "technical-research" => {
            if steps.len() <= 1 {
                "由主学科专家直接完成技术调研".to_string()
            } else if steps.len() == 2 {
                "先由主学科专家摸清现状，再补辅助学科交叉调研".to_string()
            } else {
                "先由主学科专家摸清现状，再补辅助学科交叉调研，最后做风险复核".to_string()
            }
        }
        "research-with-search" => {
            if steps.len() <= 1 {
                "由主学科专家直接联网调研".to_string()
            } else if steps.len() == 2 {
                "先由主学科专家联网摸清现状，再补辅助学科交叉调研".to_string()
            } else {
                "先由主学科专家联网摸清现状，再补辅助学科交叉调研，最后做风险复核".to_string()
            }
        }
        _ => "按需邀请专家协作处理".to_string(),
    }
}

pub fn compute_pipeline_layout(plan: &PipelinePlanInput) -> PipelineLayout {
    let steps = match plan.scene.as_str() {
        "code-development" => build_code_development_steps(&plan.expert_ids, plan.requires_design),
        "disciplinary-analysis" => build_disciplinary_analysis_steps(&plan.expert_ids),
        "technical-research" => build_research_steps(&plan.expert_ids, false),
        "research-with-search" => build_research_steps(&plan.expert_ids, true),
        _ => build_generic_steps(&plan.expert_ids),
    };

    let waves = steps
        .iter()
        .enumerate()
        .map(|(index, step)| DispatchWaveLayout {
            wave: index + 1,
            expert_ids: step.expert_ids.clone(),
        })
        .collect::<Vec<_>>();

    PipelineLayout {
        scene: plan.scene.clone(),
        description: build_layout_description(&plan.scene, &steps),
        steps,
        waves,
    }
}

pub fn build_dispatch_narrative(layout: &PipelineLayout, experts: &[PipelineExpertInfo]) -> String {
    if layout.steps.is_empty() {
        return "主管已完成任务拆解，专家准备开始执行。".to_string();
    }

    if layout.steps.len() == 1 {
        let names = layout.steps[0]
            .expert_ids
            .iter()
            .map(|expert_id| expert_label(expert_id, experts))
            .collect::<Vec<_>>()
            .join("、");
        if layout.steps[0].expert_ids.len() <= 1 {
            return format!("我先请 {} 直接处理。", names);
        }
        return format!("我先请 {} 协作处理。", names);
    }

    let step_lines = layout
        .steps
        .iter()
        .map(|step| {
            step.expert_ids
                .iter()
                .map(|expert_id| expert_label(expert_id, experts))
                .collect::<Vec<_>>()
                .join("、")
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!("我会按需要协调这些专家依次协作。\n{}", step_lines)
}

pub fn build_remaining_step_descriptions(
    layout: &PipelineLayout,
    current_idx: usize,
    experts: &[PipelineExpertInfo],
) -> Vec<String> {
    layout
        .steps
        .iter()
        .skip(current_idx + 1)
        .map(|step| {
            step.expert_ids
                .iter()
                .map(|expert_id| expert_label(expert_id, experts))
                .collect::<Vec<_>>()
                .join("、")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        build_dispatch_narrative, build_remaining_step_descriptions, compute_pipeline_layout,
        PipelineExpertInfo, PipelinePlanInput,
    };

    #[test]
    fn expands_code_development_into_minimal_required_stages() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-development".to_string(),
            task_description: "修前端".to_string(),
            expert_ids: vec!["discipline-120".to_string(), "discipline-520".to_string()],
            requires_design: Some(false),
        });
        assert_eq!(layout.steps.len(), 2);
        assert_eq!(layout.steps[0].expert_ids, vec!["discipline-120".to_string()]);
        assert_eq!(layout.steps[1].expert_ids, vec!["discipline-520".to_string()]);
    }

    #[test]
    fn code_development_keeps_analysis_and_documentation_disciplines_out_of_implementation_stage() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-development".to_string(),
            task_description: "先做统计分析和文档梳理，再改主项目实现".to_string(),
            expert_ids: vec![
                "discipline-910".to_string(),
                "discipline-870".to_string(),
                "discipline-520".to_string(),
            ],
            requires_design: Some(false),
        });
        assert_eq!(layout.steps.len(), 2);
        assert_eq!(
            layout.steps[0].expert_ids,
            vec!["discipline-910".to_string(), "discipline-870".to_string()]
        );
        assert_eq!(layout.steps[1].expert_ids, vec!["discipline-520".to_string()]);
    }

    #[test]
    fn groups_review_specialists_into_one_validation_stage() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-development".to_string(),
            task_description: "高风险改动".to_string(),
            expert_ids: vec![
                "discipline-520".to_string(),
                "discipline-620".to_string(),
                "discipline-820".to_string(),
            ],
            requires_design: Some(false),
        });
        assert_eq!(layout.steps.len(), 2);
        assert_eq!(layout.steps[0].expert_ids, vec!["discipline-520".to_string()]);
        assert_eq!(
            layout.steps[1].expert_ids,
            vec!["discipline-620".to_string(), "discipline-820".to_string()]
        );
    }

    #[test]
    fn disciplinary_analysis_prioritizes_primary_expert_then_supporting_experts() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "disciplinary-analysis".to_string(),
            task_description: "从统计和系统科学视角分析调度方案".to_string(),
            expert_ids: vec![
                "discipline-910".to_string(),
                "discipline-120".to_string(),
                "discipline-620".to_string(),
            ],
            requires_design: None,
        });
        assert_eq!(layout.steps.len(), 3);
        assert_eq!(layout.steps[0].expert_ids, vec!["discipline-910".to_string()]);
        assert_eq!(layout.steps[1].expert_ids, vec!["discipline-120".to_string()]);
        assert_eq!(layout.steps[2].expert_ids, vec!["discipline-620".to_string()]);
        assert!(layout.description.contains("主学科专家"));
    }

    #[test]
    fn technical_research_prioritizes_primary_then_supporting_then_review() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "technical-research".to_string(),
            task_description: "调研多专家系统的调度架构".to_string(),
            expert_ids: vec![
                "discipline-120".to_string(),
                "discipline-910".to_string(),
                "discipline-620".to_string(),
            ],
            requires_design: None,
        });
        assert_eq!(layout.steps.len(), 3);
        assert_eq!(layout.steps[0].expert_ids, vec!["discipline-120".to_string()]);
        assert_eq!(layout.steps[1].expert_ids, vec!["discipline-910".to_string()]);
        assert_eq!(layout.steps[1].optional, Some(false));
        assert_eq!(layout.steps[2].expert_ids, vec!["discipline-620".to_string()]);
        assert_eq!(layout.steps[2].optional, Some(true));
        assert!(layout.description.contains("主学科专家"));
    }

    #[test]
    fn research_with_search_keeps_same_order_and_marks_support_optional() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "research-with-search".to_string(),
            task_description: "联网调研这个系统调度架构的最新方案".to_string(),
            expert_ids: vec![
                "discipline-120".to_string(),
                "discipline-630".to_string(),
                "discipline-820".to_string(),
            ],
            requires_design: None,
        });
        assert_eq!(layout.steps.len(), 3);
        assert_eq!(layout.steps[0].expert_ids, vec!["discipline-120".to_string()]);
        assert_eq!(layout.steps[1].expert_ids, vec!["discipline-630".to_string()]);
        assert_eq!(layout.steps[1].optional, Some(true));
        assert_eq!(layout.steps[2].expert_ids, vec!["discipline-820".to_string()]);
        assert_eq!(layout.steps[2].optional, Some(true));
        assert!(layout.description.contains("联网"));
    }

    #[test]
    fn returns_empty_layout_for_unknown_scene() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "unknown".to_string(),
            task_description: "test".to_string(),
            expert_ids: vec![],
            requires_design: None,
        });
        assert!(layout.steps.is_empty());
        assert!(layout.waves.is_empty());
    }

    #[test]
    fn builds_dispatch_narrative_and_remaining_steps() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-review".to_string(),
            task_description: "审代码".to_string(),
            expert_ids: vec![
                "discipline-620".to_string(),
                "discipline-820".to_string(),
            ],
            requires_design: None,
        });
        let experts = vec![
            PipelineExpertInfo {
                id: "discipline-620".to_string(),
                name: "620 安全科学技术".to_string(),
                title: "一级学科专家".to_string(),
            },
            PipelineExpertInfo {
                id: "discipline-820".to_string(),
                name: "820 法学".to_string(),
                title: "一级学科专家".to_string(),
            },
        ];
        let narrative = build_dispatch_narrative(&layout, &experts);
        assert!(narrative.contains("协作处理"));
        let remaining = build_remaining_step_descriptions(&layout, 0, &experts);
        assert!(remaining.is_empty());
    }
}
