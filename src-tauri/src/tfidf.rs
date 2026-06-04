// ========== TF-IDF 向量化与搜索 ==========
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::perceptual_index::{CodeChunk, SearchResult};

/// TF-IDF 持久化数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TfIdfData {
    /// 词汇表: 词 -> 索引
    pub vocabulary: HashMap<String, usize>,
    /// IDF 值: 词索引 -> idf 值
    pub idf: HashMap<usize, f64>,
    /// 每个代码段的向量: chunk_id -> (词索引 -> tfidf权重)
    pub chunk_vectors: HashMap<String, HashMap<usize, f64>>,
}

/// 构建 TF-IDF 索引
pub fn build_index(chunks: &[CodeChunk]) -> TfIdfData {
    // 1. 分词并构建词汇表
    let (vocabulary, doc_tokens) = build_vocabulary(chunks);

    // 2. 计算 IDF
    let idf = compute_idf(&doc_tokens, &vocabulary);

    // 3. 计算每个段的 TF-IDF 向量
    let mut chunk_vectors: HashMap<String, HashMap<usize, f64>> = HashMap::new();
    let _total_docs = chunks.len() as f64;

    for (_i, chunk) in chunks.iter().enumerate() {
        let tokens = tokenize(&chunk.content);
        let tf_map = compute_tf(&tokens);
        let mut tfidf_vec = HashMap::new();

        for (term, tf) in &tf_map {
            if let Some(&term_idx) = vocabulary.get(term) {
                if let Some(&idf_val) = idf.get(&term_idx) {
                    // TF-IDF = (1 + log(tf)) * idf
                    let tfidf = (1.0 + (*tf as f64).ln()) * idf_val;
                    if tfidf > 0.0 {
                        tfidf_vec.insert(term_idx, tfidf);
                    }
                }
            }
        }

        // L2 归一化
        let norm: f64 = tfidf_vec.values().map(|v| v * v).sum::<f64>().sqrt();
        if norm > 0.0 {
            for val in tfidf_vec.values_mut() {
                *val /= norm;
            }
        }

        chunk_vectors.insert(chunk.id.clone(), tfidf_vec);
    }

    TfIdfData {
        vocabulary,
        idf,
        chunk_vectors,
    }
}

/// 搜索查询
pub fn search(query: &str, data: &TfIdfData, chunks: &[CodeChunk]) -> Vec<SearchResult> {
    // 1. 分词查询
    let query_tokens = tokenize(query);
    let query_tf = compute_tf(&query_tokens);

    // 2. 构建查询向量
    let mut query_vec: HashMap<usize, f64> = HashMap::new();
    for (term, tf) in &query_tf {
        if let Some(&term_idx) = data.vocabulary.get(term) {
            if let Some(&idf_val) = data.idf.get(&term_idx) {
                let tfidf = (1.0 + (*tf as f64).ln()) * idf_val;
                query_vec.insert(term_idx, tfidf);
            }
        }
    }

    // L2 归一化
    let norm: f64 = query_vec.values().map(|v| v * v).sum::<f64>().sqrt();
    if norm > 0.0 {
        for val in query_vec.values_mut() {
            *val /= norm;
        }
    }

    // 3. 计算与每个段落的余弦相似度
    let mut scored: Vec<(String, f64)> = Vec::new();
    for chunk in chunks {
        if let Some(chunk_vec) = data.chunk_vectors.get(&chunk.id) {
            let similarity = cosine_similarity(&query_vec, chunk_vec);
            if similarity > 0.0 {
                scored.push((chunk.id.clone(), similarity));
            }
        }
    }

    // 4. 按相似度降序排序
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // 5. 返回 Top-15
    let top_n = 15;
    let mut results = Vec::new();
    let chunk_map: HashMap<&str, &CodeChunk> = chunks.iter().map(|c| (c.id.as_str(), c)).collect();

    for (chunk_id, score) in scored.into_iter().take(top_n) {
        if let Some(chunk) = chunk_map.get(chunk_id.as_str()) {
            results.push(SearchResult {
                chunk: (*chunk).clone(),
                similarity_score: score,
                graph_score: 0.0,
                final_score: 0.0, // 由融合层计算
                source: "tfidf".to_string(),
            });
        }
    }

    results
}

// ---- 分词器 ----

