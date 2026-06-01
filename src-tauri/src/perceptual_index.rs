// ========== 感知索引系统 - 核心数据结构与融合搜索 ==========
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;

use crate::code_chunker;
use crate::code_graph;
use crate::tfidf;

// ---- 核心数据结构 ----

/// 代码段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeChunk {
    pub id: String,
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
    pub language: String,
}

/// 图谱边
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from_chunk: String,
    pub to_chunk: String,
    pub relation_type: String, // "imports" | "calls" | "references"
}

/// 搜索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub chunk: CodeChunk,
    pub similarity_score: f64,
    pub graph_score: f64,
    pub final_score: f64,
    pub source: String, // "tfidf" | "graph"
}

/// 索引状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStatus {
    pub project_name: String,
    pub total_files: usize,
    pub total_chunks: usize,
    pub last_built_at: String,
}

// ---- 索引构建 ----

/// 全量构建索引：扫描项目文件 → 分段 → TF-IDF → 建图谱
pub fn build_index(project_dir: &PathBuf) -> Result<IndexStatus, String> {
    // 1. 扫描所有代码文件
    let files = scan_code_files(project_dir)?;
    if files.is_empty() {
        return Err("项目中没有可索引的代码文件".to_string());
    }
    eprintln!("[INDEX] 扫描到 {} 个可索引文件", files.len());

    // 2. 对每个文件分段（带进度日志和保护限制）
    let mut all_chunks: Vec<CodeChunk> = Vec::new();
    const MAX_TOTAL_CHUNKS: usize = 50_000;
    const MAX_CHUNKS_PER_FILE: usize = 50;
    let mut skipped_files = 0usize;

    for (file_idx, file_path) in files.iter().enumerate() {
        // 每 500 个文件输出一次进度
        if file_idx % 500 == 0 && file_idx > 0 {
            eprintln!(
                "[INDEX] 进度: {}/{} 文件, {} 个代码段",
                file_idx,
                files.len(),
                all_chunks.len()
            );
        }

        // 总量保护：达到上限后停止分段
        if all_chunks.len() >= MAX_TOTAL_CHUNKS {
            eprintln!(
                "[INDEX] 警告: 代码段总量已达上限 {}，停止处理剩余 {} 个文件",
                MAX_TOTAL_CHUNKS,
                files.len() - file_idx
            );
            skipped_files = files.len() - file_idx;
            break;
        }

        let content = match fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(e) => {
                // 跳过无法读取的文件（编码问题等），不中断整体构建
                eprintln!("[INDEX] 跳过无法读取的文件 {}: {}", file_path.display(), e);
                skipped_files += 1;
                continue;
            }
        };

        let relative = file_path
            .strip_prefix(project_dir)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace("\\", "/");
        let mut chunks = code_chunker::chunk_file(&relative, &content);

        // 单文件 chunk 数量保护
        if chunks.len() > MAX_CHUNKS_PER_FILE {
            eprintln!(
                "[INDEX] 文件 {} 产生 {} 个分段，截断为 {}",
                relative,
                chunks.len(),
                MAX_CHUNKS_PER_FILE
            );
            chunks.truncate(MAX_CHUNKS_PER_FILE);
        }

        all_chunks.extend(chunks);
    }

    if all_chunks.is_empty() {
        return Err("所有文件均无法产生有效代码段".to_string());
    }
    eprintln!(
        "[INDEX] 分段完成: {} 个代码段 (跳过 {} 个文件)",
        all_chunks.len(),
        skipped_files
    );

    // 3. 构建 TF-IDF 索引
    eprintln!("[INDEX] 构建 TF-IDF 索引...");
    let tfidf_data = tfidf::build_index(&all_chunks);

    // 4. 构建代码图谱
    eprintln!("[INDEX] 构建代码图谱...");
    let graph = code_graph::build_graph(&all_chunks);
    eprintln!("[INDEX] 图谱构建完成: {} 条边", graph.len());

    // 5. 持久化到 .xt/perceptual_index/（紧凑 JSON + 流式写入）
    let index_dir = project_dir.join(".xt").join("perceptual_index");
    fs::create_dir_all(&index_dir).map_err(|e| format!("创建索引目录失败: {}", e))?;

    // 保存 chunks.json（紧凑格式，流式写入避免内存翻倍）
    let chunks_path = index_dir.join("chunks.json");
    {
        let file =
            fs::File::create(&chunks_path).map_err(|e| format!("创建分段文件失败: {}", e))?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &all_chunks)
            .map_err(|e| format!("序列化分段数据失败: {}", e))?;
    }

    // 保存 tfidf.json（紧凑格式）
    let tfidf_path = index_dir.join("tfidf.json");
    {
        let file =
            fs::File::create(&tfidf_path).map_err(|e| format!("创建TF-IDF文件失败: {}", e))?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &tfidf_data)
            .map_err(|e| format!("序列化TF-IDF数据失败: {}", e))?;
    }

    // 保存 graph.json（紧凑格式）
    let graph_path = index_dir.join("graph.json");
    {
        let file = fs::File::create(&graph_path).map_err(|e| format!("创建图谱文件失败: {}", e))?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &graph).map_err(|e| format!("序列化图谱数据失败: {}", e))?;
    }

    eprintln!("[INDEX] 索引持久化完成");

    let now = chrono_now();
    let status = IndexStatus {
        project_name: project_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        total_files: files.len() - skipped_files,
        total_chunks: all_chunks.len(),
        last_built_at: now,
    };

    Ok(status)
}

