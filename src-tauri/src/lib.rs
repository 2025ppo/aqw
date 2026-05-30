// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Pool, Sqlite, Row};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use dunce;

mod perceptual_index;
mod code_chunker;
mod tfidf;
mod code_graph;
mod repo_wiki;
mod memory;
mod deliverables;
mod health_score;
mod code_retention;
mod rbac;
mod experience;

/// 全局数据库连接池（应用级共享）
struct AppState {
    db: Pool<Sqlite>,
}

/// 初始化数据库连接池
async fn init_db_pool(app_handle: &tauri::AppHandle) -> Result<Pool<Sqlite>, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    
    // 确保应用数据目录存在
    fs::create_dir_all(&app_data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    
    let db_path = app_data_dir.join("chat_history.db");
    let db_path_str = db_path.to_string_lossy().to_string();
    
    eprintln!("[DB] 数据库路径: {}", db_path_str);
    
    // Windows路径需要转换为URL格式：把反斜杠换成正斜杠，并添加file://协议
    let db_url = format!("sqlite:///{}", db_path_str.replace("\\", "/"));
    eprintln!("[DB] 连接URL: {}", db_url);
    
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
        .await
        .map_err(|e| format!("数据库连接失败: {}", e))?;
    
    // 创建表
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            icon_color TEXT,
            workspace_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )"
    ).execute(&pool).await.map_err(|e| e.to_string())?;
    
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )"
    ).execute(&pool).await.map_err(|e| e.to_string())?;
    
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )"
    ).execute(&pool).await.map_err(|e| e.to_string())?;
    
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )"
    ).execute(&pool).await.map_err(|e| e.to_string())?;
    
    Ok(pool)
}

const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1/chat/completions";

/// DeepSeek 请求体
#[derive(Serialize)]
pub struct DeepSeekRequest {
    pub model: String,
    pub messages: Vec<DeepSeekMessage>,
    pub stream: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeepSeekMessage {
    pub role: String,
    pub content: String,
}

/// DeepSeek 响应体
#[derive(Deserialize, Debug)]
pub struct DeepSeekResponse {
    pub choices: Vec<DeepSeekChoice>,
    pub usage: Option<DeepSeekUsage>,
}

#[derive(Deserialize, Debug)]
pub struct DeepSeekChoice {
    pub message: DeepSeekMessage,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DeepSeekUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// 测试 API 密钥是否有效
#[derive(Deserialize)]
struct TestKeyConfig {
    #[serde(rename = "type")]
    key_type: String,
    api_key: String,
    endpoint: Option<String>,
    model: Option<String>,
}

#[tauri::command]
async fn test_api_key(config: TestKeyConfig) -> Result<bool, String> {
    let client = reqwest::Client::new();

    let (url, model) = if config.key_type == "relay" {
        let endpoint = config.endpoint.ok_or("缺少端点地址")?;
        let model = config.model.unwrap_or_else(|| "default".to_string());
        (endpoint, model)
    } else {
        let provider_id = &config.key_type;
        let model = config.model.unwrap_or_else(|| "default".to_string());
        let url = match provider_id.as_str() {
            "deepseek" => "https://api.deepseek.com/v1/chat/completions",
            "openai" => "https://api.openai.com/v1/chat/completions",
            "anthropic" => "https://api.anthropic.com/v1/messages",
            "aliyun" => "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "tencent" => "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
            _ => return Err(format!("未知厂商: {}", provider_id)),
        };
        (url.to_string(), model)
    };

    let request_body = DeepSeekRequest {
        model,
        messages: vec![DeepSeekMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
        }],
        stream: false,
    };

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .json(&request_body)
        .send()
        .await;

    match response {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                eprintln!("[API_TEST] 密钥验证成功: {} {}", config.key_type, url);
                Ok(true)
            } else {
                let body = resp.text().await.unwrap_or_default();
                let short_body = if body.len() > 200 { &body[..200] } else { &body };
                eprintln!("[API_TEST] 密钥验证失败 (HTTP {}): {}", status.as_u16(), short_body);
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    Err("密钥无效或被拒绝访问".to_string())
                } else if status.as_u16() == 404 {
                    Err("端点不存在 (404)".to_string())
                } else {
                    Err(format!("服务器返回错误 (HTTP {})", status.as_u16()))
                }
            }
        }
        Err(e) => {
            eprintln!("[API_TEST] 请求失败: {}", e);
            if e.is_timeout() {
                Err("连接超时，请检查网络和端点地址".to_string())
            } else if e.is_connect() {
                Err("无法连接到服务器，请检查端点地址".to_string())
            } else {
                Err(format!("请求失败: {}", e))
            }
        }
    }
}

/// 沙箱系统提示词
const SYSTEM_PROMPT: &str = r#"你是一个AI专家团助手，帮助用户管理项目文件和文件夹。

当用户要求创建文件夹或文件时，请在回复末尾使用以下动作标记格式：

创建文件夹：[ACTION:CREATE_FOLDER:相对路径]
创建文件：
[ACTION:CREATE_FILE:相对路径]
```
文件内容
```

例如：
- 用户说"创建一个集合文件夹" -> 你在回复末尾添加：[ACTION:CREATE_FOLDER:集合]
- 用户说"在集合里创建一个README" -> 你在回复末尾添加：
  [ACTION:CREATE_FILE:集合/README.md]
  ```
  # 集合
  
  这是集合的说明文档。
  ```

