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

/// 逻辑画布节点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicCanvasNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub detail: String,
    pub file_path: Option<String>,
    pub line_start: Option<usize>,
    pub line_end: Option<usize>,
    pub weight: usize,
}

/// 逻辑画布边
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogicCanvasEdge {
    pub from: String,
    pub to: String,
    pub relation_type: String,
    pub weight: usize,
}

/// 项目级逻辑图
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectLogicCanvasData {
    pub updated_at: String,
    pub nodes: Vec<LogicCanvasNode>,
    pub edges: Vec<LogicCanvasEdge>,
}

/// 文件级逻辑图
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileLogicCanvasData {
    pub file_path: String,
    pub language: String,
    pub updated_at: String,
    pub nodes: Vec<LogicCanvasNode>,
    pub edges: Vec<LogicCanvasEdge>,
}

#[derive(Debug, Clone, Default)]
struct RelationCounter {
    imports: usize,
    calls: usize,
    references: usize,
}

impl RelationCounter {
    fn add(&mut self, relation_type: &str) {
        match relation_type {
            "imports" => self.imports += 1,
            "calls" => self.calls += 1,
            "references" => self.references += 1,
            _ => self.references += 1,
        }
    }

    fn weight(&self) -> usize {
        self.imports + self.calls + self.references
    }

    fn summary(&self) -> String {
        let mut parts = Vec::new();
        if self.imports > 0 {
            parts.push(format!("imports×{}", self.imports));
        }
        if self.calls > 0 {
            parts.push(format!("calls×{}", self.calls));
        }
        if self.references > 0 {
            parts.push(format!("references×{}", self.references));
        }
        if parts.is_empty() {
            "references×1".to_string()
        } else {
            parts.join(" / ")
        }
    }
}

#[derive(Debug, Clone, Default)]
struct FileNodeStats {
    language: String,
    chunk_count: usize,
    incoming: usize,
    outgoing: usize,
    degree: usize,
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

fn load_index_data(project_dir: &PathBuf) -> Result<(Vec<CodeChunk>, Vec<GraphEdge>), String> {
    let index_dir = project_dir.join(".xt").join("perceptual_index");

    let chunks: Vec<CodeChunk> = {
        let path = index_dir.join("chunks.json");
        let json = fs::read_to_string(&path).map_err(|_| "索引未构建，请先构建索引".to_string())?;
        serde_json::from_str(&json).map_err(|e| format!("解析分段数据失败: {}", e))?
    };

    let graph: Vec<GraphEdge> = {
        let path = index_dir.join("graph.json");
        let json = fs::read_to_string(&path).map_err(|_| "索引未构建，请先构建索引".to_string())?;
        serde_json::from_str(&json).map_err(|e| format!("解析图谱数据失败: {}", e))?
    };

    Ok((chunks, graph))
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

fn compact_path_label(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        normalized
    }
}

fn infer_chunk_label(chunk: &CodeChunk) -> String {
    for line in chunk.content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with('#')
            || trimmed.starts_with("/*")
            || trimmed.starts_with('*')
        {
            continue;
        }
        let normalized = trimmed
            .trim_end_matches('{')
            .trim_end_matches(';')
            .trim();
        if normalized.is_empty() {
            continue;
        }
        let mut shortened = normalized.to_string();
        if shortened.chars().count() > 48 {
            shortened = format!("{}…", shortened.chars().take(48).collect::<String>());
        }
        return shortened;
    }
    format!("代码段 L{}-L{}", chunk.start_line + 1, chunk.end_line + 1)
}

fn summarize_chunk(chunk: &CodeChunk) -> String {
    let label = infer_chunk_label(chunk);
    format!(
        "{} · L{}-L{} · {}",
        label,
        chunk.start_line + 1,
        chunk.end_line + 1,
        chunk.language
    )
}

