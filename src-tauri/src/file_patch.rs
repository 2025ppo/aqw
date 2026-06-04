use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

// ===== Patch 格式定义 =====

/// Patch操作类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PatchHunk {
    /// 新建文件
    AddFile { path: String, content: String },
    /// 删除文件
    DeleteFile { path: String },
    /// 更新文件（精准修改）
    UpdateFile {
        path: String,
        changes: Vec<FileChange>,
    },
    /// 移动/重命名文件（可选同时修改内容）
    MoveFile {
        from: String,
        to: String,
        changes: Vec<FileChange>,
    },
}

/// 单个文件内的变更块
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub context: Option<String>, // @@ 定位上下文（函数名/类名/标记行）
    pub old_lines: Vec<String>,  // 要删除的行（- 前缀）
    pub new_lines: Vec<String>,  // 要新增的行（+ 前缀）
    pub is_end_of_file: bool,    // 是否在文件末尾操作
}

/// 完整的Patch结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Patch {
    pub hunks: Vec<PatchHunk>,
}

/// 应用结果（含Delta跟踪）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchResult {
    pub success: bool,
    pub applied: Vec<AppliedChange>, // 已成功应用的变更
    pub errors: Vec<PatchError>,     // 失败的变更
    pub summary: String,             // 给模型的摘要
    pub delta: AppliedDelta,         // Delta跟踪
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedChange {
    pub path: String,
    pub operation: String, // "A"(add), "M"(modify), "D"(delete), "R"(move/rename)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchError {
    pub path: String,
    pub message: String,
    pub hunk_index: usize,
}

// ===== Delta 跟踪 =====

/// 跟踪已完成的变更，即使部分失败也能告诉模型哪些文件已经改好
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedDelta {
    pub applied_operations: Vec<DeltaEntry>,
    pub exact: bool, // 所有副作用是否可确认
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaEntry {
    pub operation: String, // "add", "update", "delete", "move"
    pub path: String,
    pub success: bool,
    pub detail: Option<String>,
}

impl AppliedDelta {
    fn new() -> Self {
        Self {
            applied_operations: Vec::new(),
            exact: true,
        }
    }

    fn push(&mut self, operation: &str, path: &str, success: bool, detail: Option<String>) {
        self.applied_operations.push(DeltaEntry {
            operation: operation.to_string(),
            path: path.to_string(),
            success,
            detail,
        });
    }
}

// ===== 路径安全检查 =====

/// 验证路径安全性：拒绝绝对路径、路径穿越、符号链接
fn validate_path(file_path: &str, project_root: &Path) -> Result<PathBuf, String> {
    // 1. 拒绝绝对路径
    if Path::new(file_path).is_absolute() {
        return Err(format!("Absolute paths not allowed: {}", file_path));
    }

    // 2. 显式拒绝 .. 路径穿越，避免依赖 canonicalize 处理不存在的新文件
    if Path::new(file_path)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "Path traversal detected: {} escapes project root",
            file_path
        ));
    }

    // 3. 规范化路径。Windows 下用 dunce 去掉 `\\?\` 前缀，避免新文件路径比较误判。
    let full_path = project_root.join(file_path);
    let normalized_path = if full_path.exists() {
        dunce::canonicalize(&full_path).unwrap_or_else(|_| full_path.clone())
    } else {
        full_path.clone()
    };

    // 4. 检测路径穿越（解析后的路径必须在 project_root 内）
    let canonical_root =
        dunce::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    if !normalized_path.starts_with(&canonical_root) {
        return Err(format!(
            "Path traversal detected: {} escapes project root",
            file_path
        ));
    }

    // 5. 检测符号链接（如果路径存在）
    if normalized_path.exists() {
        let metadata = std::fs::symlink_metadata(&normalized_path)
            .map_err(|e| format!("Cannot read metadata: {}", e))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Symlink not allowed: {}", file_path));
        }
    }

    Ok(full_path)
}

