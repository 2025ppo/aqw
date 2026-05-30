import { invoke } from "@tauri-apps/api/core";
import { tokenData, type TokenUsageRecord, experts, type Expert } from "./main";
import {
  buildMemoryContext,
  saveExpertMemory,
} from "./memory-store";

// ========== 用户级词元数据 ==========

import type { TokenData } from "./main";

export let userTokenData: TokenData = {
  records: [],
  allocations: [],
  lastResetDaily: new Date().toISOString().split("T")[0],
  lastResetMonthly: new Date().toISOString().slice(0, 7),
  lastResetYearly: new Date().getFullYear().toString(),
};

/** 获取当前数据源 */
function getDataSource(source: "project" | "user"): TokenData {
  return source === "user" ? userTokenData : tokenData;
}

// ========== 配额校验模块 ==========

/** 豁免配额限制的核心角色 */
const QUOTA_EXEMPT_IDS = ["jiang-xingtu", "jiang-xinghe", "jiang-qinglan"];

/** 检查专家配额是否允许继续调用 */
export function checkQuota(expertId: string): { allowed: boolean; reason?: string } {
  // 1. 豁免角色直接放行
  if (QUOTA_EXEMPT_IDS.includes(expertId)) {
    return { allowed: true };
  }

  // 2. 获取专家配额配置
  const expert = experts.find((e: Expert) => e.id === expertId);
  if (!expert || !expert.tokenAllocation) {
    return { allowed: true }; // 未配置配额 = 不限制
  }

  const allocation = expert.tokenAllocation;
  const now = new Date();

  // 3. 检查日配额
  if (allocation.dailyLimit !== null && allocation.dailyLimit !== undefined) {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayUsage = tokenData.records
      .filter((r) => r.expertId === expertId && r.timestamp >= todayStart)
      .reduce((sum, r) => sum + r.totalTokens, 0);
    if (todayUsage >= allocation.dailyLimit) {
      return {
        allowed: false,
        reason: `专家 ${expert.name} 的日词元配额已耗尽（已用 ${todayUsage.toLocaleString()} / 上限 ${allocation.dailyLimit.toLocaleString()}），请在设置中调整配额或等待明日重置`,
      };
    }
  }

  // 4. 检查月配额
  if (allocation.monthlyLimit !== null && allocation.monthlyLimit !== undefined) {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthUsage = tokenData.records
      .filter((r) => r.expertId === expertId && r.timestamp >= monthStart)
      .reduce((sum, r) => sum + r.totalTokens, 0);
    if (monthUsage >= allocation.monthlyLimit) {
      return {
        allowed: false,
        reason: `专家 ${expert.name} 的月词元配额已耗尽（已用 ${monthUsage.toLocaleString()} / 上限 ${allocation.monthlyLimit.toLocaleString()}），请在设置中调整配额或等待下月重置`,
      };
    }
  }

  // 5. 检查年配额
  if (allocation.yearlyLimit !== null && allocation.yearlyLimit !== undefined) {
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    const yearUsage = tokenData.records
      .filter((r) => r.expertId === expertId && r.timestamp >= yearStart)
      .reduce((sum, r) => sum + r.totalTokens, 0);
    if (yearUsage >= allocation.yearlyLimit) {
      return {
        allowed: false,
        reason: `专家 ${expert.name} 的年词元配额已耗尽（已用 ${yearUsage.toLocaleString()} / 上限 ${allocation.yearlyLimit.toLocaleString()}），请在设置中调整配额或等待明年重置`,
      };
    }
  }

  return { allowed: true };
}

/** 在对话区显示配额阻断系统消息 */
export function displayQuotaBlockMessage(reason: string): void {
  const messagesContainer = document.getElementById("chat-messages");
  if (!messagesContainer) return;

  const msgDiv = document.createElement("div");
  msgDiv.className = "chat-message system-message quota-blocked";
  msgDiv.innerHTML = `
    <div class="message-content" style="
      color: #ef4444;
      background: rgba(239,68,68,0.1);
      padding: 12px;
      border-radius: 8px;
      border-left: 3px solid #ef4444;
      margin: 8px 0;
      font-size: 13px;
    ">⚠️ ${reason}</div>
  `;
  messagesContainer.appendChild(msgDiv);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ========== 词元跟踪模块 ==========

/** 时间范围类型 */
export type TimeRange = "today" | "week" | "month" | "year" | "all";

/** 生成唯一ID */
function generateTokenId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 获取当前项目名（从 sidebar 全局实例获取） */
function getCurrentProjectName(): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = (window as any).sidebar;
  if (sb && typeof sb.getActiveChat === "function") {
    const chat = sb.getActiveChat();
    return chat?.name || null;
  }
  return null;
}

