use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 完整配置结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub llm: LLMConfig,
    pub shell: ShellConfig,
    pub approval: ApprovalConfig,
    pub agent: AgentConfig,
    pub pipeline: PipelineConfig,
    pub ui: UIConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMConfig {
    pub default_provider: String,
    pub default_model: Option<String>,
    pub retry: RetrySettings,
    pub temperature: f64,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetrySettings {
    pub max_retries: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub backoff_multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellConfig {
    pub default_timeout_ms: u64,
    pub max_timeout_ms: u64,
    pub max_output_bytes: usize,
    pub max_output_lines: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalConfig {
    pub cache_enabled: bool,
    pub auto_patterns: Vec<String>,
    pub block_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub max_turns: u32,
    pub token_budget: u32,
    pub compact_threshold: f64,
    pub dead_loop_detection: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineConfig {
    pub expert_timeout_ms: u64,
    pub max_pipeline_steps: u32,
    pub enable_parallel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIConfig {
    pub streaming_enabled: bool,
    pub show_tool_calls: bool,
    pub show_progress_bar: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            llm: LLMConfig::default(),
            shell: ShellConfig::default(),
            approval: ApprovalConfig::default(),
            agent: AgentConfig::default(),
            pipeline: PipelineConfig::default(),
            ui: UIConfig::default(),
        }
    }
}

impl Default for LLMConfig {
    fn default() -> Self {
        Self {
            default_provider: "deepseek".to_string(),
            default_model: None,
            retry: RetrySettings::default(),
            temperature: 0.7,
            max_tokens: 4096,
        }
    }
}

impl Default for RetrySettings {
    fn default() -> Self {
        Self {
            max_retries: 5,
            initial_backoff_ms: 1000,
            max_backoff_ms: 32000,
            backoff_multiplier: 2.0,
        }
    }
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            default_timeout_ms: 60000,
            max_timeout_ms: 300000,
            max_output_bytes: 1048576,
            max_output_lines: 5000,
        }
    }
}

impl Default for ApprovalConfig {
    fn default() -> Self {
        Self {
            cache_enabled: true,
            auto_patterns: vec![
                "ls".to_string(),
                "cat".to_string(),
                "echo".to_string(),
                "pwd".to_string(),
                "dir".to_string(),
                "type".to_string(),
                "find".to_string(),
                "grep".to_string(),
            ],
            block_patterns: vec![
                "rm -rf /".to_string(),
                "format".to_string(),
                "del /s /q".to_string(),
            ],
        }
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_turns: 20,
            token_budget: 100000,
            compact_threshold: 0.8,
            dead_loop_detection: 3,
        }
    }
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            expert_timeout_ms: 120000,
            max_pipeline_steps: 10,
            enable_parallel: true,
        }
    }
}

impl Default for UIConfig {
    fn default() -> Self {
        Self {
            streaming_enabled: true,
            show_tool_calls: true,
            show_progress_bar: true,
        }
    }
}

/// 配置加载器（层叠合并）
pub struct ConfigLoader;

impl ConfigLoader {
    /// 加载配置（层叠合并）
    /// 优先级: 内置默认 < 用户全局 < 项目级 < 运行时覆盖
    pub fn load(project_dir: Option<&str>) -> AppConfig {
        let mut config = AppConfig::default();

        // 1. 尝试加载用户全局配置
        if let Some(global) = Self::load_global_config() {
            config = Self::merge(config, global);
        }

        // 2. 尝试加载项目级配置
        if let Some(dir) = project_dir {
            if let Some(project) = Self::load_project_config(dir) {
                config = Self::merge(config, project);
            }
        }

        config
    }

    /// 全局配置路径: ~/.xt/config.json
    pub fn global_config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".xt")
            .join("config.json")
    }

    /// 项目配置路径: {project}/.xt/project-config.json
    pub fn project_config_path(project_dir: &str) -> PathBuf {
        Path::new(project_dir)
            .join(".xt")
            .join("project-config.json")
    }

    fn load_global_config() -> Option<serde_json::Value> {
        let path = Self::global_config_path();
        let content = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn load_project_config(project_dir: &str) -> Option<serde_json::Value> {
        let path = Self::project_config_path(project_dir);
        let content = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// 深度合并JSON (overlay覆盖base)
    fn merge(base: AppConfig, overlay: serde_json::Value) -> AppConfig {
        let base_value = serde_json::to_value(&base).unwrap_or(serde_json::Value::Null);
        let merged = Self::deep_merge(base_value, overlay);
        serde_json::from_value(merged).unwrap_or(base)
    }

    /// 递归深度合并两个JSON Value
    fn deep_merge(base: serde_json::Value, overlay: serde_json::Value) -> serde_json::Value {
        match (base, overlay) {
            (serde_json::Value::Object(mut base_map), serde_json::Value::Object(overlay_map)) => {
                for (key, overlay_val) in overlay_map {
                    let merged_val = if let Some(base_val) = base_map.remove(&key) {
                        Self::deep_merge(base_val, overlay_val)
                    } else {
                        overlay_val
                    };
                    base_map.insert(key, merged_val);
                }
                serde_json::Value::Object(base_map)
            }
            (_, overlay) => overlay,
        }
    }

    /// 保存配置到指定路径
    pub fn save_config(config: &AppConfig, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    /// 获取默认配置JSON（用于UI展示可配置项）
    pub fn get_default_json() -> String {
        serde_json::to_string_pretty(&AppConfig::default()).unwrap_or_default()
    }
}