/// 中文+英文混合分词
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if ch.is_whitespace() || ch == '\n' || ch == '\r' || ch == '\t' {
            i += 1;
            continue;
        }

        // 标点符号跳过（但保留 . _ # 等代码常见符号）
        if ch.is_ascii_punctuation() && !matches!(ch, '.' | '_' | '#') {
            i += 1;
            continue;
        }

        if is_chinese_char(ch) {
            // 中文单字
            tokens.push(ch.to_string());
            // 双字组合
            if i + 1 < chars.len() && is_chinese_char(chars[i + 1]) {
                tokens.push(format!("{}{}", ch, chars[i + 1]));
            }
            if i + 2 < chars.len() && is_chinese_char(chars[i + 1]) && is_chinese_char(chars[i + 2])
            {
                tokens.push(format!("{}{}{}", ch, chars[i + 1], chars[i + 2]));
            }
            i += 1;
        } else if ch.is_alphanumeric() || ch == '_' || ch == '.' || ch == '#' {
            // 英文单词/标识符
            let start = i;
            while i < chars.len()
                && (chars[i].is_alphanumeric()
                    || chars[i] == '_'
                    || chars[i] == '.'
                    || chars[i] == '#')
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let lower = word.to_lowercase();

            // 过滤太短的词和纯数字
            if lower.len() >= 2 && !lower.chars().all(|c| c.is_ascii_digit() || c == '.') {
                // 也添加原始大小写版本（对代码标识符重要）
                if word != lower {
                    tokens.push(word);
                }
                tokens.push(lower);
            }
        } else {
            i += 1;
        }
    }

    tokens
}

fn is_chinese_char(ch: char) -> bool {
    matches!(ch, '\u{4e00}'..='\u{9fff}' | '\u{3400}'..='\u{4dbf}')
}

// ---- 词汇表 ----

fn build_vocabulary(chunks: &[CodeChunk]) -> (HashMap<String, usize>, Vec<Vec<String>>) {
    let mut term_doc_count: HashMap<String, usize> = HashMap::new();
    let mut doc_tokens: Vec<Vec<String>> = Vec::new();

    for chunk in chunks {
        let tokens = tokenize(&chunk.content);
        let unique: HashSet<String> = tokens.iter().cloned().collect();

        for term in &unique {
            *term_doc_count.entry(term.clone()).or_insert(0) += 1;
        }
        doc_tokens.push(tokens);
    }

    // 按文档频率排序，取前 5000 个最常见的词
    let mut freq_pairs: Vec<(&String, &usize)> = term_doc_count.iter().collect();
    freq_pairs.sort_by(|a, b| b.1.cmp(a.1));
    freq_pairs.truncate(5000);

    let vocabulary: HashMap<String, usize> = freq_pairs
        .into_iter()
        .enumerate()
        .map(|(idx, (term, _))| (term.clone(), idx))
        .collect();

    (vocabulary, doc_tokens)
}

// ---- TF 计算 ----

fn compute_tf(tokens: &[String]) -> HashMap<String, usize> {
    let mut tf = HashMap::new();
    for token in tokens {
        *tf.entry(token.clone()).or_insert(0) += 1;
    }
    tf
}

// ---- IDF 计算 ----

fn compute_idf(
    doc_tokens: &[Vec<String>],
    vocabulary: &HashMap<String, usize>,
) -> HashMap<usize, f64> {
    let total_docs = doc_tokens.len() as f64;
    let mut idf: HashMap<usize, f64> = HashMap::new();

    for doc in doc_tokens {
        let unique: HashSet<&String> = doc.iter().collect();
        for term in &unique {
            if let Some(&idx) = vocabulary.get(*term) {
                *idf.entry(idx).or_insert(0.0) += 1.0;
            }
        }
    }

    // IDF = log(1 + N / df)
    for (_, val) in idf.iter_mut() {
        *val = (1.0 + total_docs / *val).ln();
    }

    idf
}

// ---- 余弦相似度 ----

fn cosine_similarity(vec_a: &HashMap<usize, f64>, vec_b: &HashMap<usize, f64>) -> f64 {
    // 两个向量都已经 L2 归一化，所以点积就是余弦相似度
    let mut dot_product = 0.0;

    // 遍历较短的向量以提高效率
    if vec_a.len() <= vec_b.len() {
        for (idx, a_val) in vec_a {
            if let Some(b_val) = vec_b.get(idx) {
                dot_product += a_val * b_val;
            }
        }
    } else {
        for (idx, b_val) in vec_b {
            if let Some(a_val) = vec_a.get(idx) {
                dot_product += a_val * b_val;
            }
        }
    }

    dot_product.clamp(0.0, 1.0)
}