fn aggregate_file_edges(
    chunks: &[CodeChunk],
    graph: &[GraphEdge],
) -> (
    HashMap<String, FileNodeStats>,
    HashMap<(String, String), RelationCounter>,
) {
    let chunk_map: HashMap<&str, &CodeChunk> = chunks.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut file_stats: HashMap<String, FileNodeStats> = HashMap::new();
    let mut edge_stats: HashMap<(String, String), RelationCounter> = HashMap::new();

    for chunk in chunks {
        let entry = file_stats.entry(chunk.file_path.clone()).or_default();
        if entry.language.is_empty() {
            entry.language = chunk.language.clone();
        }
        entry.chunk_count += 1;
    }

    for edge in graph {
        let Some(from_chunk) = chunk_map.get(edge.from_chunk.as_str()) else {
            continue;
        };
        let Some(to_chunk) = chunk_map.get(edge.to_chunk.as_str()) else {
            continue;
        };
        if from_chunk.file_path == to_chunk.file_path {
            continue;
        }

        file_stats.entry(from_chunk.file_path.clone()).or_default().outgoing += 1;
        file_stats.entry(to_chunk.file_path.clone()).or_default().incoming += 1;
        file_stats.entry(from_chunk.file_path.clone()).or_default().degree += 1;
        file_stats.entry(to_chunk.file_path.clone()).or_default().degree += 1;

        edge_stats
            .entry((from_chunk.file_path.clone(), to_chunk.file_path.clone()))
            .or_default()
            .add(&edge.relation_type);
    }

    (file_stats, edge_stats)
}

pub fn build_project_logic_canvas(project_dir: &PathBuf) -> Result<ProjectLogicCanvasData, String> {
    let (chunks, graph) = load_index_data(project_dir)?;
    let (file_stats, edge_stats) = aggregate_file_edges(&chunks, &graph);

    let mut ranked_files: Vec<(String, FileNodeStats)> = file_stats.into_iter().collect();
    ranked_files.sort_by(|a, b| {
        b.1.degree
            .cmp(&a.1.degree)
            .then_with(|| b.1.chunk_count.cmp(&a.1.chunk_count))
            .then_with(|| a.0.cmp(&b.0))
    });

    const MAX_PROJECT_GRAPH_FILES: usize = 90;
    if ranked_files.len() > MAX_PROJECT_GRAPH_FILES {
        ranked_files.truncate(MAX_PROJECT_GRAPH_FILES);
    }

    let selected: HashSet<String> = ranked_files.iter().map(|(path, _)| path.clone()).collect();
    let mut nodes: Vec<LogicCanvasNode> = ranked_files
        .into_iter()
        .map(|(path, stats)| LogicCanvasNode {
            id: path.clone(),
            label: compact_path_label(&path),
            kind: "file".to_string(),
            detail: format!(
                "{}\n{} · {} 段 · 入{} / 出{} · 总关联{}",
                path,
                stats.language,
                stats.chunk_count,
                stats.incoming,
                stats.outgoing,
                stats.degree
            ),
            file_path: Some(path),
            line_start: None,
            line_end: None,
            weight: stats.degree.max(1),
        })
        .collect();

    let mut edges: Vec<LogicCanvasEdge> = edge_stats
        .into_iter()
        .filter(|((from, to), _)| selected.contains(from) && selected.contains(to))
        .map(|((from, to), counts)| LogicCanvasEdge {
            from,
            to,
            relation_type: counts.summary(),
            weight: counts.weight().max(1),
        })
        .collect();

    edges.sort_by(|a, b| {
        b.weight
            .cmp(&a.weight)
            .then_with(|| a.from.cmp(&b.from))
            .then_with(|| a.to.cmp(&b.to))
    });

    const MAX_PROJECT_GRAPH_EDGES: usize = 220;
    if edges.len() > MAX_PROJECT_GRAPH_EDGES {
        edges.truncate(MAX_PROJECT_GRAPH_EDGES);
    }

    if nodes.is_empty() {
        nodes.push(LogicCanvasNode {
            id: project_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string()),
            label: "项目".to_string(),
            kind: "file".to_string(),
            detail: "当前索引尚未提取到可视化逻辑链文件".to_string(),
            file_path: None,
            line_start: None,
            line_end: None,
            weight: 1,
        });
    }

    Ok(ProjectLogicCanvasData {
        updated_at: chrono_now(),
        nodes,
        edges,
    })
}

