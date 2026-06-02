use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 模型提供商定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key_env: String,
    pub supports_streaming: bool,
    pub supports_function_calling: bool,
    pub max_context_window: usize,
    pub default_model: String,
}

/// Provider注册表：管理所有可用的LLM Provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRegistry {
    providers: HashMap<String, ModelProvider>,
    pub default_provider_id: String,
}

impl ProviderRegistry {
    /// 创建内置所有Provider的注册表
    pub fn new() -> Self {
        let mut providers = HashMap::new();

        providers.insert(
            "deepseek".to_string(),
            ModelProvider {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                base_url: "https://api.deepseek.com/v1".to_string(),
                api_key_env: "DEEPSEEK_API_KEY".to_string(),
                supports_streaming: true,
                supports_function_calling: true,
                max_context_window: 64000,
                default_model: "deepseek-chat".to_string(),
            },
        );

        providers.insert(
            "openai".to_string(),
            ModelProvider {
                id: "openai".to_string(),
                name: "OpenAI".to_string(),
                base_url: "https://api.openai.com/v1".to_string(),
                api_key_env: "OPENAI_API_KEY".to_string(),
                supports_streaming: true,
                supports_function_calling: true,
                max_context_window: 128000,
                default_model: "gpt-4o".to_string(),
            },
        );

        providers.insert(
            "anthropic".to_string(),
            ModelProvider {
                id: "anthropic".to_string(),
                name: "Anthropic".to_string(),
                base_url: "https://api.anthropic.com/v1".to_string(),
                api_key_env: "ANTHROPIC_API_KEY".to_string(),
                supports_streaming: true,
                supports_function_calling: true,
                max_context_window: 200000,
                default_model: "claude-sonnet-4-20250514".to_string(),
            },
        );

        providers.insert(
            "aliyun".to_string(),
            ModelProvider {
                id: "aliyun".to_string(),
                name: "阿里云百炼".to_string(),
                base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
                api_key_env: "DASHSCOPE_API_KEY".to_string(),
                supports_streaming: true,
                supports_function_calling: true,
                max_context_window: 131072,
                default_model: "qwen-plus".to_string(),
            },
        );

        providers.insert(
            "ollama".to_string(),
            ModelProvider {
                id: "ollama".to_string(),
                name: "Ollama (本地)".to_string(),
                base_url: "http://localhost:11434/v1".to_string(),
                api_key_env: "".to_string(),
                supports_streaming: true,
                supports_function_calling: false,
                max_context_window: 8192,
                default_model: "llama3".to_string(),
            },
        );

        ProviderRegistry {
            providers,
            default_provider_id: "deepseek".to_string(),
        }
    }

    /// 根据ID获取Provider
    pub fn get_provider(&self, id: &str) -> Option<&ModelProvider> {
        self.providers.get(id)
    }

    /// 获取默认Provider
    pub fn get_default(&self) -> &ModelProvider {
        self.providers
            .get(&self.default_provider_id)
            .expect("default provider must exist")
    }

    /// 列出所有Provider
    pub fn list_providers(&self) -> Vec<&ModelProvider> {
        self.providers.values().collect()
    }

    /// 添加自定义Provider
    pub fn add_custom_provider(&mut self, provider: ModelProvider) {
        self.providers.insert(provider.id.clone(), provider);
    }
}

/// LLM请求结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMRequest {
    pub provider_id: String,
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub tools: Option<Vec<ToolSchema>>,
    pub stream: bool,
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 工具Schema定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub r#type: String,
    pub function: ToolFunction,
}

/// 工具函数定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// 工具调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: ToolCallFunction,
}

/// 工具调用函数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

/// LLM响应结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LLMResponse {
    pub content: Option<String>,
    pub tool_calls: Option<Vec<ToolCall>>,
    pub usage: TokenUsage,
    pub model: String,
    pub finish_reason: String,
}

/// Token使用统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}