/// 获取索引状态
pub fn get_index_status(project_dir: &PathBuf) -> IndexStatus {
    let index_dir = project_dir.join(".xt").join("perceptual_index");
    let chunks_path = index_dir.join("chunks.json");

    if !chunks_path.exists() {
        return IndexStatus {
            project_name: project_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            total_files: 0,
            total_chunks: 0,
            last_built_at: String::new(),
        };
    }

    // 统计文件数
    let files = scan_code_files(project_dir).unwrap_or_default();

    // 读取分段数
    let chunks: Vec<CodeChunk> = fs::read_to_string(&chunks_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    IndexStatus {
        project_name: project_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        total_files: files.len(),
        total_chunks: chunks.len(),
        last_built_at: String::new(),
    }
}

// ---- 融合搜索 ----

/// 执行融合搜索
pub fn search(project_dir: &PathBuf, query: &str) -> Result<Vec<SearchResult>, String> {
    let index_dir = project_dir.join(".xt").join("perceptual_index");

    // 加载索引数据
    let chunks: Vec<CodeChunk> = {
        let path = index_dir.join("chunks.json");
        let json = fs::read_to_string(&path).map_err(|_| "索引未构建，请先构建索引".to_string())?;
        serde_json::from_str(&json).map_err(|e| format!("解析分段数据失败: {}", e))?
    };

    let tfidf_data: tfidf::TfIdfData = {
        let path = index_dir.join("tfidf.json");
        let json = fs::read_to_string(&path).map_err(|_| "索引未构建，请先构建索引".to_string())?;
        serde_json::from_str(&json).map_err(|e| format!("解析TF-IDF数据失败: {}", e))?
    };

    let graph: Vec<GraphEdge> = {
        let path = index_dir.join("graph.json");
        let json = fs::read_to_string(&path).map_err(|_| "索引未构建，请先构建索引".to_string())?;
        serde_json::from_str(&json).map_err(|e| format!("解析图谱数据失败: {}", e))?
    };

    // 1. TF-IDF 搜索
    let tfidf_results = tfidf::search(query, &tfidf_data, &chunks);

    // 建立 chunk_id -> tfidf_score 映射
    let mut score_map: HashMap<String, f64> = HashMap::new();
    let mut used_ids: HashSet<String> = HashSet::new();
    for r in &tfidf_results {
        score_map.insert(r.chunk.id.clone(), r.similarity_score);
        used_ids.insert(r.chunk.id.clone());
    }

    // 2. 图谱扩展：对每个 TF-IDF 结果，找到关联代码段
    let mut graph_results: Vec<SearchResult> = Vec::new();
    for r in &tfidf_results {
        let neighbors = get_graph_neighbors(&r.chunk.id, &graph);
        for neighbor_id in &neighbors {
            if used_ids.contains(neighbor_id) {
                continue;
            }
            used_ids.insert(neighbor_id.clone());
            if let Some(chunk) = chunks.iter().find(|c| &c.id == neighbor_id) {
                let graph_score = r.similarity_score * 0.5;
                graph_results.push(SearchResult {
                    chunk: chunk.clone(),
                    similarity_score: 0.0,
                    graph_score,
                    final_score: graph_score * 0.3,
                    source: "graph".to_string(),
                });
            }
        }
    }

    // 3. 融合排序
    let mut all_results: Vec<SearchResult> = tfidf_results
        .into_iter()
        .map(|r| {
            let final_score = r.similarity_score * 0.7; // TF-IDF 权重 0.7
            SearchResult {
                similarity_score: r.similarity_score,
                graph_score: 0.0,
                final_score,
                source: "tfidf".to_string(),
                chunk: r.chunk,
            }
        })
        .chain(graph_results)
        .collect();

    // 按 final_score 降序排序
    all_results.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 限制返回前 10 条
    all_results.truncate(10);

    Ok(all_results)
}

/// 搜索并返回格式化文本（供 AI 上下文使用）
pub fn search_formatted(project_dir: &PathBuf, query: &str) -> Result<String, String> {
    let results = search(project_dir, query)?;
    let files = scan_code_files(project_dir).unwrap_or_default();

    if results.is_empty() {
        return Ok(format!(
            "(未找到相关代码段)\n\n{}",
            build_coverage_report(project_dir, &files, &[], query)
        ));
    }

    let mut output = String::from("[项目代码参考 - 以下是与当前问题最相关的代码段]\n\n");
    for (i, r) in results.iter().enumerate() {
        output.push_str(&format!(
            "[{}:L{}-L{}] ({})\n{}\n\n",
            r.chunk.file_path,
            r.chunk.start_line + 1, // 1-based for display
            r.chunk.end_line + 1,
            r.chunk.language,
            r.chunk.content.trim()
        ));
        // 限制输出量，最多返回 8 条
        if i >= 7 {
            output.push_str("...(更多相关代码段已省略)\n");
            break;
        }
    }

    let matched_paths: Vec<String> = results.iter().map(|r| r.chunk.file_path.clone()).collect();
    output.push_str("---\n");
    output.push_str(&build_coverage_report(
        project_dir,
        &files,
        &matched_paths,
        query,
    ));
    output.push_str("\n请基于以上代码参考回答用户问题；如果覆盖报告显示可能遗漏，请明确把相关文件加入必检文件清单，不要假装已经检查。");
    Ok(output)
}

fn relative_file_list(project_dir: &PathBuf, files: &[PathBuf]) -> Vec<String> {
    files
        .iter()
        .filter_map(|p| p.strip_prefix(project_dir).ok())
        .map(|p| p.to_string_lossy().replace("\\", "/"))
        .collect()
}

fn filter_candidates(paths: &[String], predicates: &[&str]) -> Vec<String> {
    paths
        .iter()
        .filter(|p| {
            let lower = p.to_lowercase();
            predicates.iter().any(|needle| lower.contains(needle))
        })
        .take(20)
        .cloned()
        .collect()
}

fn build_coverage_report(
    project_dir: &PathBuf,
    files: &[PathBuf],
    matched_paths: &[String],
    query: &str,
) -> String {
    let relative_paths = relative_file_list(project_dir, files);
    let entry_candidates = filter_candidates(
        &relative_paths,
        &[
            "main.", "index.", "app.", "server.", "lib.", "mod.rs", "routes", "router",
        ],
    );
    let test_candidates = filter_candidates(
        &relative_paths,
        &[
            ".test.",
            ".spec.",
            "__tests__",
            "/tests/",
            "\\tests\\",
            "test_",
            "_test.",
        ],
    );
    let config_candidates = filter_candidates(
        &relative_paths,
        &[
            "package.json",
            "cargo.toml",
            "tsconfig",
            "vite.config",
            "tauri.conf",
            "config.",
            ".toml",
            ".yaml",
            ".yml",
        ],
    );
    let matched_set: HashSet<&str> = matched_paths.iter().map(|s| s.as_str()).collect();
    let unmatched_candidates: Vec<String> = relative_paths
        .iter()
        .filter(|p| !matched_set.contains(p.as_str()))
        .take(20)
        .cloned()
        .collect();

    let large_repo_note = if relative_paths.len() >= MAX_INDEXABLE_FILES {
        format!(
            "\n- 大仓库提示：索引文件数达到上限 {}，必须使用分页/分批检索继续收集证据。",
            MAX_INDEXABLE_FILES
        )
    } else {
        String::new()
    };

    format!(
        "[索引覆盖报告]\n- 查询: {}\n- 可索引文件数: {}\n- 本次命中文件数: {}\n- 入口候选: {}\n- 测试候选: {}\n- 配置候选: {}\n- 未命中样例: {}{}\n",
        query,
        relative_paths.len(),
        matched_set.len(),
        if entry_candidates.is_empty() { "无".to_string() } else { entry_candidates.join(", ") },
        if test_candidates.is_empty() { "无".to_string() } else { test_candidates.join(", ") },
        if config_candidates.is_empty() { "无".to_string() } else { config_candidates.join(", ") },
        if unmatched_candidates.is_empty() { "无".to_string() } else { unmatched_candidates.join(", ") },
        large_repo_note
    )
}

// ---- 辅助函数 ----

/// 扫描项目目录中所有可索引的代码文件
fn scan_code_files(project_dir: &PathBuf) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    scan_dir(project_dir, project_dir, &mut files)?;
    Ok(files)
}

