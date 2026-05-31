use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct SheetData {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Serialize)]
pub struct DocumentContent {
    pub format: String,
    pub text: String,
    pub metadata: Option<String>,
    pub sheets: Option<Vec<SheetData>>,
}

/// 读取文档
pub fn read_doc(file_path: &str) -> Result<DocumentContent, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "txt" | "md" | "log" | "json" | "toml" | "yaml" | "yml" | "xml" | "html" | "css" | "js" | "ts" | "rs" | "py" | "java" | "go" | "c" | "cpp" | "h" => {
            read_text_file(file_path, &extension)
        }
        "pdf" => read_pdf_file(file_path),
        "docx" => read_docx_file(file_path),
        "xlsx" | "xls" => read_excel_file(file_path),
        "csv" => read_csv_file(file_path),
        _ => Err(format!("不支持的文件格式: .{}", extension)),
    }
}

/// 写入文档
pub fn write_doc(file_path: &str, content: &str, format: &str) -> Result<String, String> {
    let fmt = format.to_lowercase();
    match fmt.as_str() {
        "txt" | "md" | "text" | "markdown" => {
            std::fs::write(file_path, content)
                .map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(format!("成功写入文件: {}", file_path))
        }
        "csv" => write_csv_file(file_path, content),
        "docx" => write_docx_file(file_path, content),
        _ => Err(format!("不支持的写入格式: {}", format)),
    }
}

/// 读取纯文本文件
fn read_text_file(file_path: &str, extension: &str) -> Result<DocumentContent, String> {
    let text = std::fs::read_to_string(file_path)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    Ok(DocumentContent {
        format: extension.to_string(),
        text,
        metadata: None,
        sheets: None,
    })
}

/// 读取 PDF 文件
fn read_pdf_file(file_path: &str) -> Result<DocumentContent, String> {
    use lopdf::Document;

    let doc = Document::load(file_path)
        .map_err(|e| format!("打开PDF失败: {}", e))?;

    let mut text = String::new();
    let pages = doc.get_pages();

    for (page_num, _) in pages.iter() {
        match doc.extract_text(&[*page_num]) {
            Ok(page_text) => {
                text.push_str(&page_text);
                text.push('\n');
            }
            Err(_) => {
                // 某些页面可能无法提取文本，跳过
                continue;
            }
        }
    }

    let metadata = Some(format!("页数: {}", pages.len()));

    Ok(DocumentContent {
        format: "pdf".to_string(),
        text,
        metadata,
        sheets: None,
    })
}

