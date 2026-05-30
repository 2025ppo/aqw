// ========== 代码分段器 - 语言感知的代码切分 ==========
use crate::perceptual_index::CodeChunk;

/// 对单个文件内容进行智能分段
pub fn chunk_file(file_path: &str, content: &str) -> Vec<CodeChunk> {
    let language = detect_language(file_path);

    match language.as_str() {
        "markdown" => chunk_markdown(file_path, content),
        "rust" | "typescript" | "javascript" | "python" | "go" | "java" | "kotlin" | "swift" | "c" | "cpp" => {
            chunk_code(file_path, content, &language)
        }
        _ => chunk_generic(file_path, content, &language),
    }
}

/// 检测文件语言
pub fn detect_language(file_path: &str) -> String {
    let lower = file_path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".mdx") {
        "markdown".to_string()
    } else if lower.ends_with(".rs") {
        "rust".to_string()
    } else if lower.ends_with(".ts") || lower.ends_with(".tsx") {
        "typescript".to_string()
    } else if lower.ends_with(".js") || lower.ends_with(".jsx") {
        "javascript".to_string()
    } else if lower.ends_with(".py") {
        "python".to_string()
    } else if lower.ends_with(".go") {
        "go".to_string()
    } else if lower.ends_with(".java") {
        "java".to_string()
    } else if lower.ends_with(".kt") || lower.ends_with(".kts") {
        "kotlin".to_string()
    } else if lower.ends_with(".swift") {
        "swift".to_string()
    } else if lower.ends_with(".c") {
        "c".to_string()
    } else if lower.ends_with(".cpp") || lower.ends_with(".cxx") || lower.ends_with(".cc") || lower.ends_with(".hpp") || lower.ends_with(".h") {
        "cpp".to_string()
    } else {
        "text".to_string()
    }
}

/// Markdown 文件按标题层级分段
fn chunk_markdown(file_path: &str, content: &str) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let mut current_title = String::new();
    let mut current_content = String::new();
    let mut start_line = 0usize;
    let mut chunk_id = 0usize;

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();

        // 检测标题 (# ## ### ...)
        if trimmed.starts_with('#') && !trimmed.starts_with("```") {
            // 保存上一个分段
            if !current_title.is_empty() || !current_content.trim().is_empty() {
                let content_text = std::mem::take(&mut current_content);
                if content_text.trim().len() >= 10 {
                    chunk_id += 1;
                    chunks.push(CodeChunk {
                        id: format!("{}-{}", file_path, chunk_id),
                        file_path: file_path.to_string(),
                        start_line,
                        end_line: i.saturating_sub(1),
                        content: if current_title.is_empty() {
                            content_text
                        } else {
                            format!("# {}\n{}", current_title, content_text)
                        },
                        language: "markdown".to_string(),
                    });
                }
            }
            current_title = trimmed.to_string();
            current_content = String::new();
            start_line = i;
        } else {
            if !current_content.is_empty() {
                current_content.push('\n');
            }
            current_content.push_str(line);
        }
    }

    // 最后一个分段
    let content_text = std::mem::take(&mut current_content);
    if content_text.trim().len() >= 10 {
        chunk_id += 1;
        chunks.push(CodeChunk {
            id: format!("{}-{}", file_path, chunk_id),
            file_path: file_path.to_string(),
            start_line,
            end_line: content.lines().count().saturating_sub(1),
            content: if current_title.is_empty() {
                content_text
            } else {
                format!("# {}\n{}", current_title, content_text)
            },
            language: "markdown".to_string(),
        });
    }

    chunks
}

