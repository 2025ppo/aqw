use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
fn should_use_powershell(command: &str) -> bool {
    let trimmed = command.trim();
    let lower = trimmed.to_lowercase();

    lower.starts_with("powershell")
        || lower.starts_with("pwsh")
        || lower.starts_with("get-")
        || lower == "pwd"
        || lower.starts_with("pwd ")
        || lower.starts_with("set-")
        || lower.starts_with("select-")
        || lower.starts_with("where-")
        || lower.starts_with("foreach-")
        || lower.starts_with("new-")
        || lower.starts_with("remove-")
        || lower.starts_with("copy-")
        || lower.starts_with("move-")
        || lower.starts_with("write-")
        || lower.starts_with("test-")
        || lower.starts_with("rg ")
        || lower.starts_with("findstr ")
        || lower.starts_with("join-path")
        || lower.starts_with("$")
        || trimmed.contains('\'')
        || trimmed.contains(" | ")
        || trimmed.contains("$env:")
        || trimmed.contains("Out-File")
        || trimmed.contains("Select-String")
        || trimmed.contains("Get-Content")
        || trimmed.contains("Get-ChildItem")
}

#[cfg(windows)]
fn normalize_windows_command(command: &str, use_powershell: bool) -> String {
    let mut normalized = command
        .replace("\\\"", "\"")
        .replace("\\'", "'");

    if use_powershell {
        if normalized.eq_ignore_ascii_case("pwd") {
            normalized = "Get-Location".to_string();
        }
        normalized = normalized.replace("2>nul", "2>$null");
        normalized = normalized.replace(" 2>nul", " 2>$null");
        if let Some((before, after)) = normalized.split_once("| head -") {
            let count: String = after.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if !count.is_empty() {
                normalized = format!(
                    "{} | Select-Object -First {}{}",
                    before.trim_end(),
                    count,
                    &after[count.len()..]
                );
            }
        }
        if let Some((before, after)) = normalized.split_once("| head ") {
            let count: String = after
                .trim_start()
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect();
            if !count.is_empty() {
                let suffix = after.trim_start();
                normalized = format!(
                    "{} | Select-Object -First {}{}",
                    before.trim_end(),
                    count,
                    &suffix[count.len()..]
                );
            }
        }
        if normalized.contains("Get-Content")
            && normalized.contains("-Raw")
            && normalized.contains("-TotalCount")
        {
            normalized = normalized.replace(" -Raw", "");
        }
        if normalized.contains("Select-String")
            && normalized.contains("\\x{")
            && normalized.contains("-Pattern")
        {
            normalized = normalized
                .replace("Select-String -Path ", "rg -n -P ")
                .replace(" -AllMatches | Select-Object -First 20", "")
                .replace(" | Select-Object -First 20", "");
        }
    }

    normalized
}

// ===== Legacy compatibility types (used by existing lib.rs commands) =====

#[derive(Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub requires_auth: bool,
    pub auth_reason: String,
}

/// 危险命令列表 (legacy + enhanced)
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "format c:",
    "format d:",
    "del /s /q c:\\",
    "del /s /q d:\\",
    "del /f /s /q",
    "rd /s /q c:\\",
    "rd /s /q d:\\",
    "mkfs",
    "dd if=",
    ":(){:|:&};:",
    ":(){ :|:& };:",
    "shutdown",
    "reboot",
    "init 0",
    "init 6",
];

/// 需要管理员权限的命令前缀
const ADMIN_COMMANDS: &[&str] = &[
    "sudo",
    "runas",
    "dism",
    "bcdedit",
    "net user",
    "net localgroup",
    "sc create",
    "sc delete",
    "reg add",
    "reg delete",
];

// ===== Legacy API (backward compatibility with existing lib.rs) =====