重要规则：
1. 所有路径都是相对于项目根目录的
2. 不要包含解释文字，只添加动作标记
3. 文件内容用三个反引号包裹
4. 动作标记放在回复的最后"#;

/// 发送消息到 DeepSeek API
/// 返回 JSON 字符串，包含 content 和 usage
#[tauri::command]
async fn chat_with_deepseek(messages: Vec<DeepSeekMessage>, api_key: String) -> Result<String, String> {
    call_llm(SYSTEM_PROMPT.to_string(), messages, api_key).await
}

/// 使用自定义 system prompt 调用 LLM（供专家团路由使用）
/// 返回 JSON 字符串，包含 content 和 usage
#[tauri::command]
async fn chat_with_expert(
    messages: Vec<DeepSeekMessage>,
    api_key: String,
    system_prompt: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let mut full_messages = vec![DeepSeekMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];
    full_messages.extend(messages);

    let request_body = DeepSeekRequest {
        model: "deepseek-v4-flash".to_string(),
        messages: full_messages,
        stream: false,
    };

    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, text));
    }

    let result: DeepSeekResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = if let Some(choice) = result.choices.first() {
        choice.message.content.clone()
    } else {
        String::new()
    };

    let reply = serde_json::json!({
        "content": content,
        "usage": result.usage,
    });

    Ok(reply.to_string())
}

/// 内部通用 LLM 调用函数
/// 返回 JSON 字符串，包含 content 和 usage
async fn call_llm(
    system_prompt: String,
    messages: Vec<DeepSeekMessage>,
    api_key: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();

    let mut full_messages = vec![DeepSeekMessage {
        role: "system".to_string(),
        content: system_prompt,
    }];
    full_messages.extend(messages);

    let request_body = DeepSeekRequest {
        model: "deepseek-v4-flash".to_string(),
        messages: full_messages,
        stream: false,
    };

    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, text));
    }

    let result: DeepSeekResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = if let Some(choice) = result.choices.first() {
        choice.message.content.clone()
    } else {
        String::new()
    };

    let reply = serde_json::json!({
        "content": content,
        "usage": result.usage,
    });

    Ok(reply.to_string())
}

/// 获取应用数据目录
#[tauri::command]
fn get_app_data_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 创建工作区文件夹，并自动生成 .xt 配置文件夹及子文件夹
/// project_name: 项目名称
/// 返回创建的项目目录路径
#[tauri::command]
fn create_workspace(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用目录: {}", e))?;

    let project_dir = base_dir.join("workspaces").join(&project_name);

    // 创建目录（递归）
    fs::create_dir_all(&project_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 创建 .xt 配置文件夹（如果不存在）
    let xt_dir = project_dir.join(".xt");
    if !xt_dir.exists() {
        fs::create_dir_all(&xt_dir)
            .map_err(|e| format!("创建配置文件夹失败: {}", e))?;
        
        // 创建默认子文件夹
        let subdirs = ["configs", "logs", "cache"];
        for sub in &subdirs {
            fs::create_dir_all(xt_dir.join(sub))
                .map_err(|e| format!("创建子文件夹 {} 失败: {}", sub, e))?;
        }
        
        // 创建默认配置文件
        let config_file = xt_dir.join("config.json");
        let default_config = r#"{
  "project": "",
  "version": "0.1.0",
  "files": [],
  "canvasDirectory": {
    "nodes": [],
    "edges": [],
    "updatedAt": ""
  }
}"#;
        fs::write(&config_file, default_config)
            .map_err(|e| format!("创建配置文件失败: {}", e))?;
    }

    Ok(project_dir.to_string_lossy().to_string())
}

/// 从外部文件夹路径打开项目
#[tauri::command]
fn open_project_is_dir(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).is_dir())
}

/// 从外部文件夹路径打开项目
#[tauri::command]
fn open_project_from_path(folder_path: String, _app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() {
        return Err("文件夹不存在".to_string());
    }
    if !path.is_dir() {
        return Err("路径不是文件夹".to_string());
    }

    // 取文件夹名作为项目名称
    let project_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("未命名项目")
        .to_string();

    // 确保 .xt 配置目录存在
    let xt_dir = path.join(".xt");
    if !xt_dir.exists() {
        fs::create_dir_all(&xt_dir)
            .map_err(|e| format!("创建配置文件夹失败: {}", e))?;
        let subdirs = ["configs", "logs", "cache"];
        for sub in &subdirs {
            fs::create_dir_all(xt_dir.join(sub))
                .map_err(|e| format!("创建子文件夹 {} 失败: {}", sub, e))?;
        }
        let config_file = xt_dir.join("config.json");
        let default_config = r#"{
  "project": "",
  "version": "0.1.0",
  "files": [],
  "canvasDirectory": {
    "nodes": [],
    "edges": [],
    "updatedAt": ""
  }
}"#;
        fs::write(&config_file, default_config)
            .map_err(|e| format!("创建配置文件失败: {}", e))?;
    }

    Ok(serde_json::json!({
        "name": project_name,
        "path": folder_path
    }).to_string())
}

/// 检查工作区是否存在
#[tauri::command]
fn workspace_exists(project_name: String, app_handle: tauri::AppHandle) -> Result<bool, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let project_dir = base_dir.join("workspaces").join(&project_name);
    Ok(project_dir.exists())
}