/// 读取 DOCX 文件
fn read_docx_file(file_path: &str) -> Result<DocumentContent, String> {
    use docx_rs::*;

    let file_bytes = std::fs::read(file_path)
        .map_err(|e| format!("读取DOCX文件失败: {}", e))?;

    let doc = read_docx(&file_bytes)
        .map_err(|e| format!("解析DOCX失败: {}", e))?;

    let mut text = String::new();

    for child in doc.document.children.iter() {
        match child {
            DocumentChild::Paragraph(para) => {
                for pc in para.children.iter() {
                    match pc {
                        ParagraphChild::Run(run) => {
                            for rc in run.children.iter() {
                                match rc {
                                    RunChild::Text(t) => {
                                        text.push_str(&t.text);
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                }
                text.push('\n');
            }
            _ => {}
        }
    }

    Ok(DocumentContent {
        format: "docx".to_string(),
        text,
        metadata: None,
        sheets: None,
    })
}

/// 读取 Excel 文件
fn read_excel_file(file_path: &str) -> Result<DocumentContent, String> {
    use calamine::{open_workbook, Reader, Xlsx, Xls};

    let path = Path::new(file_path);
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut sheets_data: Vec<SheetData> = Vec::new();
    let mut all_text = String::new();

    if extension == "xlsx" {
        let mut workbook: Xlsx<_> = open_workbook(file_path)
            .map_err(|e| format!("打开Excel文件失败: {}", e))?;

        for sheet_name in workbook.sheet_names().to_vec() {
            if let Ok(range) = workbook.worksheet_range(&sheet_name) {
                let mut headers = Vec::new();
                let mut rows = Vec::new();
                let mut first_row = true;

                for row in range.rows() {
                    let row_data: Vec<String> = row.iter().map(|cell| {
                        format!("{}", cell)
                    }).collect();

                    if first_row {
                        headers = row_data;
                        first_row = false;
                    } else {
                        rows.push(row_data);
                    }
                }

                all_text.push_str(&format!("[Sheet: {}]\n", sheet_name));
                all_text.push_str(&headers.join("\t"));
                all_text.push('\n');
                for row in &rows {
                    all_text.push_str(&row.join("\t"));
                    all_text.push('\n');
                }
                all_text.push('\n');

                sheets_data.push(SheetData {
                    name: sheet_name,
                    headers,
                    rows,
                });
            }
        }
    } else {
        let mut workbook: Xls<_> = open_workbook(file_path)
            .map_err(|e| format!("打开Excel文件失败: {}", e))?;

        for sheet_name in workbook.sheet_names().to_vec() {
            if let Ok(range) = workbook.worksheet_range(&sheet_name) {
                let mut headers = Vec::new();
                let mut rows = Vec::new();
                let mut first_row = true;

                for row in range.rows() {
                    let row_data: Vec<String> = row.iter().map(|cell| {
                        format!("{}", cell)
                    }).collect();

                    if first_row {
                        headers = row_data;
                        first_row = false;
                    } else {
                        rows.push(row_data);
                    }
                }

                all_text.push_str(&format!("[Sheet: {}]\n", sheet_name));
                all_text.push_str(&headers.join("\t"));
                all_text.push('\n');
                for row in &rows {
                    all_text.push_str(&row.join("\t"));
                    all_text.push('\n');
                }
                all_text.push('\n');

                sheets_data.push(SheetData {
                    name: sheet_name,
                    headers,
                    rows,
                });
            }
        }
    }

    Ok(DocumentContent {
        format: extension.to_string(),
        text: all_text,
        metadata: Some(format!("工作表数: {}", sheets_data.len())),
        sheets: Some(sheets_data),
    })
}

/// 读取 CSV 文件
fn read_csv_file(file_path: &str) -> Result<DocumentContent, String> {
    let mut reader = csv::Reader::from_path(file_path)
        .map_err(|e| format!("打开CSV文件失败: {}", e))?;

    let headers: Vec<String> = reader
        .headers()
        .map_err(|e| format!("读取CSV表头失败: {}", e))?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut text = headers.join(",");
    text.push('\n');

    for result in reader.records() {
        let record = result.map_err(|e| format!("读取CSV行失败: {}", e))?;
        let row: Vec<String> = record.iter().map(|s| s.to_string()).collect();
        text.push_str(&row.join(","));
        text.push('\n');
        rows.push(row);
    }

    let sheet = SheetData {
        name: "CSV".to_string(),
        headers,
        rows,
    };

    Ok(DocumentContent {
        format: "csv".to_string(),
        text,
        metadata: None,
        sheets: Some(vec![sheet]),
    })
}

/// 写入 CSV 文件
fn write_csv_file(file_path: &str, content: &str) -> Result<String, String> {
    let mut writer = csv::Writer::from_path(file_path)
        .map_err(|e| format!("创建CSV文件失败: {}", e))?;

    for line in content.lines() {
        let fields: Vec<&str> = line.split(',').collect();
        writer
            .write_record(&fields)
            .map_err(|e| format!("写入CSV行失败: {}", e))?;
    }

    writer.flush().map_err(|e| format!("刷新CSV失败: {}", e))?;
    Ok(format!("成功写入CSV文件: {}", file_path))
}

/// 写入 DOCX 文件
fn write_docx_file(file_path: &str, content: &str) -> Result<String, String> {
    use docx_rs::*;

    let mut doc = Docx::new();

    for line in content.lines() {
        let para = Paragraph::new().add_run(Run::new().add_text(line));
        doc = doc.add_paragraph(para);
    }

    let file = std::fs::File::create(file_path)
        .map_err(|e| format!("创建DOCX文件失败: {}", e))?;

    doc.build()
        .pack(file)
        .map_err(|e| format!("写入DOCX失败: {}", e))?;

    Ok(format!("成功写入DOCX文件: {}", file_path))
}
