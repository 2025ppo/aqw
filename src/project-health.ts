import { invoke } from "@tauri-apps/api/core";

// ========== 类型定义 ==========

export interface HealthScore {
  overall: number;
  dimensions: HealthDimension[];
  issues: HealthIssue[];
  suggestions: string[];
  evaluated_at: string;
}

export interface HealthDimension {
  name: string;
  score: number;
  weight: number;
  description: string;
}

export interface HealthIssue {
  severity: string;
  category: string;
  message: string;
  file_path?: string;
}

export interface RetentionReport {
  project_name: string;
  generated_snippets: CodeSnippet[];
  retention_rate: number;
  avg_lifespan_days: number;
  by_expert: ExpertRetention[];
  evaluated_at: string;
}

export interface CodeSnippet {
  id: string;
  expert_id: string;
  expert_name: string;
  file_path: string;
  content_hash: string;
  generated_at: string;
  still_present: boolean;
  similarity_score: number;
}

export interface ExpertRetention {
  expert_id: string;
  expert_name: string;
  snippets_generated: number;
  snippets_retained: number;
  retention_rate: number;
}

// ========== 项目健康度 API ==========

/** 评估项目健康度 */
export async function evaluateHealth(projectPath: string): Promise<HealthScore | null> {
  try {
    const raw = await invoke<string>("evaluate_project_health", { projectPath });
    return JSON.parse(raw) as HealthScore;
  } catch (e) {
    console.error("评估项目健康度失败:", e);
    return null;
  }
}

/** 渲染健康度评分为 HTML */
export function renderHealthScore(score: HealthScore): string {
  const parts: string[] = [];

  // 总分
  const scoreClass = score.overall >= 80 ? "good" : score.overall >= 60 ? "medium" : "poor";
  parts.push(`
    <div class="health-overall ${scoreClass}">
      <div class="health-score-value">${score.overall}</div>
      <div class="health-score-label">健康度总分</div>
    </div>
  `);

  // 维度详情
  parts.push(`<div class="health-dimensions">`);
  for (const dim of score.dimensions) {
    const dimClass = dim.score >= 80 ? "good" : dim.score >= 60 ? "medium" : "poor";
    parts.push(`
      <div class="health-dimension ${dimClass}">
        <div class="dim-header">
          <span class="dim-name">${dim.name}</span>
          <span class="dim-score">${dim.score}</span>
        </div>
        <div class="dim-bar"><div class="dim-fill" style="width:${dim.score}%"></div></div>
        <div class="dim-desc">${dim.description}</div>
      </div>
    `);
  }
  parts.push(`</div>`);

  // 问题列表
  if (score.issues.length > 0) {
    parts.push(`<div class="health-issues">`);
    parts.push(`<div class="health-section-title">发现问题</div>`);
    for (const issue of score.issues) {
      parts.push(`
        <div class="health-issue ${issue.severity}">
          <span class="issue-severity">${severityLabel(issue.severity)}</span>
          <span class="issue-category">[${issue.category}]</span>
          <span class="issue-message">${escapeHtml(issue.message)}</span>
        </div>
      `);
    }
    parts.push(`</div>`);
  }

  // 建议
  if (score.suggestions.length > 0) {
    parts.push(`<div class="health-suggestions">`);
    parts.push(`<div class="health-section-title">改进建议</div>`);
    parts.push(`<ul>`);
    for (const s of score.suggestions) {
      parts.push(`<li>${escapeHtml(s)}</li>`);
    }
    parts.push(`</ul></div>`);
  }

  return parts.join("");
}

// ========== 代码保留率 API ==========

/** 评估代码保留率 */
export async function evaluateRetention(
  projectName: string,
  projectPath: string
): Promise<RetentionReport | null> {
  try {
    const raw = await invoke<string>("evaluate_code_retention", { projectName, projectPath });
    return JSON.parse(raw) as RetentionReport;
  } catch (e) {
    console.error("评估代码保留率失败:", e);
    return null;
  }
}

/** 注册生成的代码片段 */
export async function registerSnippet(
  projectName: string,
  expertId: string,
  expertName: string,
  filePath: string,
  content: string
): Promise<string | null> {
  try {
    return await invoke<string>("register_generated_snippet", {
      projectName,
      expertId,
      expertName,
      filePath,
      content,
    });
  } catch (e) {
    console.error("注册代码片段失败:", e);
    return null;
  }
}

/** 列出保留率片段 */
export async function listSnippets(projectName: string): Promise<CodeSnippet[]> {
  try {
    const raw = await invoke<string>("list_retention_snippets", { projectName });
    return JSON.parse(raw) as CodeSnippet[];
  } catch {
    return [];
  }
}

/** 渲染保留率报告为 HTML */
export function renderRetentionReport(report: RetentionReport): string {
  const parts: string[] = [];

  const ratePct = Math.round(report.retention_rate * 100);
  const rateClass = ratePct >= 70 ? "good" : ratePct >= 40 ? "medium" : "poor";

  parts.push(`
    <div class="retention-header">
      <div class="retention-rate ${rateClass}">${ratePct}%</div>
      <div class="retention-label">代码保留率</div>
      <div class="retention-detail">
        平均存活 ${report.avg_lifespan_days.toFixed(1)} 天 |
        共 ${report.generated_snippets.length} 个片段
      </div>
    </div>
  `);

  if (report.by_expert.length > 0) {
    parts.push(`<div class="retention-by-expert">`);
    parts.push(`<div class="retention-section-title">专家保留率</div>`);
    for (const er of report.by_expert) {
      const erPct = Math.round(er.retention_rate * 100);
      parts.push(`
        <div class="expert-retention">
          <span class="expert-name">${escapeHtml(er.expert_name)}</span>
          <span class="expert-bar"><span class="expert-fill" style="width:${erPct}%"></span></span>
          <span class="expert-rate">${er.snippets_retained}/${er.snippets_generated} (${erPct}%)</span>
        </div>
      `);
    }
    parts.push(`</div>`);
  }

  return parts.join("");
}

// ========== 工具函数 ==========

function severityLabel(severity: string): string {
  switch (severity) {
    case "critical": return "严重";
    case "warning": return "警告";
    case "info": return "建议";
    default: return severity;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
