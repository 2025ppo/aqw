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

const RESEARCHER_ID: &str = "jiang-ruoxi";
const DESIGNER_ID: &str = "jiang-dingchu";
const ENGINEER_IDS: &[&str] = &["jiang-qinglan", "jiang-yumo", "jiang-subai"];
const REVIEW_IDS: &[&str] = &["jiang-jianheng", "jiang-cexun", "jiang-yingqiu"];

fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    let mut deduped = Vec::new();
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() || seen.iter().any(|item| item == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
        deduped.push(trimmed.to_string());
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
    let has_research = expert_ids.iter().any(|id| id == RESEARCHER_ID);
    let has_design = expert_ids.iter().any(|id| id == DESIGNER_ID) && requires_design.unwrap_or(true);

    if has_research {
        steps.push(PipelineStepLayout {
            expert_ids: vec![RESEARCHER_ID.to_string()],
            optional: None,
        });
    }

    if has_design {
        steps.push(PipelineStepLayout {
            expert_ids: vec![DESIGNER_ID.to_string()],
            optional: None,
        });
    }

    let implementation_ids = expert_ids
        .iter()
        .filter(|id| ENGINEER_IDS.contains(&id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let miscellaneous_ids = expert_ids
        .iter()
        .filter(|id| {
            let value = id.as_str();
            value != RESEARCHER_ID
                && value != DESIGNER_ID
                && !ENGINEER_IDS.contains(&value)
                && !REVIEW_IDS.contains(&value)
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
        .filter(|id| REVIEW_IDS.contains(&id.as_str()))
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
            if steps.iter().any(|step| step.expert_ids.iter().any(|id| id == RESEARCHER_ID)) {
                phases.push("先快速摸清现状");
            }
            if steps.iter().any(|step| step.expert_ids.iter().any(|id| id == DESIGNER_ID)) {
                phases.push("补必要方案");
            }
            if steps.iter().any(|step| {
                step.expert_ids
                    .iter()
                    .any(|id| ENGINEER_IDS.contains(&id.as_str()))
            }) {
                phases.push("由主力专家直接修改");
            }
            if steps.iter().any(|step| {
                step.expert_ids
                    .iter()
                    .any(|id| REVIEW_IDS.contains(&id.as_str()))
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
        _ => "按需邀请专家协作处理".to_string(),
    }
}

pub fn compute_pipeline_layout(plan: &PipelinePlanInput) -> PipelineLayout {
    let steps = match plan.scene.as_str() {
        "code-development" => build_code_development_steps(&plan.expert_ids, plan.requires_design),
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
            expert_ids: vec!["jiang-ruoxi".to_string(), "jiang-yumo".to_string()],
            requires_design: Some(false),
        });
        assert_eq!(layout.steps.len(), 2);
        assert_eq!(layout.steps[0].expert_ids, vec!["jiang-ruoxi".to_string()]);
        assert_eq!(layout.steps[1].expert_ids, vec!["jiang-yumo".to_string()]);
    }

    #[test]
    fn groups_review_specialists_into_one_validation_stage() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-development".to_string(),
            task_description: "高风险改动".to_string(),
            expert_ids: vec![
                "jiang-yumo".to_string(),
                "jiang-jianheng".to_string(),
                "jiang-cexun".to_string(),
            ],
            requires_design: Some(false),
        });
        assert_eq!(layout.steps.len(), 2);
        assert_eq!(layout.steps[0].expert_ids, vec!["jiang-yumo".to_string()]);
        assert_eq!(
            layout.steps[1].expert_ids,
            vec!["jiang-jianheng".to_string(), "jiang-cexun".to_string()]
        );
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
                "jiang-jianheng".to_string(),
                "jiang-cexun".to_string(),
                "jiang-yingqiu".to_string(),
            ],
            requires_design: None,
        });
        let experts = vec![
            PipelineExpertInfo {
                id: "jiang-jianheng".to_string(),
                name: "江鉴衡".to_string(),
                title: "质量审核".to_string(),
            },
            PipelineExpertInfo {
                id: "jiang-cexun".to_string(),
                name: "江测巡".to_string(),
                title: "测试专家".to_string(),
            },
            PipelineExpertInfo {
                id: "jiang-yingqiu".to_string(),
                name: "江映秋".to_string(),
                title: "审查员".to_string(),
            },
        ];
        let narrative = build_dispatch_narrative(&layout, &experts);
        assert!(narrative.contains("协作处理"));
        let remaining = build_remaining_step_descriptions(&layout, 0, &experts);
        assert!(remaining.is_empty());
    }
}
