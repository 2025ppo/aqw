use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Hook阶段
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum HookPhase {
    PreTool,
    PostTool,
    PreExpert,
    PostExpert,
}

/// Hook上下文
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookContext {
    pub phase: HookPhase,
    pub expert_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_args: Option<serde_json::Value>,
    pub tool_result: Option<String>,
    pub pipeline_step: Option<u32>,
    pub blackboard_summary: Option<String>,
}

/// Hook决策
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HookDecision {
    Continue,
    ModifyInput(serde_json::Value),
    Skip(String),
    InjectContext(String),
    Retry(String),
}

/// Hook定义
#[derive(Clone)]
pub struct HookDefinition {
    pub id: String,
    pub phase: HookPhase,
    pub priority: u32,
    pub description: String,
    pub handler: Arc<dyn Fn(&HookContext) -> HookDecision + Send + Sync>,
}

/// Hook管理器
pub struct HookManager {
    hooks: RwLock<Vec<HookDefinition>>,
}

impl HookManager {
    pub fn new() -> Self {
        let manager = Self {
            hooks: RwLock::new(Vec::new()),
        };
        // 内置hooks将在首次使用时通过register_builtin_hooks注册
        manager
    }

    /// 初始化并注册内置Hook
    pub async fn init(&self) {
        self.register_builtin_hooks().await;
    }

    /// 注册Hook
    pub async fn register(&self, hook: HookDefinition) {
        let mut hooks = self.hooks.write().await;
        hooks.push(hook);
        hooks.sort_by_key(|h| h.priority);
    }

    /// 执行指定阶段的所有Hook
    pub async fn run_hooks(&self, ctx: &HookContext) -> Vec<HookDecision> {
        let hooks = self.hooks.read().await;
        hooks
            .iter()
            .filter(|h| h.phase == ctx.phase)
            .map(|h| (h.handler)(ctx))
            .collect()
    }

    /// 注册内置Hook
    async fn register_builtin_hooks(&self) {
        // 1. PostTool: shell命令执行后检查exit code
        self.register(HookDefinition {
            id: "builtin_check_exit_code".to_string(),
            phase: HookPhase::PostTool,
            priority: 10,
            description: "检查工具执行结果中的exit code".to_string(),
            handler: Arc::new(|ctx| {
                if let Some(result) = &ctx.tool_result {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(result) {
                        if let Some(code) = parsed.get("exit_code").and_then(|v| v.as_i64()) {
                            if code != 0 {
                                return HookDecision::InjectContext(format!(
                                    "命令执行失败，exit code: {}",
                                    code
                                ));
                            }
                        }
                    }
                }
                HookDecision::Continue
            }),
        })
        .await;

        // 2. PreExpert: 注入最新黑板摘要
        self.register(HookDefinition {
            id: "builtin_inject_blackboard".to_string(),
            phase: HookPhase::PreExpert,
            priority: 20,
            description: "向专家注入最新黑板摘要".to_string(),
            handler: Arc::new(|ctx| {
                if let Some(summary) = &ctx.blackboard_summary {
                    if !summary.is_empty() {
                        return HookDecision::InjectContext(summary.clone());
                    }
                }
                HookDecision::Continue
            }),
        })
        .await;

        // 3. PostExpert: 检测无进展情况
        self.register(HookDefinition {
            id: "builtin_detect_no_progress".to_string(),
            phase: HookPhase::PostExpert,
            priority: 30,
            description: "检测专家输出是否无进展".to_string(),
            handler: Arc::new(|ctx| {
                if let Some(result) = &ctx.tool_result {
                    if result.contains("NO_PROGRESS_DETECTED") {
                        return HookDecision::Retry(
                            "检测到无进展，请尝试不同方法".to_string(),
                        );
                    }
                }
                HookDecision::Continue
            }),
        })
        .await;

        // 4. PreTool: 检查审批状态
        self.register(HookDefinition {
            id: "builtin_check_approval".to_string(),
            phase: HookPhase::PreTool,
            priority: 5,
            description: "检查工具执行是否需要用户确认".to_string(),
            handler: Arc::new(|ctx| {
                if let Some(args) = &ctx.tool_args {
                    if let Some(needs_approval) =
                        args.get("needs_approval").and_then(|v| v.as_bool())
                    {
                        if needs_approval {
                            let approved = args
                                .get("approved")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if !approved {
                                return HookDecision::Skip("需要用户确认".to_string());
                            }
                        }
                    }
                }
                HookDecision::Continue
            }),
        })
        .await;
    }
}

/// 全局Hook管理器（懒初始化）
use std::sync::OnceLock;
use tokio::sync::OnceCell;

static HOOK_MANAGER: OnceLock<HookManager> = OnceLock::new();
static HOOK_INIT: OnceCell<()> = OnceCell::const_new();

pub fn get_hook_manager() -> &'static HookManager {
    HOOK_MANAGER.get_or_init(|| HookManager::new())
}

/// 确保内置hooks已注册（异步初始化）
pub async fn ensure_hooks_initialized() {
    HOOK_INIT
        .get_or_init(|| async {
            get_hook_manager().init().await;
        })
        .await;
}
