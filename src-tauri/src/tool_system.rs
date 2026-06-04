use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use crate::file_patch;
use crate::shell_executor;

/// 权限级别
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PermissionLevel {
    Auto,    // 自动执行，无需确认
    Confirm, // 需要用户确认
    Block,   // 默认拦截
}

/// 工具定义（类似Codex的ToolSpec）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value, // JSON Schema格式
    pub required_permission: PermissionLevel,
}

/// 工具执行上下文
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub working_dir: String,
    pub project_dir: String,
    pub expert_id: String,
    pub session_id: String,
}

/// 工具执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    pub success: bool,
    pub result: String,
    pub metadata: Option<serde_json::Value>,
}

/// 工具执行错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// 工具执行器 Trait（核心抽象）
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    fn definition(&self) -> &ToolDefinition;
    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError>;
}

/// 工具注册表
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn ToolExecutor>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn register(&mut self, executor: Arc<dyn ToolExecutor>) {
        let name = executor.definition().name.clone();
        self.tools.insert(name, executor);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn ToolExecutor>> {
        self.tools.get(name).cloned()
    }

    pub fn list_definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|t| t.definition().clone())
            .collect()
    }

    /// 根据专家角色过滤可用工具
    pub fn get_tools_for_expert(&self, expert_id: &str) -> Vec<ToolDefinition> {
        let expert_lower = expert_id.to_lowercase();
        let all_defs = self.list_definitions();

        // 基础工具：所有专家都能用
        let base_tools = ["file_read", "file_list", "index_search", "memory_query"];
        // 工程师类专家额外工具
        let engineer_tools = ["shell_exec", "file_write", "file_patch"];
        // 调研员工具
        let researcher_tools = ["web_search"];

        let is_engineer = expert_lower.contains("engineer")
            || expert_lower.contains("工程")
            || expert_lower.contains("dev")
            || expert_lower.contains("coder");
        let is_researcher = expert_lower.contains("research")
            || expert_lower.contains("调研")
            || expert_lower.contains("search");

        all_defs
            .into_iter()
            .filter(|def| {
                let name = def.name.as_str();
                if base_tools.contains(&name) {
                    return true;
                }
                if is_engineer && engineer_tools.contains(&name) {
                    return true;
                }
                if is_researcher && researcher_tools.contains(&name) {
                    return true;
                }
                // 主管/全能专家可用全部
                if expert_lower.contains("supervisor")
                    || expert_lower.contains("主管")
                    || expert_lower.contains("lead")
                {
                    return true;
                }
                false
            })
            .collect()
    }
}

/// 工具路由器（接收工具名+参数，找到执行器并执行）
pub struct ToolRouter {
    pub registry: ToolRegistry,
}

impl ToolRouter {
    pub fn new() -> Self {
        Self {
            registry: ToolRegistry::new(),
        }
    }

    /// 初始化并注册所有内置工具
    pub fn with_builtin_tools(_project_dir: &str) -> Self {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(ShellExecTool::new()));
        registry.register(Arc::new(FileReadTool::new()));
        registry.register(Arc::new(FileWriteTool::new()));
        registry.register(Arc::new(FilePatchTool::new()));
        registry.register(Arc::new(FileListTool::new()));
        registry.register(Arc::new(WebSearchTool::new()));
        registry.register(Arc::new(MemoryQueryTool::new()));
        registry.register(Arc::new(IndexSearchTool::new()));
        Self { registry }
    }

    /// 分发执行工具调用
    pub async fn dispatch(
        &self,
        tool_name: &str,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let executor = self.registry.get(tool_name).ok_or(ToolError {
            code: "NOT_FOUND".into(),
            message: format!("Tool not found: {}", tool_name),
            retryable: false,
        })?;
        executor.execute(args, ctx).await
    }

    /// 获取所有工具定义（用于注入到LLM请求）
    pub fn get_all_definitions(&self) -> Vec<ToolDefinition> {
        self.registry.list_definitions()
    }
}

// ===== 内置工具实现 =====

/// Shell执行工具
pub struct ShellExecTool {
    definition: ToolDefinition,
}