pub fn build_file_logic_canvas(
    project_dir: &PathBuf,
    relative_path: &str,
) -> Result<FileLogicCanvasData, String> {
    let normalized_path = relative_path.replace('\\', "/");
    let (chunks, graph) = load_index_data(project_dir)?;
    let chunk_map: HashMap<&str, &CodeChunk> = chunks.iter().map(|c| (c.id.as_str(), c)).collect();

    let mut file_chunks: Vec<CodeChunk> = chunks
        .iter()
        .filter(|c| c.file_path == normalized_path)
        .cloned()
        .collect();

    if file_chunks.is_empty() {
        let target = project_dir.join(relative_path);
        let content = fs::read_to_string(&target)
            .map_err(|e| format!("读取文件失败，无法生成逻辑图: {}", e))?;
        file_chunks = code_chunker::chunk_file(&normalized_path, &content);
        if file_chunks.is_empty() {
            file_chunks.push(CodeChunk {
                id: format!("{}-inline", normalized_path),
                file_path: normalized_path.clone(),
                start_line: 0,
                end_line: content.lines().count().saturating_sub(1),
                content: content.chars().take(800).collect(),
                language: code_chunker::detect_language(&normalized_path),
            });
        }
    }

    let language = file_chunks
        .first()
        .map(|c| c.language.clone())
        .unwrap_or_else(|| code_chunker::detect_language(&normalized_path));

    let root_id = format!("file::{}", normalized_path);
    let group_symbols_id = format!("group::{}::symbols", normalized_path);
    let group_upstream_id = format!("group::{}::upstream", normalized_path);
    let group_downstream_id = format!("group::{}::downstream", normalized_path);

    let mut nodes = vec![LogicCanvasNode {
        id: root_id.clone(),
        label: compact_path_label(&normalized_path),
        kind: "file-root".to_string(),
        detail: format!("{}\n{} · {} 个代码段", normalized_path, language, file_chunks.len()),
        file_path: Some(normalized_path.clone()),
        line_start: None,
        line_end: None,
        weight: file_chunks.len().max(1),
    }];

    let mut edges = Vec::new();

    let mut symbol_ids: HashMap<String, String> = HashMap::new();
    if !file_chunks.is_empty() {
        nodes.push(LogicCanvasNode {
            id: group_symbols_id.clone(),
            label: "本文件逻辑单元".to_string(),
            kind: "group-symbols".to_string(),
            detail: format!("按代码段/函数块自动拆分，共 {} 个", file_chunks.len()),
            file_path: Some(normalized_path.clone()),
            line_start: None,
            line_end: None,
            weight: file_chunks.len(),
        });
        edges.push(LogicCanvasEdge {
            from: root_id.clone(),
            to: group_symbols_id.clone(),
            relation_type: "contains".to_string(),
            weight: 1,
        });
    }

    for (idx, chunk) in file_chunks.iter().enumerate().take(18) {
        let symbol_id = format!("symbol::{}", chunk.id);
        symbol_ids.insert(chunk.id.clone(), symbol_id.clone());
        nodes.push(LogicCanvasNode {
            id: symbol_id.clone(),
            label: infer_chunk_label(chunk),
            kind: "symbol".to_string(),
            detail: summarize_chunk(chunk),
            file_path: Some(normalized_path.clone()),
            line_start: Some(chunk.start_line + 1),
            line_end: Some(chunk.end_line + 1),
            weight: chunk.content.lines().count().max(1),
        });
        edges.push(LogicCanvasEdge {
            from: group_symbols_id.clone(),
            to: symbol_id,
            relation_type: format!("segment-{}", idx + 1),
            weight: 1,
        });
    }

    let target_chunk_ids: HashSet<String> = file_chunks.iter().map(|c| c.id.clone()).collect();
    let mut inbound_files: HashMap<String, RelationCounter> = HashMap::new();
    let mut outbound_files: HashMap<String, RelationCounter> = HashMap::new();
    let mut inbound_symbol_links: Vec<(String, String, String)> = Vec::new();
    let mut outbound_symbol_links: Vec<(String, String, String)> = Vec::new();
    let mut internal_symbol_links: Vec<(String, String, String)> = Vec::new();

    for edge in &graph {
        let Some(from_chunk) = chunk_map.get(edge.from_chunk.as_str()) else {
            continue;
        };
        let Some(to_chunk) = chunk_map.get(edge.to_chunk.as_str()) else {
            continue;
        };

        let from_inside = target_chunk_ids.contains(&from_chunk.id);
        let to_inside = target_chunk_ids.contains(&to_chunk.id);

        if from_inside && to_inside {
            if let (Some(from_id), Some(to_id)) = (
                symbol_ids.get(&from_chunk.id),
                symbol_ids.get(&to_chunk.id),
            ) {
                internal_symbol_links.push((
                    from_id.clone(),
                    to_id.clone(),
                    edge.relation_type.clone(),
                ));
            }
            continue;
        }

        if from_inside && !to_inside {
            outbound_files
                .entry(to_chunk.file_path.clone())
                .or_default()
                .add(&edge.relation_type);
            if let Some(from_id) = symbol_ids.get(&from_chunk.id) {
                outbound_symbol_links.push((
                    from_id.clone(),
                    to_chunk.file_path.clone(),
                    edge.relation_type.clone(),
                ));
            }
            continue;
        }

        if !from_inside && to_inside {
            inbound_files
                .entry(from_chunk.file_path.clone())
                .or_default()
                .add(&edge.relation_type);
            if let Some(to_id) = symbol_ids.get(&to_chunk.id) {
                inbound_symbol_links.push((
                    from_chunk.file_path.clone(),
                    to_id.clone(),
                    edge.relation_type.clone(),
                ));
            }
        }
    }

    if !inbound_files.is_empty() {
        nodes.push(LogicCanvasNode {
            id: group_upstream_id.clone(),
            label: "上游输入/调用方".to_string(),
            kind: "group-upstream".to_string(),
            detail: format!("共 {} 个关联文件", inbound_files.len()),
            file_path: None,
            line_start: None,
            line_end: None,
            weight: inbound_files.len(),
        });
        edges.push(LogicCanvasEdge {
            from: root_id.clone(),
            to: group_upstream_id.clone(),
            relation_type: "upstream".to_string(),
            weight: 1,
        });
    }

    if !outbound_files.is_empty() {
        nodes.push(LogicCanvasNode {
            id: group_downstream_id.clone(),
            label: "下游输出/影响面".to_string(),
            kind: "group-downstream".to_string(),
            detail: format!("共 {} 个关联文件", outbound_files.len()),
            file_path: None,
            line_start: None,
            line_end: None,
            weight: outbound_files.len(),
        });
        edges.push(LogicCanvasEdge {
            from: root_id.clone(),
            to: group_downstream_id.clone(),
            relation_type: "downstream".to_string(),
            weight: 1,
        });
    }

    for (path, counts) in inbound_files.iter().take(10) {
        let node_id = format!("upstream::{}", path);
        nodes.push(LogicCanvasNode {
            id: node_id.clone(),
            label: compact_path_label(path),
            kind: "inbound-file".to_string(),
            detail: format!("{}\n{}", path, counts.summary()),
            file_path: Some(path.clone()),
            line_start: None,
            line_end: None,
            weight: counts.weight().max(1),
        });
        edges.push(LogicCanvasEdge {
            from: group_upstream_id.clone(),
            to: node_id,
            relation_type: counts.summary(),
            weight: counts.weight().max(1),
        });
    }

    for (path, counts) in outbound_files.iter().take(10) {
        let node_id = format!("downstream::{}", path);
        nodes.push(LogicCanvasNode {
            id: node_id.clone(),
            label: compact_path_label(path),
            kind: "outbound-file".to_string(),
            detail: format!("{}\n{}", path, counts.summary()),
            file_path: Some(path.clone()),
            line_start: None,
            line_end: None,
            weight: counts.weight().max(1),
        });
        edges.push(LogicCanvasEdge {
            from: group_downstream_id.clone(),
            to: node_id,
            relation_type: counts.summary(),
            weight: counts.weight().max(1),
        });
    }

    let node_ids: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
    for (from, to, relation) in internal_symbol_links {
        if node_ids.contains(&from) && node_ids.contains(&to) {
            edges.push(LogicCanvasEdge {
                from,
                to,
                relation_type: relation,
                weight: 1,
            });
        }
    }

    for (from, to_path, relation) in outbound_symbol_links {
        let to_id = format!("downstream::{}", to_path);
        if node_ids.contains(&from) && node_ids.contains(&to_id) {
            edges.push(LogicCanvasEdge {
                from,
                to: to_id,
                relation_type: relation,
                weight: 1,
            });
        }
    }

    for (from_path, to, relation) in inbound_symbol_links {
        let from_id = format!("upstream::{}", from_path);
        if node_ids.contains(&from_id) && node_ids.contains(&to) {
            edges.push(LogicCanvasEdge {
                from: from_id,
                to,
                relation_type: relation,
                weight: 1,
            });
        }
    }

    Ok(FileLogicCanvasData {
        file_path: normalized_path,
        language,
        updated_at: chrono_now(),
        nodes,
        edges,
    })
}