/** 记录词元使用 */
export async function recordTokenUsage(
  expertId: string,
  expertName: string,
  model: string,
  keyId: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Promise<void> {
  const record: TokenUsageRecord = {
    id: generateTokenId(),
    expertId,
    expertName,
    model,
    keyId,
    timestamp: Date.now(),
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
  tokenData.records.push(record);
  userTokenData.records.push({ ...record });
  // 异步持久化，不阻塞主流程
  saveTokenData().catch(console.error);
  saveUserTokenData().catch(console.error);
}

/** 获取时间范围起始时间戳 */
function getTimeRangeStart(range: TimeRange): number {
  const now = new Date();
  switch (range) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case "week": {
      const day = now.getDay() || 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
      return monday.getTime();
    }
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    case "year":
      return new Date(now.getFullYear(), 0, 1).getTime();
    case "all":
      return 0;
  }
}

/** 按专家查询词元使用 */
export function getTokenUsageByExpert(
  expertId: string,
  timeRange: TimeRange = "all",
  dataSource: "project" | "user" = "project"
): TokenUsageRecord[] {
  const start = getTimeRangeStart(timeRange);
  const data = getDataSource(dataSource);
  return data.records.filter((r) => r.expertId === expertId && r.timestamp >= start);
}

/** 获取总使用量 */
export function getTotalUsage(
  timeRange: TimeRange = "all",
  dataSource: "project" | "user" = "project"
): { prompt: number; completion: number; total: number } {
  const start = getTimeRangeStart(timeRange);
  const data = getDataSource(dataSource);
  const filtered = data.records.filter((r) => r.timestamp >= start);
  return filtered.reduce(
    (acc, r) => ({
      prompt: acc.prompt + r.promptTokens,
      completion: acc.completion + r.completionTokens,
      total: acc.total + r.totalTokens,
    }),
    { prompt: 0, completion: 0, total: 0 }
  );
}

/** 计算专家表现统计 */
export function getExpertPerformance(
  expertId?: string,
  dataSource: "project" | "user" = "project"
): ExpertPerformance[] {
  const start = getTimeRangeStart("all");
  const data = getDataSource(dataSource);
  const records = data.records.filter((r) => r.timestamp >= start);

  const grouped = new Map<string, TokenUsageRecord[]>();
  for (const r of records) {
    if (expertId && r.expertId !== expertId) continue;
    const list = grouped.get(r.expertId) || [];
    list.push(r);
    grouped.set(r.expertId, list);
  }

  const results: ExpertPerformance[] = [];
  for (const [eid, list] of grouped) {
    const totalCalls = list.length;
    const totalTokens = list.reduce((s, r) => s + r.totalTokens, 0);
    results.push({
      expertId: eid,
      expertName: list[0]?.expertName || eid,
      totalCalls,
      successCalls: totalCalls,
      errorCalls: 0,
      avgResponseTimeMs: 0,
      totalTokensUsed: totalTokens,
      avgTokensPerCall: totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0,
      successRate: 100,
    });
  }
  return results;
}

/** 持久化 token 数据（项目级） */
export async function saveTokenData(): Promise<void> {
  try {
    const projectName = getCurrentProjectName();
    if (!projectName) return;
    await invoke("save_token_data", {
      projectName,
      data: JSON.stringify(tokenData),
    });
  } catch (e) {
    console.error("Failed to save token data:", e);
  }
}

/** 加载 token 数据（项目级） */
export async function loadTokenData(): Promise<void> {
  try {
    const projectName = getCurrentProjectName();
    if (!projectName) return;
    const raw = (await invoke("load_token_data", { projectName })) as string;
    if (raw) {
      const parsed = JSON.parse(raw) as typeof tokenData;
      tokenData.records = parsed.records || [];
      tokenData.allocations = parsed.allocations || [];
      tokenData.lastResetDaily = parsed.lastResetDaily || new Date().toISOString().split("T")[0];
      tokenData.lastResetMonthly = parsed.lastResetMonthly || new Date().toISOString().slice(0, 7);
      tokenData.lastResetYearly = parsed.lastResetYearly || new Date().getFullYear().toString();
    }
  } catch (e) {
    console.error("Failed to load token data:", e);
  }
}

/** 持久化用户级词元数据 */
export async function saveUserTokenData(): Promise<void> {
  try {
    await invoke("save_user_token_data", {
      data: JSON.stringify(userTokenData),
    });
  } catch (e) {
    console.error("Failed to save user token data:", e);
  }
}

/** 加载用户级词元数据 */
export async function loadUserTokenData(): Promise<void> {
  try {
    const raw = (await invoke("load_user_token_data")) as string;
    if (raw) {
      const parsed = JSON.parse(raw) as typeof userTokenData;
      userTokenData.records = parsed.records || [];
      userTokenData.allocations = parsed.allocations || [];
      userTokenData.lastResetDaily = parsed.lastResetDaily || new Date().toISOString().split("T")[0];
      userTokenData.lastResetMonthly = parsed.lastResetMonthly || new Date().toISOString().slice(0, 7);
      userTokenData.lastResetYearly = parsed.lastResetYearly || new Date().getFullYear().toString();
    }
  } catch (e) {
    console.error("Failed to load user token data:", e);
  }
}

// ========== 类型定义 ==========

/** 场景类型 */
export type SceneType =
  | "code-development"
  | "code-review"
  | "technical-research"
  | "design"
  | "quick-answer";

/** 路由器中的专家定义（含 system prompt） */
export interface RouterExpert {
  id: string;
  name: string;
  title: string;
  description: string;
  systemPrompt: string;
}

/** 专家信息（不含 system prompt，用于 UI 展示） */
export interface ExpertInfo {
  id: string;
  name: string;
  title: string;
  description: string;
}

/** 专家任务状态 */
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
  tokensUsed?: number;
}