/// 获取所有工作区列表
#[tauri::command]
fn list_workspaces(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let workspaces_dir = base_dir.join("workspaces");
    if !workspaces_dir.exists() {
        return Ok(vec![]);
    }

    let mut projects = vec![];
    let entries = fs::read_dir(&workspaces_dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(name) = entry.file_name().to_str() {
                projects.push(name.to_string());
            }
        }
    }

    Ok(projects)
}

/// 检查并补全 .xt 配置文件夹
/// 如果项目文件夹存在但缺少 .xt 文件夹，则自动创建
#[tauri::command]
fn ensure_xt_config(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let project_dir = base_dir.join("workspaces").join(&project_name);
    let xt_dir = project_dir.join(".xt");

    if !xt_dir.exists() {
        fs::create_dir_all(&xt_dir)
            .map_err(|e| format!("创建配置文件夹失败: {}", e))?;
        
        // 创建默认子文件夹
        let subdirs = ["configs", "logs", "cache"];
        for sub in &subdirs {
            fs::create_dir_all(xt_dir.join(sub))
                .map_err(|e| format!("创建子文件夹 {} 失败: {}", sub, e))?;
        }
        
        // 创建默认配置文件
        let config_file = xt_dir.join("config.json");
        let default_config = r#"{
  "project": "",
  "version": "0.1.0",
  "files": [],
  "canvasDirectory": {
    "nodes": [],
    "edges": [],
    "updatedAt": ""
  }
}"#;
        fs::write(&config_file, default_config)
            .map_err(|e| format!("创建配置文件失败: {}", e))?;
    }

    Ok(xt_dir.to_string_lossy().to_string())
}

/// 扫描项目目录结构
#[tauri::command]
fn scan_project_structure(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let mut structure = vec![];
    scan_dir_recursive(&project_dir, &project_dir, &mut structure)?;

    Ok(serde_json::to_string(&structure).map_err(|e| e.to_string())?)
}

#[derive(Serialize)]
struct DirEntry {
    path: String,
    name: String,
    is_dir: bool,
}

/// 结构扫描跳过目录集合
const SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "__pycache__", "venv", ".venv",
    "build", ".next", "coverage", "vendor", ".gradle", "gradle",
    "obj", "bin", "out", "packages", ".nuget", "Pods", "DerivedData",
    ".dart_tool", ".pub-cache", "bower_components", "jspm_packages",
    ".cache", ".parcel-cache", ".terraform", ".serverless",
    "logs", "tmp", "temp",
];

/// 最大扫描条目数
const MAX_SCAN_ENTRIES: usize = 20_000;

fn scan_dir_recursive(
    base: &std::path::Path,
    current: &std::path::Path,
    result: &mut Vec<DirEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;

    for entry in entries {
        // 总量保护
        if result.len() >= MAX_SCAN_ENTRIES {
            return Ok(());
        }

        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过隐藏文件（保留 .xt 配置目录）
        if name.starts_with('.') && name != ".xt" {
            continue;
        }

        let is_dir = path.is_dir();

        // 跳过常见无关目录
        if is_dir && (path.is_symlink() || SCAN_SKIP_DIRS.contains(&name.as_str())) {
            continue;
        }

        let relative_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();

        result.push(DirEntry {
            path: relative_path,
            name,
            is_dir,
        });

        if is_dir {
            scan_dir_recursive(base, &path, result)?;
        }
    }

    Ok(())
}

/// 分析项目依赖关系（调用 DeepSeek）
#[tauri::command]
async fn analyze_project_dependencies(
    project_name: String,
    api_key: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // 1. 扫描目录结构
    let structure_json = scan_project_structure(project_name.clone(), app_handle)?;

    // 2. 调用 DeepSeek 分析依赖
    let client = reqwest::Client::new();
    let prompt = format!(
        r#"你是一个项目结构分析专家。请分析以下项目目录结构，识别文件夹和文件之间的依赖关系。

项目目录结构（JSON格式）：
{}

请返回一个JSON数组，格式如下：
[
  {{"id": "唯一标识", "type": "folder|file", "name": "显示名称", "x": 0, "y": 0}},
  ...
]

以及一个依赖关系数组：
[
  {{"from": "源节点id", "to": "目标节点id"}},
  ...
]

注意：
1. 节点位置(x,y)请合理分布，避免重叠
2. 文件夹用橙色(#FF8C42)，文件用绿色(#4CAF50)
3. 依赖关系表示文件属于哪个文件夹，或文件之间的引用关系
4. 只返回JSON数据，不要其他解释

请返回完整JSON格式：{{"nodes": [...], "edges": [...]}}"#,
        structure_json
    );

    let request_body = DeepSeekRequest {
        model: "deepseek-v4-flash".to_string(),
        messages: vec![DeepSeekMessage {
            role: "user".to_string(),
            content: prompt,
        }],
        stream: false,
    };

    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, text));
    }

    let result: DeepSeekResponse = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if let Some(choice) = result.choices.first() {
        Ok(choice.message.content.clone())
    } else {
        Err("API 返回空内容".to_string())
    }
}