fn build_logic_chain_report(results: &[SearchResult], chunks: &[CodeChunk], graph: &[GraphEdge]) -> String {
    let chunk_map: HashMap<&str, &CodeChunk> = chunks.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut file_hits: HashMap<String, usize> = HashMap::new();
    let mut focus_files = Vec::new();

    for result in results.iter().take(6) {
        *file_hits.entry(result.chunk.file_path.clone()).or_insert(0) += 1;
        if !focus_files.iter().any(|p: &String| p == &result.chunk.file_path) {
            focus_files.push(result.chunk.file_path.clone());
        }
    }

    if focus_files.is_empty() {
        return "[逻辑链路建议]\n- 暂无可用链路证据".to_string();
    }

    let mut neighbors_by_file: HashMap<String, HashMap<String, RelationCounter>> = HashMap::new();
    for edge in graph {
        let Some(from_chunk) = chunk_map.get(edge.from_chunk.as_str()) else {
            continue;
        };
        let Some(to_chunk) = chunk_map.get(edge.to_chunk.as_str()) else {
            continue;
        };
        if from_chunk.file_path == to_chunk.file_path {
            continue;
        }

        if focus_files.contains(&from_chunk.file_path) {
            neighbors_by_file
                .entry(from_chunk.file_path.clone())
                .or_default()
                .entry(to_chunk.file_path.clone())
                .or_default()
                .add(&edge.relation_type);
        }
        if focus_files.contains(&to_chunk.file_path) {
            neighbors_by_file
                .entry(to_chunk.file_path.clone())
                .or_default()
                .entry(from_chunk.file_path.clone())
                .or_default()
                .add(&edge.relation_type);
        }
    }

    let mut lines = vec!["[逻辑链路建议]".to_string()];
    let hit_summary = focus_files
        .iter()
        .map(|path| format!("{} (命中 {} 段)", path, file_hits.get(path).copied().unwrap_or(0)))
        .collect::<Vec<String>>()
        .join("；");
    lines.push(format!("- 直接命中文件: {}", hit_summary));

    let mut suggested_files = Vec::new();
    for focus in focus_files.iter().take(3) {
        let mut neighbors: Vec<(String, RelationCounter)> = neighbors_by_file
            .get(focus)
            .map(|items| items.iter().map(|(path, counts)| (path.clone(), counts.clone())).collect())
            .unwrap_or_default();
        neighbors.sort_by(|a, b| b.1.weight().cmp(&a.1.weight()).then_with(|| a.0.cmp(&b.0)));
        neighbors.truncate(4);

        if neighbors.is_empty() {
            lines.push(format!("- 围绕 {}: 暂未发现跨文件链路，优先检查同文件上下文。", focus));
            continue;
        }

        let neighbor_text = neighbors
            .iter()
            .map(|(path, counts)| format!("{} [{}]", path, counts.summary()))
            .collect::<Vec<String>>()
            .join("；");
        lines.push(format!("- 围绕 {}: {}", focus, neighbor_text));

        for (path, _) in neighbors {
            if !focus_files.contains(&path) && !suggested_files.contains(&path) {
                suggested_files.push(path);
            }
        }
    }

    if !suggested_files.is_empty() {
        lines.push(format!(
            "- 建议补查文件: {}",
            suggested_files.into_iter().take(8).collect::<Vec<String>>().join(", ")
        ));
    }

    lines.join("\n")
}