/// 检查命令安全性 (legacy API)
pub fn check_safety(
    command: &str,
    args: &[String],
    working_dir: &str,
    project_dir: &str,
) -> CommandResult {
    let work_path = Path::new(working_dir);
    let project_path = Path::new(project_dir);

    let abs_work = if work_path.is_absolute() {
        work_path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(work_path)
    };

    let abs_project = if project_path.is_absolute() {
        project_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(project_path)
    };

    let work_str = abs_work.to_string_lossy().to_lowercase();
    let project_str = abs_project.to_string_lossy().to_lowercase();

    if !work_str.starts_with(&project_str) {
        return CommandResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: -1,
            requires_auth: true,
            auth_reason: format!(
                "工作目录 {} 不在项目目录 {} 范围内",
                working_dir, project_dir
            ),
        };
    }

    let full_command = format!("{} {}", command, args.join(" ")).to_lowercase();
    for pattern in DANGEROUS_PATTERNS {
        if full_command.contains(pattern) {
            return CommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: -1,
                requires_auth: true,
                auth_reason: format!("检测到危险命令模式: {}", pattern),
            };
        }
    }

    let cmd_lower = command.to_lowercase();
    for admin_cmd in ADMIN_COMMANDS {
        if cmd_lower.starts_with(admin_cmd) || full_command.starts_with(admin_cmd) {
            return CommandResult {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: -1,
                requires_auth: true,
                auth_reason: format!("命令需要管理员权限: {}", admin_cmd),
            };
        }
    }

    CommandResult {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: 0,
        requires_auth: false,
        auth_reason: String::new(),
    }
}

/// 执行命令 (legacy API)
pub fn execute(command: &str, args: &[String], working_dir: &str) -> Result<CommandResult, String> {
    let work_path = Path::new(working_dir);
    if !work_path.exists() {
        return Err(format!("工作目录不存在: {}", working_dir));
    }

    // Windows 下使用 PowerShell（NoProfile）以支持 rg / Select-String / Get-ChildItem 等 cmdlet；
    // 同时通过 -Command 仍兼容大多数 cmd 风格命令（dir/echo/type 在 PS 中是别名）。
    let full_cmd = if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    };

    let working_dir_owned = working_dir.to_string();
    let full_cmd_owned = full_cmd.clone();

    let handle = std::thread::spawn(move || {
        if cfg!(target_os = "windows") {
            let use_powershell = should_use_powershell(&full_cmd_owned);
            let shell_command = normalize_windows_command(&full_cmd_owned, use_powershell);
            if use_powershell {
                std::process::Command::new("powershell")
                    .args(["-NoProfile", "-NonInteractive", "-Command", &shell_command])
                    .current_dir(&working_dir_owned)
                    .output()
            } else {
                std::process::Command::new("cmd")
                    .args(["/D", "/S", "/C", &shell_command])
                    .current_dir(&working_dir_owned)
                    .output()
            }
        } else {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(&full_cmd_owned)
                .current_dir(&working_dir_owned)
                .output()
        }
    });

    let timeout_dur = std::time::Duration::from_secs(30);
    let start = std::time::Instant::now();

    loop {
        if handle.is_finished() {
            break;
        }
        if start.elapsed() > timeout_dur {
            return Err("命令执行超时（30秒限制）".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let output = handle
        .join()
        .map_err(|_| "命令线程异常退出".to_string())?
        .map_err(|e| format!("命令执行失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok(CommandResult {
        stdout,
        stderr,
        exit_code,
        requires_auth: false,
        auth_reason: String::new(),
    })
}

// ===== Enhanced API (new production-grade execution engine) =====

/// 执行配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecConfig {
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub max_output_lines: usize,
    pub kill_on_timeout: bool,
    pub working_dir_sandbox: bool,
    pub env_overrides: HashMap<String, String>,
}

impl Default for ExecConfig {
    fn default() -> Self {
        Self {
            timeout_ms: 60000,
            max_output_bytes: 1_048_576,
            max_output_lines: 5000,
            kill_on_timeout: true,
            working_dir_sandbox: true,
            env_overrides: HashMap::new(),
        }
    }
}

/// 结构化执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub wall_time_ms: u64,
    pub truncated: bool,
    pub killed: bool,
    pub total_lines: usize,
}

