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

#[derive(Clone, Debug)]
struct PipelineDefinition {
    scene: &'static str,
    description: &'static str,
    steps: &'static [PipelineStepTemplate],
}

#[derive(Clone, Debug)]
struct PipelineStepTemplate {
    expert_ids: &'static [&'static str],
    optional: bool,
}

const PIPELINES: &[PipelineDefinition] = &[
    PipelineDefinition {
        scene: "code-development",
        description: "完整开发流程：调研 -> 设计（可选） -> 开发 -> 质量审核 -> 命令测试 -> 审查",
        steps: &[
            PipelineStepTemplate {
                expert_ids: &["jiang-ruoxi"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-dingchu"],
                optional: true,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-qinglan"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-jianheng"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-cexun"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-yingqiu"],
                optional: false,
            },
        ],
    },
    PipelineDefinition {
        scene: "code-review",
        description: "代码审查：质量审核 -> 命令测试 -> 审查结论",
        steps: &[
            PipelineStepTemplate {
                expert_ids: &["jiang-jianheng"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-cexun"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-yingqiu"],
                optional: false,
            },
        ],
    },
    PipelineDefinition {
        scene: "technical-research",
        description: "技术调研：调研员独立执行",
        steps: &[PipelineStepTemplate {
            expert_ids: &["jiang-ruoxi"],
            optional: false,
        }],
    },
    PipelineDefinition {
        scene: "design",
        description: "设计方案：调研 -> 设计",
        steps: &[
            PipelineStepTemplate {
                expert_ids: &["jiang-ruoxi"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-dingchu"],
                optional: false,
            },
        ],
    },
    PipelineDefinition {
        scene: "translation",
        description: "多语言翻译任务",
        steps: &[PipelineStepTemplate {
            expert_ids: &["jiang-lingyu"],
            optional: false,
        }],
    },
    PipelineDefinition {
        scene: "writing",
        description: "创意写作、文案策划、报告撰写",
        steps: &[
            PipelineStepTemplate {
                expert_ids: &["jiang-ruoxi"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-moxian"],
                optional: false,
            },
        ],
    },
    PipelineDefinition {
        scene: "office",
        description: "邮件、会议纪要、日程等办公事务",
        steps: &[PipelineStepTemplate {
            expert_ids: &["jiang-wenshu"],
            optional: false,
        }],
    },
    PipelineDefinition {
        scene: "data-analysis",
        description: "数据分析、可视化和报告生成",
        steps: &[
            PipelineStepTemplate {
                expert_ids: &["jiang-ruoxi"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-shuyan"],
                optional: false,
            },
        ],
    },
    PipelineDefinition {
        scene: "document-processing",
        description: "文档读取、转换和生成",
        steps: &[PipelineStepTemplate {
            expert_ids: &["jiang-zhilan"],
            optional: false,
        }],
    },
    PipelineDefinition {
        scene: "media-creation",
        description: "图像生成/编辑、视频处理、音频处理",
        steps: &[PipelineStepTemplate {
            expert_ids: &["jiang-huaying"],
            optional: false,
        }],
    },
    PipelineDefinition {
        scene: "video-production",
        description: "视频创作：调研 -> 镜头分段 -> 生成 -> 拼接",
        steps: &[
            PipelineStepTemplate {
                expert_ids: &["jiang-ruoxi"],
                optional: false,
            },
            PipelineStepTemplate {
                expert_ids: &["jiang-huaying"],
                optional: false,
            },
        ],
    },
    PipelineDefinition {
        scene: "research-with-search",
        description: "需要网络搜索的深度调研",
        steps: &[PipelineStepTemplate {
            expert_ids: &["jiang-ruoxi"],
            optional: false,
        }],
    },
];

pub fn compute_pipeline_layout(plan: &PipelinePlanInput) -> PipelineLayout {
    let pipeline = PIPELINES
        .iter()
        .find(|pipeline| pipeline.scene == plan.scene)
        .cloned();

    let Some(pipeline) = pipeline else {
        return PipelineLayout {
            scene: plan.scene.clone(),
            description: String::new(),
            steps: vec![],
            waves: vec![],
        };
    };

    let steps = pipeline
        .steps
        .iter()
        .filter_map(|step| {
            if step.optional && plan.scene == "code-development" && !plan.requires_design.unwrap_or(false) {
                return None;
            }
            let mut expert_ids = step.expert_ids.iter().map(|id| (*id).to_string()).collect::<Vec<_>>();
            if plan.scene == "code-development" && step.expert_ids.contains(&"jiang-qinglan") {
                let plan_engineers = plan
                    .expert_ids
                    .iter()
                    .filter(|id| ["jiang-qinglan", "jiang-yumo", "jiang-subai"].contains(&id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                if !plan_engineers.is_empty() {
                    expert_ids = plan_engineers;
                }
            }
            Some(PipelineStepLayout {
                expert_ids,
                optional: if step.optional { Some(true) } else { None },
            })
        })
        .collect::<Vec<_>>();

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
        description: pipeline.description.to_string(),
        steps,
        waves,
    }
}

pub fn build_dispatch_narrative(layout: &PipelineLayout, experts: &[PipelineExpertInfo]) -> String {
    if layout.waves.is_empty() {
        return "主管已完成任务拆解，专家准备开始执行。".to_string();
    }
    let wave_text = layout
        .waves
        .iter()
        .map(|wave| {
            let names = wave
                .expert_ids
                .iter()
                .map(|expert_id| {
                    experts
                        .iter()
                        .find(|expert| &expert.id == expert_id)
                        .map(|expert| format!("{}（{}）", expert.name, expert.title))
                        .unwrap_or_else(|| expert_id.clone())
                })
                .collect::<Vec<_>>()
                .join("、");
            let mode = if wave.expert_ids.len() > 1 { "并行" } else { "串行" };
            format!("第{}轮{}：{}", wave.wave, mode, names)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("主管已发起专家协作。\n{}", wave_text)
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
                .map(|expert_id| {
                    experts
                        .iter()
                        .find(|expert| &expert.id == expert_id)
                        .map(|expert| format!("{}（{}）", expert.name, expert.title))
                        .unwrap_or_else(|| expert_id.clone())
                })
                .collect::<Vec<_>>()
                .join(" + ")
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
    fn expands_code_development_pipeline_with_selected_engineer() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-development".to_string(),
            task_description: "修前端".to_string(),
            expert_ids: vec!["jiang-ruoxi".to_string(), "jiang-yumo".to_string()],
            requires_design: Some(false),
        });
        assert_eq!(layout.steps.len(), 5);
        assert_eq!(layout.steps[1].expert_ids, vec!["jiang-yumo".to_string()]);
        assert_eq!(layout.waves.len(), 5);
    }

    #[test]
    fn keeps_optional_design_step_when_required() {
        let layout = compute_pipeline_layout(&PipelinePlanInput {
            scene: "code-development".to_string(),
            task_description: "做完整方案".to_string(),
            expert_ids: vec!["jiang-ruoxi".to_string(), "jiang-qinglan".to_string()],
            requires_design: Some(true),
        });
        assert_eq!(layout.steps.len(), 6);
        assert_eq!(layout.steps[1].expert_ids, vec!["jiang-dingchu".to_string()]);
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
            expert_ids: vec![],
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
        assert!(narrative.contains("第1轮串行"));
        let remaining = build_remaining_step_descriptions(&layout, 0, &experts);
        assert_eq!(remaining.len(), 2);
        assert!(remaining[0].contains("江测巡"));
    }
}