/// 代码文件按函数/类/结构体边界分段
fn chunk_code(file_path: &str, content: &str, language: &str) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let lines: Vec<&str> = content.lines().collect();

    // 检测代码块边界的正则模式
    let block_starters = match language {
        "rust" => &[
            "fn ", "pub fn ", "async fn ", "pub async fn ",
            "struct ", "pub struct ", "enum ", "pub enum ",
            "impl ", "trait ", "pub trait ", "mod ", "pub mod ",
            "macro_rules!",
        ][..],
        "typescript" | "javascript" => &[
            "function ", "async function ", "export function ",
            "export async function ", "class ", "export class ",
            "interface ", "export interface ", "type ", "export type ",
            "const ", "export const ",
        ][..],
        "python" => &[
            "def ", "async def ", "class ",
        ][..],
        "go" => &[
            "func ", "type ", "const (", "var (",
        ][..],
        "java" | "kotlin" => &[
            "public class ", "class ", "public interface ", "interface ",
            "public fun ", "fun ", "public static ", "private ",
        ][..],
        "swift" => &[
            "func ", "class ", "struct ", "enum ", "protocol ",
            "extension ", "var ", "let ",
        ][..],
        "c" | "cpp" => &[
            "void ", "int ", "char ", "float ", "double ", "bool ",
            "struct ", "class ", "enum ", "template", "auto ",
            "static ", "inline ", "virtual ",
        ][..],
        _ => &["fn ", "function ", "class ", "def "][..],
    };

    let mut current_start = 0usize;
    let mut chunk_id = 0usize;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // 检查是否是新块的开始（顶层或缩进较浅的声明）
        let is_block_start = block_starters.iter().any(|starter| {
            trimmed.starts_with(starter)
        });

        // 只对顶层或接近顶层的声明分段
        let indent = line.len().saturating_sub(trimmed.len());
        let is_top_level = indent <= 4;

        if is_block_start && is_top_level && i > current_start {
            // 保存上一个分段
            let prev_content = lines[current_start..i].join("\n");
            if prev_content.trim().len() >= 10 {
                chunk_id += 1;
                chunks.push(CodeChunk {
                    id: format!("{}-{}", file_path, chunk_id),
                    file_path: file_path.to_string(),
                    start_line: current_start,
                    end_line: i.saturating_sub(1),
                    content: prev_content,
                    language: language.to_string(),
                });
            }
            current_start = i;
        }
    }

    // 最后一个分段
    let last_content = lines[current_start..].join("\n");
    if last_content.trim().len() >= 10 {
        chunk_id += 1;
        chunks.push(CodeChunk {
            id: format!("{}-{}", file_path, chunk_id),
            file_path: file_path.to_string(),
            start_line: current_start,
            end_line: lines.len().saturating_sub(1),
            content: last_content,
            language: language.to_string(),
        });
    }

    // 如果没有找到任何分段（文件都是零散语句），按段落切分
    if chunks.is_empty() {
        chunk_generic_internal(file_path, content, language)
    } else {
        // 把过大的分段再切分（>2000字符）
        let mut final_chunks = Vec::new();
        for chunk in chunks {
            if chunk.content.len() > 2000 {
                final_chunks.extend(split_large_chunk(&chunk, file_path, &mut chunk_id));
            } else {
                final_chunks.push(chunk);
            }
        }
        final_chunks
    }
}

/// 通用文本文件按段落切分
fn chunk_generic(file_path: &str, content: &str, language: &str) -> Vec<CodeChunk> {
    chunk_generic_internal(file_path, content, language)
}

fn chunk_generic_internal(file_path: &str, content: &str, language: &str) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let mut chunk_id = 0usize;

    // 按空行分割成段落
    let paragraphs: Vec<&str> = content.split("\n\n").collect();
    let mut start_line = 0usize;

    for para in paragraphs {
        let trimmed = para.trim();
        if trimmed.len() < 10 {
            start_line += para.lines().count() + 1;
            continue;
        }
        let line_count = para.lines().count();
        chunk_id += 1;
        chunks.push(CodeChunk {
            id: format!("{}-{}", file_path, chunk_id),
            file_path: file_path.to_string(),
            start_line,
            end_line: start_line + line_count.saturating_sub(1),
            content: trimmed.to_string(),
            language: language.to_string(),
        });
        start_line += line_count + 1; // +1 for the blank line
    }

    // 如果只有一段很大，按每约1500字符切分
    if chunks.len() == 1 && chunks[0].content.len() > 2000 {
        chunks = split_large_chunk(&chunks[0], file_path, &mut chunk_id);
    }

    chunks
}

/// 将过大的分段按段落再切分
fn split_large_chunk(chunk: &CodeChunk, file_path: &str, chunk_id: &mut usize) -> Vec<CodeChunk> {
    let mut chunks = Vec::new();
    let lines: Vec<&str> = chunk.content.lines().collect();
    let mut batch_start = 0usize;
    let mut batch_len = 0usize;

    for (i, line) in lines.iter().enumerate() {
        batch_len += line.len() + 1; // +1 for \n
        if batch_len > 1500 && i > batch_start {
            let content = lines[batch_start..i].join("\n");
            if content.trim().len() >= 10 {
                *chunk_id += 1;
                chunks.push(CodeChunk {
                    id: format!("{}-{}", file_path, chunk_id),
                    file_path: file_path.to_string(),
                    start_line: chunk.start_line + batch_start,
                    end_line: chunk.start_line + i.saturating_sub(1),
                    content,
                    language: chunk.language.clone(),
                });
            }
            batch_start = i;
            batch_len = 0;
        }
    }

    // 剩余部分
    if batch_start < lines.len() {
        let content = lines[batch_start..].join("\n");
        if content.trim().len() >= 10 {
            *chunk_id += 1;
            chunks.push(CodeChunk {
                id: format!("{}-{}", file_path, chunk_id),
                file_path: file_path.to_string(),
                start_line: chunk.start_line + batch_start,
                end_line: chunk.end_line,
                content,
                language: chunk.language.clone(),
            });
        }
    }

    if chunks.is_empty() {
        chunks.push(chunk.clone());
    }

    chunks
}
