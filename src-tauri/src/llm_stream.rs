use crate::llm_provider::*;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

/// 重试配置
#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub backoff_multiplier: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        RetryConfig {
            max_retries: 5,
            initial_backoff_ms: 1000,
            max_backoff_ms: 32000,
            backoff_multiplier: 2.0,
        }
    }
}

/// 流式Token事件载体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamTokenEvent {
    pub stream_id: String,
    pub token: String,
}

/// 流式完成事件载体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamDoneEvent {
    pub stream_id: String,
    pub response: LLMResponse,
}

/// 流式错误事件载体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamErrorEvent {
    pub stream_id: String,
    pub error: String,
}

/// 流式LLM客户端
pub struct StreamingLLMClient {
    client: Client,
    retry_config: RetryConfig,
}

impl StreamingLLMClient {
    pub fn new(retry_config: Option<RetryConfig>) -> Self {
        StreamingLLMClient {
            client: Client::new(),
            retry_config: retry_config.unwrap_or_default(),
        }
    }

    /// 流式调用LLM，通过Tauri Event逐token推送到前端
    pub async fn call_streaming(
        &self,
        app_handle: &AppHandle,
        provider: &ModelProvider,
        request: &LLMRequest,
        stream_id: &str,
    ) -> Result<LLMResponse, String> {
        let mut last_error = String::new();

        for attempt in 0..=self.retry_config.max_retries {
            if attempt > 0 {
                let delay = self.backoff_delay(attempt - 1);
                eprintln!(
                    "[LLM] 重试 {}/{}, 等待 {:?}",
                    attempt, self.retry_config.max_retries, delay
                );
                sleep(delay).await;
            }

            match self
                .do_streaming_call(app_handle, provider, request, stream_id)
                .await
            {
                Ok(response) => return Ok(response),
                Err(e) => {
                    eprintln!("[LLM] 流式调用失败 (attempt {}): {}", attempt, e);
                    last_error = e;
                }
            }
        }

        // 所有重试都失败，发送错误事件
        let _ = app_handle.emit(
            "llm-stream-error",
            StreamErrorEvent {
                stream_id: stream_id.to_string(),
                error: last_error.clone(),
            },
        );
        Err(last_error)
    }

    /// 执行单次流式调用
    async fn do_streaming_call(
        &self,
        app_handle: &AppHandle,
        provider: &ModelProvider,
        request: &LLMRequest,
        stream_id: &str,
    ) -> Result<LLMResponse, String> {
        let api_key = self.get_api_key(provider)?;
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| provider.default_model.clone());
        let url = format!("{}/chat/completions", provider.base_url);