/** 专家表现统计 */
export interface ExpertPerformance {
  expertId: string;
  expertName: string;
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  avgResponseTimeMs: number;
  totalTokensUsed: number;
  avgTokensPerCall: number;
  successRate: number;
}

/** 主管的调度计划 */
export interface DispatchPlan {
  scene: SceneType;
  taskDescription: string;
  expertIds: string[];
  requiresDesign?: boolean;
}

/** 流水线步骤 */
interface PipelineStep {
  expertIds: string[];   // 此步涉及的专家（多个则并行）
  optional?: boolean;    // 是否可选（如设计师）
}

/** 流水线定义 */
interface Pipeline {
  scene: SceneType;
  steps: PipelineStep[];
  description: string;
}

// ========== 专家注册表（路由器内部，不含主管/助手） ==========

const ROUTER_EXPERTS: RouterExpert[] = [
  {
    id: "jiang-ruoxi",
    name: "江若溪",
    title: "调研员",
    description: "负责代码环境调研、需求分析、技术可行性评估与上下文收集",
    systemPrompt: `你是「江若溪」，专家团调研员。

你的核心职责：
1. 分析项目代码环境（技术栈、目录结构、已有功能）
2. 梳理和细化用户需求
3. 评估技术可行性，识别风险和约束
4. 收集相关上下文，为后续工程师提供充分信息

输出格式：
## 需求分析
[需求理解和细化]

## 环境调研
[技术栈、目录结构、相关代码文件]

## 可行性评估
[技术可行性、风险、建议方案]

## 上下文摘要
[后续步骤需要的关键信息]

注意：
- 你只负责调研和分析，不编写代码，不做设计
- 如需读取文件了解现状，使用 [ACTION:READ_FILE:相对路径]
- 输出结构清晰，便于后续专家快速理解`,
  },
  {
    id: "jiang-qinglan",
    name: "江青澜",
    title: "通用工程师",
    description: "负责通用技术方案、架构设计与技术实现",
    systemPrompt: `你是「江青澜」，专家团通用工程师。

你的核心职责：
1. 根据调研报告实现技术方案
2. 编写高质量、可维护的代码
3. 遵循项目现有代码风格和架构规范
4. 处理跨前后端的通用技术任务

执行规范：
- 创建文件：[ACTION:CREATE_FILE:相对路径]\n\`\`\`\n内容\n\`\`\`
- 写入文件：[ACTION:WRITE_FILE:相对路径]\n\`\`\`\n内容\n\`\`\`
- 创建目录：[ACTION:CREATE_FOLDER:相对路径]

注意：
- 严格按照调研报告的技术约束进行实现
- 代码必须有完整导入、依赖，确保可直接运行
- 不做不必要的重构，聚焦于当前任务`,
  },
  {
    id: "jiang-yumo",
    name: "江予墨",
    title: "前端工程师",
    description: "负责前端开发、界面实现与交互逻辑",
    systemPrompt: `你是「江予墨」，专家团前端工程师。

你的核心职责：
1. 实现前端界面和交互逻辑
2. 编写 HTML/CSS/TypeScript/JavaScript 代码
3. 确保响应式布局和良好用户体验
4. 遵循项目前端架构和组件规范

执行规范：
- 创建文件：[ACTION:CREATE_FILE:相对路径]\n\`\`\`\n内容\n\`\`\`
- 写入文件：[ACTION:WRITE_FILE:相对路径]\n\`\`\`\n内容\n\`\`\`

注意：
- 严格遵循项目已有的 UI 规范和样式变量
- 代码必须完整，包含所有必要的导入和类型声明
- 关注无障碍访问和性能`,
  },
  {
    id: "jiang-subai",
    name: "江素白",
    title: "后端工程师",
    description: "负责后端服务、数据库设计与 API 开发",
    systemPrompt: `你是「江素白」，专家团后端工程师。

你的核心职责：
1. 实现后端服务、API 和数据层
2. 设计数据库结构和查询
3. 处理业务逻辑和服务端渲染
4. 确保 API 安全和性能

执行规范：
- 创建文件：[ACTION:CREATE_FILE:相对路径]\n\`\`\`\n内容\n\`\`\`
- 写入文件：[ACTION:WRITE_FILE:相对路径]\n\`\`\`\n内容\n\`\`\`

注意：
- 严格遵循项目后端技术栈和架构模式
- 确保数据验证和错误处理完整
- 关注安全性和可扩展性`,
  },
  {
    id: "jiang-dingchu",
    name: "江定初",
    title: "设计师",
    description: "负责 UI/UX 设计、视觉方案与交互规范",
    systemPrompt: `你是「江定初」，专家团设计师。

你的核心职责：
1. 设计 UI/UX 方案，输出结构化的设计文档
2. 定义视觉规范（颜色、间距、字体、布局）
3. 提供交互设计说明和状态描述
4. 输出 Markdown 格式的设计方案文档

输出规范：
- 设计方案文档使用 [ACTION:CREATE_FILE:设计方案路径.md] 保存
- 包含：布局结构图、组件说明、交互状态、视觉参数
- 使用清晰的 Markdown 结构，便于工程师参照实现

注意：
- 你不直接编写代码，只输出设计方案
- 方案必须可落地，包含具体的像素值、颜色代码等
- 复杂需求分模块描述`,
  },
  {
    id: "jiang-yingqiu",
    name: "江映秋",
    title: "审查员",
    description: "负责代码质量审查、方案合规校验、风险评估与验收确认",
    systemPrompt: `你是「江映秋」，专家团审查员。

你的核心职责：
1. 审查代码质量、安全性和可维护性
2. 验证实现是否符合调研报告和设计方案
3. 识别潜在 bug、性能问题和安全风险
4. 给出明确的通过/不通过结论和修改建议

输出格式：
## 审查范围
[本次审查覆盖的文件和功能]

## 审查结论
通过 / 有条件通过 / 不通过

## 问题列表
- [严重程度] [文件:行号] 问题描述 → 修改建议

## 质量评估
- 代码规范：[评分]
- 功能完整性：[评分]
- 安全性：[评分]
- 可维护性：[评分]

注意：
- 你只负责审查，不直接修改代码
- 问题描述要具体，修改建议要可操作
- 如发现问题严重，明确标注「不通过」并说明原因`,
  },
];

