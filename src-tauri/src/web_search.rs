use scraper::{Html, Selector};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// 搜索 Bing 并返回结果
pub async fn search(query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
    let encoded_query = urlencode(query);
    let url = format!(
        "https://www.bing.com/search?q={}&setlang=zh-Hans",
        encoded_query
    );

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let html_text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let document = Html::parse_document(&html_text);

    let algo_selector =
        Selector::parse(".b_algo").map_err(|e| format!("选择器解析失败: {:?}", e))?;
    let title_selector =
        Selector::parse("h2 a").map_err(|e| format!("标题选择器解析失败: {:?}", e))?;
    let snippet_selector =
        Selector::parse(".b_caption p").map_err(|e| format!("摘要选择器解析失败: {:?}", e))?;

    let mut results = Vec::new();

    for element in document.select(&algo_selector) {
        if results.len() >= max_results {
            break;
        }

        let title = element
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default();

        let url = element
            .select(&title_selector)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or("")
            .to_string();

        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default();

        if !title.is_empty() && !url.is_empty() {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }
    }

    Ok(results)
}

/// 获取网页正文内容
pub async fn fetch_page(url: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let html_text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let document = Html::parse_document(&html_text);

    // 提取 body 正文文本
    let body_selector = Selector::parse("body").map_err(|e| format!("选择器失败: {:?}", e))?;

    let mut text_content = String::new();

    if let Some(body) = document.select(&body_selector).next() {
        for text_node in body.text() {
            let trimmed = text_node.trim();
            if !trimmed.is_empty() {
                text_content.push_str(trimmed);
                text_content.push('\n');
            }
        }
    }

    // 简单过滤：去除多余空行
    let cleaned: String = text_content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<&str>>()
        .join("\n");

    // 截断返回长度
    let result = if cleaned.len() > 8000 {
        cleaned[..cleaned.char_indices().nth(8000).map(|(i, _)| i).unwrap_or(cleaned.len())].to_string()
    } else {
        cleaned
    };

    Ok(result)
}

/// 简单的 URL 编码
fn urlencode(s: &str) -> String {
    let mut result = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            b' ' => result.push('+'),
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}
