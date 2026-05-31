use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub requires_auth: bool,
    pub auth_reason: String,
}

/// 危险命令列表
const DANGEROUS_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "format c:",
    "format d:",
    "del /s /q c:\\",
    "del /s /q d:\\",
    "rd /s /q c:\\",
    "rd /s /q d:\\",
    "mkfs",
    "dd if=",
    ":(){:|:&};:",
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

/// 检查命令安全性
pub fn check_safety(command: &str, args: &[String], working_dir: &str, project_dir: &str) -> CommandResult {
    // 1. 规范化路径
    let work_path = Path::new(working_dir);
    let project_path = Path::new(project_dir);

    let abs_work = if work_path.is_absolute() {
        work_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(work_path)
    };

    let abs_project = if project_path.is_absolute() {
        project_path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(project_path)
    };

    // 2. 检查工作目录是否在项目目录内
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

    // 3. 检查危险命令
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

    // 4. 检查是否需要管理员权限
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

    // 安全通过
    CommandResult {
        stdout: String::new(),
        stderr: String::new(),
        exit_code: 0,
        requires_auth: false,
        auth_reason: String::new(),
    }
}

/// 执行命令
pub fn execute(command: &str, args: &[String], working_dir: &str) -> Result<CommandResult, String> {
    let work_path = Path::new(working_dir);
    if !work_path.exists() {
        return Err(format!("工作目录不存在: {}", working_dir));
    }

    // 根据操作系统选择 shell
    let (shell, shell_arg) = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };

    // 构建完整命令字符串
    let full_cmd = if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    };

    // 使用线程执行以实现超时保护
    let working_dir_owned = working_dir.to_string();
    let shell_owned = shell.to_string();
    let shell_arg_owned = shell_arg.to_string();

    let handle = std::thread::spawn(move || {
        Command::new(&shell_owned)
            .arg(&shell_arg_owned)
            .arg(&full_cmd)
            .current_dir(&working_dir_owned)
            .output()
    });

    // 30秒超时
    let timeout = Duration::from_secs(30);
    let start = std::time::Instant::now();

    loop {
        if handle.is_finished() {
            break;
        }
        if start.elapsed() > timeout {
            return Err("命令执行超时（30秒限制）".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
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