// ========== Pipeline 定义 ==========

const PIPELINES: Pipeline[] = [
  {
    scene: "code-development",
    steps: [
      { expertIds: ["jiang-ruoxi"] },                                    // 调研员先行
      { expertIds: ["jiang-dingchu"], optional: true },                   // 设计师（可选）
      { expertIds: ["jiang-qinglan"] },                                   // 工程师（动态替换）
      { expertIds: ["jiang-yingqiu"] },                                   // 审查员收尾
    ],
    description: "完整开发流程：调研 → 设计（可选）→ 开发 → 审查",
  },
  {
    scene: "code-review",
    steps: [{ expertIds: ["jiang-yingqiu"] }],
    description: "代码审查：审查员独立执行",
  },
  {
    scene: "technical-research",
    steps: [{ expertIds: ["jiang-ruoxi"] }],
    description: "技术调研：调研员独立执行",
  },
  {
    scene: "design",
    steps: [
      { expertIds: ["jiang-ruoxi"] },
      { expertIds: ["jiang-dingchu"] },
    ],
    description: "设计方案：调研 → 设计",
  },
  // quick-answer 无流水线，主管直接回答
];

// ========== 活跃任务管理 ==========

let activeExpertTasks: ExpertTask[] = [];
let taskCounter = 0;
let currentPipelineId = "";

/** 任务更新回调（供 UI 监听进度） */
let taskUpdateCallback: ((tasks: ExpertTask[]) => void) | null = null;

/** 注册任务更新回调 */
export function onTaskUpdate(cb: (tasks: ExpertTask[]) => void) {
  taskUpdateCallback = cb;
}

export function notifyTaskUpdate() {
  taskUpdateCallback?.([...activeExpertTasks]);
}

export function createTask(expertId: string, input: string): ExpertTask {
  const expert = ROUTER_EXPERTS.find((e) => e.id === expertId);
  return {
    id: `task-${++taskCounter}`,
    expertId,
    expertName: expert?.name || expertId,
    expertTitle: expert?.title || "未知",
    status: "pending",
    input,
  };
}

// ========== API 密钥解析 ==========

interface ExpertLike {
  id: string;
  keyId: string | null;
}
interface KeyPoolItemLike {
  type: string;
  data: { id: string; apiKey?: string };
}

/** 根据专家 ID 解析其绑定的 API 密钥 */
export function resolveExpertApiKey(
  expertId: string,
  expertsList: ExpertLike[],
  keyPool: KeyPoolItemLike[]
): string | null {
  const expert = expertsList.find((e) => e.id === expertId);
  if (!expert?.keyId) return null;
  const item = keyPool.find((k) => k.data.id === expert.keyId);
  return item?.data?.apiKey || null;
}

