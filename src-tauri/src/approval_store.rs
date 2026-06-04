use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ApprovalDecision {
    Approved,
    ApprovedAlways, // "总是允许此类命令"
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRecord {
    pub pattern: String,
    pub decision: ApprovalDecision,
    pub timestamp: i64,
}

#[derive(Debug)]
pub enum ApprovalCheckResult {
    Auto,
    NeedsConfirmation,
    Blocked(String),
}

pub struct ApprovalStore {
    cache: Mutex<HashMap<String, ApprovalRecord>>,
    auto_patterns: Vec<String>,
    block_patterns: Vec<String>,
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            auto_patterns: vec![
                "ls".into(),
                "dir".into(),
                "cat".into(),
                "type".into(),
                "echo".into(),
                "pwd".into(),
                "cd".into(),
                "git status".into(),
                "git log".into(),
                "git diff".into(),
                "git branch".into(),
                "cargo check".into(),
                "cargo build".into(),
                "npm run".into(),
                "node".into(),
                "npx".into(),
            ],
            block_patterns: vec![
                "rm -rf /".into(),
                "format c:".into(),
                "del /f /s /q".into(),
                ":(){ :|:& };:".into(),
                "dd if=".into(),
                "sudo rm".into(),
                "runas".into(),
            ],
        }
    }

    /// 检查命令是否需要审批
    pub fn check_approval(&self, command: &str) -> ApprovalCheckResult {
        let cmd_lower = command.to_lowercase().trim().to_string();

        // 1. 检查 block_patterns → Blocked
        for pattern in &self.block_patterns {
            if cmd_lower.contains(&pattern.to_lowercase()) {
                return ApprovalCheckResult::Blocked(format!("命令匹配危险模式: {}", pattern));
            }
        }

        // 2. 检查 auto_patterns → Auto
        for pattern in &self.auto_patterns {
            if cmd_lower.starts_with(&pattern.to_lowercase()) {
                return ApprovalCheckResult::Auto;
            }
        }

        // 3. 检查 cache 中是否有 ApprovedAlways → Auto
        let extracted = Self::extract_pattern(&cmd_lower);
        if let Ok(cache) = self.cache.lock() {
            if let Some(record) = cache.get(&extracted) {
                if record.decision == ApprovalDecision::ApprovedAlways {
                    return ApprovalCheckResult::Auto;
                }
            }
        }

        // 4. 其他 → NeedsConfirmation
        ApprovalCheckResult::NeedsConfirmation
    }

    /// 记录用户审批决策
    pub fn record_decision(&self, command: &str, decision: ApprovalDecision) {
        let pattern = Self::extract_pattern(command);
        let record = ApprovalRecord {
            pattern: pattern.clone(),
            decision,
            timestamp: chrono::Utc::now().timestamp(),
        };
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(pattern, record);
        }
    }

    /// 提取命令模式(去掉参数细节，保留命令前缀)
    fn extract_pattern(command: &str) -> String {
        let trimmed = command.trim().to_lowercase();
        // 取命令的前两个 token 作为 pattern
        let parts: Vec<&str> = trimmed.splitn(3, ' ').collect();
        match parts.len() {
            0 => String::new(),
            1 => parts[0].to_string(),
            _ => format!("{} {}", parts[0], parts[1]),
        }
    }
}
