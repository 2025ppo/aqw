use serde::{Deserialize, Serialize};

use crate::{memory, repo_wiki};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviousExpertResult {
    pub expert_id: Option<String>,
    pub name: String,
    pub title: String,
    pub output: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertContextRequest {
    pub project_name: Option<String>,
    pub project_id: Option<i64>,
    pub expert_id: String,
    pub task_description: String,
    pub previous_results: Vec<PreviousExpertResult>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContextMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertContextResponse {
    pub retrieval_context: String,
    pub negative_index: Vec<String>,
    pub messages: Vec<ContextMessage>,
}

fn summarize_tool_text(text: &str, max_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return text.to_string();
    }
    let head_len = ((max_chars as f64) * 0.6).floor() as usize;
    let tail_len = ((max_chars as f64) * 0.25).floor() as usize;
    let head: String = text.chars().take(head_len).collect();
    let tail: String = text
        .chars()
        .rev()
        .take(tail_len)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    format!(
        "{}\n...\n[输出过长，已截断 {} 个字符]\n...\n{}",
        head,
        char_count.saturating_sub(head.chars().count() + tail.chars().count()),
        tail
    )
}

pub fn format_cards_context(cards: &[repo_wiki::KnowledgeCard]) -> String {
    if cards.is_empty() {
        return String::new();
    }
    let lines = cards
        .iter()
        .take(6)
        .map(|card| {
            format!(
                "- [{}] {}: {}",
                card.category,
                card.title,
                summarize_tool_text(card.content.trim(), 220)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n【一级索引 · 仓库知识概览】\n{}\n", lines)
}

pub fn format_memory_context(results: &[memory::MemorySearchResult], title: &str) -> String {
    if results.is_empty() {
        return String::new();
    }
    let lines = results
        .iter()
        .take(3)
        .enumerate()
        .map(|(idx, item)| {
            format!(
                "[历史记忆 {}] {}",
                idx + 1,
                summarize_tool_text(item.entry.content.trim(), 300)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("\n【{}】\n{}\n", title, lines)
}

pub fn build_retrieval_context(
    cards_context: Option<String>,
    vector_context: Option<String>,
    expert_memory_context: Option<String>,
    shared_memory_context: Option<String>,
    negative_index: &[String],
) -> String {
    let mut retrieval_context = String::new();
    if let Some(cards) = cards_context.filter(|value| !value.trim().is_empty()) {
        retrieval_context.push_str(&cards);
    }
    if let Some(vector) = vector_context.filter(|value| !value.trim().is_empty()) {
        retrieval_context.push_str(&format!(
            "\n【二级索引 · 代码定位】\n{}\n",
            summarize_tool_text(vector.trim(), 2400)
        ));
    }
    if let Some(expert_memory) = expert_memory_context.filter(|value| !value.trim().is_empty()) {
        retrieval_context.push_str(&expert_memory);
    }
    if let Some(shared_memory) = shared_memory_context.filter(|value| !value.trim().is_empty()) {
        retrieval_context.push_str(&shared_memory);
    }
    if !negative_index.is_empty() {
        retrieval_context.push_str(&format!(
            "\n【系统认知盲区（负向索引）】\n{}\n注意：以上标注为系统检索的已知局限，相关信息可能不完整或过时，请在执行时自行验证。\n",
            negative_index
                .iter()
                .take(5)
                .map(|item| format!("- {}", item))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    retrieval_context
}

pub fn build_initial_messages(
    previous_results: &[PreviousExpertResult],
    task_description: &str,
    retrieval_context: &str,
) -> Vec<ContextMessage> {
    let mut messages = Vec::new();
    if !previous_results.is_empty() {
        let prev_context = previous_results
            .iter()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|item| {
                format!(
                    "=== {}（{}）的输出摘要 ===\n{}\n",
                    item.name,
                    item.title,
                    summarize_tool_text(item.output.trim(), 1800)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        messages.push(ContextMessage {
            role: "user".to_string(),
            content: format!(
                "以下是前置专家的工作结果，请在此基础上继续你的工作：\n\n{}",
                prev_context
            ),
        });
    }

    let enhanced_task = if retrieval_context.trim().is_empty() {
        task_description.to_string()
    } else {
        format!(
            "{}\n{}",
            task_description,
            summarize_tool_text(retrieval_context, 6500)
        )
    };
    messages.push(ContextMessage {
        role: "user".to_string(),
        content: enhanced_task,
    });
    messages
}

#[cfg(test)]
mod tests {
    use super::{
        build_initial_messages, build_retrieval_context, format_cards_context,
        format_memory_context, PreviousExpertResult,
    };
    use crate::{memory, repo_wiki};

    #[test]
    fn builds_messages_with_previous_results_and_context() {
        let messages = build_initial_messages(
            &[PreviousExpertResult {
                expert_id: Some("discipline-120".to_string()),
                name: "120 信息科学与系统科学".to_string(),
                title: "一级学科专家".to_string(),
                output: "这里是上一步摘要".to_string(),
            }],
            "修复项目",
            "【一级索引】卡片摘要",
        );
        assert_eq!(messages.len(), 2);
        assert!(messages[0].content.contains("前置专家"));
        assert!(messages[1].content.contains("卡片摘要"));
    }

    #[test]
    fn formats_cards_and_memory_context() {
        let cards = vec![repo_wiki::KnowledgeCard {
            id: "1".to_string(),
            title: "架构".to_string(),
            category: "architecture".to_string(),
            tags: vec![],
            content: "这是一个前后端分离的项目".to_string(),
            sources: vec![],
            updated_at: "2026-06-04".to_string(),
        }];
        let cards_context = format_cards_context(&cards);
        assert!(cards_context.contains("仓库知识概览"));

        let memories = vec![memory::MemorySearchResult {
            entry: memory::MemoryEntry {
                id: "m1".to_string(),
                project_id: 1,
                expert_id: "discipline-520".to_string(),
                memory_type: "working".to_string(),
                content: "之前修过 app.js".to_string(),
                keywords: vec![],
                context_summary: "".to_string(),
                created_at: 1,
                access_count: 0,
                last_accessed: 1,
            },
            score: 0.9,
        }];
        let memory_context = format_memory_context(&memories, "相关历史记忆");
        assert!(memory_context.contains("相关历史记忆"));
    }

    #[test]
    fn merges_negative_index_into_retrieval_context() {
        let context = build_retrieval_context(
            Some("卡片".to_string()),
            None,
            None,
            None,
            &["向量检索未命中".to_string()],
        );
        assert!(context.contains("负向索引"));
        assert!(context.contains("向量检索未命中"));
    }
}