// ========== 专家调用 ==========

/** 调用单个专家 */
async function callExpert(
  expertId: string,
  taskDescription: string,
  previousResults: { name: string; title: string; output: string }[],
  apiKey: string,
  keyId: string,
  onUpdate?: (task: ExpertTask) => void,
  projectName?: string,
  projectId?: number
): Promise<ExpertTask> {
  const expert = ROUTER_EXPERTS.find((e) => e.id === expertId);
  if (!expert) throw new Error(`专家 ${expertId} 未注册`);

  // === 配额前置校验 ===
  const quotaCheck = checkQuota(expertId);
  if (!quotaCheck.allowed) {
    displayQuotaBlockMessage(quotaCheck.reason!);
    const blockTask: ExpertTask = {
      id: `task-${++taskCounter}`,
      expertId,
      expertName: expert.name,
      expertTitle: expert.title,
      status: "error",
      input: taskDescription,
      error: quotaCheck.reason,
      startTime: Date.now(),
      endTime: Date.now(),
    };
    onUpdate?.(blockTask);
    return blockTask;
  }

  const task: ExpertTask = {
    id: `task-${++taskCounter}`,
    expertId,
    expertName: expert.name,
    expertTitle: expert.title,
    status: "running",
    input: taskDescription,
    startTime: Date.now(),
  };
  onUpdate?.(task);

  try {
    // ===== 上下文增强：感知索引 + 记忆系统 =====
    let perceptualContext = "";
    let memoryContext = "";

    if (projectName && projectId !== undefined) {
      // 1. 感知索引检索相关代码段
      try {
        const indexResults = await invoke<string>("perceptual_index_search", {
          projectName,
          query: taskDescription,
        });
        if (indexResults && indexResults !== "(未找到相关代码段)") {
          perceptualContext = `\n【项目代码参考】\n${indexResults}\n`;
        }
      } catch {
        // 索引未构建时静默忽略
      }

      // 2. 记忆系统检索相关历史记忆
      try {
        memoryContext = await buildMemoryContext(
          projectName,
          projectId,
          expertId,
          taskDescription
        );
      } catch {
        // 记忆检索失败时静默忽略
      }
    }

    // 构建消息：先前专家结果 + 上下文增强 + 当前任务描述
    const messages: { role: string; content: string }[] = [];

    if (previousResults.length > 0) {
      const prevContext = previousResults
        .map((r) => `=== ${r.name}（${r.title}）的输出 ===\n${r.output}\n`)
        .join("\n");
      messages.push({
        role: "user",
        content: `以下是前置专家的工作结果，请在此基础上继续你的工作：\n\n${prevContext}`,
      });
    }

    // 注入感知索引和记忆上下文
    const enhancedTask = `${taskDescription}${perceptualContext}${memoryContext}`;
    messages.push({ role: "user", content: enhancedTask });

    const rawReply = await invoke<string>("chat_with_expert", {
      messages,
      apiKey,
      systemPrompt: expert.systemPrompt,
    });

    // 解析后端返回的 JSON（包含 content 和 usage）
    let reply = rawReply;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.content === "string") {
          reply = parsed.content;
        }
        if (parsed.usage && typeof parsed.usage === "object") {
          usage = parsed.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        }
      }
    } catch {
      // 不是 JSON 则直接使用原始文本
    }

    // 记录词元使用（fire-and-forget）
    if (usage) {
      recordTokenUsage(expertId, expert.name, "deepseek-v4-flash", keyId, usage).catch(console.error);
      task.tokensUsed = usage.total_tokens;
    }

    // 保存专家输出到记忆系统
    if (projectName && projectId !== undefined && task.status !== "error") {
      saveExpertMemory(projectName, projectId, expertId, expert.name, taskDescription, reply).catch(console.error);
    }

    task.output = reply;
    task.status = "done";
    task.endTime = Date.now();
    onUpdate?.(task);
    return task;
  } catch (e) {
    task.error = String(e);
    task.status = "error";
    task.endTime = Date.now();
    onUpdate?.(task);
    return task;
  }
}

// ========== 流水线执行 ==========

