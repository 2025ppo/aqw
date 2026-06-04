use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// 搜索 Bing 并返回结果
pub async fn search(query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
    let encoded_query = urlencode(query);
    let html_url = format!(
        "https://www.bing.com/search?q={}&setlang=zh-Hans",
        encoded_query
    );
    let rss_url = format!(
        "https://www.bing.com/search?format=rss&q={}&setlang=zh-Hans",
        encoded_query
    );

    let client = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|e| format!("创建搜索客户端失败: {}", e))?;

    let rss_response = client
        .get(&rss_url)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("RSS 搜索请求失败: {}", e))?;
    let rss_text = rss_response
        .text()
        .await
        .map_err(|e| format!("读取 RSS 响应失败: {}", e))?;

    let rss_results = parse_bing_rss_results(&rss_text, max_results);
    if !rss_results.is_empty() {
        return Ok(rss_results);
    }

    let response = client
        .get(&html_url)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| format!("HTML 搜索请求失败: {}", e))?;
    let html_text = response
        .text()
        .await
        .map_err(|e| format!("读取 HTML 响应失败: {}", e))?;

    let html_results = parse_bing_html_results(&html_text, max_results)?;
    if html_results.is_empty() {
        return Err("搜索接口未返回任何结果".to_string());
    }

    Ok(html_results)
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
        cleaned[..cleaned
            .char_indices()
            .nth(8000)
            .map(|(i, _)| i)
            .unwrap_or(cleaned.len())]
            .to_string()
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

fn parse_bing_html_results(
    html_text: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, String> {
    let document = Html::parse_document(html_text);

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
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let url = element
            .select(&title_selector)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or("")
            .trim()
            .to_string();

        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
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

fn parse_bing_rss_results(xml_text: &str, max_results: usize) -> Vec<SearchResult> {
    let mut results = Vec::new();

    for item in xml_text.split("<item>").skip(1) {
        if results.len() >= max_results {
            break;
        }

        let Some(item_content) = item.split("</item>").next() else {
            continue;
        };

        let title = extract_xml_tag(item_content, "title")
            .map(|value| clean_xml_text(&value))
            .unwrap_or_default();
        let url = extract_xml_tag(item_content, "link")
            .map(|value| decode_xml_entities(value.trim()))
            .unwrap_or_default();
        let snippet = extract_xml_tag(item_content, "description")
            .map(|value| clean_xml_text(&value))
            .unwrap_or_default();

        if !title.is_empty() && !url.is_empty() {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }
    }

    results
}

fn extract_xml_tag(content: &str, tag: &str) -> Option<String> {
    let open_tag = format!("<{}>", tag);
    let close_tag = format!("</{}>", tag);
    let start = content.find(&open_tag)? + open_tag.len();
    let end = content[start..].find(&close_tag)? + start;
    Some(content[start..end].to_string())
}

fn clean_xml_text(raw: &str) -> String {
    let text = raw
        .trim()
        .strip_prefix("<![CDATA[")
        .and_then(|value| value.strip_suffix("]]>"))
        .unwrap_or(raw)
        .trim();

    let fragment = Html::parse_fragment(text);
    let collected = fragment.root_element().text().collect::<String>();
    decode_xml_entities(collected.trim())
}

fn decode_xml_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

// ========== 增强版搜索（带缓存 + 多源fallback + 结构化返回） ==========

/// 搜索结果缓存
struct SearchCache {
    entries: HashMap<String, CacheEntry>,
    max_age: Duration,
}

struct CacheEntry {
    results: Vec<SearchResult>,
    created_at: Instant,
}

impl SearchCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            max_age: Duration::from_secs(3600),
        }
    }

    fn get(&self, query: &str) -> Option<&Vec<SearchResult>> {
        self.entries.get(query).and_then(|e| {
            if e.created_at.elapsed() < self.max_age {
                Some(&e.results)
            } else {
                None
            }
        })
    }

    fn set(&mut self, query: String, results: Vec<SearchResult>) {
        // 清理过期条目
        self.entries
            .retain(|_, v| v.created_at.elapsed() < self.max_age);
        self.entries.insert(
            query,
            CacheEntry {
                results,
                created_at: Instant::now(),
            },
        );
    }
}

static SEARCH_CACHE: Lazy<Mutex<SearchCache>> = Lazy::new(|| Mutex::new(SearchCache::new()));

/// 增强版搜索（带缓存+多源fallback+结构化返回）
pub async fn web_search_enhanced(
    query: &str,
    max_results: usize,
    max_tokens: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    // 1. 检查缓存
    {
        let cache = SEARCH_CACHE.lock().unwrap();
        if let Some(cached) = cache.get(query) {
            return Ok(truncate_results(cached.clone(), max_tokens));
        }
    }

    // 2. 多源尝试: 优先Bing
    let results = match search(query, max_results).await {
        Ok(r) if !r.is_empty() => r,
        _ => {
            // Bing失败，尝试DuckDuckGo
            match duckduckgo_search(query, max_results).await {
                Ok(r) if !r.is_empty() => r,
                _ => {
                    // 最后fallback：直接构造搜索URL
                    vec![SearchResult {
                        title: format!("搜索: {}", query),
                        url: format!("https://www.bing.com/search?q={}", urlencode(query)),
                        snippet: "所有搜索引擎均不可用，请手动搜索".into(),
                    }]
                }
            }
        }
    };

    // 3. 写入缓存
    {
        let mut cache = SEARCH_CACHE.lock().unwrap();
        cache.set(query.to_string(), results.clone());
    }

    Ok(truncate_results(results, max_tokens))
}

/// DuckDuckGo HTML搜索 (免费fallback)
async fn duckduckgo_search(query: &str, max_results: usize) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://html.duckduckgo.com/html/?q={}", urlencode(query));
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;

    let html = resp.text().await.map_err(|e| e.to_string())?;

    // 解析HTML结果
    let document = Html::parse_document(&html);
    let result_selector = Selector::parse(".result").unwrap();
    let title_selector = Selector::parse(".result__title a, .result__a").unwrap();
    let snippet_selector = Selector::parse(".result__snippet").unwrap();

    let mut results = Vec::new();
    for element in document.select(&result_selector).take(max_results) {
        let title = element
            .select(&title_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        let href = element
            .select(&title_selector)
            .next()
            .and_then(|e| e.value().attr("href"))
            .unwrap_or("")
            .to_string();
        let snippet = element
            .select(&snippet_selector)
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        if !title.is_empty() {
            results.push(SearchResult {
                title,
                url: href,
                snippet,
            });
        }
    }

    Ok(results)
}

/// 根据Token预算截断结果
fn truncate_results(results: Vec<SearchResult>, max_tokens: Option<usize>) -> Vec<SearchResult> {
    if let Some(budget) = max_tokens {
        let mut token_count = 0usize;
        results
            .into_iter()
            .take_while(|r| {
                let est = (r.title.len() + r.snippet.len()) / 3; // 粗略估算
                token_count += est;
                token_count <= budget
            })
            .collect()
    } else {
        results
    }
}

/// 将搜索结果格式化为模型友好的文本
#[allow(dead_code)]
pub fn format_results_for_model(results: &[SearchResult]) -> String {
    results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            format!(
                "[{}] {}\n    URL: {}\n    {}",
                i + 1,
                r.title,
                r.url,
                r.snippet
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