impl ExecOutput {
    /// 格式化为模型可读的字符串
    pub fn format_for_model(&self) -> String {
        let mut result = format!(
            "Exit code: {} | Wall time: {:.1}s",
            self.exit_code,
            self.wall_time_ms as f64 / 1000.0
        );
        if self.killed {
            result.push_str(" | KILLED(timeout)");
        }
        if self.truncated {
            result.push_str(&format!(
                " | TRUNCATED(showed partial of {} lines)",
                self.total_lines
            ));
        }
        result.push_str("\n\nOutput:\n");
        if !self.stdout.is_empty() {
            result.push_str(&self.stdout);
        }
        if !self.stderr.is_empty() {
            result.push_str("\nStderr:\n");
            result.push_str(&self.stderr);
        }
        result
    }
}

/// Head+Tail Buffer: 保留前N行和后N行
struct HeadTailBuffer {
    head: Vec<String>,
    tail: VecDeque<String>,
    head_limit: usize,
    tail_limit: usize,
    pub total_lines: usize,
    total_bytes: usize,
    max_bytes: usize,
}

impl HeadTailBuffer {
    fn new(head_limit: usize, tail_limit: usize, max_bytes: usize) -> Self {
        Self {
            head: Vec::with_capacity(head_limit),
            tail: VecDeque::with_capacity(tail_limit + 1),
            head_limit,
            tail_limit,
            total_lines: 0,
            total_bytes: 0,
            max_bytes,
        }
    }

    fn push_line(&mut self, line: String) {
        self.total_bytes += line.len() + 1; // +1 for newline
        self.total_lines += 1;

        // If within byte limit and head not full, add to head
        if self.head.len() < self.head_limit {
            self.head.push(line);
        } else {
            // Add to tail ring buffer
            if self.tail.len() >= self.tail_limit {
                self.tail.pop_front();
            }
            self.tail.push_back(line);
        }
    }

    fn is_over_limit(&self) -> bool {
        self.total_bytes > self.max_bytes
    }

    fn build_output(&self) -> (String, bool) {
        let truncated = self.total_lines > self.head_limit && !self.tail.is_empty();

        if !truncated {
            // All output fits in head
            return (self.head.join("\n"), false);
        }

        // Head + truncation marker + tail
        let skipped = self.total_lines - self.head_limit - self.tail.len();
        let mut output = self.head.join("\n");
        if skipped > 0 {
            output.push_str(&format!("\n\n[...truncated {} lines...]\n\n", skipped));
        } else {
            output.push('\n');
        }
        let tail_text: Vec<&str> = self.tail.iter().map(|s| s.as_str()).collect();
        output.push_str(&tail_text.join("\n"));
        (output, true)
    }
}

/// 危险命令检测结果
#[derive(Debug)]
pub enum CommandSafetyResult {
    Safe,
    Dangerous(String),
    NeedsElevation(String),
}

/// 危险命令检测(增强版)
pub fn check_command_safety_enhanced(command: &str) -> CommandSafetyResult {
    let cmd_lower = command.to_lowercase();

    for pattern in DANGEROUS_PATTERNS {
        if cmd_lower.contains(pattern) {
            return CommandSafetyResult::Dangerous(format!(
                "检测到危险命令模式: {}",
                pattern
            ));
        }
    }

    for admin_cmd in ADMIN_COMMANDS {
        if cmd_lower.starts_with(admin_cmd) {
            return CommandSafetyResult::NeedsElevation(format!(
                "命令需要管理员权限: {}",
                admin_cmd
            ));
        }
    }

    CommandSafetyResult::Safe
}