/** 执行流水线（专家依次/并行执行） */
export async function executePipeline(
  plan: DispatchPlan,
  apiKeyResolver: (expertId: string) => string | null,
  onProgress: (tasks: ExpertTask[]) => void,
  projectName?: string,
  projectId?: number
): Promise<{ tasks: ExpertTask[]; pipelineId: string }> {
  const pipeline = PIPELINES.find((p) => p.scene === plan.scene);
  if (!pipeline) return { tasks: [], pipelineId: "" };

  currentPipelineId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeExpertTasks = [];
  const allResults: ExpertTask[] = [];
  const completedResults: { name: string; title: string; output: string }[] = [];

  // 构建步骤的专家列表（根据 plan.expertIds 动态替换）
  const steps: PipelineStep[] = [];
  for (const step of pipeline.steps) {
    let ids = [...step.expertIds];

    // 对于 code-development 的工程师步骤：替换为 plan 指定的实际工程师
    if (plan.scene === "code-development" && step.expertIds.includes("jiang-qinglan")) {
      const planEngineers = plan.expertIds.filter((id) =>
        ["jiang-qinglan", "jiang-yumo", "jiang-subai"].includes(id)
      );
      if (planEngineers.length > 0) ids = planEngineers;
    }

    // 跳过可选步骤（如果 plan 未要求设计）
    if (step.optional && plan.scene === "code-development" && !plan.requiresDesign) {
      continue;
    }

    steps.push({ expertIds: ids, optional: step.optional });
  }

  for (const step of steps) {
    if (step.expertIds.length === 1) {
      // 顺序执行
      const expertId = step.expertIds[0];
      const apiKey = apiKeyResolver(expertId);
      if (!apiKey) {
        const expert = ROUTER_EXPERTS.find((e) => e.id === expertId);
        const errTask: ExpertTask = {
          id: `task-${++taskCounter}`,
          expertId,
          expertName: expert?.name || expertId,
          expertTitle: expert?.title || "未知",
          status: "error",
          input: plan.taskDescription,
          error: `${expert?.name || expertId} 未配置 API 密钥，已跳过此步骤`,
          startTime: Date.now(),
          endTime: Date.now(),
        };
        allResults.push(errTask);
        activeExpertTasks.push(errTask);
        onProgress([...activeExpertTasks]);
        continue;
      }

      const task = await callExpert(expertId, plan.taskDescription, completedResults, apiKey, expertId, undefined, projectName, projectId);
      allResults.push(task);
      activeExpertTasks.push(task);
      onProgress([...activeExpertTasks]);

      if (task.output) {
        completedResults.push({
          name: task.expertName,
          title: task.expertTitle,
          output: task.output,
        });
      }
    } else {
      // 并行执行
      const parallelPromises = step.expertIds.map(async (expertId) => {
        const apiKey = apiKeyResolver(expertId);
        if (!apiKey) {
          const expert = ROUTER_EXPERTS.find((e) => e.id === expertId);
          const errTask: ExpertTask = {
            id: `task-${++taskCounter}`,
            expertId,
            expertName: expert?.name || expertId,
            expertTitle: expert?.title || "未知",
            status: "error",
            input: plan.taskDescription,
            error: `${expert?.name || expertId} 未配置 API 密钥，已跳过`,
            startTime: Date.now(),
            endTime: Date.now(),
          };
          return errTask;
        }
        return callExpert(expertId, plan.taskDescription, completedResults, apiKey, expertId, undefined, projectName, projectId);
      });

      const results = await Promise.all(parallelPromises);
      for (const task of results) {
        allResults.push(task);
        activeExpertTasks.push(task);
        if (task.output) {
          completedResults.push({
            name: task.expertName,
            title: task.expertTitle,
            output: task.output,
          });
        }
      }
      onProgress([...activeExpertTasks]);
    }
  }

  return { tasks: allResults, pipelineId: currentPipelineId };
}

// ========== 主管审核 ==========

/** 主管审核所有专家结果，综合为最终回复 */
export async function supervisorReview(
  taskDescription: string,
  expertResults: ExpertTask[],
  apiKey: string,
  keyId: string = "supervisor"
): Promise<string> {
  const reviewPrompt = `你是「江星图」，项目主管。你的专家团已完成任务，请审核结果并综合为给用户的最终回复。

审核要求：
1. 检查专家输出是否满足用户的原始需求
2. 如有审查员参与，以其结论为主要依据
3. 若发现问题，明确指出需改进之处
4. 以清晰、结构化的方式向用户呈现最终结果
5. 如有代码文件操作（CREATE_FILE/WRITE_FILE），保留这些动作标记

注意：
- 你是主管，呈现专家工作成果，不声称自己完成了具体工作
- 如专家之间有分歧，给出你的判断和建议
- 简洁明了，不堆砌冗余内容`;

  const summary = expertResults
    .map((r) => {
      const status = r.status === "done" ? "完成" : r.status === "error" ? "失败" : "未知";
      return `### ${r.expertName}（${r.expertTitle}）[${status}]\n${r.output || r.error || "无输出"}`;
    })
    .join("\n\n");

  const messages = [
    { role: "user", content: `任务描述：${taskDescription}` },
    { role: "user", content: `专家工作结果：\n\n${summary}\n\n请审核并综合为最终回复。` },
  ];

  // === 配额前置校验（主管）===
  const quotaCheck = checkQuota("supervisor");
  if (!quotaCheck.allowed) {
    displayQuotaBlockMessage(quotaCheck.reason!);
    return `专家团已执行完毕，但主管审核被配额阻断：${quotaCheck.reason}\n\n各专家结果：\n${summary}`;
  }

  try {
    const rawReply = await invoke<string>("chat_with_expert", {
      messages,
      apiKey,
      systemPrompt: reviewPrompt,
    });

    // 解析后端返回的 JSON（包含 content 和 usage）
    let reply = rawReply;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.content === "string") {
          reply = parsed.content;
        }
        if (parsed.usage && typeof parsed.usage === "object") {
          usage = parsed.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        }
      }
    } catch {
      // 不是 JSON 则直接使用原始文本
    }

    // 记录词元使用（fire-and-forget）
    if (usage) {
      recordTokenUsage("supervisor", "江星图", "deepseek-v4-flash", keyId, usage).catch(console.error);
    }

    return reply;
  } catch (e) {
    return `专家团已执行完毕，但主管审核时遇到问题：${e}\n\n各专家结果：\n${summary}`;
  }
}

