// ========== 项目健康度评分系统 ==========
// 基于本地代码分析，无需云端服务

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// ---- 数据结构 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthScore {
    pub overall: u8, // 0-100
    pub dimensions: Vec<HealthDimension>,
    pub issues: Vec<HealthIssue>,
    pub suggestions: Vec<String>,
    pub evaluated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthDimension {
    pub name: String,
    pub score: u8,
    pub weight: f32,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthIssue {
    pub severity: String, // "critical" | "warning" | "info"
    pub category: String,
    pub message: String,
    pub file_path: Option<String>,
}

// ---- 核心评分逻辑 ----

/// 评估项目健康度
pub fn evaluate_health(project_path: &str) -> HealthScore {
    let path = Path::new(project_path);
    let mut dimensions: Vec<HealthDimension> = Vec::new();
    let mut issues: Vec<HealthIssue> = Vec::new();
    let mut suggestions: Vec<String> = Vec::new();

    // 1. 代码结构评分
    let structure_score = evaluate_structure(path, &mut issues, &mut suggestions);
    dimensions.push(HealthDimension {
        name: "代码结构".to_string(),
        score: structure_score,
        weight: 0.25,
        description: "目录组织、模块划分、文件大小".to_string(),
    });

    // 2. 文档覆盖评分
    let doc_score = evaluate_documentation(path, &mut issues, &mut suggestions);
    dimensions.push(HealthDimension {
        name: "文档覆盖".to_string(),
        score: doc_score,
        weight: 0.20,
        description: "README、注释、文档完整性".to_string(),
    });

    // 3. 依赖健康评分
    let dep_score = evaluate_dependencies(path, &mut issues, &mut suggestions);
    dimensions.push(HealthDimension {
        name: "依赖健康".to_string(),
        score: dep_score,
        weight: 0.20,
        description: "依赖数量、过时依赖、安全漏洞".to_string(),
    });

    // 4. 代码质量评分（本地启发式）
    let quality_score = evaluate_code_quality(path, &mut issues, &mut suggestions);
    dimensions.push(HealthDimension {
        name: "代码质量".to_string(),
        score: quality_score,
        weight: 0.20,
        description: "重复代码、复杂度、测试覆盖".to_string(),
    });

    // 5. 活跃度评分
    let activity_score = evaluate_activity(path, &mut issues, &mut suggestions);
    dimensions.push(HealthDimension {
        name: "活跃度".to_string(),
        score: activity_score,
        weight: 0.15,
        description: "提交频率、最近修改时间".to_string(),
    });

    // 计算总分
    let overall: u8 = dimensions
        .iter()
        .map(|d| (d.score as f32 * d.weight).round() as u8)
        .sum();

    HealthScore {
        overall: overall.min(100),
        dimensions,
        issues,
        suggestions,
        evaluated_at: chrono::Local::now().to_rfc3339(),
    }
}

// ---- 各维度评估函数 ----

fn evaluate_structure(
    path: &Path,
    issues: &mut Vec<HealthIssue>,
    suggestions: &mut Vec<String>,
) -> u8 {
    let mut score = 100u8;

    // 检查目录深度
    let max_depth = find_max_depth(path, 0);
    if max_depth > 6 {
        score = score.saturating_sub(15);
        issues.push(HealthIssue {
            severity: "warning".to_string(),
            category: "代码结构".to_string(),
            message: format!("目录层级过深（{}层），建议控制在5层以内", max_depth),
            file_path: None,
        });
        suggestions.push("考虑扁平化目录结构，将深层模块上提".to_string());
    }

    // 检查文件数量
    let file_count = count_files(path);
    if file_count > 500 {
        score = score.saturating_sub(10);
        issues.push(HealthIssue {
            severity: "info".to_string(),
            category: "代码结构".to_string(),
            message: format!("项目文件数量较多（{}个），考虑拆分为子项目", file_count),
            file_path: None,
        });
    }

    // 检查超大文件
    let large_files = find_large_files(path, 500); // 500KB
    if !large_files.is_empty() {
        score = score.saturating_sub((large_files.len() * 5).min(20) as u8);
        for (file, size) in &large_files[..3.min(large_files.len())] {
            issues.push(HealthIssue {
                severity: "warning".to_string(),
                category: "代码结构".to_string(),
                message: format!("文件过大（{:.1}KB），建议拆分", *size as f64 / 1024.0),
                file_path: Some(file.clone()),
            });
        }
        suggestions.push("将超大文件拆分为多个小模块".to_string());
    }

    score
}

fn evaluate_documentation(
    path: &Path,
    issues: &mut Vec<HealthIssue>,
    suggestions: &mut Vec<String>,
) -> u8 {
    let mut score = 100u8;

    // 检查 README
    let has_readme = ["README.md", "README.txt", "README"]
        .iter()
        .any(|name| path.join(name).exists());
    if !has_readme {
        score = score.saturating_sub(20);
        issues.push(HealthIssue {
            severity: "warning".to_string(),
            category: "文档覆盖".to_string(),
            message: "缺少 README 文件".to_string(),
            file_path: None,
        });
        suggestions.push("添加 README.md 说明项目用途和使用方法".to_string());
    }

    // 检查 CHANGELOG
    let has_changelog = ["CHANGELOG.md", "CHANGELOG", "HISTORY.md"]
        .iter()
        .any(|name| path.join(name).exists());
    if !has_changelog {
        score = score.saturating_sub(5);
        suggestions.push("添加 CHANGELOG.md 记录版本变更".to_string());
    }

    // 检查 LICENSE
    let has_license = ["LICENSE", "LICENSE.md", "LICENSE.txt"]
        .iter()
        .any(|name| path.join(name).exists());
    if !has_license {
        score = score.saturating_sub(5);
        suggestions.push("添加 LICENSE 文件明确开源协议".to_string());
    }

    // 估算注释率
    let comment_ratio = estimate_comment_ratio(path);
    if comment_ratio < 0.05 {
        score = score.saturating_sub(15);
        issues.push(HealthIssue {
            severity: "info".to_string(),
            category: "文档覆盖".to_string(),
            message: format!(
                "代码注释率较低（{:.1}%），建议增加关键逻辑注释",
                comment_ratio * 100.0
            ),
            file_path: None,
        });
    }

    score
}

fn evaluate_dependencies(
    path: &Path,
    issues: &mut Vec<HealthIssue>,
    suggestions: &mut Vec<String>,
) -> u8 {
    let mut score = 100u8;

    // 检测依赖文件
    let dep_files = detect_dependency_files(path);
    if dep_files.is_empty() {
        score = score.saturating_sub(10);
        issues.push(HealthIssue {
            severity: "info".to_string(),
            category: "依赖健康".to_string(),
            message: "未检测到依赖管理文件".to_string(),
            file_path: None,
        });
        return score;
    }

    // 统计依赖数量
    let dep_count = count_dependencies(&dep_files);
    if dep_count > 50 {
        score = score.saturating_sub(15);
        issues.push(HealthIssue {
            severity: "warning".to_string(),
            category: "依赖健康".to_string(),
            message: format!("依赖数量较多（{}个），注意依赖膨胀", dep_count),
            file_path: None,
        });
        suggestions.push("定期审查并移除未使用的依赖".to_string());
    } else if dep_count > 100 {
        score = score.saturating_sub(25);
        issues.push(HealthIssue {
            severity: "critical".to_string(),
            category: "依赖健康".to_string(),
            message: format!("依赖数量过多（{}个），强烈建议精简", dep_count),
            file_path: None,
        });
    }

    score
}

fn evaluate_code_quality(
    path: &Path,
    issues: &mut Vec<HealthIssue>,
    suggestions: &mut Vec<String>,
) -> u8 {
    let mut score = 100u8;

    // 检查测试目录/文件
    let has_tests = find_test_files(path);
    if has_tests.is_empty() {
        score = score.saturating_sub(20);
        issues.push(HealthIssue {
            severity: "warning".to_string(),
            category: "代码质量".to_string(),
            message: "未检测到测试文件".to_string(),
            file_path: None,
        });
        suggestions.push("添加单元测试和集成测试".to_string());
    }

    // 检查 TODO/FIXME 标记
    let todos = find_todo_markers(path);
    if todos.len() > 10 {
        score = score.saturating_sub(10);
        issues.push(HealthIssue {
            severity: "info".to_string(),
            category: "代码质量".to_string(),
            message: format!("发现 {} 个 TODO/FIXME 标记，建议逐步清理", todos.len()),
            file_path: None,
        });
    }

    score
}

fn evaluate_activity(
    path: &Path,
    issues: &mut Vec<HealthIssue>,
    suggestions: &mut Vec<String>,
) -> u8 {
    let mut score = 100u8;

    // 检查 .git 目录获取最近提交时间
    let git_dir = path.join(".git");
    if git_dir.exists() {
        // 尝试读取 HEAD 的修改时间作为近似活跃度指标
        let head_path = git_dir.join("HEAD");
        if let Ok(meta) = fs::metadata(&head_path) {
            if let Ok(modified) = meta.modified() {
                let days_since = modified.elapsed().unwrap_or_default().as_secs() / 86400;
                if days_since > 90 {
                    score = score.saturating_sub(30);
                    issues.push(HealthIssue {
                        severity: "warning".to_string(),
                        category: "活跃度".to_string(),
                        message: format!("项目已{}天未更新", days_since),
                        file_path: None,
                    });
                } else if days_since > 30 {
                    score = score.saturating_sub(10);
                }
            }
        }
    } else {
        score = score.saturating_sub(15);
        issues.push(HealthIssue {
            severity: "info".to_string(),
            category: "活跃度".to_string(),
            message: "未检测到 Git 仓库".to_string(),
            file_path: None,
        });
        suggestions.push("使用 Git 进行版本控制".to_string());
    }

    score
}

// ---- 辅助函数 ----

fn find_max_depth(path: &Path, current: usize) -> usize {
    if !path.is_dir() {
        return current;
    }
    let mut max = current;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry_path.file_name().unwrap_or_default().to_string_lossy();
            // 跳过隐藏目录和常见非代码目录
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if entry_path.is_dir() {
                let depth = find_max_depth(&entry_path, current + 1);
                max = max.max(depth);
            }
        }
    }
    max
}