/// 保存项目列表到本地
#[tauri::command]
fn save_projects(projects: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let projects_file = base_dir.join("projects.json");
    fs::write(&projects_file, projects).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从本地加载项目列表
#[tauri::command]
fn load_projects(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let projects_file = base_dir.join("projects.json");
    if !projects_file.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&projects_file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存草稿数据到 .xt/draft.json
#[tauri::command]
fn save_draft(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let draft_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("draft.json");

    if let Some(parent) = draft_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&draft_file, data).map_err(|e| format!("写入草稿文件失败: {}", e))?;
    Ok(())
}

/// 从 .xt/draft.json 加载草稿数据
#[tauri::command]
fn load_draft(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let draft_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("draft.json");

    if !draft_file.exists() {
        return Ok("null".to_string());
    }

    let content = fs::read_to_string(&draft_file).map_err(|e| format!("读取草稿文件失败: {}", e))?;
    Ok(content)
}

/// 保存应用状态（最后打开的项目等）
#[tauri::command]
fn save_app_state(state: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let state_file = base_dir.join("app_state.json");
    fs::write(&state_file, state).map_err(|e| e.to_string())?;
    Ok(())
}

/// 加载应用状态
#[tauri::command]
fn load_app_state(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let state_file = base_dir.join("app_state.json");
    if !state_file.exists() {
        return Ok("{}".to_string());
    }
    let content = fs::read_to_string(&state_file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存密钥池到本地
#[tauri::command]
fn save_key_pool(items: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("key_pool.json");
    fs::write(&file, items).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从本地加载密钥池
#[tauri::command]
fn load_key_pool(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("key_pool.json");
    if !file.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 保存专家团配置到本地
#[tauri::command]
fn save_experts(config: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("experts.json");
    fs::write(&file, config).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从本地加载专家团配置
#[tauri::command]
fn load_experts(app_handle: tauri::AppHandle) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file = base_dir.join("experts.json");
    if !file.exists() {
        return Ok("[]".to_string());
    }
    let content = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(content)
}

/// 获取项目工作区路径（优先从 projects.json 解析外部项目路径）
fn get_project_dir(project_name: &str, app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    // 从 projects.json 查找外部项目的 workspacePath
    let projects_file = base_dir.join("projects.json");
    if projects_file.exists() {
        if let Ok(content) = fs::read_to_string(&projects_file) {
            if let Ok(projects) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                for p in &projects {
                    if p["name"].as_str() == Some(project_name) {
                        if let Some(wp) = p["workspacePath"].as_str() {
                            if !wp.is_empty() {
                                let path = PathBuf::from(wp);
                                if path.exists() {
                                    // 返回规范化路径，避免反斜杠/大小写不一致问题
                                    match path.canonicalize() {
                                        Ok(canon) => return Ok(canon),
                                        Err(_) => {
                                            // 如果 canonicalize 失败（如网络路径），
                                            // 至少统一使用正斜杠并解析 . 和 ..
                                            return Ok(dunce::simplified(&path).to_path_buf());
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

    let fallback = base_dir.join("workspaces").join(project_name);
    // 对默认路径同样做规范化
    match fallback.canonicalize() {
        Ok(canon) => Ok(canon),
        Err(_) => Ok(dunce::simplified(&fallback).to_path_buf()),
    }
}

/// 校验沙箱路径（确保不越界）
fn validate_sandbox_path(base: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    // 检查是否包含 .. 
    let target_str = target.to_string_lossy();
    if target_str.contains("..") {
        return Err("路径包含非法字符 ..".to_string());
    }

    // 检查是否在 base 目录下（使用 dunce::simplified 规范化后比较，避免反斜杠问题）
    let canonical_base = dunce::simplified(base);
    let canonical_target = dunce::simplified(target);
    if !canonical_target.starts_with(canonical_base) {
        return Err("路径超出沙箱范围".to_string());
    }

    // 禁止访问 .xt 配置文件夹
    let xt_path = canonical_base.join(".xt");
    let xt_path_str = xt_path.to_string_lossy().to_string();
    let target_str = canonical_target.to_string_lossy().to_string();
    if target_str.starts_with(&xt_path_str) {
        return Err("禁止访问 .xt 配置文件夹".to_string());
    }

    Ok(())
}

/// 沙箱：创建文件夹
#[tauri::command]
fn sandbox_create_folder(
    project_name: String,
    relative_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    fs::create_dir_all(&target).map_err(|e| format!("创建文件夹失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 沙箱：创建文件
#[tauri::command]
fn sandbox_create_file(
    project_name: String,
    relative_path: String,
    content: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    // 确保父目录存在
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
    }

    fs::write(&target, content).map_err(|e| format!("创建文件失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 沙箱：读取文件（文本）
#[tauri::command]
fn sandbox_read_file(
    project_name: String,
    relative_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() {
        return Err("文件不存在".to_string());
    }

    let content = fs::read_to_string(&target).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(content)
}

/// 沙箱：读取文件为 Base64（用于图片等二进制文件预览）
#[tauri::command]
fn sandbox_read_file_base64(
    project_name: String,
    relative_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() {
        return Err("文件不存在".to_string());
    }

    let bytes = fs::read(&target).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(BASE64.encode(&bytes))
}

/// 沙箱：写入文件
#[tauri::command]
fn sandbox_write_file(
    project_name: String,
    relative_path: String,
    content: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    // 自动创建父目录
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }

    fs::write(&target, content).map_err(|e| format!("写入文件失败: {}", e))?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct TreeEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    entry_type: String,
    children: Option<Vec<TreeEntry>>,
}

/// 词元使用记录
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TokenUsageRecord {
    id: String,
    expert_id: String,
    expert_name: String,
    model: String,
    key_id: String,
    timestamp: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}

/// 词元配额配置
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TokenAllocation {
    expert_id: String,
    daily_limit: Option<u64>,
    monthly_limit: Option<u64>,
    yearly_limit: Option<u64>,
}

/// 词元数据（记录 + 配额）
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TokenData {
    records: Vec<TokenUsageRecord>,
    allocations: Vec<TokenAllocation>,
    last_reset_daily: String,
    last_reset_monthly: String,
    last_reset_yearly: String,
}

/// 沙箱：列出目录内容
#[tauri::command]
fn sandbox_list_dir(
    project_name: String,
    relative_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if !target.exists() || !target.is_dir() {
        return Err("目录不存在".to_string());
    }

    /// 目录树条目上限
    const MAX_TREE_ENTRIES: usize = 10_000;

    fn read_dir_recursive(base: &PathBuf, current: &PathBuf, counter: &mut usize) -> Result<Vec<TreeEntry>, String> {
        let mut entries = vec![];
        for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
            if *counter >= MAX_TREE_ENTRIES {
                break;
            }

            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();

            // 跳过隐藏文件（但保留项目配置目录 .xt）
            if name.starts_with('.') && name != ".xt" {
                continue;
            }

            let full_path = entry.path();

            // 跳过常见无关目录
            if full_path.is_dir() && (full_path.is_symlink() || SCAN_SKIP_DIRS.contains(&name.as_str())) {
                continue;
            }

            let relative = full_path.strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .to_string()
                .replace("\\", "/");
            
            let is_dir = full_path.is_dir();
            let mut tree_entry = TreeEntry {
                name,
                path: relative,
                entry_type: if is_dir { "folder".to_string() } else { "file".to_string() },
                children: None,
            };
            
            *counter += 1;

            if is_dir {
                match read_dir_recursive(base, &full_path, counter) {
                    Ok(children) => {
                        tree_entry.children = Some(children);
                    }
                    Err(_) => {
                        tree_entry.children = Some(vec![]);
                    }
                }
            }
            
            entries.push(tree_entry);
        }
        
        // 文件夹在前，文件在后，各自按名称排序
        entries.sort_by(|a, b| {
            let a_is_dir = a.entry_type == "folder";
            let b_is_dir = b.entry_type == "folder";
            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });
        
        Ok(entries)
    }

    let mut counter = 0usize;
    let entries = read_dir_recursive(&project_dir, &target, &mut counter)?;
    Ok(serde_json::to_string(&entries).map_err(|e| e.to_string())?)
}

/// 沙箱：删除文件或空文件夹
#[tauri::command]
fn sandbox_delete(
    project_name: String,
    relative_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let target = project_dir.join(&relative_path);

    validate_sandbox_path(&project_dir, &target)?;

    if target.is_dir() {
        fs::remove_dir(&target).map_err(|e| format!("删除文件夹失败: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    Ok(())
}

/// 保存可视化目录数据到 .xt/config.json
/// data 格式: { mode: "structure" | "logic", nodes, edges, updatedAt, directorySnapshot }
/// 会按 mode 分别存入 canvasDirectory.structure 或 canvasDirectory.logic
#[tauri::command]
fn save_canvas_directory(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let config_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("config.json");

    if !config_file.exists() {
        ensure_xt_config(project_name.clone(), app_handle.clone())?;
    }

    let content = fs::read_to_string(&config_file).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let mut config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {}", e))?;

    let dir_data: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("解析目录数据失败: {}", e))?;

    // 获取 mode，决定存到 structure 还是 logic 子字段
    let mode = dir_data.get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("structure");

    if let Some(obj) = config.as_object_mut() {
        let canvas_dir = obj.entry("canvasDirectory")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(canvas_obj) = canvas_dir.as_object_mut() {
            canvas_obj.insert(mode.to_string(), dir_data);
        }
    }

    let updated = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&config_file, updated).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 从 .xt/config.json 加载可视化目录数据
/// 返回整个 canvasDirectory 对象（包含 structure 和 logic 两个子字段），如果不存在返回 null
#[tauri::command]
fn load_canvas_directory(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let config_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("config.json");

    if !config_file.exists() {
        return Ok("null".to_string());
    }

    let content = fs::read_to_string(&config_file).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("解析配置失败: {}", e))?;

    // 返回整个 canvasDirectory 对象（包含 structure 和 logic），如果不存在返回 null
    if let Some(dir) = config.get("canvasDirectory") {
        Ok(dir.to_string())
    } else {
        Ok("null".to_string())
    }
}

/// 保存项目到数据库
#[tauri::command]
async fn db_save_project(
    id: i64,
    name: String,
    icon_color: String,
    workspace_path: Option<String>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO projects (id, name, icon_color, workspace_path) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(name)
        .bind(icon_color)
        .bind(workspace_path)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 从数据库加载所有项目
#[tauri::command]
async fn db_load_projects(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let rows = sqlx::query("SELECT id, name, icon_color, workspace_path FROM projects ORDER BY created_at")
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    
    let projects: Vec<serde_json::Value> = rows.iter().map(|row| {
        serde_json::json!({
            "id": row.get::<i64, _>("id"),
            "name": row.get::<String, _>("name"),
            "iconColor": row.get::<String, _>("icon_color"),
            "workspacePath": row.get::<Option<String>, _>("workspace_path"),
        })
    }).collect();
    
    Ok(serde_json::to_string(&projects).map_err(|e| e.to_string())?)
}

/// 保存会话到数据库
#[tauri::command]
async fn db_save_session(
    project_id: i64,
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<i64, String> {
    let result = sqlx::query("INSERT INTO sessions (project_id, name) VALUES (?, ?)")
        .bind(project_id)
        .bind(name)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(result.last_insert_rowid())
}

/// 保存消息到数据库
#[tauri::command]
async fn db_save_message(
    session_id: i64,
    role: String,
    content: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .bind(session_id)
        .bind(role)
        .bind(content)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清除某个会话的所有消息（用于重新保存时去重）
#[tauri::command]
async fn db_clear_messages(
    session_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM messages WHERE session_id = ?")
        .bind(session_id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存项目聊天会话到 .xt/chat_sessions.json（项目级持久化）
#[tauri::command]
fn save_chat_sessions(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let sessions_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("chat_sessions.json");

    // 确保 .xt 目录存在
    if let Some(parent) = sessions_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&sessions_file, &data).map_err(|e| format!("写入会话文件失败: {}", e))?;
    Ok(())
}

/// 从项目 .xt/chat_sessions.json 加载聊天会话
#[tauri::command]
fn load_chat_sessions(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let sessions_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("chat_sessions.json");

    if !sessions_file.exists() {
        return Ok("null".to_string());
    }

    let content = fs::read_to_string(&sessions_file).map_err(|e| format!("读取会话文件失败: {}", e))?;
    Ok(content)
}

/// 保存词元数据到 .xt/token_data.json
#[tauri::command]
fn save_token_data(
    project_name: String,
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("token_data.json");

    if let Some(parent) = token_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&token_file, data).map_err(|e| format!("写入词元数据失败: {}", e))?;
    Ok(())
}

/// 从 .xt/token_data.json 加载词元数据
#[tauri::command]
fn load_token_data(
    project_name: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir
        .join("workspaces")
        .join(&project_name)
        .join(".xt")
        .join("token_data.json");

    if !token_file.exists() {
        let default = TokenData {
            records: vec![],
            allocations: vec![],
            last_reset_daily: String::new(),
            last_reset_monthly: String::new(),
            last_reset_yearly: String::new(),
        };
        return Ok(serde_json::to_string(&default).map_err(|e| e.to_string())?);
    }

    let content = fs::read_to_string(&token_file).map_err(|e| format!("读取词元数据失败: {}", e))?;
    Ok(content)
}

/// 保存用户级词元数据到 app_data_dir/user_token_data.json
#[tauri::command]
fn save_user_token_data(
    data: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir.join("user_token_data.json");

    if let Some(parent) = token_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    fs::write(&token_file, data).map_err(|e| format!("写入用户词元数据失败: {}", e))?;
    Ok(())
}

/// 从 app_data_dir/user_token_data.json 加载用户级词元数据
#[tauri::command]
fn load_user_token_data(
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let token_file = base_dir.join("user_token_data.json");

    if !token_file.exists() {
        let default = TokenData {
            records: vec![],
            allocations: vec![],
            last_reset_daily: String::new(),
            last_reset_monthly: String::new(),
            last_reset_yearly: String::new(),
        };
        return Ok(serde_json::to_string(&default).map_err(|e| e.to_string())?);
    }

    let content = fs::read_to_string(&token_file).map_err(|e| format!("读取用户词元数据失败: {}", e))?;
    Ok(content)
}

/// 从数据库加载项目的所有会话和消息
#[tauri::command]
async fn db_load_project_data(
    project_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    // 加载会话
    let session_rows = sqlx::query("SELECT id, name FROM sessions WHERE project_id = ? ORDER BY created_at")
        .bind(project_id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    
    let mut sessions: Vec<serde_json::Value> = vec![];
    for session_row in &session_rows {
        let session_id: i64 = session_row.get("id");
        let session_name: String = session_row.get("name");
        
        // 加载消息
        let msg_rows = sqlx::query("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at")
            .bind(session_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;
        
        let messages: Vec<serde_json::Value> = msg_rows.iter().map(|row| {
            serde_json::json!({
                "role": row.get::<String, _>("role"),
                "content": row.get::<String, _>("content"),
            })
        }).collect();
        
        sessions.push(serde_json::json!({
            "id": session_id,
            "name": session_name,
            "messages": messages,
        }));
    }
    
    Ok(serde_json::to_string(&sessions).map_err(|e| e.to_string())?)
}

/// 删除项目（级联删除会话和消息）
#[tauri::command]
async fn db_delete_project(
    id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存应用状态
#[tauri::command]
async fn db_save_state(
    key: String,
    value: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)")
        .bind(key)
        .bind(value)
        .execute(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 加载应用状态
#[tauri::command]
async fn db_load_state(
    key: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let row = sqlx::query("SELECT value FROM app_state WHERE key = ?")
        .bind(key)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    
    if let Some(r) = row {
        Ok(r.get::<String, _>("value"))
    } else {
        Ok("".to_string())
    }
}

/// ========== 记忆系统命令 ==========

#[derive(Serialize, Deserialize)]
struct MemorySaveRequest {
    project_name: String,
    entry: memory::MemoryEntry,
}

#[tauri::command]
fn memory_save(req: MemorySaveRequest, app_handle: tauri::AppHandle) -> Result<(), String> {
    let project_dir = get_project_dir(&req.project_name, &app_handle)?;
    memory::save_memory(&project_dir, &req.entry)
}

#[derive(Serialize, Deserialize)]
struct MemorySearchRequest {
    project_name: String,
    query: memory::MemoryQuery,
}

#[tauri::command]
fn memory_search(req: MemorySearchRequest, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&req.project_name, &app_handle)?;
    let results = memory::search_memories(&project_dir, &req.query)?;
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

#[tauri::command]
fn memory_delete(
    project_name: String,
    memory_type: String,
    id: String,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    memory::delete_memory(&project_dir, &memory_type, &id)
}

#[tauri::command]
fn memory_clear_type(
    project_name: String,
    memory_type: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    memory::clear_memory_type(&project_dir, &memory_type)
}

#[tauri::command]
fn memory_run_lifecycle(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    memory::run_memory_lifecycle(&project_dir)
}

#[tauri::command]
fn memory_get_stats(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let ephemeral = memory::load_memory_entries(&project_dir, "ephemeral")?.len();
    let working = memory::load_memory_entries(&project_dir, "working")?.len();
    let longterm = memory::load_memory_entries(&project_dir, "longterm")?.len();
    let stats = serde_json::json!({
        "ephemeral": ephemeral,
        "working": working,
        "longterm": longterm,
        "total": ephemeral + working + longterm,
    });
    serde_json::to_string(&stats).map_err(|e| e.to_string())
}

/// 解析项目目录：优先使用 DB 中的 workspace_path（支持外部项目），否则 fallback 到 workspaces/
async fn resolve_project_dir(
    project_name: &str,
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, Arc<AppState>>,
) -> Result<PathBuf, String> {
    let row = sqlx::query("SELECT workspace_path FROM projects WHERE name = ?")
        .bind(project_name)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| format!("查询项目路径失败: {}", e))?;

    if let Some(row) = row {
        let workspace_path: Option<String> = row.get("workspace_path");
        if let Some(path) = workspace_path {
            if !path.is_empty() {
                let p = PathBuf::from(&path);
                if p.exists() {
                    return Ok(p);
                }
                eprintln!("[INDEX] 外部项目路径不存在，尝试 fallback: {}", path);
            }
        }
    }

    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(base_dir.join("workspaces").join(project_name))
}

/// 构建感知索引（异步，避免阻塞线程池）
#[tauri::command]
async fn perceptual_index_build(
    project_name: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    eprintln!("[INDEX] 构建索引: {}", project_dir.display());
    let status = tokio::task::spawn_blocking(move || perceptual_index::build_index(&project_dir))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::to_string(&status).map_err(|e| e.to_string())?)
}

/// 感知索引融合搜索（返回格式化文本供 AI 上下文使用）
#[tauri::command]
async fn perceptual_index_search(
    project_name: String,
    query: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    perceptual_index::search_formatted(&project_dir, &query)
}

/// 查询感知索引状态
#[tauri::command]
async fn perceptual_index_status(
    project_name: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_name, &app_handle, &state).await?;

    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }

    let status = perceptual_index::get_index_status(&project_dir);
    Ok(serde_json::to_string(&status).map_err(|e| e.to_string())?)
}

// ========== Wiki 知识库命令 ==========

/// 列出仓库导航项
#[tauri::command]
fn repo_list_items(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let items = repo_wiki::list_repo_items(&project_dir);
    Ok(serde_json::to_string(&items).map_err(|e| e.to_string())?)
}

/// 读取知识卡片
#[tauri::command]
fn repo_read_cards(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let cards = repo_wiki::read_cards(&project_dir)?;
    Ok(serde_json::to_string(&cards).map_err(|e| e.to_string())?)
}

/// 读取 Wiki 文章
#[tauri::command]
fn repo_read_wiki(project_name: String, name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    repo_wiki::read_wiki(&project_dir, &name)
}

/// 全量生成 Knowledge Cards（调用 AI）
#[tauri::command]
async fn repo_generate_cards(project_name: String, api_key: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let cards = repo_wiki::generate_cards(&project_dir, &api_key).await?;
    Ok(serde_json::to_string(&cards).map_err(|e| e.to_string())?)
}

/// 从卡片二次凝练 Wiki 文章（调用 AI）
#[tauri::command]
async fn repo_synthesize_wiki(project_name: String, api_key: String, name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    let wiki = repo_wiki::synthesize_wiki(&project_dir, &api_key, &name).await?;
    Ok(serde_json::to_string(&wiki).map_err(|e| e.to_string())?)
}

/// 增量迭代：对比文件快照，只更新变化的卡片
#[tauri::command]
async fn repo_incremental_update(project_name: String, api_key: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    if !project_dir.exists() {
        return Err("项目不存在".to_string());
    }
    repo_wiki::incremental_update(&project_dir, &api_key).await
}

// ========== 交付清单命令 ==========

#[derive(Serialize, Deserialize)]
struct GenerateDeliverableRequest {
    project_name: String,
    task_id: String,
    task_description: String,
    expert_outputs: Vec<ExpertOutputItem>,
}

#[derive(Serialize, Deserialize)]
struct ExpertOutputItem {
    expert_id: String,
    expert_name: String,
    status: String,
    output: String,
}

#[tauri::command]
fn generate_deliverable(req: GenerateDeliverableRequest, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&req.project_name, &app_handle)?;

    let outputs: Vec<(String, String, String, String)> = req.expert_outputs
        .into_iter()
        .map(|item| (item.expert_id, item.expert_name, item.status, item.output))
        .collect();

    let deliverable = deliverables::generate_deliverable(&req.task_id, &req.task_description, &outputs);
    deliverables::save_deliverable(&project_dir, &deliverable)?;

    serde_json::to_string(&deliverable).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_deliverables(project_name: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    let list = deliverables::list_deliverables(&project_dir)?;
    serde_json::to_string(&list).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_deliverable(project_name: String, task_id: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let project_dir = get_project_dir(&project_name, &app_handle)?;
    match deliverables::load_deliverable(&project_dir, &task_id)? {
        Some(d) => serde_json::to_string(&d).map_err(|e| e.to_string()),
        None => Ok("null".to_string()),
    }
}

// ---- 健康度评分命令 ----

#[tauri::command]
fn evaluate_project_health(project_path: String) -> Result<String, String> {
    let score = health_score::evaluate_health(&project_path);
    serde_json::to_string(&score).map_err(|e| e.to_string())
}

// ---- 代码保留率命令 ----

#[tauri::command]
fn evaluate_code_retention(project_name: String, project_path: String) -> Result<String, String> {
    let report = code_retention::evaluate_retention(&project_name, &project_path)?;
    serde_json::to_string(&report).map_err(|e| e.to_string())
}

#[tauri::command]
fn register_generated_snippet(
    project_name: String,
    expert_id: String,
    expert_name: String,
    file_path: String,
    content: String,
) -> Result<String, String> {
    let id = code_retention::register_generated_code(&project_name, &expert_id, &expert_name, &file_path, &content)?;
    Ok(id)
}

#[tauri::command]
fn list_retention_snippets(project_name: String) -> Result<String, String> {
    let snippets = code_retention::list_snippets(&project_name)?;
    serde_json::to_string(&snippets).map_err(|e| e.to_string())
}

// ---- RBAC 权限命令 ----

#[tauri::command]
fn check_expert_permission(expert_id: String, permission: String) -> Result<String, String> {
    let perm = match permission.as_str() {
        "ReadFiles" => rbac::Permission::ReadFiles,
        "WriteFiles" => rbac::Permission::WriteFiles,
        "DeleteFiles" => rbac::Permission::DeleteFiles,
        "ExecuteCode" => rbac::Permission::ExecuteCode,
        "CallExternalApi" => rbac::Permission::CallExternalApi,
        "AccessMemory" => rbac::Permission::AccessMemory,
        "ModifyMemory" => rbac::Permission::ModifyMemory,
        "AccessTokenData" => rbac::Permission::AccessTokenData,
        "SupervisorOverride" => rbac::Permission::SupervisorOverride,
        _ => return Err(format!("未知权限: {}", permission)),
    };
    let decision = rbac::check_permission(&expert_id, perm);
    serde_json::to_string(&decision).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_expert_path_access(expert_id: String, path: String) -> Result<String, String> {
    let decision = rbac::check_path_access(&expert_id, &path);
    serde_json::to_string(&decision).map_err(|e| e.to_string())
}

// ---- 经验沉淀命令 ----

#[tauri::command]
fn get_experience_沉淀(expert_id: String, expert_name: String) -> Result<String, String> {
    // 简化版：返回基于专家ID的默认经验沉淀
    let exp = experience::generate_experience_沉淀(
        &expert_id,
        &expert_name,
        &[],
        &[],
    );
    serde_json::to_string(&exp).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 使用spawn非阻塞初始化数据库，避免卡住主线程
            tauri::async_runtime::spawn(async move {
                match init_db_pool(&handle).await {
                    Ok(pool) => {
                        handle.manage(Arc::new(AppState { db: pool }));
                        eprintln!("[DB] 数据库初始化成功");
                    }
                    Err(e) => {
                        eprintln!("[DB] 数据库初始化失败: {}", e);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_data_dir,
            create_workspace,
            workspace_exists,
            open_project_is_dir,
            open_project_from_path,
            list_workspaces,
            ensure_xt_config,
            chat_with_deepseek,
            chat_with_expert,
            test_api_key,
            scan_project_structure,
            analyze_project_dependencies,
            save_projects,
            load_projects,
            save_app_state,
            load_app_state,
            save_key_pool,
            load_key_pool,
            save_experts,
            load_experts,
            sandbox_create_folder,
            sandbox_create_file,
            sandbox_read_file,
            sandbox_read_file_base64,
            sandbox_write_file,
            sandbox_list_dir,
            sandbox_delete,
            save_canvas_directory,
            load_canvas_directory,
            db_save_project,
            db_load_projects,
            db_save_session,
            db_save_message,
            db_clear_messages,
            db_load_project_data,
            db_delete_project,
            db_save_state,
            db_load_state,
            save_chat_sessions,
            load_chat_sessions,
            perceptual_index_build,
            perceptual_index_search,
            perceptual_index_status,
            repo_list_items,
            repo_read_cards,
            repo_read_wiki,
            repo_generate_cards,
            repo_synthesize_wiki,
            repo_incremental_update,
            save_draft,
            load_draft,
            save_token_data,
            load_token_data,
            save_user_token_data,
            load_user_token_data,
            memory_save,
            memory_search,
            memory_delete,
            memory_clear_type,
            memory_run_lifecycle,
            memory_get_stats,
            generate_deliverable,
            list_deliverables,
            load_deliverable,
            evaluate_project_health,
            evaluate_code_retention,
            register_generated_snippet,
            list_retention_snippets,
            check_expert_permission,
            check_expert_path_access,
            get_experience_沉淀,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