// ========== 主管意图分析 ==========

/** 构建主管的 system prompt（含可用专家列表） */
function buildSupervisorPrompt(availableExperts: ExpertInfo[]): string {
  const expertList = availableExperts
    .map((e) => `- ${e.name}（${e.title}）：${e.description}`)
    .join("\n");

  return `你是「江星图」，项目主管。你的职责是分析用户需求，制定任务计划并分配专家处理。

【核心原则】
1. 你绝对不直接编写代码、审查代码、进行技术调研或设计
2. 你的工作是：理解需求 → 选择场景 → 派遣专家 → 审核结果
3. 所有实际工作必须交由专家完成

【可用专家】
${expertList}

【场景与派遣规则】

1. code-development（代码开发）
   - 流程：调研员 → [设计师（可选）] → 工程师 → 审查员
   - 工程师从 江青澜（通用）/ 江予墨（前端）/ 江素白（后端）中选择
   - 复杂度较高时设置 requiresDesign=true 引入设计师
   - expertIds 顺序：["jiang-ruoxi", 工程师ID, "jiang-yingqiu"]

2. code-review（代码审查）
   - 只需审查员：expertIds: ["jiang-yingqiu"]

3. technical-research（技术调研）
   - 只需调研员：expertIds: ["jiang-ruoxi"]

4. design（设计方案）
   - 调研员 + 设计师：expertIds: ["jiang-ruoxi", "jiang-dingchu"]

5. quick-answer（简单问题/闲聊）
   - 无需专家：expertIds: []

【输出格式】（必须是合法 JSON，不要输出其他内容）
{"scene":"场景名","taskDescription":"具体任务描述","expertIds":["专家ID1","专家ID2"],"requiresDesign":false}`;
}