// ===== Patch 解析器 =====

/// 解析Patch文本为结构体
pub fn parse_patch(input: &str) -> Result<Patch, String> {
    let mut hunks = Vec::new();
    let raw_lines: Vec<&str> = input.lines().collect();
    let mut i = 0;

    // 跳过可能的 heredoc 包装 (<<'EOF' ... EOF) - 兼容性处理
    let lines = strip_heredoc_wrapper(&raw_lines);

    // 查找 *** Begin Patch
    while i < lines.len() {
        if lines[i].trim() == "*** Begin Patch" {
            i += 1;
            break;
        }
        i += 1;
    }

    if i >= lines.len() {
        return Err("未找到 '*** Begin Patch' 标记".into());
    }

    // 解析各个Hunk
    while i < lines.len() {
        let line = lines[i].trim();

        if line == "*** End Patch" {
            break;
        } else if line.starts_with("*** Add File: ") {
            let path = line.trim_start_matches("*** Add File: ").to_string();
            i += 1;
            let mut content_lines = Vec::new();
            while i < lines.len() && lines[i].starts_with('+') {
                content_lines.push(lines[i][1..].to_string()); // 去掉 + 前缀
                i += 1;
            }
            hunks.push(PatchHunk::AddFile {
                path,
                content: content_lines.join("\n"),
            });
        } else if line.starts_with("*** Delete File: ") {
            let path = line.trim_start_matches("*** Delete File: ").to_string();
            hunks.push(PatchHunk::DeleteFile { path });
            i += 1;
        } else if line.starts_with("*** Update File: ") {
            let path = line.trim_start_matches("*** Update File: ").to_string();
            i += 1;

            // 检查是否有 *** Move to: 标记
            let move_to = if i < lines.len() && lines[i].trim().starts_with("*** Move to: ") {
                let dest = lines[i]
                    .trim()
                    .trim_start_matches("*** Move to: ")
                    .to_string();
                i += 1;
                Some(dest)
            } else {
                None
            };

            let mut changes = Vec::new();

            while i < lines.len() {
                let l = lines[i];
                if l.starts_with("*** ") {
                    break; // 下一个hunk或End Patch
                }

                if l.starts_with("@@") {
                    // 解析变更块
                    let context = if l.len() > 2 && !l[2..].trim().is_empty() {
                        Some(l[2..].trim().to_string())
                    } else {
                        None
                    };
                    i += 1;

                    let mut old_lines = Vec::new();
                    let mut new_lines = Vec::new();
                    let mut is_eof = false;

                    while i < lines.len() {
                        let cl = lines[i];
                        if cl.starts_with("@@") || cl.starts_with("*** ") {
                            break;
                        }
                        if cl == "*** End of File" {
                            is_eof = true;
                            i += 1;
                            break;
                        }
                        if cl.starts_with('-') {
                            old_lines.push(cl[1..].to_string());
                        } else if cl.starts_with('+') {
                            new_lines.push(cl[1..].to_string());
                        } else if cl.starts_with(' ') {
                            // 上下文行 - 同时加入old和new
                            old_lines.push(cl[1..].to_string());
                            new_lines.push(cl[1..].to_string());
                        } else {
                            // 无前缀行当作上下文
                            old_lines.push(cl.to_string());
                            new_lines.push(cl.to_string());
                        }
                        i += 1;
                    }

                    changes.push(FileChange {
                        context,
                        old_lines,
                        new_lines,
                        is_end_of_file: is_eof,
                    });
                } else {
                    i += 1;
                }
            }

            // 根据是否有 move_to 决定生成 MoveFile 还是 UpdateFile
            if let Some(dest) = move_to {
                hunks.push(PatchHunk::MoveFile {
                    from: path,
                    to: dest,
                    changes,
                });
            } else {
                hunks.push(PatchHunk::UpdateFile { path, changes });
            }
        } else {
            i += 1;
        }
    }

    if hunks.is_empty() {
        return Err("Patch中没有找到任何变更操作".into());
    }

    Ok(Patch { hunks })
}