impl ShellExecTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "shell_exec".into(),
                description: "在项目目录中执行shell命令。可用于运行构建、测试、git操作等。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的shell命令" },
                        "working_dir": { "type": "string", "description": "工作目录(相对于项目根目录)" },
                        "timeout_ms": { "type": "number", "description": "超时毫秒数(默认60000)" }
                    },
                    "required": ["command"]
                }),
                required_permission: PermissionLevel::Confirm,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for ShellExecTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let command = args
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or(ToolError {
                code: "INVALID_ARGS".into(),
                message: "Missing required parameter: command".into(),
                retryable: false,
            })?;
        let working_dir = args.get("working_dir").and_then(|v| v.as_str());
        let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64());

        let config = shell_executor::ExecConfig {
            timeout_ms: timeout_ms.unwrap_or(60000),
            ..Default::default()
        };

        let output = shell_executor::execute_command_enhanced(
            command,
            &ctx.project_dir,
            working_dir,
            Some(config),
        )
        .await
        .map_err(|e| ToolError {
            code: "EXEC_FAILED".into(),
            message: e,
            retryable: true,
        })?;

        Ok(ToolOutput {
            success: output.exit_code == 0,
            result: output.format_for_model(),
            metadata: Some(serde_json::json!({
                "exit_code": output.exit_code,
                "wall_time_ms": output.wall_time_ms,
                "truncated": output.truncated,
                "killed": output.killed,
            })),
        })
    }
}

/// 文件读取工具
pub struct FileReadTool {
    definition: ToolDefinition,
}

impl FileReadTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "file_read".into(),
                description: "读取项目中指定文件的内容。支持文本文件。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "文件路径(相对于项目根目录)" },
                        "start_line": { "type": "number", "description": "起始行号(从1开始)" },
                        "end_line": { "type": "number", "description": "结束行号(包含)" }
                    },
                    "required": ["path"]
                }),
                required_permission: PermissionLevel::Auto,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for FileReadTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or(ToolError {
            code: "INVALID_ARGS".into(),
            message: "Missing required parameter: path".into(),
            retryable: false,
        })?;

        let full_path = std::path::Path::new(&ctx.project_dir).join(path);
        if !full_path.starts_with(&ctx.project_dir) {
            return Err(ToolError {
                code: "SANDBOX_VIOLATION".into(),
                message: "Path is outside project directory".into(),
                retryable: false,
            });
        }

        let content = tokio::fs::read_to_string(&full_path)
            .await
            .map_err(|e| ToolError {
                code: "IO_ERROR".into(),
                message: format!("Failed to read file: {}", e),
                retryable: false,
            })?;

        let start_line = args
            .get("start_line")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);
        let end_line = args
            .get("end_line")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize);

        let result = if let (Some(start), Some(end)) = (start_line, end_line) {
            let lines: Vec<&str> = content.lines().collect();
            let start_idx = start.saturating_sub(1);
            let end_idx = end.min(lines.len());
            lines[start_idx..end_idx].join("\n")
        } else if let Some(start) = start_line {
            let lines: Vec<&str> = content.lines().collect();
            let start_idx = start.saturating_sub(1);
            lines[start_idx..].join("\n")
        } else {
            content
        };

        Ok(ToolOutput {
            success: true,
            result,
            metadata: None,
        })
    }
}

/// 文件写入工具
pub struct FileWriteTool {
    definition: ToolDefinition,
}

impl FileWriteTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "file_write".into(),
                description: "写入或创建项目中的文件。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "文件路径(相对于项目根目录)" },
                        "content": { "type": "string", "description": "要写入的内容" },
                        "append": { "type": "boolean", "description": "是否追加模式(默认false)" }
                    },
                    "required": ["path", "content"]
                }),
                required_permission: PermissionLevel::Confirm,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for FileWriteTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or(ToolError {
            code: "INVALID_ARGS".into(),
            message: "Missing required parameter: path".into(),
            retryable: false,
        })?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or(ToolError {
                code: "INVALID_ARGS".into(),
                message: "Missing required parameter: content".into(),
                retryable: false,
            })?;
        let append = args
            .get("append")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let full_path = std::path::Path::new(&ctx.project_dir).join(path);
        if !full_path.starts_with(&ctx.project_dir) {
            return Err(ToolError {
                code: "SANDBOX_VIOLATION".into(),
                message: "Path is outside project directory".into(),
                retryable: false,
            });
        }

        // Ensure parent directory exists
        if let Some(parent) = full_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError {
                    code: "IO_ERROR".into(),
                    message: format!("Failed to create directory: {}", e),
                    retryable: false,
                })?;
        }

        if append {
            use tokio::io::AsyncWriteExt;
            let mut file = tokio::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(&full_path)
                .await
                .map_err(|e| ToolError {
                    code: "IO_ERROR".into(),
                    message: format!("Failed to open file: {}", e),
                    retryable: false,
                })?;
            file.write_all(content.as_bytes())
                .await
                .map_err(|e| ToolError {
                    code: "IO_ERROR".into(),
                    message: format!("Failed to write file: {}", e),
                    retryable: false,
                })?;
        } else {
            tokio::fs::write(&full_path, content)
                .await
                .map_err(|e| ToolError {
                    code: "IO_ERROR".into(),
                    message: format!("Failed to write file: {}", e),
                    retryable: false,
                })?;
        }

        Ok(ToolOutput {
            success: true,
            result: format!("File written: {}", path),
            metadata: Some(serde_json::json!({
                "bytes_written": content.len(),
            })),
        })
    }
}