/** 主管分析用户意图，输出调度计划 */
export async function supervisorAnalyze(
  userMessage: string,
  conversationHistory: { role: string; content: string }[],
  availableExperts: ExpertInfo[],
  supervisorApiKey: string,
  keyId: string = "supervisor"
): Promise<DispatchPlan> {
  const systemPrompt = buildSupervisorPrompt(availableExperts);

  const messages: { role: string; content: string }[] = [];

  // 最近 5 条对话上下文（不含当前消息）
  const recentHistory = conversationHistory.slice(-5);
  if (recentHistory.length > 0) {
    const historyText = recentHistory
      .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.substring(0, 300)}`)
      .join("\n");
    messages.push({ role: "user", content: `最近对话上下文：\n${historyText}` });
  }

  messages.push({
    role: "user",
    content: `请分析以下需求并输出调度计划（仅输出 JSON）：\n${userMessage}`,
  });

  // === 配额前置校验（主管）===
  const quotaCheck = checkQuota("supervisor");
  if (!quotaCheck.allowed) {
    displayQuotaBlockMessage(quotaCheck.reason!);
    return { scene: "quick-answer", taskDescription: userMessage, expertIds: [] };
  }

  try {
    const rawReply = await invoke<string>("chat_with_expert", {
      messages,
      apiKey: supervisorApiKey,
      systemPrompt,
    });

    // 解析后端返回的 JSON（包含 content 和 usage）
    let reply = rawReply;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.content === "string") {
          reply = parsed.content;
        }
        if (parsed.usage && typeof parsed.usage === "object") {
          usage = parsed.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        }
      }
    } catch {
      // 不是 JSON 则直接使用原始文本
    }

    // 记录词元使用（fire-and-forget）
    if (usage) {
      recordTokenUsage("supervisor", "江星图", "deepseek-v4-flash", keyId, usage).catch(console.error);
    }

    return parseDispatchPlan(reply);
  } catch {
    return { scene: "quick-answer", taskDescription: userMessage, expertIds: [] };
  }
}

// ========== 增量意图分析 ==========

/** 分析用户在专家执行期间发送的新消息 */
export async function analyzeFollowupIntent(
  followupMessage: string,
  currentPlan: DispatchPlan,
  supervisorApiKey: string,
  keyId: string = "supervisor"
): Promise<{ action: "append" | "new-plan"; plan?: DispatchPlan }> {
  const prompt = `你是项目主管。当前正在执行任务：
场景：${currentPlan.scene}
任务：${currentPlan.taskDescription}

用户发来了新消息：「${followupMessage}」

判断：
1. 如果是对当前任务的补充或修改，输出 {"action":"append","taskDescription":"补充说明"}
2. 如果是完全新的任务，输出 {"action":"new-plan","scene":"场景","taskDescription":"描述","expertIds":[]}

仅输出 JSON。`;

  // === 配额前置校验（主管）===
  const quotaCheck = checkQuota("supervisor");
  if (!quotaCheck.allowed) {
    displayQuotaBlockMessage(quotaCheck.reason!);
    return { action: "append" };
  }

  try {
    const rawReply = await invoke<string>("chat_with_expert", {
      messages: [{ role: "user", content: followupMessage }],
      apiKey: supervisorApiKey,
      systemPrompt: prompt,
    });

    // 解析后端返回的 JSON（包含 content 和 usage）
    let reply = rawReply;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.content === "string") {
          reply = parsed.content;
        }
        if (parsed.usage && typeof parsed.usage === "object") {
          usage = parsed.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        }
      }
    } catch {
      // 不是 JSON 则直接使用原始文本
    }

    // 记录词元使用（fire-and-forget）
    if (usage) {
      recordTokenUsage("supervisor", "江星图", "deepseek-v4-flash", keyId, usage).catch(console.error);
    }

    const parsed = extractJson(reply);
    if (parsed.action === "new-plan") {
      return { action: "new-plan", plan: parseDispatchPlan(reply) };
    }
    return { action: "append" };
  } catch {
    return { action: "append" };
  }
}

// ========== 进度查询 ==========

/** 获取当前活跃任务列表 */
export function getActiveTasks(): ExpertTask[] {
  return [...activeExpertTasks];
}

/** 获取当前活跃任务数量 */
export function getActiveTaskCount(): number {
  return activeExpertTasks.filter((t) => t.status === "running").length;
}

/** 构建进度汇报文本 */
export function buildProgressReport(): string {
  if (activeExpertTasks.length === 0) return "当前没有正在执行的任务。";

  const lines = activeExpertTasks.map((t) => {
    const icon = t.status === "done" ? "✓" : t.status === "running" ? "⟳" : t.status === "error" ? "✗" : "○";
    return `${icon} ${t.expertName}（${t.expertTitle}）：${
      t.status === "done" ? "已完成" : t.status === "running" ? "执行中" : t.status === "error" ? "失败" : "等待中"
    }`;
  });

  return `当前任务进度：\n${lines.join("\n")}`;
}

/** 清除活跃任务列表（流水线结束后调用） */
export function clearActiveTasks() {
  activeExpertTasks = [];
}

// ========== 工具函数 ==========

/** 获取路由器中注册的专家列表（用于 UI 和主管 prompt） */
export function getRouterExperts(): RouterExpert[] {
  return [...ROUTER_EXPERTS];
}

/** 获取可用专家信息（不含 system prompt） */
export function getAvailableExpertInfos(): ExpertInfo[] {
  return ROUTER_EXPERTS.map((e) => ({
    id: e.id,
    name: e.name,
    title: e.title,
    description: e.description,
  }));
}

/** 获取指定专家信息 */
export function getRouterExpert(id: string): RouterExpert | undefined {
  return ROUTER_EXPERTS.find((e) => e.id === id);
}

/** 解析 AI 返回中的 dispatch plan JSON */
function parseDispatchPlan(raw: string): DispatchPlan {
  const parsed = extractJson(raw);
  const scene = (parsed.scene as SceneType) || "quick-answer";
  const validScenes: SceneType[] = [
    "code-development", "code-review", "technical-research", "design", "quick-answer",
  ];
  return {
    scene: validScenes.includes(scene) ? scene : "quick-answer",
    taskDescription: typeof parsed.taskDescription === "string" ? parsed.taskDescription : "",
    expertIds: Array.isArray(parsed.expertIds)
      ? (parsed.expertIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    requiresDesign: parsed.requiresDesign === true,
  };
}

/** 从 AI 返回文本中提取 JSON 对象 */
function extractJson(text: string): Record<string, unknown> {
  try {
    // 尝试 ```json ... ``` 代码块
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) return JSON.parse(codeBlockMatch[1].trim());

    // 尝试直接解析
    return JSON.parse(text.trim());
  } catch {
    // 尝试提取第一个 {...}
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {
        /* 忽略 */
      }
    }
    return {};
  }
}
