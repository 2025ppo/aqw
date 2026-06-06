use std::borrow::Cow;

pub fn normalize_expert_id(expert_id: &str) -> Cow<'_, str> {
    match expert_id {
        "jiang-ruoxi" => Cow::Borrowed("discipline-120"),
        "jiang-dingchu" | "jiang-huaying" => Cow::Borrowed("discipline-760"),
        "jiang-qinglan" | "jiang-yumo" | "jiang-subai" => Cow::Borrowed("discipline-520"),
        "jiang-jianheng" | "jiang-cexun" | "jiang-yingqiu" => Cow::Borrowed("discipline-620"),
        "jiang-lingyu" => Cow::Borrowed("discipline-740"),
        "jiang-moxian" => Cow::Borrowed("discipline-750"),
        "jiang-wenshu" | "jiang-zhilan" => Cow::Borrowed("discipline-870"),
        "jiang-shuyan" => Cow::Borrowed("discipline-910"),
        _ => Cow::Borrowed(expert_id),
    }
}

pub fn normalize_expert_ids(expert_ids: &[String]) -> Vec<String> {
    expert_ids
        .iter()
        .map(|id| normalize_expert_id(id).into_owned())
        .collect()
}

pub fn is_supervisor_expert(expert_id: &str) -> bool {
    normalize_expert_id(expert_id).as_ref() == "jiang-xingtu"
}

pub fn is_review_expert(expert_id: &str) -> bool {
    matches!(
        normalize_expert_id(expert_id).as_ref(),
        "discipline-620" | "discipline-820"
    )
}

pub fn is_creative_expert(expert_id: &str) -> bool {
    normalize_expert_id(expert_id).as_ref() == "discipline-760"
}

pub fn is_documentation_expert(expert_id: &str) -> bool {
    matches!(
        normalize_expert_id(expert_id).as_ref(),
        "discipline-740" | "discipline-870"
    )
}

pub fn is_implementation_expert(expert_id: &str) -> bool {
    let normalized = normalize_expert_id(expert_id);
    let expert_id = normalized.as_ref();
    expert_id == "discipline-610"
        || expert_id
            .strip_prefix("discipline-")
            .and_then(|code| code.parse::<u16>().ok())
            .map(|code| (400..600).contains(&code))
            .unwrap_or(false)
}

pub fn supports_source_reading_rewrite(expert_id: &str) -> bool {
    let normalized = normalize_expert_id(expert_id);
    matches!(normalized.as_ref(), "discipline-120" | "discipline-910")
        || is_implementation_expert(normalized.as_ref())
        || is_review_expert(normalized.as_ref())
        || is_documentation_expert(normalized.as_ref())
}
