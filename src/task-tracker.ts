import { invoke } from "@tauri-apps/api/core";

// ========== 类型定义 ==========

export interface Deliverable {
  taskId: string;
  createdAt: string;
  summary: string;
  codeChanges: { filePath: string; changeType: string; expertId: string }[];
  reviewFindings: { severity: string; filePath: string; issue: string; suggestion: string }[];
  testSuggestions: string[];
  expertContributions: { expertId: string; tokensUsed: number; responseTimeMs: number }[];
}

export interface ExpertTask {
  id: string;
  expertId: string;
  expertName: string;
  expertTitle: string;
  status: "pending" | "running" | "done" | "error";
  input: string;
  output?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
}

// ========== 交付清单 API ==========

/** 生成并保存交付清单 */
export async function generateDeliverable(
  projectName: string,
  taskId: string,
  taskDescription: string,
  expertOutputs: ExpertTask[]
): Promise<Deliverable | null> {
  try {
    const items = expertOutputs.map((t) => ({
      expert_id: t.expertId,
      expert_name: t.expertName,
      status: t.status,
      output: t.output || t.error || "",
    }));

    const raw = await invoke<string>("generate_deliverable", {
      req: {
        project_name: projectName,
        task_id: taskId,
        task_description: taskDescription,
        expert_outputs: items,
      },
    });

    return JSON.parse(raw) as Deliverable;
  } catch (e) {
    console.error("生成交付清单失败:", e);
    return null;
  }
}

/** 加载交付清单 */
export async function loadDeliverable(
  projectName: string,
  taskId: string
): Promise<Deliverable | null> {
  try {
    const raw = await invoke<string>("load_deliverable", { projectName, taskId });
    if (raw === "null") return null;
    return JSON.parse(raw) as Deliverable;
  } catch {
    return null;
  }
}

/** 列出所有交付清单 */
export async function listDeliverables(projectName: string): Promise<Deliverable[]> {
  try {
    const raw = await invoke<string>("list_deliverables", { projectName });
    return JSON.parse(raw) as Deliverable[];
  } catch {
    return [];
  }
}

// ========== 交付清单渲染 ==========

/** 渲染交付清单为 HTML */
export function renderDeliverable(deliverable: Deliverable): string {
  const parts: string[] = [];

  // 摘要
  parts.push(`<div class="deliverable-summary">${escapeHtml(deliverable.summary).replace(/\n/g, "<br>")}</div>`);

  // 代码变更
  if (deliverable.codeChanges.length > 0) {
    const createCount = deliverable.codeChanges.filter((c) => c.changeType === "create").length;
    const modifyCount = deliverable.codeChanges.filter((c) => c.changeType === "modify").length;
    const deleteCount = deliverable.codeChanges.filter((c) => c.changeType === "delete").length;

    parts.push(`
      <div class="deliverable-section">
        <div class="deliverable-section-title">代码变更</div>
        <div class="deliverable-stats">
          <span class="stat-create">+${createCount} 创建</span>
          <span class="stat-modify">~${modifyCount} 修改</span>
          <span class="stat-delete">-${deleteCount} 删除</span>
        </div>
        <div class="deliverable-list">
          ${deliverable.codeChanges.map((c) => `
            <div class="deliverable-item ${c.changeType}">
              <span class="change-badge ${c.changeType}">${changeTypeLabel(c.changeType)}</span>
              <span class="file-path">${escapeHtml(c.filePath)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    `);
  }

  // 审查意见
  if (deliverable.reviewFindings.length > 0) {
    const critical = deliverable.reviewFindings.filter((f) => f.severity === "critical").length;
    const warning = deliverable.reviewFindings.filter((f) => f.severity === "warning").length;
    const info = deliverable.reviewFindings.filter((f) => f.severity === "info").length;

    parts.push(`
      <div class="deliverable-section">
        <div class="deliverable-section-title">审查意见</div>
        <div class="deliverable-stats">
          <span class="stat-critical">${critical} 严重</span>
          <span class="stat-warning">${warning} 警告</span>
          <span class="stat-info">${info} 建议</span>
        </div>
        <div class="deliverable-list">
          ${deliverable.reviewFindings.map((f) => `
            <div class="deliverable-item ${f.severity}">
              <span class="severity-badge ${f.severity}">${severityLabel(f.severity)}</span>
              <span class="finding-text">${escapeHtml(f.issue)}</span>
              ${f.suggestion ? `<span class="finding-suggestion">→ ${escapeHtml(f.suggestion)}</span>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    `);
  }

  // 测试建议
  if (deliverable.testSuggestions.length > 0) {
    parts.push(`
      <div class="deliverable-section">
        <div class="deliverable-section-title">测试建议</div>
        <div class="deliverable-list">
          ${deliverable.testSuggestions.map((s) => `
            <div class="deliverable-item">
              <span class="test-badge">TEST</span>
              <span>${escapeHtml(s)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    `);
  }

  return `
    <div class="deliverable-card">
      <div class="deliverable-header">
        <span class="deliverable-title">交付清单</span>
        <span class="deliverable-time">${formatTime(deliverable.createdAt)}</span>
      </div>
      ${parts.join("")}
    </div>
  `;
}

// ========== 工具函数 ==========

function changeTypeLabel(type: string): string {
  switch (type) {
    case "create": return "创建";
    case "modify": return "修改";
    case "delete": return "删除";
    case "create_folder": return "新建目录";
    default: return type;
  }
}

function severityLabel(severity: string): string {
  switch (severity) {
    case "critical": return "严重";
    case "warning": return "警告";
    case "info": return "建议";
    default: return severity;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(timestamp: string): string {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return timestamp;
  const date = new Date(ts * 1000);
  return date.toLocaleString("zh-CN");
}