        // 构建请求体
        let mut body = serde_json::json!({
            "model": model,
            "messages": request.messages,
            "stream": true,
        });

        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        if let Some(max_t) = request.max_tokens {
            body["max_tokens"] = serde_json::json!(max_t);
        }
        if let Some(ref tools) = request.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::json!(tools);
            }
        }

        // 发送HTTP请求
        let mut req_builder = self
            .client
            .post(&url)
            .header("Content-Type", "application/json");

        if !api_key.is_empty() {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req_builder
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求发送失败: {}", e))?;

        let status = response.status().as_u16();
        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            let err_msg = format!("API错误 ({}): {}", status, error_text);
            if Self::is_retryable(status) {
                return Err(err_msg);
            } else {
                // 不可重试的错误直接发送错误事件并返回
                let _ = app_handle.emit(
                    "llm-stream-error",
                    StreamErrorEvent {
                        stream_id: stream_id.to_string(),
                        error: err_msg.clone(),
                    },
                );
                return Err(err_msg);
            }
        }

        // 解析SSE流
        let mut full_content = String::new();
        let mut tool_calls_map: std::collections::HashMap<u32, ToolCall> =
            std::collections::HashMap::new();
        let mut finish_reason = String::new();
        let mut usage = TokenUsage::default();
        let mut buffer = String::new();

        let mut stream = response.bytes_stream();

        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("读取流失败: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            // 逐行解析SSE
            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim_end_matches('\r').to_string();
                buffer = buffer[line_end + 1..].to_string();

                if line.is_empty() {
                    continue;
                }

                if !line.starts_with("data: ") {
                    continue;
                }

                let data = &line[6..];

                if data == "[DONE]" {
                    // 流结束
                    let response = LLMResponse {
                        content: if full_content.is_empty() {
                            None
                        } else {
                            Some(full_content.clone())
                        },
                        tool_calls: if tool_calls_map.is_empty() {
                            None
                        } else {
                            let mut calls: Vec<(u32, ToolCall)> = tool_calls_map.drain().collect();
                            calls.sort_by_key(|(idx, _)| *idx);
                            Some(calls.into_iter().map(|(_, tc)| tc).collect())
                        },
                        usage: usage.clone(),
                        model: model.clone(),
                        finish_reason: finish_reason.clone(),
                    };

                    let _ = app_handle.emit(
                        "llm-stream-done",
                        StreamDoneEvent {
                            stream_id: stream_id.to_string(),
                            response: response.clone(),
                        },
                    );

                    return Ok(response);
                }

                // 解析JSON chunk
                if let Ok(chunk_json) = serde_json::from_str::<serde_json::Value>(data) {
                    // 提取usage（如果存在）
                    if let Some(u) = chunk_json.get("usage") {
                        if let Ok(parsed_usage) = serde_json::from_value::<TokenUsage>(u.clone()) {
                            usage = parsed_usage;
                        }
                    }

                    // 提取choices
                    if let Some(choices) = chunk_json.get("choices").and_then(|c| c.as_array()) {
                        for choice in choices {
                            // finish_reason
                            if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                                finish_reason = fr.to_string();
                            }

                            // delta content
                            if let Some(delta) = choice.get("delta") {
                                if let Some(content) = delta.get("content").and_then(|c| c.as_str())
                                {
                                    if !content.is_empty() {
                                        full_content.push_str(content);
                                        let _ = app_handle.emit(
                                            "llm-stream-token",
                                            StreamTokenEvent {
                                                stream_id: stream_id.to_string(),
                                                token: content.to_string(),
                                            },
                                        );
                                    }
                                }

                                // delta tool_calls
                                if let Some(tc_array) =
                                    delta.get("tool_calls").and_then(|t| t.as_array())
                                {
                                    for tc in tc_array {
                                        let index =
                                            tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0)
                                                as u32;

                                        let entry =
                                            tool_calls_map.entry(index).or_insert_with(|| {
                                                ToolCall {
                                                    id: String::new(),
                                                    r#type: "function".to_string(),
                                                    function: ToolCallFunction {
                                                        name: String::new(),
                                                        arguments: String::new(),
                                                    },
                                                }
                                            });

                                        if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                                            entry.id = id.to_string();
                                        }
                                        if let Some(func) = tc.get("function") {
                                            if let Some(name) =
                                                func.get("name").and_then(|n| n.as_str())
                                            {
                                                entry.function.name = name.to_string();
                                            }
                                            if let Some(args) =
                                                func.get("arguments").and_then(|a| a.as_str())
                                            {
                                                entry.function.arguments.push_str(args);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 流结束但没有收到[DONE]，构建响应
        let response = LLMResponse {
            content: if full_content.is_empty() {
                None
            } else {
                Some(full_content)
            },
            tool_calls: if tool_calls_map.is_empty() {
                None
            } else {
                let mut calls: Vec<(u32, ToolCall)> = tool_calls_map.drain().collect();
                calls.sort_by_key(|(idx, _)| *idx);
                Some(calls.into_iter().map(|(_, tc)| tc).collect())
            },
            usage,
            model,
            finish_reason,
        };

        let _ = app_handle.emit(
            "llm-stream-done",
            StreamDoneEvent {
                stream_id: stream_id.to_string(),
                response: response.clone(),
            },
        );

        Ok(response)
    }

    /// 非流式调用（兼容不需要流式的场景）
    pub async fn call_blocking(
        &self,
        provider: &ModelProvider,
        request: &LLMRequest,
    ) -> Result<LLMResponse, String> {
        let mut last_error = String::new();

        for attempt in 0..=self.retry_config.max_retries {
            if attempt > 0 {
                let delay = self.backoff_delay(attempt - 1);
                eprintln!(
                    "[LLM] 非流式重试 {}/{}, 等待 {:?}",
                    attempt, self.retry_config.max_retries, delay
                );
                sleep(delay).await;
            }

            match self.do_blocking_call(provider, request).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    eprintln!("[LLM] 非流式调用失败 (attempt {}): {}", attempt, e);
                    last_error = e;
                }
            }
        }

        Err(last_error)
    }

    /// 执行单次非流式调用
    async fn do_blocking_call(
        &self,
        provider: &ModelProvider,
        request: &LLMRequest,
    ) -> Result<LLMResponse, String> {
        let api_key = self.get_api_key(provider)?;
        let model = request
            .model
            .clone()
            .unwrap_or_else(|| provider.default_model.clone());
        let url = format!("{}/chat/completions", provider.base_url);

        let mut body = serde_json::json!({
            "model": model,
            "messages": request.messages,
            "stream": false,
        });

        if let Some(temp) = request.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        if let Some(max_t) = request.max_tokens {
            body["max_tokens"] = serde_json::json!(max_t);
        }
        if let Some(ref tools) = request.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::json!(tools);
            }
        }

        let mut req_builder = self
            .client
            .post(&url)
            .header("Content-Type", "application/json");

        if !api_key.is_empty() {
            req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = req_builder
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("请求发送失败: {}", e))?;

        let status = response.status().as_u16();
        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            let err_msg = format!("API错误 ({}): {}", status, error_text);
            if Self::is_retryable(status) {
                return Err(err_msg);
            } else {
                return Err(err_msg);
            }
        }

        let result: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("解析响应失败: {}", e))?;

        // 解析标准OpenAI格式响应
        let choices = result
            .get("choices")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();

        let first_choice = choices.first();

        let content = first_choice
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let finish_reason = first_choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(|f| f.as_str())
            .unwrap_or("stop")
            .to_string();

        let tool_calls: Option<Vec<ToolCall>> = first_choice
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("tool_calls"))
            .and_then(|tc| serde_json::from_value(tc.clone()).ok());

        let usage = result
            .get("usage")
            .and_then(|u| serde_json::from_value::<TokenUsage>(u.clone()).ok())
            .unwrap_or_default();

        let resp_model = result
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or(&model)
            .to_string();

        Ok(LLMResponse {
            content,
            tool_calls,
            usage,
            model: resp_model,
            finish_reason,
        })
    }

    /// 从环境变量获取API Key
    fn get_api_key(&self, provider: &ModelProvider) -> Result<String, String> {
        if provider.api_key_env.is_empty() {
            // Ollama等本地provider无需key
            return Ok(String::new());
        }
        std::env::var(&provider.api_key_env)
            .map_err(|_| format!("环境变量 {} 未设置，请配置API Key", provider.api_key_env))
    }

    /// 指数退避等待时长
    fn backoff_delay(&self, attempt: u32) -> Duration {
        let delay = self.retry_config.initial_backoff_ms as f64
            * self.retry_config.backoff_multiplier.powi(attempt as i32);
        Duration::from_millis(delay.min(self.retry_config.max_backoff_ms as f64) as u64)
    }

    /// 判断HTTP状态码是否可重试
    fn is_retryable(status: u16) -> bool {
        matches!(status, 429 | 500 | 502 | 503 | 504)
    }
}
