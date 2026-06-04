// ========== 五维经验沉淀系统 ==========
// Memory / Skill / Strategy / Validation / Workflow

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---- 数据结构 ----

/// 五维经验沉淀
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experience沉淀 {
    pub expert_id: String,
    pub expert_name: String,
    pub updated_at: String,
    pub dimensions: ExperienceDimensions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceDimensions {
    pub memory: MemoryExperience,         // 记忆沉淀
    pub skill: SkillExperience,           // 技能沉淀
    pub strategy: StrategyExperience,     // 策略沉淀
    pub validation: ValidationExperience, // 验证沉淀
    pub workflow: WorkflowExperience,     // 工作流沉淀
}

// 1. 记忆沉淀：专家在特定项目中的上下文记忆
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExperience {
    pub project_memories: Vec<ProjectMemory>,
    pub total_memories: usize,
    pub most_active_project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMemory {
    pub project_name: String,
    pub memory_count: usize,
    pub last_accessed: String,
    pub key_topics: Vec<String>,
}

// 2. 技能沉淀：专家擅长的技术领域
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillExperience {
    pub skills: Vec<SkillItem>,
    pub top_skill: Option<String>,
    pub skill_diversity_score: u8, // 0-100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillItem {
    pub name: String,
    pub category: String, // "language" | "framework" | "tool" | "domain"
    pub proficiency: u8,  // 0-100
    pub evidence_count: usize,
}

// 3. 策略沉淀：专家解决问题的策略模式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyExperience {
    pub patterns: Vec<StrategyPattern>,
    pub preferred_approach: Option<String>,
    pub adaptation_score: u8, // 0-100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyPattern {
    pub name: String,
    pub description: String,
    pub usage_count: usize,
    pub success_rate: f32,
}

// 4. 验证沉淀：专家的审查和验证记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationExperience {
    pub total_reviews: usize,
    pub issues_found: usize,
    pub critical_issues: usize,
    pub avg_review_depth: u8, // 0-100
    pub accuracy_score: u8,   // 0-100
}

// 5. 工作流沉淀：专家参与的工作流优化
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowExperience {
    pub pipelines_participated: Vec<String>,
    pub optimizations_suggested: Vec<String>,
    pub efficiency_score: u8, // 0-100
}

// ---- 经验沉淀生成 ----

/// 从专家任务历史生成经验沉淀
pub fn generate_experience_沉淀(
    expert_id: &str,
    expert_name: &str,
    task_history: &[TaskRecord],
    memory_records: &[MemoryRecord],
) -> Experience沉淀 {
    Experience沉淀 {
        expert_id: expert_id.to_string(),
        expert_name: expert_name.to_string(),
        updated_at: chrono::Local::now().to_rfc3339(),
        dimensions: ExperienceDimensions {
            memory: extract_memory_experience(expert_id, memory_records),
            skill: extract_skill_experience(task_history),
            strategy: extract_strategy_experience(task_history),
            validation: extract_validation_experience(task_history),
            workflow: extract_workflow_experience(task_history),
        },
    }
}

// ---- 各维度提取逻辑 ----

fn extract_memory_experience(expert_id: &str, records: &[MemoryRecord]) -> MemoryExperience {
    let mut project_map: HashMap<String, Vec<&MemoryRecord>> = HashMap::new();

    for r in records.iter().filter(|r| r.expert_id == expert_id) {
        project_map
            .entry(r.project_name.clone())
            .or_default()
            .push(r);
    }

    let project_memories: Vec<ProjectMemory> = project_map
        .iter()
        .map(|(name, recs)| {
            let topics =
                extract_key_topics(&recs.iter().map(|r| r.content.as_str()).collect::<Vec<_>>());
            ProjectMemory {
                project_name: name.clone(),
                memory_count: recs.len(),
                last_accessed: recs
                    .last()
                    .map(|r| r.created_at.clone())
                    .unwrap_or_default(),
                key_topics: topics,
            }
        })
        .collect();

    let most_active = project_memories
        .iter()
        .max_by_key(|p| p.memory_count)
        .map(|p| p.project_name.clone());

    MemoryExperience {
        total_memories: records.iter().filter(|r| r.expert_id == expert_id).count(),
        project_memories,
        most_active_project: most_active,
    }
}

fn extract_skill_experience(tasks: &[TaskRecord]) -> SkillExperience {
    let mut skill_map: HashMap<String, (String, usize)> = HashMap::new();

    for task in tasks {
        let detected = detect_skills(&task.output);
        for (name, category) in detected {
            let entry = skill_map.entry(name).or_insert((category, 0));
            entry.1 += 1;
        }
    }

    let mut skills: Vec<SkillItem> = skill_map
        .into_iter()
        .map(|(name, (category, count))| SkillItem {
            name,
            category,
            proficiency: (count * 5).min(100) as u8,
            evidence_count: count,
        })
        .collect();

    skills.sort_by(|a, b| b.proficiency.cmp(&a.proficiency));

    let top_skill = skills.first().map(|s| s.name.clone());
    let diversity = (skills.len() * 10).min(100) as u8;

    SkillExperience {
        skills,
        top_skill,
        skill_diversity_score: diversity,
    }
}