/// 单文件大小上限：512KB，超过则跳过
const MAX_FILE_SIZE: u64 = 512 * 1024;
/// 最大可索引文件数
const MAX_INDEXABLE_FILES: usize = 15_000;

fn scan_dir(base: &PathBuf, current: &PathBuf, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过隐藏文件和目录
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            // 跳过符号链接目录，避免无限递归
            if path.is_symlink() {
                continue;
            }
            // 跳过常见无关目录（覆盖主流语言/工具链）
            let skip_dirs: HashSet<&str> = [
                // JS/TS 生态
                "node_modules",
                "dist",
                ".next",
                "coverage",
                "bower_components",
                "jspm_packages",
                ".parcel-cache",
                ".turbo",
                // Rust
                "target",
                // Python
                "__pycache__",
                "venv",
                ".venv",
                "wheels",
                "eggs",
                // Java/Kotlin/Gradle
                ".gradle",
                "gradle",
                "build",
                // .NET/C#/C++
                "obj",
                "bin",
                "out",
                "packages",
                ".nuget",
                // iOS/macOS
                "Pods",
                "DerivedData",
                // Dart/Flutter
                ".dart_tool",
                ".pub-cache",
                // IDE/编辑器
                ".idea",
                ".vs",
                ".vscode",
                // 通用
                ".git",
                ".cache",
                ".terraform",
                ".serverless",
                "logs",
                "tmp",
                "temp",
                "CDN",
            ]
            .iter()
            .copied()
            .collect();
            if skip_dirs.contains(name.as_str()) {
                continue;
            }
            scan_dir(base, &path, files)?;
        } else {
            // 文件总数保护
            if files.len() >= MAX_INDEXABLE_FILES {
                break;
            }

            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let indexable_exts = [
                "ts", "tsx", "js", "jsx", "rs", "py", "md", "json", "html", "css", "scss", "less",
                "go", "java", "kt", "swift", "c", "cpp", "h", "hpp", "yaml", "yml", "toml", "xml",
                "sql", "sh", "bash", "ps1", "txt", "cfg", "ini",
            ];
            if indexable_exts.contains(&ext.as_str()) {
                // 文件大小预检查，跳过超大文件（minified/lock/生成文件等）
                if let Ok(meta) = fs::metadata(&path) {
                    if meta.len() > MAX_FILE_SIZE {
                        continue;
                    }
                }
                files.push(path.clone());
            }
        }
    }
    Ok(())
}

/// 获取图谱中与指定 chunk 相邻的 chunk id 列表
fn get_graph_neighbors(chunk_id: &str, graph: &[GraphEdge]) -> Vec<String> {
    let mut neighbors = Vec::new();
    for edge in graph {
        if edge.from_chunk == chunk_id {
            neighbors.push(edge.to_chunk.clone());
        }
        if edge.to_chunk == chunk_id {
            neighbors.push(edge.from_chunk.clone());
        }
    }
    neighbors
}

/// 获取当前时间戳（Unix seconds）
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    secs.to_string()
}