/// 去掉heredoc包装（兼容GPT-4.1的行为）
fn strip_heredoc_wrapper<'a>(lines: &'a [&'a str]) -> Vec<&'a str> {
    if lines.is_empty() {
        return lines.to_vec();
    }

    // 检查是否有heredoc头
    let first = lines[0].trim();
    if first.starts_with("<<")
        && (first.contains("'EOF'") || first.contains("\"EOF\"") || first.ends_with("EOF"))
    {
        // 去掉第一行和最后一个EOF行
        let mut result: Vec<&str> = lines[1..].to_vec();
        if let Some(last) = result.last() {
            if last.trim() == "EOF" {
                result.pop();
            }
        }
        return result;
    }

    lines.to_vec()
}

// ===== 四级容错匹配 =====

/// 在文件内容中查找匹配的行序列（含尾部空行容错）
fn seek_sequence(
    file_lines: &[&str],
    target_lines: &[String],
    start_from: usize,
    is_end_of_file: bool,
) -> Option<usize> {
    if target_lines.is_empty() {
        return Some(start_from);
    }

    // 当 pattern 长度超过文件行数时无法匹配
    if target_lines.len() > file_lines.len() {
        return None;
    }

    // 先尝试完整匹配
    let found = seek_sequence_inner(file_lines, target_lines, start_from, is_end_of_file);

    if found.is_some() {
        return found;
    }

    // 尾部空行容错：模型经常多输出一个尾部空行，去掉后重试
    if let Some(last) = target_lines.last() {
        if last.is_empty() && target_lines.len() > 1 {
            let trimmed_pattern = &target_lines[..target_lines.len() - 1];
            return seek_sequence_inner(file_lines, trimmed_pattern, start_from, is_end_of_file);
        }
    }

    None
}

/// 内部四级匹配逻辑
fn seek_sequence_inner(
    file_lines: &[&str],
    target_lines: &[String],
    start_from: usize,
    is_end_of_file: bool,
) -> Option<usize> {
    if target_lines.is_empty() {
        return Some(start_from);
    }

    if target_lines.len() > file_lines.len() {
        return None;
    }

    let search_range = if is_end_of_file {
        // 从末尾开始反向搜索
        let start = file_lines.len().saturating_sub(target_lines.len() + 20);
        start..file_lines.len()
    } else {
        start_from..file_lines.len()
    };

    // 级别1: 精确匹配
    if let Some(pos) = find_exact(file_lines, target_lines, &search_range) {
        return Some(pos);
    }

    // 级别2: 右trim匹配（忽略行尾空白）
    if let Some(pos) = find_trimmed_right(file_lines, target_lines, &search_range) {
        return Some(pos);
    }

    // 级别3: 两侧trim匹配
    if let Some(pos) = find_trimmed_both(file_lines, target_lines, &search_range) {
        return Some(pos);
    }

    // 级别4: Unicode归一化匹配
    if let Some(pos) = find_normalized(file_lines, target_lines, &search_range) {
        return Some(pos);
    }

    None
}

fn find_exact(
    file_lines: &[&str],
    target: &[String],
    range: &std::ops::Range<usize>,
) -> Option<usize> {
    'outer: for i in range.clone() {
        if i + target.len() > file_lines.len() {
            break;
        }
        for (j, t) in target.iter().enumerate() {
            if file_lines[i + j] != t.as_str() {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

fn find_trimmed_right(
    file_lines: &[&str],
    target: &[String],
    range: &std::ops::Range<usize>,
) -> Option<usize> {
    'outer: for i in range.clone() {
        if i + target.len() > file_lines.len() {
            break;
        }
        for (j, t) in target.iter().enumerate() {
            if file_lines[i + j].trim_end() != t.trim_end() {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

fn find_trimmed_both(
    file_lines: &[&str],
    target: &[String],
    range: &std::ops::Range<usize>,
) -> Option<usize> {
    'outer: for i in range.clone() {
        if i + target.len() > file_lines.len() {
            break;
        }
        for (j, t) in target.iter().enumerate() {
            if file_lines[i + j].trim() != t.trim() {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

fn find_normalized(
    file_lines: &[&str],
    target: &[String],
    range: &std::ops::Range<usize>,
) -> Option<usize> {
    'outer: for i in range.clone() {
        if i + target.len() > file_lines.len() {
            break;
        }
        for (j, t) in target.iter().enumerate() {
            if normalize_unicode(file_lines[i + j]) != normalize_unicode(t) {
                continue 'outer;
            }
        }
        return Some(i);
    }
    None
}

/// Unicode归一化：各种特殊字符统一为ASCII等价物（扩展覆盖）
fn normalize_unicode(s: &str) -> String {
    s.trim()
        .chars()
        .map(|c| match c {
            // 破折号变体 → ASCII '-'
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            // 单引号变体 → ASCII '\''
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // 双引号变体 → ASCII '"'
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // 空格变体 → ASCII ' '
            '\u{00A0}' | '\u{2000}' | '\u{2001}' | '\u{2002}' | '\u{2003}' | '\u{2004}'
            | '\u{2005}' | '\u{2006}' | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}'
            | '\u{200B}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

// ===== @@ 上下文定位 =====

/// 通过 @@ 上下文在文件中定位起始位置
fn find_context_anchor(file_lines: &[&str], context: &str, start_from: usize) -> Option<usize> {
    let ctx_trimmed = context.trim();
    if ctx_trimmed.is_empty() {
        return Some(start_from); // 空context = 从start_from开始搜索
    }

    // 在文件中搜索包含该context的行
    for i in start_from..file_lines.len() {
        if file_lines[i].contains(ctx_trimmed) || file_lines[i].trim() == ctx_trimmed {
            return Some(i);
        }
    }
    None
}

// ===== Patch 验证 (先验证后执行) =====

/// 验证Patch是否可以安全应用
pub fn verify_patch(patch: &Patch, project_dir: &str) -> Result<(), Vec<PatchError>> {
    let mut errors = Vec::new();
    let project_root = Path::new(project_dir);

    for (idx, hunk) in patch.hunks.iter().enumerate() {
        match hunk {
            PatchHunk::AddFile { path, .. } => {
                // 路径安全检查
                if let Err(e) = validate_path(path, project_root) {
                    errors.push(PatchError {
                        path: path.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                let full_path = project_root.join(path);
                if full_path.exists() {
                    errors.push(PatchError {
                        path: path.clone(),
                        message: "文件已存在，无法Add（如需修改请使用Update）".into(),
                        hunk_index: idx,
                    });
                }
            }
            PatchHunk::DeleteFile { path } => {
                if let Err(e) = validate_path(path, project_root) {
                    errors.push(PatchError {
                        path: path.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                let full_path = project_root.join(path);
                if !full_path.exists() {
                    errors.push(PatchError {
                        path: path.clone(),
                        message: "文件不存在，无法Delete".into(),
                        hunk_index: idx,
                    });
                }
            }
            PatchHunk::UpdateFile { path, changes } => {
                if let Err(e) = validate_path(path, project_root) {
                    errors.push(PatchError {
                        path: path.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                let full_path = project_root.join(path);
                if !full_path.exists() {
                    errors.push(PatchError {
                        path: path.clone(),
                        message: "文件不存在，无法Update（如需创建请使用Add）".into(),
                        hunk_index: idx,
                    });
                    continue;
                }

                // 验证每个change的old_lines能否在文件中找到
                verify_changes_in_file(&full_path, changes, path, idx, &mut errors);
            }
            PatchHunk::MoveFile { from, to, changes } => {
                if let Err(e) = validate_path(from, project_root) {
                    errors.push(PatchError {
                        path: from.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                if let Err(e) = validate_path(to, project_root) {
                    errors.push(PatchError {
                        path: to.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                let full_from = project_root.join(from);
                if !full_from.exists() {
                    errors.push(PatchError {
                        path: from.clone(),
                        message: "源文件不存在，无法Move".into(),
                        hunk_index: idx,
                    });
                    continue;
                }
                if !changes.is_empty() {
                    verify_changes_in_file(&full_from, changes, from, idx, &mut errors);
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// 验证 changes 中的 old_lines 能否在文件中找到
fn verify_changes_in_file(
    full_path: &Path,
    changes: &[FileChange],
    path: &str,
    idx: usize,
    errors: &mut Vec<PatchError>,
) {
    let content = std::fs::read_to_string(full_path).unwrap_or_default();
    let file_lines: Vec<&str> = content.lines().collect();
    let mut search_from = 0;

    for (ci, change) in changes.iter().enumerate() {
        if let Some(ctx) = &change.context {
            if let Some(pos) = find_context_anchor(&file_lines, ctx, search_from) {
                search_from = pos;
            }
        }

        let only_old: Vec<String> = change
            .old_lines
            .iter()
            .filter(|l| !change.new_lines.contains(l))
            .cloned()
            .collect();

        if !only_old.is_empty() {
            if seek_sequence(&file_lines, &only_old, search_from, change.is_end_of_file).is_none() {
                errors.push(PatchError {
                    path: path.to_string(),
                    message: format!(
                        "第{}个变更块中无法找到匹配行: {:?}",
                        ci + 1,
                        only_old.first().unwrap_or(&String::new())
                    ),
                    hunk_index: idx,
                });
            }
        }
    }
}

// ===== Patch 应用 =====

/// 应用Patch到文件系统（带Delta跟踪和路径安全）
pub fn apply_patch(patch: &Patch, project_dir: &str) -> PatchResult {
    let mut applied = Vec::new();
    let mut errors = Vec::new();
    let mut delta = AppliedDelta::new();
    let project_root = Path::new(project_dir);

    for (idx, hunk) in patch.hunks.iter().enumerate() {
        match hunk {
            PatchHunk::AddFile { path, content } => {
                // 路径安全检查
                if let Err(e) = validate_path(path, project_root) {
                    delta.push("add", path, false, Some(e.clone()));
                    errors.push(PatchError {
                        path: path.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                match apply_add_file(project_dir, path, content) {
                    Ok(()) => {
                        delta.push("add", path, true, None);
                        applied.push(AppliedChange {
                            path: path.clone(),
                            operation: "A".into(),
                        });
                    }
                    Err(e) => {
                        delta.push("add", path, false, Some(e.clone()));
                        delta.exact = false;
                        errors.push(PatchError {
                            path: path.clone(),
                            message: e,
                            hunk_index: idx,
                        });
                    }
                }
            }
            PatchHunk::DeleteFile { path } => {
                if let Err(e) = validate_path(path, project_root) {
                    delta.push("delete", path, false, Some(e.clone()));
                    errors.push(PatchError {
                        path: path.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                match apply_delete_file(project_dir, path) {
                    Ok(()) => {
                        delta.push("delete", path, true, None);
                        applied.push(AppliedChange {
                            path: path.clone(),
                            operation: "D".into(),
                        });
                    }
                    Err(e) => {
                        delta.push("delete", path, false, Some(e.clone()));
                        delta.exact = false;
                        errors.push(PatchError {
                            path: path.clone(),
                            message: e,
                            hunk_index: idx,
                        });
                    }
                }
            }
            PatchHunk::UpdateFile { path, changes } => {
                if let Err(e) = validate_path(path, project_root) {
                    delta.push("update", path, false, Some(e.clone()));
                    errors.push(PatchError {
                        path: path.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                match apply_update_file(project_dir, path, changes) {
                    Ok(()) => {
                        delta.push("update", path, true, None);
                        applied.push(AppliedChange {
                            path: path.clone(),
                            operation: "M".into(),
                        });
                    }
                    Err(e) => {
                        delta.push("update", path, false, Some(e.clone()));
                        delta.exact = false;
                        errors.push(PatchError {
                            path: path.clone(),
                            message: e,
                            hunk_index: idx,
                        });
                    }
                }
            }
            PatchHunk::MoveFile { from, to, changes } => {
                if let Err(e) = validate_path(from, project_root) {
                    delta.push("move", from, false, Some(e.clone()));
                    errors.push(PatchError {
                        path: from.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                if let Err(e) = validate_path(to, project_root) {
                    delta.push("move", to, false, Some(e.clone()));
                    errors.push(PatchError {
                        path: to.clone(),
                        message: e,
                        hunk_index: idx,
                    });
                    continue;
                }
                match apply_move_file(project_dir, from, to, changes) {
                    Ok(()) => {
                        delta.push("move", &format!("{} -> {}", from, to), true, None);
                        applied.push(AppliedChange {
                            path: to.clone(),
                            operation: "R".into(),
                        });
                    }
                    Err(e) => {
                        delta.push("move", from, false, Some(e.clone()));
                        delta.exact = false;
                        errors.push(PatchError {
                            path: from.clone(),
                            message: e,
                            hunk_index: idx,
                        });
                    }
                }
            }
        }
    }

    let success = errors.is_empty();
    let summary = if success {
        format!(
            "Success. Applied changes to {} file(s):\n{}",
            applied.len(),
            applied
                .iter()
                .map(|a| format!("{} {}", a.operation, a.path))
                .collect::<Vec<_>>()
                .join("\n")
        )
    } else {
        format!(
            "Partial failure. Applied: {} file(s), Failed: {} operation(s).\nErrors:\n{}",
            applied.len(),
            errors.len(),
            errors
                .iter()
                .map(|e| format!("  {}: {}", e.path, e.message))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    PatchResult {
        success,
        applied,
        errors,
        summary,
        delta,
    }
}

fn apply_add_file(project_dir: &str, path: &str, content: &str) -> Result<(), String> {
    let full_path = Path::new(project_dir).join(path);

    // 自动创建父目录
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    std::fs::write(&full_path, content).map_err(|e| format!("写入文件失败: {}", e))
}

fn apply_delete_file(project_dir: &str, path: &str) -> Result<(), String> {
    let full_path = Path::new(project_dir).join(path);
    std::fs::remove_file(&full_path).map_err(|e| format!("删除文件失败: {}", e))
}

/// 应用文件更新——使用逆向应用策略（从后向前）避免行号偏移
fn apply_update_file(project_dir: &str, path: &str, changes: &[FileChange]) -> Result<(), String> {
    let full_path = Path::new(project_dir).join(path);
    let content =
        std::fs::read_to_string(&full_path).map_err(|e| format!("读取文件失败: {}", e))?;

    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    // 第一步：全部解析和定位（记录每个change的start_index和替换信息）
    let replacements = compute_replacements_for_changes(&lines, changes)?;

    // 第二步：按 start_index 排序后从后向前应用
    let mut sorted_replacements = replacements;
    sorted_replacements.sort_by_key(|(start_idx, _, _)| *start_idx);

    // 从后向前应用，避免前面的修改影响后面的行号计算
    for (start_idx, old_len, new_lines) in sorted_replacements.into_iter().rev() {
        // 删除旧行
        if old_len > 0 && start_idx < lines.len() {
            let end = (start_idx + old_len).min(lines.len());
            lines.drain(start_idx..end);
        }
        // 插入新行
        for (j, new_line) in new_lines.iter().enumerate() {
            let insert_pos = (start_idx + j).min(lines.len());
            lines.insert(insert_pos, new_line.clone());
        }
    }

    // 写回文件
    let new_content = lines.join("\n");
    // 保留原文件的末尾换行习惯
    let final_content = if content.ends_with('\n') && !new_content.ends_with('\n') {
        new_content + "\n"
    } else {
        new_content
    };

    std::fs::write(&full_path, final_content).map_err(|e| format!("写入文件失败: {}", e))
}

/// 计算所有 changes 的替换信息：(start_index, old_len, new_lines)
fn compute_replacements_for_changes(
    lines: &[String],
    changes: &[FileChange],
) -> Result<Vec<(usize, usize, Vec<String>)>, String> {
    let mut replacements: Vec<(usize, usize, Vec<String>)> = Vec::new();
    let file_lines: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let mut search_from: usize = 0;

    for (ci, change) in changes.iter().enumerate() {
        // 定位起始位置
        let search_start = if let Some(ctx) = &change.context {
            find_context_anchor(&file_lines, ctx, search_from).unwrap_or(search_from)
        } else {
            search_from
        };

        if change.old_lines.is_empty() && !change.new_lines.is_empty() {
            // 纯插入：在context位置后插入
            let insert_pos = if change.is_end_of_file {
                lines.len()
            } else {
                // 在找到的context行之后插入
                let anchor = find_context_anchor(
                    &file_lines,
                    change.context.as_deref().unwrap_or(""),
                    search_start,
                )
                .unwrap_or(search_start);
                anchor + 1
            };
            replacements.push((insert_pos, 0, change.new_lines.clone()));
            search_from = insert_pos;
        } else if !change.old_lines.is_empty() {
            // 替换操作：找到old_lines序列，替换为new_lines
            if let Some(match_pos) = seek_sequence(
                &file_lines,
                &change.old_lines,
                search_start,
                change.is_end_of_file,
            ) {
                replacements.push((match_pos, change.old_lines.len(), change.new_lines.clone()));
                search_from = match_pos + change.old_lines.len();
            } else {
                return Err(format!(
                    "第{}个变更块: 无法在文件中找到匹配行。期望找到:\n{}",
                    ci + 1,
                    change
                        .old_lines
                        .iter()
                        .take(3)
                        .map(|l| format!("  '{}'", l))
                        .collect::<Vec<_>>()
                        .join("\n")
                ));
            }
        }
    }

    Ok(replacements)
}

/// 移动/重命名文件（可选先应用修改）
fn apply_move_file(
    project_dir: &str,
    from: &str,
    to: &str,
    changes: &[FileChange],
) -> Result<(), String> {
    let from_path = Path::new(project_dir).join(from);
    let to_path = Path::new(project_dir).join(to);

    // 如果有修改操作，先应用到源文件
    if !changes.is_empty() {
        apply_update_file(project_dir, from, changes)?;
    }

    // 确保目标目录存在
    if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {}", e))?;
    }

    // 执行移动
    match std::fs::rename(&from_path, &to_path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // rename 可能跨文件系统失败，降级为 copy + delete
            let data = std::fs::read(&from_path).map_err(|_| format!("移动文件失败: {}", e))?;
            std::fs::write(&to_path, &data)
                .map_err(|write_err| format!("移动文件失败(写入目标): {}", write_err))?;
            std::fs::remove_file(&from_path)
                .map_err(|del_err| format!("移动文件失败(删除源): {}", del_err))?;
            Ok(())
        }
    }
}

// ===== Tauri命令接口 =====

/// 解析并应用Patch（带验证）
pub fn parse_and_apply_patch(patch_text: &str, project_dir: &str) -> Result<PatchResult, String> {
    // 1. 解析
    let patch = parse_patch(patch_text)?;

    // 2. 验证（可选跳过，直接尝试应用）
    if let Err(errors) = verify_patch(&patch, project_dir) {
        // 验证失败但不完全阻止——只报告warning，仍然尝试应用
        // 因为验证是保守的，有些情况实际能成功
        eprintln!("Patch验证发现问题 (仍将尝试应用): {:?}", errors);
    }

    // 3. 应用
    Ok(apply_patch(&patch, project_dir))
}