/// 搜索并返回格式化文本（供 AI 上下文使用）
pub fn search_formatted(project_dir: &PathBuf, query: &str) -> Result<String, String> {
    let results = search(project_dir, query)?;
    let (all_chunks, graph) = load_index_data(project_dir)?;
    let files = scan_code_files(project_dir).unwrap_or_default();

    if results.is_empty() {
        return Ok(format!(
            "(未找到相关代码段)\n\n{}\n\n{}",
            build_logic_chain_report(&results, &all_chunks, &graph),
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
    output.push_str(&build_logic_chain_report(&results, &all_chunks, &graph));
    output.push_str("\n---\n");
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

// ---- 增量更新与Fuzzy搜索 ----

/// Fuzzy文件名搜索结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FuzzyFileMatch {
    pub path: String,
    pub file_name: String,
    pub score: u32,
}

/// 增量更新索引：仅重建受影响的chunk
pub fn incremental_update(
    project_dir: &PathBuf,
    changed_files: &[String],
) -> Result<usize, String> {
    let index_dir = project_dir.join(".xt").join("perceptual_index");
    let chunks_path = index_dir.join("chunks.json");

    // 加载现有chunks
    let mut chunks: Vec<CodeChunk> = if chunks_path.exists() {
        let json = fs::read_to_string(&chunks_path)
            .map_err(|e| format!("读取索引失败: {}", e))?;
        serde_json::from_str(&json).unwrap_or_default()
    } else {
        return Err("索引未构建，请先构建索引".to_string());
    };

    let mut updated_count = 0;

    for file_path in changed_files {
        let normalized = file_path.replace("\\\\", "/");

        // 1. 移除该文件的旧chunk
        chunks.retain(|chunk| chunk.file_path != normalized);

        // 2. 读取文件新内容
        let full_path = project_dir.join(file_path);
        if !full_path.exists() {
            updated_count += 1;
            continue; // 文件已删除，只需移除旧chunk即可
        }

        let content = match fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // 3. 重新分段
        let new_chunks = code_chunker::chunk_file(&normalized, &content);

        // 4. 加入索引
        chunks.extend(new_chunks);
        updated_count += 1;
    }

    // 5. 重建 TF-IDF
    let tfidf_data = tfidf::build_index(&chunks);

    // 6. 重建graph
    let graph = code_graph::build_graph(&chunks);

    // 7. 持久化
    fs::create_dir_all(&index_dir).map_err(|e| format!("创建索引目录失败: {}", e))?;

    {
        let file = fs::File::create(&chunks_path)
            .map_err(|e| format!("创建分段文件失败: {}", e))?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &chunks)
            .map_err(|e| format!("序列化分段数据失败: {}", e))?;
    }

    {
        let tfidf_path = index_dir.join("tfidf.json");
        let file = fs::File::create(&tfidf_path)
            .map_err(|e| format!("创建TF-IDF文件失败: {}", e))?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &tfidf_data)
            .map_err(|e| format!("序列化TF-IDF数据失败: {}", e))?;
    }

    {
        let graph_path = index_dir.join("graph.json");
        let file = fs::File::create(&graph_path)
            .map_err(|e| format!("创建图谱文件失败: {}", e))?;
        let writer = BufWriter::new(file);
        serde_json::to_writer(writer, &graph)
            .map_err(|e| format!("序列化图谱数据失败: {}", e))?;
    }

    Ok(updated_count)
}

/// Fuzzy文件名搜索
pub fn fuzzy_file_search(
    project_dir: &PathBuf,
    query: &str,
    max_results: usize,
) -> Vec<FuzzyFileMatch> {
    let query_lower = query.to_lowercase();
    let query_chars: Vec<char> = query_lower.chars().collect();

    let mut matches: Vec<FuzzyFileMatch> = Vec::new();

    // 遍历项目文件
    let files = scan_code_files(project_dir).unwrap_or_default();
    for file_path in &files {
        let rel_path = file_path
            .strip_prefix(project_dir)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace("\\\\", "/");
        let file_name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let file_name_lower = file_name.to_lowercase();

        // 计算fuzzy匹配分数
        if let Some(score) = fuzzy_match_score(&query_chars, &file_name_lower) {
            matches.push(FuzzyFileMatch {
                path: rel_path,
                file_name,
                score,
            });
        }
    }

    matches.sort_by(|a, b| b.score.cmp(&a.score));
    matches.truncate(max_results);
    matches
}

/// Fuzzy匹配算法：字符子序列匹配 + 连续匹配加权
fn fuzzy_match_score(query: &[char], target: &str) -> Option<u32> {
    let target_chars: Vec<char> = target.chars().collect();
    let mut score: u32 = 0;
    let mut qi = 0;
    let mut consecutive: u32 = 0;

    for (ti, tc) in target_chars.iter().enumerate() {
        if qi < query.len() && *tc == query[qi] {
            qi += 1;
            consecutive += 1;
            score += 1 + consecutive * 2; // 连续匹配加权
            // 文件名开头或分隔符后匹配加权
            if ti == 0 || matches!(target_chars.get(ti.wrapping_sub(1)), Some('/') | Some('\\') | Some('.') | Some('_') | Some('-')) {
                score += 5;
            }
        } else {
            consecutive = 0;
        }
    }

    if qi == query.len() { Some(score) } else { None }
}

/// 格式化搜索结果（代码片段+上下文行）
#[allow(dead_code)]
pub fn format_search_result_with_context(chunk: &CodeChunk, context_lines: usize) -> String {
    let lines: Vec<&str> = chunk.content.lines().collect();
    let total = lines.len();
    let preview_lines = if total <= context_lines * 2 + 5 {
        lines.join("\n")
    } else {
        let head: String = lines[..context_lines.min(total)].join("\n");
        let tail: String = lines[total.saturating_sub(context_lines)..].join("\n");
        format!("{}\n  [...{} more lines...]\n{}", head, total - context_lines * 2, tail)
    };

    format!("{}:{}-{}\n{}", chunk.file_path, chunk.start_line + 1, chunk.end_line + 1, preview_lines)
}