/// 结构化补丁工具
pub struct FilePatchTool {
    definition: ToolDefinition,
}

impl FilePatchTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "file_patch".into(),
                description: "应用结构化补丁到项目文件。支持新增、修改、删除和移动文件。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "patch": { "type": "string", "description": "结构化Patch文本(*** Begin Patch ... *** End Patch)" }
                    },
                    "required": ["patch"]
                }),
                required_permission: PermissionLevel::Confirm,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for FilePatchTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let patch = args
            .get("patch")
            .and_then(|v| v.as_str())
            .ok_or(ToolError {
                code: "INVALID_ARGS".into(),
                message: "Missing required parameter: patch".into(),
                retryable: false,
            })?;

        match file_patch::parse_and_apply_patch(patch, &ctx.project_dir) {
            Ok(result) => {
                let applied_files: Vec<String> = result
                    .applied
                    .iter()
                    .map(|change| change.path.clone())
                    .collect();
                let first_error = result.errors.first();
                Ok(ToolOutput {
                    success: result.success,
                    result: result.summary.clone(),
                    metadata: Some(serde_json::json!({
                        "error": first_error.map(|err| err.message.clone()),
                        "failed_file": first_error.map(|err| err.path.clone()),
                        "hunk_index": first_error.map(|err| err.hunk_index),
                        "applied_files": applied_files,
                        "applied_count": result.applied.len(),
                        "failed_count": result.errors.len(),
                        "delta": result.delta,
                    })),
                })
            }
            Err(error) => Ok(ToolOutput {
                success: false,
                result: error.clone(),
                metadata: Some(serde_json::json!({
                    "error": error,
                    "applied_files": [],
                    "applied_count": 0,
                    "failed_count": 1,
                })),
            }),
        }
    }
}

/// 文件列表工具
pub struct FileListTool {
    definition: ToolDefinition,
}

impl FileListTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "file_list".into(),
                description: "列出目录中的文件和子目录。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "目录路径(相对于项目根目录，默认为根目录)" },
                        "recursive": { "type": "boolean", "description": "是否递归列出(默认false)" },
                        "max_depth": { "type": "number", "description": "最大递归深度(默认3)" }
                    }
                }),
                required_permission: PermissionLevel::Auto,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for FileListTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let recursive = args
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let max_depth = args.get("max_depth").and_then(|v| v.as_u64()).unwrap_or(3) as usize;

        let full_path = std::path::Path::new(&ctx.project_dir).join(path);
        if !full_path.starts_with(&ctx.project_dir) {
            return Err(ToolError {
                code: "SANDBOX_VIOLATION".into(),
                message: "Path is outside project directory".into(),
                retryable: false,
            });
        }

        let mut entries = Vec::new();
        Self::list_dir_impl(
            &full_path,
            &ctx.project_dir,
            recursive,
            max_depth,
            0,
            &mut entries,
        )
        .map_err(|e| ToolError {
            code: "IO_ERROR".into(),
            message: format!("Failed to list directory: {}", e),
            retryable: false,
        })?;

        Ok(ToolOutput {
            success: true,
            result: entries.join("\n"),
            metadata: Some(serde_json::json!({ "count": entries.len() })),
        })
    }
}

impl FileListTool {
    fn list_dir_impl(
        dir: &std::path::Path,
        project_dir: &str,
        recursive: bool,
        max_depth: usize,
        current_depth: usize,
        entries: &mut Vec<String>,
    ) -> Result<(), String> {
        if current_depth > max_depth {
            return Ok(());
        }
        let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Cannot read dir: {}", e))?;
        for entry in read_dir.flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(project_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            let is_dir = path.is_dir();
            let prefix = if is_dir { "[DIR]" } else { "[FILE]" };
            entries.push(format!("{} {}", prefix, rel));
            if is_dir && recursive && current_depth < max_depth {
                Self::list_dir_impl(
                    &path,
                    project_dir,
                    recursive,
                    max_depth,
                    current_depth + 1,
                    entries,
                )?;
            }
        }
        Ok(())
    }
}