/// 核心执行函数 (enhanced, async, production-grade)
pub async fn execute_command_enhanced(
    command: &str,
    project_dir: &str,
    working_dir: Option<&str>,
    config: Option<ExecConfig>,
) -> Result<ExecOutput, String> {
    let config = config.unwrap_or_default();
    let start = std::time::Instant::now();

    // 1. 路径沙箱检查
    let actual_dir = if let Some(wd) = working_dir {
        let full = Path::new(project_dir).join(wd);
        if config.working_dir_sandbox && !full.starts_with(project_dir) {
            return Err("Working directory outside project sandbox".into());
        }
        full.to_string_lossy().to_string()
    } else {
        project_dir.to_string()
    };

    // 2. 构建命令(跨平台) — Windows 下使用 PowerShell 以支持现代 cmdlet (rg/Select-String/Get-*)
    let mut cmd = if cfg!(windows) {
        let use_powershell = should_use_powershell(command);
        let shell_command = normalize_windows_command(command, use_powershell);
        let mut c = if use_powershell {
            let mut ps = Command::new("powershell");
            ps.args(["-NoProfile", "-NonInteractive", "-Command", &shell_command]);
            ps
        } else {
            let mut cmd = Command::new("cmd");
            cmd.args(["/D", "/S", "/C", &shell_command]);
            cmd
        };
        #[cfg(windows)]
        c.creation_flags(0x00000200); // CREATE_NEW_PROCESS_GROUP
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(&actual_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // 3. 环境变量
    for (key, val) in &config.env_overrides {
        cmd.env(key, val);
    }

    // 4. 启动进程
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;

    let child_stdout = child.stdout.take().unwrap();
    let child_stderr = child.stderr.take().unwrap();

    // 5. 异步读取输出(带超时)
    let max_out = config.max_output_bytes;
    let result = timeout(Duration::from_millis(config.timeout_ms), async {
        let stdout_reader = BufReader::new(child_stdout);
        let stderr_reader = BufReader::new(child_stderr);

        let mut stdout_lines = stdout_reader.lines();
        let mut stderr_lines = stderr_reader.lines();

        let mut stdout_buffer = HeadTailBuffer::new(500, 500, max_out);
        let mut stderr_buffer = HeadTailBuffer::new(100, 100, max_out / 4);

        // Read stdout and stderr concurrently
        let stdout_handle = tokio::spawn(async move {
            let mut buf = HeadTailBuffer::new(500, 500, max_out);
            while let Ok(Some(line)) = stdout_lines.next_line().await {
                buf.push_line(line);
                if buf.is_over_limit() {
                    break;
                }
            }
            buf
        });

        let stderr_handle = tokio::spawn(async move {
            let mut buf = HeadTailBuffer::new(100, 100, max_out / 4);
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                buf.push_line(line);
                if buf.is_over_limit() {
                    break;
                }
            }
            buf
        });

        stdout_buffer = stdout_handle.await.unwrap_or(stdout_buffer);
        stderr_buffer = stderr_handle.await.unwrap_or(stderr_buffer);

        (stdout_buffer, stderr_buffer)
    })
    .await;

    let killed = result.is_err();
    let (stdout_buffer, stderr_buffer) = match result {
        Ok(buffers) => buffers,
        Err(_) => {
            // Timeout - kill the process
            if config.kill_on_timeout {
                let _ = child.kill().await;
            }
            (
                HeadTailBuffer::new(500, 500, max_out),
                HeadTailBuffer::new(100, 100, max_out / 4),
            )
        }
    };

    let exit_code = child
        .wait()
        .await
        .map(|s| s.code().unwrap_or(-1))
        .unwrap_or(-1);
    let wall_time_ms = start.elapsed().as_millis() as u64;

    let (stdout_text, stdout_truncated) = stdout_buffer.build_output();
    let (stderr_text, stderr_truncated) = stderr_buffer.build_output();
    let total_lines = stdout_buffer.total_lines + stderr_buffer.total_lines;

    Ok(ExecOutput {
        exit_code,
        stdout: stdout_text,
        stderr: stderr_text,
        wall_time_ms,
        truncated: stdout_truncated || stderr_truncated,
        killed,
        total_lines,
    })
}

/// 兼容层：简单接口（内部调用enhanced版本）
pub async fn execute_command_async(command: &str, project_dir: &str) -> Result<String, String> {
    let output = execute_command_enhanced(command, project_dir, None, None).await?;
    Ok(output.format_for_model())
}