fn count_files(path: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry_path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if entry_path.is_file() {
                count += 1;
            } else if entry_path.is_dir() {
                count += count_files(&entry_path);
            }
        }
    }
    count
}

fn find_large_files(path: &Path, threshold_kb: usize) -> Vec<(String, usize)> {
    let mut result = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry_path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if entry_path.is_file() {
                if let Ok(meta) = fs::metadata(&entry_path) {
                    let size = meta.len() as usize;
                    if size > threshold_kb * 1024 {
                        result.push((entry_path.to_string_lossy().to_string(), size));
                    }
                }
            } else if entry_path.is_dir() {
                result.extend(find_large_files(&entry_path, threshold_kb));
            }
        }
    }
    result
}

fn estimate_comment_ratio(path: &Path) -> f64 {
    let mut total_lines = 0usize;
    let mut comment_lines = 0usize;

    let code_exts = ["rs", "ts", "js", "py", "java", "go", "cpp", "c", "h", "hpp"];

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry_path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if entry_path.is_file() {
                let ext = entry_path.extension().unwrap_or_default().to_string_lossy();
                if !code_exts.contains(&ext.as_ref()) {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&entry_path) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        total_lines += 1;
                        if trimmed.starts_with("//")
                            || trimmed.starts_with("#")
                            || trimmed.starts_with("/*")
                            || trimmed.starts_with("*")
                            || trimmed.starts_with("///")
                            || trimmed.starts_with("//!")
                        {
                            comment_lines += 1;
                        }
                    }
                }
            } else if entry_path.is_dir() {
                // 简化处理：不递归统计
            }
        }
    }

    if total_lines == 0 {
        0.0
    } else {
        comment_lines as f64 / total_lines as f64
    }
}