/// 网络搜索工具
pub struct WebSearchTool {
    definition: ToolDefinition,
}

impl WebSearchTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "web_search".into(),
                description: "搜索互联网获取最新信息。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索关键词" },
                        "max_results": { "type": "number", "description": "最大返回结果数(默认5)" }
                    },
                    "required": ["query"]
                }),
                required_permission: PermissionLevel::Auto,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for WebSearchTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or(ToolError {
                code: "INVALID_ARGS".into(),
                message: "Missing required parameter: query".into(),
                retryable: false,
            })?;
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(5) as usize;

        let _ctx = ctx; // suppress unused warning
        let results = crate::web_search::search(query, max_results)
            .await
            .map_err(|e| ToolError {
                code: "SEARCH_FAILED".into(),
                message: e,
                retryable: true,
            })?;

        let result_text = serde_json::to_string_pretty(&results).unwrap_or_default();
        Ok(ToolOutput {
            success: true,
            result: result_text,
            metadata: None,
        })
    }
}

/// 记忆查询工具
pub struct MemoryQueryTool {
    definition: ToolDefinition,
}

impl MemoryQueryTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "memory_query".into(),
                description: "查询专家的长期记忆知识库。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "记忆查询关键词" },
                        "memory_type": { "type": "string", "description": "记忆类型(fact/experience/preference)" }
                    },
                    "required": ["query"]
                }),
                required_permission: PermissionLevel::Auto,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for MemoryQueryTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or(ToolError {
                code: "INVALID_ARGS".into(),
                message: "Missing required parameter: query".into(),
                retryable: false,
            })?;

        // Delegate to memory module's search functionality
        // Returns a simplified result since actual DB search needs the pool
        Ok(ToolOutput {
            success: true,
            result: format!(
                "Memory query for '{}' - use memory_search Tauri command for full DB access",
                query
            ),
            metadata: Some(serde_json::json!({ "query": query })),
        })
    }
}

/// 索引搜索工具
pub struct IndexSearchTool {
    definition: ToolDefinition,
}

impl IndexSearchTool {
    pub fn new() -> Self {
        Self {
            definition: ToolDefinition {
                name: "index_search".into(),
                description: "在项目代码索引中搜索符号、定义和引用。".into(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "搜索查询(函数名、类名、变量名等)" },
                        "file_pattern": { "type": "string", "description": "文件模式过滤(如 *.rs, *.ts)" }
                    },
                    "required": ["query"]
                }),
                required_permission: PermissionLevel::Auto,
            },
        }
    }
}

#[async_trait]
impl ToolExecutor for IndexSearchTool {
    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or(ToolError {
                code: "INVALID_ARGS".into(),
                message: "Missing required parameter: query".into(),
                retryable: false,
            })?;

        // Delegate to perceptual_index search - needs project_dir state
        Ok(ToolOutput {
            success: true,
            result: format!("Index search for '{}' - use perceptual_index_search Tauri command for full index access", query),
            metadata: Some(serde_json::json!({ "query": query })),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn file_patch_tool_is_registered_and_writes_files() {
        let project_dir = std::env::temp_dir().join(format!(
            "ai-experts-file-patch-tool-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&project_dir).unwrap();

        let ctx = ToolContext {
            working_dir: project_dir.to_string_lossy().to_string(),
            project_dir: project_dir.to_string_lossy().to_string(),
            expert_id: "jiang-yumo".into(),
            session_id: "test-session".into(),
        };

        let router = ToolRouter::with_builtin_tools(&ctx.project_dir);
        let patch =
            "*** Begin Patch\n*** Add File: smoke-test.txt\n+patched content\n*** End Patch\n";
        let runtime = tokio::runtime::Runtime::new().unwrap();

        let output = runtime
            .block_on(async {
                router
                    .dispatch("file_patch", serde_json::json!({ "patch": patch }), &ctx)
                    .await
            })
            .unwrap();

        let written = fs::read_to_string(project_dir.join("smoke-test.txt")).unwrap();
        assert!(output.success, "tool result should be successful");
        assert_eq!(written, "patched content");

        let _ = fs::remove_dir_all(&project_dir);
    }
}