fn extract_strategy_experience(tasks: &[TaskRecord]) -> StrategyExperience {
    let mut patterns = vec![
        StrategyPattern {
            name: "渐进式实现".to_string(),
            description: "分步骤实现功能，逐步验证".to_string(),
            usage_count: 0,
            success_rate: 0.0,
        },
        StrategyPattern {
            name: "重构优先".to_string(),
            description: "先清理现有代码再添加新功能".to_string(),
            usage_count: 0,
            success_rate: 0.0,
        },
        StrategyPattern {
            name: "测试驱动".to_string(),
            description: "先写测试再实现功能".to_string(),
            usage_count: 0,
            success_rate: 0.0,
        },
    ];

    for task in tasks {
        let output_lower = task.output.to_lowercase();
        if output_lower.contains("step") || output_lower.contains("逐步") {
            patterns[0].usage_count += 1;
        }
        if output_lower.contains("refactor") || output_lower.contains("重构") {
            patterns[1].usage_count += 1;
        }
        if output_lower.contains("test") || output_lower.contains("测试") {
            patterns[2].usage_count += 1;
        }
    }

    let total = tasks.len().max(1);
    for p in &mut patterns {
        p.success_rate = p.usage_count as f32 / total as f32;
    }

    patterns.sort_by(|a, b| b.usage_count.cmp(&a.usage_count));

    let preferred = patterns.first().and_then(|p| {
        if p.usage_count > 0 {
            Some(p.name.clone())
        } else {
            None
        }
    });

    StrategyExperience {
        patterns,
        preferred_approach: preferred,
        adaptation_score: 50,
    }
}

fn extract_validation_experience(tasks: &[TaskRecord]) -> ValidationExperience {
    let review_tasks: Vec<&TaskRecord> = tasks
        .iter()
        .filter(|t| t.expert_id.contains("mingxuan") || t.task_type == "review")
        .collect();

    let total_reviews = review_tasks.len();
    let mut issues_found = 0;
    let mut critical_issues = 0;

    for task in &review_tasks {
        let output = &task.output;
        issues_found += output.matches("问题").count() + output.matches("issue").count();
        critical_issues += output.matches("严重").count() + output.matches("critical").count();
    }

    ValidationExperience {
        total_reviews,
        issues_found,
        critical_issues,
        avg_review_depth: if total_reviews > 0 { 70 } else { 0 },
        accuracy_score: if total_reviews > 0 { 75 } else { 0 },
    }
}

fn extract_workflow_experience(tasks: &[TaskRecord]) -> WorkflowExperience {
    let pipelines: Vec<String> = tasks
        .iter()
        .filter_map(|t| t.pipeline_id.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    WorkflowExperience {
        pipelines_participated: pipelines,
        optimizations_suggested: vec![],
        efficiency_score: 60,
    }
}

// ---- 辅助函数 ----

fn extract_key_topics(contents: &[&str]) -> Vec<String> {
    let mut topics: Vec<String> = Vec::new();
    let keywords = [
        ("React", "前端框架"),
        ("Vue", "前端框架"),
        ("Angular", "前端框架"),
        ("Rust", "系统语言"),
        ("Go", "系统语言"),
        ("Python", "脚本语言"),
        ("TypeScript", "脚本语言"),
        ("Java", "企业语言"),
        ("API", "接口设计"),
        ("Database", "数据存储"),
        ("SQL", "数据存储"),
        ("Docker", "部署"),
        ("Kubernetes", "部署"),
        ("Test", "测试"),
        ("Security", "安全"),
    ];

    for content in contents {
        let lower = content.to_lowercase();
        for (kw, topic) in &keywords {
            if lower.contains(&kw.to_lowercase()) && !topics.contains(&topic.to_string()) {
                topics.push(topic.to_string());
            }
        }
    }

    topics.truncate(5);
    topics
}

fn detect_skills(output: &str) -> Vec<(String, String)> {
    let mut skills = Vec::new();
    let patterns = [
        ("rust", "language", "Rust"),
        ("typescript", "language", "TypeScript"),
        ("javascript", "language", "JavaScript"),
        ("python", "language", "Python"),
        ("go", "language", "Go"),
        ("java", "language", "Java"),
        ("react", "framework", "React"),
        ("vue", "framework", "Vue"),
        ("tauri", "framework", "Tauri"),
        ("docker", "tool", "Docker"),
        ("git", "tool", "Git"),
        ("sql", "tool", "SQL"),
        ("frontend", "domain", "前端开发"),
        ("backend", "domain", "后端开发"),
        ("database", "domain", "数据库"),
        ("security", "domain", "安全"),
    ];

    let lower = output.to_lowercase();
    for (pat, category, name) in &patterns {
        if lower.contains(pat) {
            skills.push((name.to_string(), category.to_string()));
        }
    }

    skills
}

// ---- 输入数据结构 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRecord {
    pub expert_id: String,
    pub task_type: String,
    pub output: String,
    pub pipeline_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub expert_id: String,
    pub project_name: String,
    pub content: String,
    pub created_at: String,
}