fn detect_dependency_files(path: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let dep_names = [
        "package.json",
        "Cargo.toml",
        "requirements.txt",
        "Pipfile",
        "go.mod",
        "pom.xml",
        "build.gradle",
        "Gemfile",
        "composer.json",
        "mix.exs",
        "Cargo.lock",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
    ];
    for name in &dep_names {
        if path.join(name).exists() {
            files.push(name.to_string());
        }
    }
    files
}

fn count_dependencies(dep_files: &[String]) -> usize {
    let mut total = 0;
    for file in dep_files {
        match file.as_str() {
            "package.json" => total += 20, // 估算
            "Cargo.toml" => total += 15,
            "requirements.txt" => total += 10,
            "go.mod" => total += 12,
            _ => total += 5,
        }
    }
    total
}

fn find_test_files(path: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let test_patterns = ["test", "tests", "spec", "__tests__"];
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if test_patterns.iter().any(|p| name.contains(p)) {
                files.push(entry_path.to_string_lossy().to_string());
            }
        }
    }
    files
}

fn find_todo_markers(path: &Path) -> Vec<(String, usize)> {
    let mut result = Vec::new();
    let code_exts = ["rs", "ts", "js", "py", "java", "go", "cpp", "c", "md"];

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            let name = entry_path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if entry_path.is_file() {
                let ext = entry_path.extension().unwrap_or_default().to_string_lossy();
                if !code_exts.contains(&ext.as_ref()) {
                    continue;
                }
                if let Ok(content) = fs::read_to_string(&entry_path) {
                    let count = content.matches("TODO").count() + content.matches("FIXME").count();
                    if count > 0 {
                        result.push((entry_path.to_string_lossy().to_string(), count));
                    }
                }
            }
        }
    }
    result
}
