use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRecord {
    pub id: String,
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: Option<String>,
    pub model: String,
    pub key_id: String,
    pub timestamp: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenAllocation {
    pub expert_id: String,
    pub daily_limit: Option<u64>,
    pub monthly_limit: Option<u64>,
    pub yearly_limit: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenData {
    pub records: Vec<TokenUsageRecord>,
    pub allocations: Vec<TokenAllocation>,
    pub last_reset_daily: String,
    pub last_reset_monthly: String,
    pub last_reset_yearly: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaCheckRequest {
    pub expert_id: String,
    pub expert_name: String,
    pub allocations: Vec<TokenAllocation>,
    pub records: Vec<TokenUsageRecord>,
    pub exempt_expert_ids: Vec<String>,
    pub now_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaCheckResponse {
    pub allowed: bool,
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppendTokenUsageRequest {
    pub project_data: TokenData,
    pub user_data: TokenData,
    pub expert_id: String,
    pub expert_name: String,
    pub expert_title: Option<String>,
    pub model: String,
    pub key_id: String,
    pub usage: UsageSummary,
    pub timestamp: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppendTokenUsageResponse {
    pub project_data: TokenData,
    pub user_data: TokenData,
    pub record: TokenUsageRecord,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenExpertMeta {
    pub id: String,
    pub name: String,
    pub title: String,
    pub daily_limit: Option<u64>,
    pub monthly_limit: Option<u64>,
    pub yearly_limit: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenDashboardRequest {
    pub project_data: TokenData,
    pub user_data: TokenData,
    pub data_source: String,
    pub range: String,
    pub experts: Vec<TokenExpertMeta>,
    pub quota_exempt_ids: Vec<String>,
    pub now_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSummary {
    pub prompt: u64,
    pub completion: u64,
    pub total: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertDistributionItem {
    pub expert_id: String,
    pub name: String,
    pub title: String,
    pub total: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatsItem {
    pub model: String,
    pub calls: u64,
    pub tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaStatusItem {
    pub expert_id: String,
    pub name: String,
    pub title: String,
    pub daily_limit: Option<u64>,
    pub monthly_limit: Option<u64>,
    pub yearly_limit: Option<u64>,
    pub day_used: u64,
    pub month_used: u64,
    pub year_used: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpertRangeStat {
    pub expert_id: String,
    pub name: String,
    pub title: String,
    pub total: u64,
    pub quota: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrendSeries {
    pub labels: Vec<String>,
    pub buckets: Vec<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenDashboardSnapshot {
    pub today_usage: TokenUsageSummary,
    pub month_usage: TokenUsageSummary,
    pub total_usage: TokenUsageSummary,
    pub active_expert_count: usize,
    pub expert_distribution: Vec<ExpertDistributionItem>,
    pub model_stats: Vec<ModelStatsItem>,
    pub quota_status: Vec<QuotaStatusItem>,
    pub recent_records: Vec<TokenUsageRecord>,
    pub expert_range_stats: Vec<ExpertRangeStat>,
    pub trend: TrendSeries,
}

pub fn check_quota(request: &QuotaCheckRequest) -> QuotaCheckResponse {
    if request
        .exempt_expert_ids
        .iter()
        .any(|expert_id| expert_id == &request.expert_id)
    {
        return QuotaCheckResponse {
            allowed: true,
            reason: None,
        };
    }

    let Some(allocation) = request
        .allocations
        .iter()
        .find(|allocation| allocation.expert_id == request.expert_id)
    else {
        return QuotaCheckResponse {
            allowed: true,
            reason: None,
        };
    };

    let now_ms = request.now_ms.unwrap_or_else(now_ms);
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms as i64)
        .unwrap_or_else(chrono::Utc::now);
    let today_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as u64;
    let month_start = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis() as u64;
    let year_start = chrono::NaiveDate::from_ymd_opt(now.year(), 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis() as u64;

    if let Some(limit) = allocation.daily_limit {
        let used = sum_usage_since(&request.records, &request.expert_id, today_start);
        if used >= limit {
            return blocked(
                &request.expert_name,
                "日",
                used,
                limit,
                "请在设置中调整配额或等待明日重置",
            );
        }
    }
    if let Some(limit) = allocation.monthly_limit {
        let used = sum_usage_since(&request.records, &request.expert_id, month_start);
        if used >= limit {
            return blocked(
                &request.expert_name,
                "月",
                used,
                limit,
                "请在设置中调整配额或等待下月重置",
            );
        }
    }
    if let Some(limit) = allocation.yearly_limit {
        let used = sum_usage_since(&request.records, &request.expert_id, year_start);
        if used >= limit {
            return blocked(
                &request.expert_name,
                "年",
                used,
                limit,
                "请在设置中调整配额或等待明年重置",
            );
        }
    }

    QuotaCheckResponse {
        allowed: true,
        reason: None,
    }
}

pub fn append_token_usage(request: &AppendTokenUsageRequest) -> AppendTokenUsageResponse {
    let timestamp = request.timestamp.unwrap_or_else(now_ms);
    let record = TokenUsageRecord {
        id: generate_token_id(timestamp),
        expert_id: request.expert_id.clone(),
        expert_name: request.expert_name.clone(),
        expert_title: request.expert_title.clone(),
        model: request.model.clone(),
        key_id: request.key_id.clone(),
        timestamp,
        prompt_tokens: request.usage.prompt_tokens,
        completion_tokens: request.usage.completion_tokens,
        total_tokens: request.usage.total_tokens,
    };

    let mut project_data = request.project_data.clone();
    project_data.records.push(record.clone());

    let mut user_data = request.user_data.clone();
    user_data.records.push(record.clone());

    AppendTokenUsageResponse {
        project_data,
        user_data,
        record,
    }
}

pub fn build_dashboard_snapshot(request: &TokenDashboardRequest) -> TokenDashboardSnapshot {
    let now_ms = request.now_ms.unwrap_or_else(now_ms);
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms as i64)
        .unwrap_or_else(chrono::Utc::now);
    let data = if request.data_source == "user" {
        &request.user_data
    } else {
        &request.project_data
    };

    let today_start = start_of_day_ms(now);
    let month_start = start_of_month_ms(now);
    let year_start = start_of_year_ms(now);
    let range_start = get_range_start(&request.range, now);

    let today_usage = summarize_usage_since(&data.records, today_start);
    let month_usage = summarize_usage_since(&data.records, month_start);
    let total_usage = summarize_usage_since(&data.records, 0);

    let active_expert_count = data
        .records
        .iter()
        .filter(|record| record.timestamp >= range_start)
        .map(|record| record.expert_id.clone())
        .collect::<std::collections::HashSet<_>>()
        .len();

    let mut expert_distribution = request
        .experts
        .iter()
        .map(|expert| ExpertDistributionItem {
            expert_id: expert.id.clone(),
            name: expert.name.clone(),
            title: expert.title.clone(),
            total: data
                .records
                .iter()
                .filter(|record| record.expert_id == expert.id && record.timestamp >= range_start)
                .map(|record| record.total_tokens)
                .sum(),
        })
        .filter(|item| item.total > 0)
        .collect::<Vec<_>>();
    expert_distribution.sort_by(|a, b| b.total.cmp(&a.total));

    let mut model_stats_map = std::collections::HashMap::<String, ModelStatsItem>::new();
    for record in data.records.iter().filter(|record| record.timestamp >= range_start) {
        let entry = model_stats_map
            .entry(record.model.clone())
            .or_insert(ModelStatsItem {
                model: record.model.clone(),
                calls: 0,
                tokens: 0,
            });
        entry.calls += 1;
        entry.tokens += record.total_tokens;
    }
    let mut model_stats = model_stats_map.into_values().collect::<Vec<_>>();
    model_stats.sort_by(|a, b| b.tokens.cmp(&a.tokens));

    let quota_status = request
        .experts
        .iter()
        .filter(|expert| !request.quota_exempt_ids.iter().any(|id| id == &expert.id))
        .filter(|expert| expert.daily_limit.is_some() || expert.monthly_limit.is_some() || expert.yearly_limit.is_some())
        .map(|expert| QuotaStatusItem {
            expert_id: expert.id.clone(),
            name: expert.name.clone(),
            title: expert.title.clone(),
            daily_limit: expert.daily_limit,
            monthly_limit: expert.monthly_limit,
            yearly_limit: expert.yearly_limit,
            day_used: sum_usage_since(&request.project_data.records, &expert.id, today_start),
            month_used: sum_usage_since(&request.project_data.records, &expert.id, month_start),
            year_used: sum_usage_since(&request.project_data.records, &expert.id, year_start),
        })
        .collect();

    let mut recent_records = data.records.clone();
    recent_records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    recent_records.truncate(20);

    let mut expert_range_stats = request
        .experts
        .iter()
        .map(|expert| {
            let total = data
                .records
                .iter()
                .filter(|record| record.expert_id == expert.id && record.timestamp >= range_start)
                .map(|record| record.total_tokens)
                .sum();
            let quota = match request.range.as_str() {
                "today" => expert.daily_limit,
                "month" => expert.monthly_limit,
                "year" => expert.yearly_limit,
                _ => None,
            };
            ExpertRangeStat {
                expert_id: expert.id.clone(),
                name: expert.name.clone(),
                title: expert.title.clone(),
                total,
                quota,
            }
        })
        .filter(|item| item.total > 0 || item.quota.is_some())
        .collect::<Vec<_>>();
    expert_range_stats.sort_by(|a, b| b.total.cmp(&a.total));

    let trend = build_trend_series(&data.records, &request.range, now);

    TokenDashboardSnapshot {
        today_usage,
        month_usage,
        total_usage,
        active_expert_count,
        expert_distribution,
        model_stats,
        quota_status,
        recent_records,
        expert_range_stats,
        trend,
    }
}

fn sum_usage_since(records: &[TokenUsageRecord], expert_id: &str, start_ms: u64) -> u64 {
    records
        .iter()
        .filter(|record| record.expert_id == expert_id && record.timestamp >= start_ms)
        .map(|record| record.total_tokens)
        .sum()
}

fn summarize_usage_since(records: &[TokenUsageRecord], start_ms: u64) -> TokenUsageSummary {
    records
        .iter()
        .filter(|record| record.timestamp >= start_ms)
        .fold(
            TokenUsageSummary {
                prompt: 0,
                completion: 0,
                total: 0,
            },
            |mut acc, record| {
                acc.prompt += record.prompt_tokens;
                acc.completion += record.completion_tokens;
                acc.total += record.total_tokens;
                acc
            },
        )
}

fn get_range_start(range: &str, now: chrono::DateTime<chrono::Utc>) -> u64 {
    match range {
        "today" => start_of_day_ms(now),
        "week" => {
            let weekday = now.weekday().number_from_monday() as i64 - 1;
            let start = now.date_naive() - chrono::Days::new(weekday as u64);
            start.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as u64
        }
        "month" => start_of_month_ms(now),
        "year" => start_of_year_ms(now),
        _ => 0,
    }
}

fn start_of_day_ms(now: chrono::DateTime<chrono::Utc>) -> u64 {
    now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis() as u64
}

fn start_of_month_ms(now: chrono::DateTime<chrono::Utc>) -> u64 {
    chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis() as u64
}

fn start_of_year_ms(now: chrono::DateTime<chrono::Utc>) -> u64 {
    chrono::NaiveDate::from_ymd_opt(now.year(), 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis() as u64
}

fn build_trend_series(
    records: &[TokenUsageRecord],
    range: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> TrendSeries {
    match range {
        "today" => {
            let mut buckets = vec![0u64; 24];
            for record in records.iter().filter(|record| record.timestamp >= start_of_day_ms(now)) {
                let hour = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(record.timestamp as i64)
                    .map(|dt| dt.hour() as usize)
                    .unwrap_or(0);
                buckets[hour] += record.total_tokens;
            }
            TrendSeries {
                labels: (0..24).map(|hour| format!("{hour}")).collect(),
                buckets,
            }
        }
        "week" => {
            let mut buckets = vec![0u64; 7];
            let start = get_range_start("week", now);
            for record in records.iter().filter(|record| record.timestamp >= start) {
                let weekday = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(record.timestamp as i64)
                    .map(|dt| dt.weekday().number_from_monday() as usize - 1)
                    .unwrap_or(0);
                buckets[weekday] += record.total_tokens;
            }
            TrendSeries {
                labels: vec!["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
                    .into_iter()
                    .map(String::from)
                    .collect(),
                buckets,
            }
        }
        "month" => {
            let days_in_month = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
                .unwrap()
                .checked_add_months(chrono::Months::new(1))
                .unwrap()
                .pred_opt()
                .map(|date| date.day())
                .unwrap_or(30) as usize;
            let mut buckets = vec![0u64; days_in_month];
            let start = start_of_month_ms(now);
            for record in records.iter().filter(|record| record.timestamp >= start) {
                let day = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(record.timestamp as i64)
                    .map(|dt| dt.day() as usize - 1)
                    .unwrap_or(0);
                if day < buckets.len() {
                    buckets[day] += record.total_tokens;
                }
            }
            TrendSeries {
                labels: (1..=days_in_month).map(|day| day.to_string()).collect(),
                buckets,
            }
        }
        "year" => {
            let mut buckets = vec![0u64; 12];
            let start = start_of_year_ms(now);
            for record in records.iter().filter(|record| record.timestamp >= start) {
                let month = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(record.timestamp as i64)
                    .map(|dt| dt.month0() as usize)
                    .unwrap_or(0);
                buckets[month] += record.total_tokens;
            }
            TrendSeries {
                labels: (1..=12).map(|month| format!("{month}月")).collect(),
                buckets,
            }
        }
        _ => {
            let mut buckets = vec![0u64; 12];
            let labels = (0..12)
                .map(|offset| {
                    let month_index = 11 - offset;
                    let date = now
                        .date_naive()
                        .with_day(1)
                        .unwrap()
                        .checked_sub_months(chrono::Months::new(month_index as u32))
                        .unwrap();
                    format!("{}月", date.month())
                })
                .collect::<Vec<_>>();
            for record in records {
                if let Some(record_dt) = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(record.timestamp as i64) {
                    let diff = (now.year() - record_dt.year()) * 12 + now.month() as i32 - record_dt.month() as i32;
                    if (0..12).contains(&diff) {
                        buckets[11 - diff as usize] += record.total_tokens;
                    }
                }
            }
            TrendSeries { labels, buckets }
        }
    }
}

fn blocked(
    expert_name: &str,
    period: &str,
    used: u64,
    limit: u64,
    suffix: &str,
) -> QuotaCheckResponse {
    QuotaCheckResponse {
        allowed: false,
        reason: Some(format!(
            "专家 {} 的{}词元配额已耗尽（已用 {} / 上限 {}），{}",
            expert_name,
            period,
            format_number(used),
            format_number(limit),
            suffix
        )),
    }
}

fn format_number(value: u64) -> String {
    let raw = value.to_string();
    let mut out = String::new();
    for (index, ch) in raw.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

fn generate_token_id(timestamp: u64) -> String {
    format!(
        "{}-{}",
        radix36(timestamp),
        radix36(timestamp.rotate_left(7) ^ 0x9E3779B97F4A7C15)
    )
}

fn radix36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut chars = Vec::new();
    while value > 0 {
        chars.push(DIGITS[(value % 36) as usize] as char);
        value /= 36;
    }
    chars.into_iter().rev().collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{append_token_usage, check_quota, AppendTokenUsageRequest, QuotaCheckRequest, TokenAllocation, TokenData, TokenUsageRecord, UsageSummary};

    fn empty_token_data() -> TokenData {
        TokenData {
            records: vec![],
            allocations: vec![],
            last_reset_daily: "2026-06-01".to_string(),
            last_reset_monthly: "2026-06".to_string(),
            last_reset_yearly: "2026".to_string(),
        }
    }

    #[test]
    fn blocks_when_daily_limit_reached() {
        let decision = check_quota(&QuotaCheckRequest {
            expert_id: "jiang-yumo".to_string(),
            expert_name: "江予墨".to_string(),
            allocations: vec![TokenAllocation {
                expert_id: "jiang-yumo".to_string(),
                daily_limit: Some(100),
                monthly_limit: None,
                yearly_limit: None,
            }],
            records: vec![TokenUsageRecord {
                id: "r1".to_string(),
                expert_id: "jiang-yumo".to_string(),
                expert_name: "江予墨".to_string(),
                expert_title: Some("前端工程师".to_string()),
                model: "deepseek-chat".to_string(),
                key_id: "key-1".to_string(),
                timestamp: 1_780_531_200_000,
                prompt_tokens: 30,
                completion_tokens: 70,
                total_tokens: 100,
            }],
            exempt_expert_ids: vec![],
            now_ms: Some(1_780_531_200_000),
        });
        assert!(!decision.allowed);
        assert!(decision.reason.unwrap_or_default().contains("日词元配额已耗尽"));
    }

    #[test]
    fn appends_usage_into_both_datasets() {
        let response = append_token_usage(&AppendTokenUsageRequest {
            project_data: empty_token_data(),
            user_data: empty_token_data(),
            expert_id: "jiang-yumo".to_string(),
            expert_name: "江予墨".to_string(),
            expert_title: Some("前端工程师".to_string()),
            model: "deepseek-chat".to_string(),
            key_id: "key-1".to_string(),
            usage: UsageSummary {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
            },
            timestamp: Some(1000),
        });
        assert_eq!(response.project_data.records.len(), 1);
        assert_eq!(response.user_data.records.len(), 1);
        assert_eq!(response.record.total_tokens, 30);
    }
}
