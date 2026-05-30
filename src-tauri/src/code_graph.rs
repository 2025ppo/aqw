// ========== 代码图谱构建 - 提取导入/调用/引用关系 ==========
use std::collections::{HashMap, HashSet};
use crate::perceptual_index::{CodeChunk, GraphEdge};

/// 最大边数上限，防止图谱爆炸
const MAX_EDGES: usize = 100_000;

/// 从代码段集合构建代码图谱（优化版：使用 HashMap 索引，复杂度 O(n)）
pub fn build_graph(chunks: &[CodeChunk]) -> Vec<GraphEdge> {
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut used_pairs: HashSet<(String, String)> = HashSet::new();

    // ===== 预建索引：将 O(n²) 降到 O(n) =====

    // 索引 1: 函数/类名 -> chunk_id 列表
    let mut name_to_chunks: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in chunks {
        let names = extract_defined_names(&chunk.content, &chunk.language);
        for name in names {
            name_to_chunks
                .entry(name)
                .or_default()
                .push(chunk.id.clone());
        }
    }

    // 索引 2: file_stem(小写) -> chunk_id 列表（用于按模块名匹配 import）
    let mut stem_to_chunks: HashMap<String, Vec<String>> = HashMap::new();
    // 索引 3: file_path(小写) -> chunk_id 列表（用于按路径后缀匹配 import）
    let mut path_to_chunks: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in chunks {
        let path_lower = chunk.file_path.to_lowercase();
        path_to_chunks
            .entry(path_lower.clone())
            .or_default()
            .push(chunk.id.clone());

        let stem = std::path::Path::new(&path_lower)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if !stem.is_empty() {
            stem_to_chunks
                .entry(stem)
                .or_default()
                .push(chunk.id.clone());
        }
    }

    // 索引 4: file_path -> 该文件的所有 chunk 引用列表（用于同文件相邻引用）
    let mut file_chunks: HashMap<String, Vec<&CodeChunk>> = HashMap::new();
    for chunk in chunks {
        file_chunks
            .entry(chunk.file_path.clone())
            .or_default()
            .push(chunk);
    }

    // 辅助函数：将一对 chunk id 作为边加入（去重 + 上限保护）
    fn add_edge(
        edges: &mut Vec<GraphEdge>,
        used_pairs: &mut HashSet<(String, String)>,
        from: &str,
        to: &str,
        relation: &str,
    ) {
        if edges.len() >= MAX_EDGES {
            return;
        }
        let pair = (
            from.min(to).to_string(),
            from.max(to).to_string(),
        );
        if used_pairs.insert(pair) {
            edges.push(GraphEdge {
                from_chunk: from.to_string(),
                to_chunk: to.to_string(),
                relation_type: relation.to_string(),
            });
        }
    }

    // 对每个分段，提取导入和调用，建立边
    for chunk in chunks {
        if edges.len() >= MAX_EDGES {
            break;
        }

        // 导入关系：用 HashMap O(1) 查找替代 O(n) 线性扫描
        let imports = extract_imports(&chunk.content, &chunk.language);
        for import in &imports {
            let import_lower = import.to_lowercase();

            // 策略 1：按 file_stem 精确匹配
            let stem = std::path::Path::new(&import_lower)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| import_lower.clone());

            let mut found = false;
            if let Some(candidates) = stem_to_chunks.get(&stem) {
                for target_id in candidates {
                    if target_id != &chunk.id {
                        add_edge(&mut edges, &mut used_pairs, &chunk.id, target_id, "imports");
                        found = true;
                        break;
                    }
                }
            }

            // 策略 2：按路径后缀匹配（当 stem 无法匹配时）
            if !found {
                // 尝试匹配几种常见的路径后缀格式
                let suffixes = [
                    format!("/{}", import_lower),
                    format!("/{}.rs", import_lower),
                    format!("/{}.ts", import_lower),
                    format!("/{}.tsx", import_lower),
                    format!("/{}.js", import_lower),
                    format!("/{}.jsx", import_lower),
                    format!("/{}.py", import_lower),
                ];
                for (fp, cids) in &path_to_chunks {
                    if suffixes.iter().any(|s| fp.ends_with(s)) {
                        for target_id in cids {
                            if target_id != &chunk.id {
                                add_edge(&mut edges, &mut used_pairs, &chunk.id, target_id, "imports");
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // 调用关系（已经是 O(1) 查找，保持不变）
        let calls = extract_calls(&chunk.content, &chunk.language);
        for call in &calls {
            if let Some(target_chunks) = name_to_chunks.get(call) {
                for target_id in target_chunks {
                    if target_id != &chunk.id {
                        add_edge(&mut edges, &mut used_pairs, &chunk.id, target_id, "calls");
                    }
                }
            }
        }

        // 同文件相邻段引用：用预建索引替代 O(n) 过滤
        if let Some(same_file) = file_chunks.get(&chunk.file_path) {
            let mut count = 0;
            for neighbor in same_file {
                if neighbor.id == chunk.id {
                    continue;
                }
                add_edge(&mut edges, &mut used_pairs, &chunk.id, &neighbor.id, "references");
                count += 1;
                if count >= 3 {
                    break;
                }
            }
        }
    }

    eprintln!("[GRAPH] 图谱构建完成: {} 条边", edges.len());
    edges
}

/// 从代码段内容提取定义的名称（函数名、类名等）
fn extract_defined_names(content: &str, language: &str) -> Vec<String> {
    let mut names = Vec::new();

    let patterns: &[&str] = match language {
        "rust" => &["fn ", "struct ", "enum ", "trait ", "mod "],
        "typescript" | "javascript" => &["function ", "class ", "interface ", "type ", "const "],
        "python" => &["def ", "class "],
        "go" => &["func ", "type "],
        _ => &["fn ", "function ", "class ", "def "],
    };

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*") {
            continue;
        }
        for pattern in patterns {
            if let Some(rest) = trimmed.strip_prefix(pattern) {
                let rest = rest.trim_start();
                // 提取标识符名称
                if let Some(name) = extract_identifier(rest) {
                    if name.len() >= 2 && !is_keyword(&name, language) {
                        names.push(name);
                    }
                }
            }
        }
    }

    names
}

/// 从代码行开头提取标识符名称
fn extract_identifier(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut name = String::new();
    for ch in &chars {
        if ch.is_alphanumeric() || *ch == '_' {
            name.push(*ch);
        } else {
            break;
        }
    }
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 检查是否为语言关键字
fn is_keyword(name: &str, language: &str) -> bool {
    let keywords: &[&str] = match language {
        "rust" => &[
            "fn", "struct", "enum", "trait", "impl", "mod", "pub", "use",
            "let", "mut", "const", "static", "if", "else", "match", "for",
            "while", "loop", "return", "self", "Self", "super", "crate",
            "true", "false", "async", "await", "move", "ref", "type",
            "where", "unsafe", "extern", "as", "in", "dyn", "box",
        ],
        "typescript" | "javascript" => &[
            "function", "class", "interface", "type", "const", "let", "var",
            "if", "else", "for", "while", "return", "this", "true", "false",
            "null", "undefined", "import", "export", "default", "from",
            "async", "await", "new", "typeof", "instanceof", "in", "of",
            "switch", "case", "break", "continue", "try", "catch", "throw",
            "extends", "implements", "static", "public", "private", "protected",
        ],
        "python" => &[
            "def", "class", "if", "elif", "else", "for", "while", "return",
            "import", "from", "as", "True", "False", "None", "and", "or",
            "not", "in", "is", "lambda", "try", "except", "finally", "with",
            "raise", "yield", "pass", "break", "continue", "global", "nonlocal",
        ],
        _ => &[
            "fn", "function", "class", "def", "return", "if", "else",
        ],
    };
    keywords.contains(&name)
}

/// 提取代码段中的导入
fn extract_imports(content: &str, language: &str) -> Vec<String> {
    let mut imports = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        match language {
            "rust" => {
                if trimmed.starts_with("use ") {
                    // use std::collections::HashMap; -> "std::collections"
                    if let Some(import_path) = trimmed.strip_prefix("use ") {
                        let path = import_path.trim();
                        // 取模块路径部分（去掉最后的 ::{...} 或 ::Name）
                        let parts: Vec<&str> = path.split("::").collect();
                        if parts.len() >= 2 {
                            let module = parts[..parts.len() - 1].join("::");
                            imports.push(module);
                        } else if let Some(name) = parts.first() {
                            imports.push(name.to_string());
                        }
                    }
                }
                if trimmed.starts_with("mod ") {
                    if let Some(name) = trimmed.strip_prefix("mod ") {
                        let name = name.trim().trim_end_matches(';');
                        imports.push(name.to_string());
                    }
                }
            }
            "typescript" | "javascript" => {
                if trimmed.starts_with("import ") {
                    // import { foo } from "./bar"; -> "./bar"
                    // import "./style.css"; -> "./style.css"
                    if let Some(from_pos) = trimmed.find("from ") {
                        let path = &trimmed[from_pos + 5..].trim();
                        let path = path.trim_matches(|c| c == '\'' || c == '"' || c == ';');
                        imports.push(path.to_string());
                    } else if let Some(import_start) = trimmed.find("import ") {
                        let rest = &trimmed[import_start + 7..].trim();
                        let path = rest.trim_matches(|c| c == '\'' || c == '"' || c == ';');
                        if !path.is_empty() && path.contains('/') {
                            imports.push(path.to_string());
                        }
                    }
                }
                if trimmed.starts_with("require(") {
                    // const fs = require("fs"); -> "fs"
                    if let Some(start) = trimmed.find('(') {
                        if let Some(end) = trimmed.rfind(')') {
                            let path = &trimmed[start + 1..end].trim();
                            let path = path.trim_matches(|c| c == '\'' || c == '"');
                            imports.push(path.to_string());
                        }
                    }
                }
            }
            "python" => {
                if trimmed.starts_with("import ") {
                    // import os -> "os"
                    let rest = trimmed.strip_prefix("import ").unwrap_or("");
                    for part in rest.split(',') {
                        let name = part.trim().split_whitespace().next().unwrap_or("");
                        imports.push(name.to_string());
                    }
                }
                if trimmed.starts_with("from ") {
                    // from collections import defaultdict -> "collections"
                    let rest = trimmed.strip_prefix("from ").unwrap_or("");
                    if let Some(module) = rest.split_whitespace().next() {
                        imports.push(module.to_string());
                    }
                }
            }
            "go" => {
                if trimmed.starts_with("import ") || trimmed == "import (" {
                    // 简单导入语句
                    let rest = trimmed.strip_prefix("import ").unwrap_or("");
                    let path = rest.trim().trim_matches(|c| c == '"' || c == '(' || c == ')');
                    if !path.is_empty() {
                        imports.push(path.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    // 去重
    let mut seen = HashSet::new();
    imports.retain(|i| seen.insert(i.clone()));
    imports
}

/// 提取代码段中的函数调用
fn extract_calls(content: &str, _language: &str) -> Vec<String> {
    let mut calls = Vec::new();

    // 匹配 identifier(...) 调用模式
    for line in content.lines() {
        let trimmed = line.trim();
        // 跳过注释
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*") || trimmed.starts_with('*') {
            continue;
        }

        // 查找所有 word(...) 模式
        let chars: Vec<char> = trimmed.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            // 找到标识符开头
            if chars[i].is_alphabetic() || chars[i] == '_' {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let name: String = chars[start..i].iter().collect();

                // 跳过空格看是否是 (
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '(' {
                    // 确保不是关键词，且首字母小写（函数调用不是类型）
                    let first_char = name.chars().next().unwrap(); // safe: name非空
                    if !is_keyword(&name, _language)
                        && name.len() >= 2
                        && first_char.is_lowercase()
                        // 跳过常见内置
                        && !matches!(
                            name.as_str(),
                            "if" | "for" | "while" | "match" | "switch" | "return"
                                | "println" | "print" | "console" | "require" | "import"
                                | "assert" | "panic" | "throw" | "await" | "typeof"
                                | "Ok" | "Err" | "Some" | "None" | "Vec" | "String"
                                | "HashMap" | "HashSet" | "Option" | "Result" | "Box"
                        )
                    {
                        calls.push(name);
                    }
                }
            } else {
                i += 1;
            }
        }
    }

    // 去重，限制数量
    let mut seen = HashSet::new();
    calls.retain(|c| seen.insert(c.clone()));
    calls.truncate(20);
    calls
}
