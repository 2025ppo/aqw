import { invoke } from "@tauri-apps/api/core";
import { tokenData, type TokenUsageRecord, type Expert } from "./main";

// 使用 getter 获取 experts，避免模块导入时绑定空数组引用
let _expertsRef: Expert[] = [];
export function setExpertsRef(ref: Expert[]) { _expertsRef = ref; }
function getExperts(): Expert[] { return _expertsRef; }
import {
  buildMemoryContext,
  buildGeneralMemoryContext,
  saveExpertMemory,
} from "./memory-store";
import {
  appendPromptModuleTrace,
  loadPromptModuleHistoryHints,
} from "./prompt-module-history";
import {
  assemblePromptFromModules,
  buildExpertPromptPlan,
  detectToolIntentWithoutAction,
  normalizePromptModuleHintMap,
  type PromptModuleId,
  type PromptModuleHintMap,
} from "./prompt-modules";

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
  const expert = getExperts().find((e: Expert) => e.id === expertId);
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
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  expertTitle?: string
): Promise<void> {
  const record: TokenUsageRecord = {
    id: generateTokenId(),
    expertId,
    expertName,
    expertTitle,
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
  | "quick-answer"
  | "translation"
  | "writing"
  | "office"
  | "data-analysis"
  | "document-processing"
  | "media-creation"
  | "video-production"
  | "research-with-search";

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
  phase?: string;
  phaseDetail?: string;
  dispatchWave?: number;
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
  promptModuleHints?: PromptModuleHintMap;
}

export interface PipelineFollowup {
  id: string;
  message: string;
  targetExpertIds: string[];
  deliveryMode: "current-step" | "next-relevant" | "all-remaining";
  consumedBy: string[];
  createdAt: number;
}

export interface DispatchWave {
  wave: number;
  expertIds: string[];
}

export interface EvidenceItem {
  id: string;
  source: string;
  summary: string;
  createdAt: number;
}

export interface RequiredFileSet {
  files: string[];
  unresolved: string[];
  exclusions: string[];
}

export interface PatchProposal {
  id: string;
  files: string[];
  risk: "low" | "medium" | "high";
  status: "draft" | "proposed" | "blocked" | "applied";
}

export interface ValidationRun {
  command: string;
  passed: boolean;
  summary: string;
}

export interface ReviewDecision {
  reviewer: string;
  decision: "pass" | "revise" | "block";
  reason: string;
}

export interface BlackboardTask {
  id: string;
  goal: string;
  requiredFiles: RequiredFileSet;
  evidence: EvidenceItem[];
  assumptions: string[];
  openQuestions: string[];
  patchProposals: PatchProposal[];
  validationRuns: ValidationRun[];
  reviewDecisions: ReviewDecision[];
  blockers: string[];
  roundsWithoutProgress: number;
}

export interface ExpertCommandAuthorizationRequest {
  expertId: string;
  expertName: string;
  expertTitle: string;
  reason: string;
  command: string;
  workingDir: string;
  authMode: "auto" | "restricted" | "admin";
  safetyReason: string;
}

interface ExpertWebSearchToolEvent {
  kind: "web-search";
  expertId: string;
  expertName: string;
  expertTitle: string;
  reason: string;
  query: string;
  status: "success" | "error";
  results?: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
}

interface ExpertCommandToolEvent {
  kind: "command";
  expertId: string;
  expertName: string;
  expertTitle: string;
  reason: string;
  command: string;
  workingDir: string;
  authMode: "auto" | "restricted" | "admin";
  status: "success" | "denied" | "error";
  safetyReason?: string;
  output?: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  error?: string;
}

export type ExpertToolEvent = ExpertWebSearchToolEvent | ExpertCommandToolEvent;

interface ExpertWebSearchRequest {
  kind: "web-search";
  query: string;
  reason: string;
}

interface ExpertCommandRequest {
  kind: "command";
  command: string;
  reason: string;
  workingDir: string;
}

type ExpertToolRequest = ExpertWebSearchRequest | ExpertCommandRequest;

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

function buildPipelineSteps(plan: DispatchPlan, pipeline: Pipeline): PipelineStep[] {
  const steps: PipelineStep[] = [];
  for (const step of pipeline.steps) {
    let ids = [...step.expertIds];
    if (plan.scene === "code-development" && step.expertIds.includes("jiang-qinglan")) {
      const planEngineers = plan.expertIds.filter((id) =>
        ["jiang-qinglan", "jiang-yumo", "jiang-subai"].includes(id)
      );
      if (planEngineers.length > 0) ids = planEngineers;
    }
    if (step.optional && plan.scene === "code-development" && !plan.requiresDesign) {
      continue;
    }
    steps.push({ expertIds: ids, optional: step.optional });
  }
  return steps;
}

export function buildDispatchWaves(plan: DispatchPlan): DispatchWave[] {
  const pipeline = PIPELINES.find((p) => p.scene === plan.scene);
  if (!pipeline) return [];
  const steps = buildPipelineSteps(plan, pipeline);
  return steps.map((step, idx) => ({ wave: idx + 1, expertIds: [...step.expertIds] }));
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
- 输出结构清晰，便于后续专家快速理解
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
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

变更输出规范：
- 直接输出可执行文件动作，系统会按动作直接落盘，不走补丁提案合并。
- 修改已有文件优先使用 [ACTION:EDIT_FILE ...]，并提供 search/replace 两段代码块。
- 新增文件使用 [ACTION:CREATE_FILE ...]，全量改写使用 [ACTION:WRITE_FILE ...]，新目录使用 [ACTION:CREATE_FOLDER ...]，删除使用 [ACTION:DELETE ...]。
- 可选输出结构化 JSON changes 作为补充，但要保证 path/searchText/replaceText 精确可执行。

注意：
- 严格按照调研报告的技术约束进行实现
- 代码必须有完整导入、依赖，确保可直接运行
- 不做不必要的重构，聚焦于当前任务
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
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

变更输出规范：
- 直接输出可执行文件动作，系统会按动作直接落盘，不走补丁提案合并。
- 修改已有文件优先使用 [ACTION:EDIT_FILE ...]，并提供 search/replace 两段代码块。
- 新增文件使用 [ACTION:CREATE_FILE ...]，全量改写使用 [ACTION:WRITE_FILE ...]，新目录使用 [ACTION:CREATE_FOLDER ...]，删除使用 [ACTION:DELETE ...]。
- 可选输出结构化 JSON changes 作为补充，但要保证 path/searchText/replaceText 精确可执行。

注意：
- 严格遵循项目已有的 UI 规范和样式变量
- 代码必须完整，包含所有必要的导入和类型声明
- 关注无障碍访问和性能
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
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

变更输出规范：
- 直接输出可执行文件动作，系统会按动作直接落盘，不走补丁提案合并。
- 修改已有文件优先使用 [ACTION:EDIT_FILE ...]，并提供 search/replace 两段代码块。
- 新增文件使用 [ACTION:CREATE_FILE ...]，全量改写使用 [ACTION:WRITE_FILE ...]，新目录使用 [ACTION:CREATE_FOLDER ...]，删除使用 [ACTION:DELETE ...]。
- 可选输出结构化 JSON changes 作为补充，但要保证 path/searchText/replaceText 精确可执行。

注意：
- 严格遵循项目后端技术栈和架构模式
- 确保数据验证和错误处理完整
- 关注安全性和可扩展性
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
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
- 如发现问题严重，明确标注「不通过」并说明原因
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
  },
  {
    id: "jiang-lingyu",
    name: "江灵语",
    title: "翻译官",
    description: "多语言互译专家，精通中英日韩法德等主流语言，保持原文语境与风格",
    systemPrompt: `你是江灵语，星图专家团的翻译官。你的职责是：
1. 精确翻译用户指定的内容，保持原文的语境、风格和语气
2. 支持中英日韩法德西俄等主流语言互译
3. 对于专业术语，提供翻译+原文标注
4. 对于文学性内容，注重信达雅
5. 若原文有歧义，提供多种翻译版本并说明差异

输出格式：直接输出翻译结果，必要时附注说明。`,
  },
  {
    id: "jiang-moxian",
    name: "江墨弦",
    title: "写作家",
    description: "创意写作与文案策划专家，擅长各类文体的撰写与润色",
    systemPrompt: `你是江墨弦，星图专家团的写作家。你的职责是：
1. 根据用户需求进行创意写作（小说、诗歌、散文、剧本等）
2. 撰写商业文案（广告语、品牌故事、营销文案）
3. 撰写正式报告（工作报告、调研报告、分析报告）
4. 润色和改写已有文本，提升表达质量
5. 根据目标受众调整文风和语调

输出格式：直接输出写作成果。对于长文，先给出大纲再展开。`,
  },
  {
    id: "jiang-wenshu",
    name: "江文舒",
    title: "办公秘书",
    description: "日常办公事务处理专家，擅长邮件撰写、日程管理、会议纪要等",
    systemPrompt: `你是江文舒，星图专家团的办公秘书。你的职责是：
1. 撰写各类商务邮件（感谢信、邀请函、通知、回复等）
2. 整理和生成会议纪要、工作总结
3. 制定日程安排和待办事项清单
4. 起草通知、公告、备忘录等办公文档
5. 协助整理信息、归纳要点

输出格式：使用规范的商务格式，层次清晰，要点突出。`,
  },
  {
    id: "jiang-shuyan",
    name: "江数衍",
    title: "数据分析师",
    description: "数据分析与可视化专家，擅长数据解读、统计分析和图表生成",
    systemPrompt: `你是江数衍，星图专家团的数据分析师。你的职责是：
1. 分析用户提供的数据（CSV、Excel等），发现趋势和规律
2. 进行统计分析（均值、方差、相关性、回归等）
3. 生成数据可视化图表（使用 ECharts，输出为 HTML）
4. 撰写数据分析报告（Markdown格式）
5. 提供数据驱动的决策建议

当需要生成图表时，使用 [ACTION:CREATE_FILE] 创建包含 ECharts 的 HTML 文件。
报告默认使用 Markdown 格式输出。
分析结果保存到项目根目录的 /analysis/ 文件夹。`,
  },
  {
    id: "jiang-zhilan",
    name: "江纸澜",
    title: "文档专员",
    description: "文档处理专家，擅长各种格式文档的读取、转换、整理和生成",
    systemPrompt: `你是江纸澜，星图专家团的文档专员。你的职责是：
1. 读取和解析各种格式的文档（PDF、DOCX、XLSX、CSV、TXT、MD）
2. 文档格式转换（如 DOCX→MD、CSV→表格等）
3. 文档内容提取和摘要
4. 根据需求生成新文档
5. 文档排版整理和格式优化

保持文档的结构完整性和格式规范性。
工具能力会按当前任务按需加载；未加载的能力不要臆造格式。`,
  },
  {
    id: "jiang-huaying",
    name: "江画影",
    title: "媒体专家",
    description: "多媒体处理专家，擅长图像生成/编辑、视频制作、音频处理",
    systemPrompt: `你是江画影，星图专家团的媒体专家。你的职责是：
1. 根据描述生成图像（使用 [ACTION:GENERATE_IMAGE]）
2. 对已有图像进行编辑和修改（局部重绘、风格转换等）
3. 视频创作：镜头分段规划、逐段生成、最终拼接
4. 音频处理（语音合成、音频转写）
5. 多媒体素材的管理和组合

所有媒体文件默认导出到项目根目录。
工具能力会按当前任务按需加载；未加载的能力不要臆造格式。`,
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
  {
    scene: "translation",
    steps: [{ expertIds: ["jiang-lingyu"] }],
    description: "多语言翻译任务",
  },
  {
    scene: "writing",
    steps: [
      { expertIds: ["jiang-ruoxi"] },
      { expertIds: ["jiang-moxian"] },
    ],
    description: "创意写作、文案策划、报告撰写",
  },
  {
    scene: "office",
    steps: [{ expertIds: ["jiang-wenshu"] }],
    description: "邮件、会议纪要、日程等办公事务",
  },
  {
    scene: "data-analysis",
    steps: [
      { expertIds: ["jiang-ruoxi"] },
      { expertIds: ["jiang-shuyan"] },
    ],
    description: "数据分析、可视化和报告生成",
  },
  {
    scene: "document-processing",
    steps: [{ expertIds: ["jiang-zhilan"] }],
    description: "文档读取、转换和生成",
  },
  {
    scene: "media-creation",
    steps: [{ expertIds: ["jiang-huaying"] }],
    description: "图像生成/编辑、视频处理、音频处理",
  },
  {
    scene: "video-production",
    steps: [
      { expertIds: ["jiang-ruoxi"] },
      { expertIds: ["jiang-huaying"] },
    ],
    description: "视频创作：调研 → 镜头分段 → 生成 → 拼接",
  },
  {
    scene: "research-with-search",
    steps: [{ expertIds: ["jiang-ruoxi"] }],
    description: "需要网络搜索的深度调研",
  },
];

// ========== 活跃任务管理 ==========

let activeExpertTasks: ExpertTask[] = [];
let taskCounter = 0;
let currentPipelineId = "";
let activeStepExpertIds: string[] = [];

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

function getExpertNameLabel(expertId: string): string {
  const expert = ROUTER_EXPERTS.find((item) => item.id === expertId);
  return expert ? `${expert.name}（${expert.title}）` : expertId;
}

function getRelevantFollowupsForExpert(
  expertId: string,
  currentStepExpertIds: string[],
  followups?: PipelineFollowup[],
  currentStepOnly = false
): PipelineFollowup[] {
  if (!followups || followups.length === 0) return [];

  return followups.filter((followup) => {
    if (followup.consumedBy.includes(expertId)) return false;
    if (followup.targetExpertIds.length > 0 && !followup.targetExpertIds.includes(expertId)) {
      return false;
    }
    if (currentStepOnly && followup.deliveryMode === "next-relevant") return false;
    if (followup.deliveryMode === "current-step") {
      return currentStepExpertIds.includes(expertId);
    }
    return true;
  });
}

function markFollowupsConsumed(
  followups: PipelineFollowup[] | undefined,
  followupIds: string[],
  expertId: string
): void {
  if (!followups || followupIds.length === 0) return;
  const seen = new Set(followupIds);
  for (const followup of followups) {
    if (!seen.has(followup.id)) continue;
    if (!followup.consumedBy.includes(expertId)) {
      followup.consumedBy.push(expertId);
    }
  }
}

function buildTaskDescriptionForExpert(
  scene: SceneType,
  baseTaskDescription: string,
  blackboard: BlackboardTask,
  expertId: string,
  currentStepExpertIds: string[],
  pendingFollowups?: PipelineFollowup[],
  currentStepOnly = false
): { text: string; followupIds: string[] } {
  const relevantFollowups = getRelevantFollowupsForExpert(
    expertId,
    currentStepExpertIds,
    pendingFollowups,
    currentStepOnly
  );

  const followupContext = relevantFollowups.length > 0
    ? `\n\n【主管刚收到用户的中途修正，请你直接处理】\n${relevantFollowups
      .map((item, idx) => `${idx + 1}. ${item.message}`)
      .join("\n")}\n`
    : "";

  const withFollowups = `${baseTaskDescription}${followupContext}`;
  const finalText = scene === "code-development"
    ? `${withFollowups}${renderBlackboardContext(blackboard)}`
    : withFollowups;

  return {
    text: finalText,
    followupIds: relevantFollowups.map((item) => item.id),
  };
}

function upsertCompletedResult(
  completedResults: Array<{ expertId: string; name: string; title: string; output: string }>,
  task: ExpertTask
): void {
  if (!task.output) return;
  const next = {
    expertId: task.expertId,
    name: task.expertName,
    title: task.expertTitle,
    output: task.output,
  };
  const existingIdx = completedResults.findIndex((item) => item.expertId === task.expertId);
  if (existingIdx >= 0) {
    completedResults[existingIdx] = next;
  } else {
    completedResults.push(next);
  }
}

async function runCurrentStepFollowupRound(
  scene: SceneType,
  baseTaskDescription: string,
  blackboard: BlackboardTask,
  currentStepExpertIds: string[],
  completedResults: Array<{ expertId: string; name: string; title: string; output: string }>,
  allResults: ExpertTask[],
  pendingFollowups: PipelineFollowup[] | undefined,
  apiKeyResolver: (expertId: string) => string | null,
  modelResolver: (expertId: string) => string,
  projectName: string | undefined,
  projectId: number | undefined,
  promptModuleHints: PromptModuleHintMap | undefined,
  projectWorkspacePath: string | undefined,
  onProgress: (tasks: ExpertTask[]) => void,
  onExpertProgress?: (progress: { expertId: string; phase: string; detail: string }) => void,
  onToolEvent?: (event: ExpertToolEvent) => void,
  onCommandAuthorization?: (request: ExpertCommandAuthorizationRequest) => Promise<boolean>
): Promise<void> {
  if (!pendingFollowups || pendingFollowups.length === 0) return;

  for (const expertId of currentStepExpertIds) {
    const followups = getRelevantFollowupsForExpert(expertId, currentStepExpertIds, pendingFollowups, true);
    if (followups.length === 0) continue;

    const apiKey = apiKeyResolver(expertId);
    if (!apiKey) continue;

    const expertTask = buildTaskDescriptionForExpert(
      scene,
      `${baseTaskDescription}\n\n【说明】你刚才已开始处理该任务。现在主管基于用户插话，要求你在现有基础上直接修正/补充。`,
      blackboard,
      expertId,
      currentStepExpertIds,
      pendingFollowups,
      true
    );

    const task = await callExpert(
      expertId,
      scene,
      expertTask.text,
      completedResults,
      apiKey,
      modelResolver(expertId),
      expertId,
      undefined,
      projectName,
      projectId,
      promptModuleHints?.[expertId],
      projectWorkspacePath,
      onExpertProgress,
      onToolEvent,
      onCommandAuthorization
    );
    for (let idx = activeExpertTasks.length - 1; idx >= 0; idx--) {
      if (activeExpertTasks[idx].expertId === expertId) {
        task.dispatchWave = activeExpertTasks[idx].dispatchWave;
        break;
      }
    }
    allResults.push(task);
    activeExpertTasks.push(task);
    updateBlackboardFromTask(blackboard, task);
    onProgress([...activeExpertTasks]);
    if (task.output) {
      upsertCompletedResult(completedResults, task);
      markFollowupsConsumed(pendingFollowups, expertTask.followupIds, expertId);
    }
  }
}

function createBlackboardTask(plan: DispatchPlan): BlackboardTask {
  return {
    id: `blackboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    goal: plan.taskDescription,
    requiredFiles: { files: [], unresolved: [], exclusions: [] },
    evidence: [],
    assumptions: [],
    openQuestions: [],
    patchProposals: [],
    validationRuns: [],
    reviewDecisions: [],
    blockers: [],
    roundsWithoutProgress: 0,
  };
}

function extractFileMentions(text: string): string[] {
  const files = new Set<string>();
  const regex = /(?:^|[\s`"'(])([A-Za-z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|rs|py|go|java|kt|swift|c|cpp|h|hpp|css|html|json|md|toml|yaml|yml|sql))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    files.add(match[1].replace(/\\/g, "/"));
  }
  return [...files].slice(0, 80);
}

function extractChangeFiles(text: string): string[] {
  const files = new Set<string>();
  const actionRegex = /\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|DELETE):([^\]]+)\]/g;
  const paramActionRegex = /\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|DELETE)\s+[^\]]*?path="([^"]+)"/g;
  let match;
  while ((match = actionRegex.exec(text)) !== null) files.add(match[1].trim());
  while ((match = paramActionRegex.exec(text)) !== null) files.add(match[1].trim());
  const jsonPathRegex = /"path"\s*:\s*"([^"]+)"/g;
  while ((match = jsonPathRegex.exec(text)) !== null) files.add(match[1].trim());
  return [...files].map((p) => p.replace(/\\/g, "/")).slice(0, 80);
}

function updateBlackboardFromTask(blackboard: BlackboardTask, task: ExpertTask): void {
  const output = task.output || task.error || "";
  if (!output) return;

  const fileMentions = extractFileMentions(output);
  for (const file of fileMentions) {
    if (!blackboard.requiredFiles.files.includes(file)) {
      blackboard.requiredFiles.files.push(file);
      blackboard.requiredFiles.unresolved.push(file);
    }
  }

  const changedFiles = extractChangeFiles(output);
  if (changedFiles.length > 0) {
    blackboard.patchProposals.push({
      id: `${task.id}-patch-${blackboard.patchProposals.length + 1}`,
      files: changedFiles,
      risk: output.includes("allowOverwrite") || output.includes("WRITE_FILE") ? "high" : "medium",
      status: "draft",
    });
    blackboard.requiredFiles.unresolved = blackboard.requiredFiles.unresolved.filter((f) => !changedFiles.includes(f));
  }

  if (task.expertTitle.includes("调研") || task.expertTitle.includes("设计")) {
    blackboard.evidence.push({
      id: `${task.id}-evidence-${blackboard.evidence.length + 1}`,
      source: `${task.expertName}（${task.expertTitle}）`,
      summary: output.replace(/<think>[\s\S]*?<\/think>/g, "").slice(0, 360),
      createdAt: Date.now(),
    });
  }

  if (task.expertTitle.includes("审查")) {
    const decision: ReviewDecision["decision"] = /不通过|阻断|block/i.test(output)
      ? "block"
      : /修改|返工|revise/i.test(output)
        ? "revise"
        : "pass";
    blackboard.reviewDecisions.push({
      reviewer: task.expertName,
      decision,
      reason: output.replace(/<think>[\s\S]*?<\/think>/g, "").slice(0, 240),
    });
    if (decision !== "pass") {
      const lastDecision = blackboard.reviewDecisions[blackboard.reviewDecisions.length - 1];
      blackboard.blockers.push(`${task.expertName}: ${lastDecision?.reason || "审查未通过"}`);
    }
  }
}

function renderBlackboardContext(blackboard: BlackboardTask): string {
  const required = blackboard.requiredFiles.files.length
    ? blackboard.requiredFiles.files.slice(0, 40).map((f) => `- ${f}`).join("\n")
    : "- 尚未锁定，当前专家必须先根据证据提出候选文件或说明无法锁定";
  const evidence = blackboard.evidence.length
    ? blackboard.evidence.slice(-6).map((e) => `- ${e.source}: ${e.summary}`).join("\n")
    : "- 暂无，当前专家需要补充可验证证据";
  const patches = blackboard.patchProposals.length
    ? blackboard.patchProposals.slice(-6).map((p) => `- ${p.id}: ${p.files.join(", ")} (${p.risk})`).join("\n")
    : "- 暂无文件变更动作";
  const blockers = blackboard.blockers.length
    ? blackboard.blockers.slice(-5).map((b) => `- ${b}`).join("\n")
    : "- 暂无";

  return `\n\n【共享黑板 · 所有专家必须围绕它协作】\n任务目标：${blackboard.goal}\n\n必检/候选文件：\n${required}\n\n证据：\n${evidence}\n\n文件变更动作：\n${patches}\n\n阻塞项：\n${blockers}\n\n协作规则：\n- 不要假装看过未列入证据的文件；需要文件时先把它加入必检/候选文件。\n- 工程实现必须输出可执行文件动作（ACTION 或结构化 changes），系统会直接执行。\n- 审查必须审查文件动作覆盖范围、局部编辑可定位性、是否存在漏改文件。\n`;
}

function parseActionParams(paramsStr: string): Record<string, string> {
  const params: Record<string, string> = {};
  const paramRegex = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = paramRegex.exec(paramsStr)) !== null) {
    params[match[1]] = match[2];
  }
  return params;
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function resolveToolWorkingDir(rawDir: string | undefined, projectWorkspacePath?: string): string {
  const trimmed = rawDir?.trim();
  const baseDir = projectWorkspacePath?.trim() || ".";
  if (!trimmed || trimmed === ".") return baseDir;
  if (!projectWorkspacePath || isAbsolutePath(trimmed)) return trimmed;

  const separator = projectWorkspacePath.includes("\\") ? "\\" : "/";
  const relative = trimmed
    .replace(/^[.][\\/]/, "")
    .replace(/^[\\/]+/, "");
  return `${projectWorkspacePath.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

function resolveToolCommandAuthMode(
  requiresAuth: boolean,
  authReason: string
): "auto" | "restricted" | "admin" {
  if (!requiresAuth) return "auto";
  return /管理员权限/.test(authReason) ? "admin" : "restricted";
}

function extractExpertToolRequests(text: string, projectWorkspacePath?: string): ExpertToolRequest[] {
  const requests: ExpertToolRequest[] = [];
  const actionRegex = /\[ACTION:(WEB_SEARCH|EXECUTE_CMD)((?:\s+\w+="[^"]*")*)\]/g;
  let match;
  while ((match = actionRegex.exec(text)) !== null) {
    const actionType = match[1];
    const params = parseActionParams(match[2] || "");
    if (actionType === "WEB_SEARCH") {
      const query = params.query?.trim();
      if (!query) continue;
      requests.push({
        kind: "web-search",
        query,
        reason: params.reason?.trim() || "需要外部资料或最新信息支撑当前结论",
      });
      continue;
    }

    const command = params.command?.trim();
    if (!command) continue;
    requests.push({
      kind: "command",
      command,
      reason: params.reason?.trim() || "需要通过本地命令核实环境或验证当前结论",
      workingDir: resolveToolWorkingDir(params.dir, projectWorkspacePath),
    });
  }
  return requests;
}

function stripInlineToolActions(text: string): string {
  return text
    .replace(/\[ACTION:(?:WEB_SEARCH|EXECUTE_CMD)(?:\s+\w+="[^"]*")*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  scene: SceneType,
  taskDescription: string,
  previousResults: { name: string; title: string; output: string }[],
  apiKey: string,
  model: string,
  keyId: string,
  onUpdate?: (task: ExpertTask) => void,
  projectName?: string,
  projectId?: number,
  hintModuleIds?: PromptModuleId[],
  projectWorkspacePath?: string,
  onProgress?: (progress: { expertId: string; phase: string; detail: string }) => void,
  onToolEvent?: (event: ExpertToolEvent) => void,
  onCommandAuthorization?: (request: ExpertCommandAuthorizationRequest) => Promise<boolean>
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
    let historyHintModuleIds: PromptModuleId[] = [];
    if (projectName) {
      try {
        historyHintModuleIds = await loadPromptModuleHistoryHints(
          projectName,
          expert.id,
          scene,
          taskDescription
        );
      } catch {
        historyHintModuleIds = [];
      }
    }

    const promptAssembly = buildExpertPromptPlan(
      expert.id,
      expert.systemPrompt,
      scene,
      taskDescription,
      [...(hintModuleIds || []), ...historyHintModuleIds]
    );
    const activeModuleIds = new Set<PromptModuleId>(promptAssembly.moduleIds);
    let activeSystemPrompt = promptAssembly.prompt;
    const learnedModuleIds = new Set<PromptModuleId>();
    const triggerSources = new Set<string>();
    console.debug(
      `[PromptModules] ${expertId} scene=${scene} modules=${promptAssembly.moduleIds.join(",") || "none"} historyHints=${historyHintModuleIds.join(",") || "none"} promptChars=${promptAssembly.prompt.length}`
    );

    // === 三重分级检索 ===
    let retrievalContext = "";
    const negativeIndex: string[] = []; // 负向索引：记录盲区

    // --- 一级索引：仓库知识卡片（搜索限定） ---
    if (projectName) {
      if (onProgress) onProgress({ expertId, phase: 'searching-repo', detail: '仓库检索中...' });
      try {
        const cards = await invoke<string>("repo_read_cards", { projectName });
        if (cards && cards !== "[]") {
          retrievalContext += `\n【一级索引 · 仓库知识概览】\n${cards}\n`;
        } else {
          negativeIndex.push("仓库知识卡片为空，项目结构认知不完整");
        }
      } catch {
        negativeIndex.push("仓库知识检索失败，无法获取项目全局视图");
      }
    }

    // --- 二级索引：向量检索（精确定位） ---
    if (projectName && projectId !== undefined) {
      if (onProgress) onProgress({ expertId, phase: 'searching-vector', detail: '向量检索中...' });
      try {
        const searchResult = await invoke<string>("perceptual_index_search", {
          projectName,
          query: taskDescription,
        });
        if (searchResult && searchResult !== "(未找到相关代码段)") {
          retrievalContext += `\n【二级索引 · 代码定位】\n${searchResult}\n`;
        } else {
          negativeIndex.push("向量检索未命中相关代码段，可能存在索引覆盖盲区");
        }
      } catch {
        negativeIndex.push("向量检索执行失败");
      }
    }

    // --- 三级：记忆检索（历史经验） ---
    if (projectName && projectId !== undefined) {
      if (onProgress) onProgress({ expertId, phase: 'searching-memory', detail: '记忆检索中...' });
      try {
        const memContext = await buildMemoryContext(
          projectName,
          projectId,
          expertId,
          taskDescription
        );
        if (memContext) {
          retrievalContext += `\n${memContext}\n`;
        } else {
          negativeIndex.push("无相关历史记忆，当前任务缺乏历史经验参照");
        }

        const sharedMemoryContext = await buildGeneralMemoryContext(
          projectName,
          projectId,
          taskDescription
        );
        if (sharedMemoryContext && sharedMemoryContext !== memContext) {
          retrievalContext += `\n【共享项目记忆】\n${sharedMemoryContext.trim()}\n`;
        }
      } catch {
        negativeIndex.push("记忆检索失败");
      }
    }

    // --- 负向索引注入（让专家知道系统的认知盲区） ---
    if (negativeIndex.length > 0) {
      retrievalContext += `\n【系统认知盲区（负向索引）】\n${negativeIndex.map(n => `- ${n}`).join('\n')}\n注意：以上标注为系统检索的已知局限，相关信息可能不完整或过时，请在执行时自行验证。\n`;
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

    // 组装最终任务描述（含三级检索上下文）
    const enhancedTask = `${taskDescription}${retrievalContext}`;
    messages.push({ role: "user", content: enhancedTask });

    // AI 调用开始
    if (onProgress) onProgress({ expertId, phase: 'analyzing', detail: '分析中...' });

    const rawReply = await invoke<string>("chat_with_expert", {
      messages,
      apiKey,
      systemPrompt: activeSystemPrompt,
      model,
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

    const mergeUsage = (nextUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null) => {
      if (!nextUsage) return;
      if (usage) {
        usage.prompt_tokens += nextUsage.prompt_tokens;
        usage.completion_tokens += nextUsage.completion_tokens;
        usage.total_tokens += nextUsage.total_tokens;
      } else {
        usage = { ...nextUsage };
      }
    };

    const rebuildActiveSystemPrompt = () => {
      activeSystemPrompt = assemblePromptFromModules(expert.systemPrompt, [...activeModuleIds]);
    };

    const maybeRetryWithToolReminder = async () => {
      if (extractExpertToolRequests(reply, projectWorkspacePath).length > 0) return;

      const inferred = detectToolIntentWithoutAction(reply);
      const reminderTargets: string[] = [];
      if (inferred.needsWebSearch) {
        reminderTargets.push("网络搜索");
        activeModuleIds.add("web-search-guidance");
      }
      if (inferred.needsCommand) {
        reminderTargets.push("命令执行");
        activeModuleIds.add("command-guidance");
      }
      if (inferred.needsVideoWorkflow) {
        reminderTargets.push("视频工作流");
        activeModuleIds.add("video-workflow");
      }
      if (reminderTargets.length === 0) return;

      rebuildActiveSystemPrompt();
      if (onProgress) onProgress({ expertId, phase: "analyzing", detail: "补充按需能力后重试中..." });
      messages.push({ role: "assistant", content: reply });
      messages.push({
        role: "user",
        content: `你刚才已经表现出可能需要${reminderTargets.join("、")}来完成任务。如果确实需要，请直接输出标准 ACTION 发起；如果不需要，就直接给出最终结果，不要停留在“建议后续再查/再跑命令”的层面。`,
      });

      const rawRetryReply = await invoke<string>("chat_with_expert", {
        messages,
        apiKey,
        systemPrompt: activeSystemPrompt,
        model,
      });

      let retriedReply = rawRetryReply;
      let retryUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
      try {
        const parsedRetry = JSON.parse(rawRetryReply);
        if (parsedRetry && typeof parsedRetry === "object") {
          if (typeof parsedRetry.content === "string") {
            retriedReply = parsedRetry.content;
          }
          if (parsedRetry.usage && typeof parsedRetry.usage === "object") {
            retryUsage = parsedRetry.usage as {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            };
          }
        }
      } catch {
        // 保持原始文本
      }

      reply = retriedReply;
      mergeUsage(retryUsage);
    };

    await maybeRetryWithToolReminder();

    for (let toolRound = 0; toolRound < 3; toolRound++) {
      const toolRequests = extractExpertToolRequests(reply, projectWorkspacePath);
      if (toolRequests.length === 0) break;

      const toolContexts: string[] = [];
      for (const request of toolRequests) {
        if (request.kind === "web-search") {
          learnedModuleIds.add("web-search-guidance");
          triggerSources.add("web-search");
          if (onProgress) onProgress({ expertId, phase: "web-searching", detail: "网络搜索中..." });
          try {
            const results = await invoke<string>("web_search_query", {
              query: request.query,
              maxResults: 5,
            });
            let parsedResults: Array<{ title: string; url: string; snippet: string }> = [];
            try {
              parsedResults = JSON.parse(results) as Array<{ title: string; url: string; snippet: string }>;
            } catch {
              parsedResults = [];
            }
            onToolEvent?.({
              kind: "web-search",
              expertId,
              expertName: expert.name,
              expertTitle: expert.title,
              reason: request.reason,
              query: request.query,
              status: "success",
              results: parsedResults,
            });
            toolContexts.push(`[网络搜索结果]
发起理由：${request.reason}
查询：${request.query}
结果：${results}`);
          } catch (e) {
            const error = String(e);
            onToolEvent?.({
              kind: "web-search",
              expertId,
              expertName: expert.name,
              expertTitle: expert.title,
              reason: request.reason,
              query: request.query,
              status: "error",
              error,
            });
            toolContexts.push(`[网络搜索失败]
发起理由：${request.reason}
查询：${request.query}
错误：${error}`);
          }
          continue;
        }

        learnedModuleIds.add("command-guidance");
        triggerSources.add("command");
        if (onProgress) onProgress({ expertId, phase: "running-command", detail: "命令执行中..." });
        try {
          const projectDir = projectWorkspacePath || request.workingDir;
          const safetyCheck = await invoke<string>("check_command_safety", {
            command: request.command,
            args: [],
            workingDir: request.workingDir,
            projectDir,
          });
          const safety = JSON.parse(safetyCheck) as {
            requires_auth?: boolean;
            auth_reason?: string;
          };
          const requiresAuth = !!safety.requires_auth;
          const safetyReason = String(safety.auth_reason || "");
          const authMode = resolveToolCommandAuthMode(requiresAuth, safetyReason);

          if (requiresAuth) {
            const authorized = onCommandAuthorization
              ? await onCommandAuthorization({
                expertId,
                expertName: expert.name,
                expertTitle: expert.title,
                reason: request.reason,
                command: request.command,
                workingDir: request.workingDir,
                authMode,
                safetyReason,
              })
              : false;
            if (!authorized) {
              onToolEvent?.({
                kind: "command",
                expertId,
                expertName: expert.name,
                expertTitle: expert.title,
                reason: request.reason,
                command: request.command,
                workingDir: request.workingDir,
                authMode,
                status: "denied",
                safetyReason,
              });
              toolContexts.push(`[命令未执行]
发起理由：${request.reason}
命令：${request.command}
工作目录：${request.workingDir}
状态：用户未授权
说明：${safetyReason || "命令需要用户授权"}`);
              continue;
            }
          }

          const rawCommandResult = await invoke<string>("execute_command", {
            command: request.command,
            args: [],
            workingDir: request.workingDir,
          });
          const parsedCommandResult = JSON.parse(rawCommandResult) as {
            stdout?: string;
            stderr?: string;
            exit_code?: number;
          };
          const stdout = parsedCommandResult.stdout || "";
          const stderr = parsedCommandResult.stderr || "";
          const exitCode = typeof parsedCommandResult.exit_code === "number" ? parsedCommandResult.exit_code : -1;
          onToolEvent?.({
            kind: "command",
            expertId,
            expertName: expert.name,
            expertTitle: expert.title,
            reason: request.reason,
            command: request.command,
            workingDir: request.workingDir,
            authMode,
            status: "success",
            safetyReason,
            output: {
              stdout,
              stderr,
              exitCode,
            },
          });
          toolContexts.push(`[命令执行结果]
发起理由：${request.reason}
命令：${request.command}
工作目录：${request.workingDir}
退出码：${exitCode}
标准输出：
${stdout || "(空)"}
标准错误：
${stderr || "(空)"}`);
        } catch (e) {
          const error = String(e);
          onToolEvent?.({
            kind: "command",
            expertId,
            expertName: expert.name,
            expertTitle: expert.title,
            reason: request.reason,
            command: request.command,
            workingDir: request.workingDir,
            authMode: "auto",
            status: "error",
            error,
          });
          toolContexts.push(`[命令执行失败]
发起理由：${request.reason}
命令：${request.command}
工作目录：${request.workingDir}
错误：${error}`);
        }
      }

      if (toolContexts.length === 0) {
        reply = stripInlineToolActions(reply);
        break;
      }

      if (onProgress) onProgress({ expertId, phase: "analyzing", detail: "结合工具结果分析中..." });
      messages.push({ role: "assistant", content: reply });
      messages.push({
        role: "user",
        content: `以下是你请求的工具执行结果，请基于这些信息继续完成任务，并不要重复发起已经执行过的同类请求：\n\n${toolContexts.join("\n\n")}`,
      });

      const rawFollowupReply = await invoke<string>("chat_with_expert", {
        messages,
        apiKey,
        systemPrompt: activeSystemPrompt,
        model,
      });

      let nextReply = rawFollowupReply;
      let nextUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
      try {
        const parsedFollowup = JSON.parse(rawFollowupReply);
        if (parsedFollowup && typeof parsedFollowup === "object") {
          if (typeof parsedFollowup.content === "string") {
            nextReply = parsedFollowup.content;
          }
          if (parsedFollowup.usage && typeof parsedFollowup.usage === "object") {
            nextUsage = parsedFollowup.usage as {
              prompt_tokens: number;
              completion_tokens: number;
              total_tokens: number;
            };
          }
        }
      } catch {
        // 保持原始文本
      }

      reply = nextReply;
      mergeUsage(nextUsage);
    }

    reply = stripInlineToolActions(reply);

    // 记录词元使用（fire-and-forget）
    if (usage) {
      recordTokenUsage(expertId, expert.name, model, keyId, usage, expert.title).catch(console.error);
      task.tokensUsed = usage.total_tokens;
    }

    if (projectName && learnedModuleIds.size > 0) {
      const normalizedTaskDescription = taskDescription
        .split("【共享黑板")[0]
        .trim()
        .slice(0, 400);
      appendPromptModuleTrace(projectName, {
        expertId,
        scene,
        taskDescription: normalizedTaskDescription || taskDescription.slice(0, 400),
        moduleIds: [...learnedModuleIds],
        triggerSources: [...triggerSources],
        createdAt: Date.now(),
      }).catch(console.error);
    }

    // 保存专家输出到记忆系统
    if (projectName && projectId !== undefined && task.status !== "error") {
      saveExpertMemory(projectName, projectId, expertId, expert.name, taskDescription, reply).catch(console.error);
    }

    task.output = reply;

    // 检测专家是否在编写代码（输出中包含 ACTION 标记）
    if (onProgress) {
      const hasAction = /\[ACTION:(CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|EXECUTE_CMD|WRITE_DOCUMENT|GENERATE_IMAGE|READ_DOCUMENT|OPEN_BROWSER|CANVAS_ADD_NODE|CANVAS_CONNECT|VIDEO_SET_SEGMENTS|VIDEO_UPDATE_SEGMENT|SWITCH_VIEW)/i.test(reply)
        || /"changes"\s*:|"operation"\s*:\s*"(?:create_file|write_file|edit_file|create_folder|delete)"/i.test(reply);
      if (hasAction) {
        onProgress({ expertId, phase: 'writing-code', detail: '编写代码...' });
      }
      onProgress({ expertId, phase: 'completed', detail: '已完成' });
    }

    task.status = "done";
    task.endTime = Date.now();

    // 检查专家是否要求修订索引
    if (projectName && apiKey) {
      const feedbackMatch = reply.match(/\[INDEX_FEEDBACK:([\s\S]*?)\]/);
      if (feedbackMatch) {
        try {
          await invoke("repo_incremental_update", { projectName, apiKey, model });
        } catch (e) {
          console.warn("索引修订触发失败:", e);
        }
      }
    }

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

/** 执行流水线（专家依次/并行执行），每步完成后由主管中途检查 */
export async function executePipeline(
  plan: DispatchPlan,
  apiKeyResolver: (expertId: string) => string | null,
  modelResolver: (expertId: string) => string,
  onProgress: (tasks: ExpertTask[]) => void,
  projectName?: string,
  projectId?: number,
  projectWorkspacePath?: string,
  supervisorApiKey?: string,
  supervisorModel?: string,
  pendingFollowups?: PipelineFollowup[],
  onSupervisorDecision?: (action: string, reason?: string) => void,
  onExpertProgress?: (progress: { expertId: string; phase: string; detail: string }) => void,
  onToolEvent?: (event: ExpertToolEvent) => void,
  onCommandAuthorization?: (request: ExpertCommandAuthorizationRequest) => Promise<boolean>
): Promise<{ tasks: ExpertTask[]; pipelineId: string }> {
  const pipeline = PIPELINES.find((p) => p.scene === plan.scene);
  if (!pipeline) return { tasks: [], pipelineId: "" };

  currentPipelineId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeExpertTasks = [];
  activeStepExpertIds = [];
  const allResults: ExpertTask[] = [];
  const completedResults: { expertId: string; name: string; title: string; output: string }[] = [];
  const blackboard = createBlackboardTask(plan);
  let lastBlackboardSignature = "";

  // 构建步骤的专家列表（根据 plan.expertIds 动态替换）
  const steps: PipelineStep[] = buildPipelineSteps(plan, pipeline);

  // 构建剩余步骤描述列表（供主管中途检查用）
  const buildRemainingDescs = (currentIdx: number): string[] => {
    return steps.slice(currentIdx + 1).map((s) => {
      const names = s.expertIds.map((id) => {
        const e = ROUTER_EXPERTS.find((r) => r.id === id);
        return e ? `${e.name}（${e.title}）` : id;
      });
      return names.join(" + ");
    });
  };

  let stepIdx = 0;
  while (stepIdx < steps.length) {
    const step = steps[stepIdx];
    activeStepExpertIds = [...step.expertIds];
    let stepCompleted = false;

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
          dispatchWave: stepIdx + 1,
        };
        allResults.push(errTask);
        activeExpertTasks.push(errTask);
        onProgress([...activeExpertTasks]);
        stepCompleted = true;
      } else {
        const expertTask = buildTaskDescriptionForExpert(
          plan.scene,
          plan.taskDescription,
          blackboard,
          expertId,
          step.expertIds,
          pendingFollowups
        );
        const task = await callExpert(
          expertId,
          plan.scene,
          expertTask.text,
          completedResults,
          apiKey,
          modelResolver(expertId),
          expertId,
          undefined,
          projectName,
          projectId,
          plan.promptModuleHints?.[expertId],
          projectWorkspacePath,
          onExpertProgress,
          onToolEvent,
          onCommandAuthorization
        );
        task.dispatchWave = stepIdx + 1;
        allResults.push(task);
        activeExpertTasks.push(task);
        updateBlackboardFromTask(blackboard, task);
        onProgress([...activeExpertTasks]);

        if (task.output) {
          upsertCompletedResult(completedResults, task);
          markFollowupsConsumed(pendingFollowups, expertTask.followupIds, expertId);
        }
        stepCompleted = true;
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
            dispatchWave: stepIdx + 1,
          };
          return errTask;
        }
        const expertTask = buildTaskDescriptionForExpert(
          plan.scene,
          plan.taskDescription,
          blackboard,
          expertId,
          step.expertIds,
          pendingFollowups
        );
        const task = await callExpert(
          expertId,
          plan.scene,
          expertTask.text,
          completedResults,
          apiKey,
          modelResolver(expertId),
          expertId,
          undefined,
          projectName,
          projectId,
          plan.promptModuleHints?.[expertId],
          projectWorkspacePath,
          onExpertProgress,
          onToolEvent,
          onCommandAuthorization
        );
        task.dispatchWave = stepIdx + 1;
        return { task, followupIds: expertTask.followupIds };
      });

      const results = await Promise.all(parallelPromises);
      for (const result of results) {
        const task = "task" in result ? result.task : result;
        const followupIds = "followupIds" in result ? result.followupIds : [];
        allResults.push(task);
        activeExpertTasks.push(task);
        updateBlackboardFromTask(blackboard, task);
        if (task.output) {
          upsertCompletedResult(completedResults, task);
          markFollowupsConsumed(pendingFollowups, followupIds, task.expertId);
        }
      }
      onProgress([...activeExpertTasks]);
      stepCompleted = true;
    }

    if (stepCompleted) {
      await runCurrentStepFollowupRound(
        plan.scene,
        plan.taskDescription,
        blackboard,
        step.expertIds,
        completedResults,
        allResults,
        pendingFollowups,
        apiKeyResolver,
        modelResolver,
        projectName,
        projectId,
        plan.promptModuleHints,
        projectWorkspacePath,
        onProgress,
        onExpertProgress,
        onToolEvent,
        onCommandAuthorization
      );
    }

    if (plan.scene === "code-development" && stepCompleted) {
      const signature = [
        blackboard.requiredFiles.files.length,
        blackboard.evidence.length,
        blackboard.patchProposals.length,
        blackboard.reviewDecisions.length,
        blackboard.blockers.length,
      ].join(":");
      if (signature === lastBlackboardSignature) {
        blackboard.roundsWithoutProgress++;
      } else {
        blackboard.roundsWithoutProgress = 0;
        lastBlackboardSignature = signature;
      }
      if (blackboard.roundsWithoutProgress >= 5) {
        const blockTask: ExpertTask = {
          id: `task-${++taskCounter}`,
          expertId: "blackboard-guard",
          expertName: "黑板守卫",
          expertTitle: "协作门禁",
          status: "error",
          input: plan.taskDescription,
          error: "连续三轮没有新增证据、文件清单、文件变更动作或审查进展，已停止当前策略以避免空转。",
          startTime: Date.now(),
          endTime: Date.now(),
        };
        allResults.push(blockTask);
        activeExpertTasks.push(blockTask);
        onProgress([...activeExpertTasks]);
        break;
      }
    }

    // ===== 主管中途检查（非最后一步且有 supervisorApiKey 时调用）=====
    if (stepCompleted && supervisorApiKey && stepIdx < steps.length - 1) {
      const remainingDescs = buildRemainingDescs(stepIdx);
      const decision = await supervisorMidCheck(
        stepIdx,
        steps.length,
        plan.scene === "code-development" ? `${plan.taskDescription}${renderBlackboardContext(blackboard)}` : plan.taskDescription,
        completedResults,
        remainingDescs,
        pendingFollowups || [],
        supervisorApiKey,
        supervisorModel || "deepseek-chat"
      );

      // 通知 UI 主管的决定
      if (onSupervisorDecision) {
        const reasonText = decision.reason || (decision.action === "continue" ? "继续执行下一步" : "");
        onSupervisorDecision(decision.action, reasonText);
      }

      switch (decision.action) {
        case "continue":
          stepIdx++;
          break;
        case "retry":
          // 不递增 stepIdx，重新执行当前步骤
          // 清除当前步骤最后一次的结果以便重新执行
          // （保留 completedResults 中之前步骤的输出，当前步骤的输出在重试时会被新结果替代）
          break;
        case "skip-next":
          stepIdx += 2; // 跳过下一个步骤
          break;
        case "abort":
          stepIdx = steps.length; // 直接跳出循环
          break;
        default:
          stepIdx++;
      }
    } else {
      stepIdx++;
    }
  }

  activeStepExpertIds = [];
  return { tasks: allResults, pipelineId: currentPipelineId };
}

// ========== 主管中途检查 ==========

/** 主管在每个流水线步骤完成后评估，决定是否调整后续步骤 */
export async function supervisorMidCheck(
  stepIndex: number,
  totalSteps: number,
  taskDescription: string,
  currentExpertResults: { expertId: string; name: string; title: string; output: string }[],
  remainingStepDescs: string[],
  userFollowups: PipelineFollowup[],
  supervisorApiKey: string,
  supervisorModel: string
): Promise<{ action: "continue" | "retry" | "skip-next" | "abort"; reason?: string }> {
  const followupContext = userFollowups.length > 0
    ? `\n\n【用户中途补充要求】\n${userFollowups.map((item) => {
      const targetText = item.targetExpertIds.length > 0
        ? ` -> ${item.targetExpertIds.map((id) => getExpertNameLabel(id)).join("、")}`
        : "";
      return `${item.message}${targetText}`;
    }).join("；")}`
    : "";

  const resultsSummary = currentExpertResults
    .map((r) => `### ${r.name}（${r.title}）\n${r.output.substring(0, 500)}${r.output.length > 500 ? "...(截断)" : ""}`)
    .join("\n\n");

  const remainingDesc = remainingStepDescs.length > 0
    ? `\n剩余步骤：${remainingStepDescs.map((d, i) => `${i + 1}. ${d}`).join("；")}`
    : "\n剩余步骤：无（最后一步）";

  const prompt = `你是「江星图」，项目主管。你正在监督专家团流水线执行（第 ${stepIndex + 1}/${totalSteps} 步刚完成）。

原始任务：「${taskDescription}」${followupContext}

已完成专家的输出：
${resultsSummary}
${remainingDesc}

请判断下一步行动（仅输出 JSON）：
1. 如果当前步骤输出质量合格，后续步骤仍合理 → {"action":"continue"}
2. 如果当前步骤输出有问题，需要该专家重新执行 → {"action":"retry","reason":"具体反馈"}
3. 如果下一步不再需要（如设计方案已足够明确）→ {"action":"skip-next","reason":"原因"}
4. 如果当前输出已完全满足需求，或出现严重问题需终止 → {"action":"abort","reason":"原因"}

默认行为是 continue，仅在确有必要时选择其他操作。
只输出 JSON，不要输出其他内容。`;

  try {
    const rawReply = await invoke<string>("chat_with_expert", {
      messages: [{ role: "user", content: prompt }],
      apiKey: supervisorApiKey,
      systemPrompt: "你是项目主管，负责监督专家团执行。仅输出 JSON，不要其他内容。",
      model: supervisorModel,
    });

    // 解析返回
    let reply = rawReply;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
        reply = parsed.content;
      }
    } catch { /* 不是JSON包装 */ }

    const decision = extractJson(reply);
    const validActions = ["continue", "retry", "skip-next", "abort"];
    const action = validActions.includes(decision.action as string)
      ? (decision.action as "continue" | "retry" | "skip-next" | "abort")
      : "continue";

    return {
      action,
      reason: typeof decision.reason === "string" ? decision.reason : undefined,
    };
  } catch {
    // 中途检查失败时默认继续，不阻塞流水线
    return { action: "continue" };
  }
}

// ========== 主管审核 ==========

/** 主管（资质调研员）审核所有专家结果，综合为最终回复 */
export async function supervisorReview(
  taskDescription: string,
  expertResults: ExpertTask[],
  apiKey: string,
  keyId: string = "supervisor",
  model: string = "deepseek-chat"
): Promise<string> {
  const reviewPrompt = `你是「江星图」，项目主管。专家团已完成任务，现在向用户交付结果。

## 严格输出规则

1. **仅输出一句不超过50字的自然语言交付语**，描述完成了什么（如"已完成登录页面重构并写入源码"）。

2. 文件变更会由系统直接执行；你不要转述、复写或保留任何 ACTION/ChangeSet/代码块。

3. **严禁以下行为：**
   - 复述、重复、摘要化任何专家已输出的代码内容
   - 输出"工作亮点"、"改进建议"及其相关段落
   - 输出"各位专家已汇总"、"经审查确认"、"调研员…工程师…"等元数据过渡语
   - 对代码内容做任何形式的总结、罗列或逐文件说明
   - 提及任何专家的名字、头衔或分工
   - 输出任何以 ### 开头的章节标题
   - 输出任何 [ACTION:...] 标记或 JSON 代码块

4. **最终输出结构：** 一句交付语（≤50字）。`;

  const summary = expertResults
    .map((r) => {
      const status = r.status === "done" ? "完成" : r.status === "error" ? "失败" : "未知";
      return `### ${r.expertName}（${r.expertTitle}）[${status}]\n${r.output || r.error || "无输出"}`;
    })
    .join("\n\n");

  const messages = [
    { role: "user", content: `任务描述：${taskDescription}` },
    { role: "user", content: `专家工作结果（其中可能包含结构化 ChangeSet 或 ACTION，系统会直接执行对应文件动作）：\n\n${summary}\n\n请审核并综合为最终回复。重要：最终回复只给用户一句自然交付语，不要复写任何代码、JSON 或 ACTION 标记。` },
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
      model,
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
      recordTokenUsage("supervisor", "江星图", model, keyId, usage, "主管").catch(console.error);
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

  return `你是「江星图」，项目主管兼资质调研员。你的职责是分析用户需求，制定任务计划并分配专家处理。

【核心原则】
1. 你绝对不直接编写代码、审查代码、进行技术调研或设计
2. 你的工作是：理解需求 → 选择场景 → 派遣专家 → 审核结果
3. 所有实际工作必须交由专家完成
4. 用自然、亲切的语言与用户交流，这款软件面向各类用户，并非只有专业程序员

【可用专家】
${expertList}

【场景与派遣规则】

1. code-development（代码开发）
   - 流程：调研员 → [设计师（可选）] → 工程师 → 审查员
   - 工程师从 江青澜（通用）/ 江予墨（前端）/ 江素白（后端）中选择
   - 复杂度较高时设置 requiresDesign=true 引入设计师
   - 如果用户是在已有网站、网页、代码产物基础上提出修改要求，一律视为增量开发任务，必须选择 code-development，不能只分配 design
   - expertIds 顺序：["jiang-ruoxi", 工程师ID, "jiang-yingqiu"]

2. code-review（代码审查）
   - 只需审查员：expertIds: ["jiang-yingqiu"]

3. technical-research（技术调研）
   - 只需调研员：expertIds: ["jiang-ruoxi"]

4. design（设计方案）
   - 调研员 + 设计师：expertIds: ["jiang-ruoxi", "jiang-dingchu"]
   - 仅当用户明确要求“方案/规范/文档”，且不要求直接修改现有产物时，才使用该场景

5. quick-answer（简单问题/闲聊）
   - 无需专家：expertIds: []

6. translation（翻译任务）
   - 将内容翻译成其他语言：expertIds: ["jiang-lingyu"]

7. writing（写作任务）
   - 创意写作、文案、报告撰写、文本润色：expertIds: ["jiang-ruoxi", "jiang-moxian"]

8. office（办公事务）
   - 邮件撰写、会议纪要、日程管理、通知公告：expertIds: ["jiang-wenshu"]

9. data-analysis（数据分析）
   - 数据解读、统计分析、图表生成、数据报告：expertIds: ["jiang-ruoxi", "jiang-shuyan"]

10. document-processing（文档处理）
    - 读取/转换/生成文档文件：expertIds: ["jiang-zhilan"]

11. media-creation（媒体创作）
    - 图像生成/编辑、音频处理：expertIds: ["jiang-huaying"]

12. video-production（视频创作）
    - 视频制作，需调研+镜头分段+逐段生成+拼接：expertIds: ["jiang-ruoxi", "jiang-huaying"]

13. research-with-search（需要网络搜索的调研）
    - 需获取最新外部信息时：expertIds: ["jiang-ruoxi"]

【按需能力模块提示】
你可以额外输出 promptModuleHints，告诉系统某位专家应优先加载哪些能力模块。
- 只在你有较高把握该专家大概率会用到时才填写；不确定就留空。
- 只能给与该专家职责相符的模块，不要把视频工作流塞给前端工程师，也不要把文档模块塞给审查员。
- 可选模块 ID 仅限：
  - code-tool-primer
  - web-search-guidance
  - command-guidance
  - document-tool-primer
  - media-tool-primer
  - video-workflow
- 示例：
  "promptModuleHints": {
    "jiang-ruoxi": ["web-search-guidance"],
    "jiang-yumo": ["command-guidance"]
  }

【输出格式】（必须是合法 JSON，不要输出其他内容）
{"scene":"场景名","taskDescription":"具体任务描述","expertIds":["专家ID1","专家ID2"],"requiresDesign":false,"promptModuleHints":{"专家ID":["模块ID"]}}`;
}

/** 主管分析用户意图，输出调度计划 */
export async function supervisorAnalyze(
  userMessage: string,
  conversationHistory: { role: string; content: string }[],
  availableExperts: ExpertInfo[],
  supervisorApiKey: string,
  keyId: string = "supervisor",
  model: string = "deepseek-chat"
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
    content: `请分析以下需求并输出调度计划（仅输出 JSON，用自然亲切的语言理解用户需求）：\n${userMessage}`,
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
      model,
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
      recordTokenUsage("supervisor", "江星图", model, keyId, usage, "主管").catch(console.error);
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
  keyId: string = "supervisor",
  model: string = "deepseek-chat"
): Promise<{
  action: "append" | "replace" | "respond" | "respond-and-append" | "respond-and-replace";
  taskDescription?: string;
  reply?: string;
  targetExpertIds?: string[];
  deliveryMode?: PipelineFollowup["deliveryMode"];
}> {
  const progressReport = buildProgressReport();
  const currentStepSummary = activeStepExpertIds.length > 0
    ? activeStepExpertIds.map((id) => `- ${id}: ${getExpertNameLabel(id)}`).join("\n")
    : "- 当前没有可识别的执行中专家";
  const remainingExpertSummary = currentPlan.expertIds.length > 0
    ? currentPlan.expertIds.map((id) => `- ${id}: ${getExpertNameLabel(id)}`).join("\n")
    : "- 当前计划中没有专家";
  const activeTaskSummary = activeExpertTasks.length > 0
    ? activeExpertTasks
      .map((task) => {
        const status =
          task.status === "done"
            ? "已完成"
            : task.status === "running"
              ? "执行中"
              : task.status === "error"
                ? `失败：${task.error || "未知错误"}`
                : "等待中";
        const detail = task.output
          ? task.output.slice(0, 180)
          : task.phaseDetail || task.error || task.input.slice(0, 120);
        return `- ${task.expertId}: ${task.expertName}（${task.expertTitle}）：${status}${detail ? `；${detail}` : ""}`;
      })
      .join("\n")
    : "暂无可用的阶段性结果。";

  const prompt = `你是项目主管。当前正在执行任务：
场景：${currentPlan.scene}
任务：${currentPlan.taskDescription}

当前正在处理的专家：
${currentStepSummary}

当前任务可继续协作的专家：
${remainingExpertSummary}

当前进度：
${progressReport}

阶段性专家信息：
${activeTaskSummary}

用户发来了中途消息：「${followupMessage}」

判断：
1. 如果是对当前任务的补充，输出 {"action":"append","taskDescription":"补充说明","targetExpertIds":["专家ID"],"deliveryMode":"current-step|next-relevant|all-remaining"}
2. 如果用户是在修正错误要求、撤销前述要求或明显改变主意，但仍属于当前这轮工作，输出 {"action":"replace","taskDescription":"更新后的当前任务描述","targetExpertIds":["专家ID"],"deliveryMode":"current-step|next-relevant|all-remaining"}
3. 如果用户是在询问当前进度、原因、已经发现的问题，主管必须直接回答，输出 {"action":"respond","reply":"直接给用户的话"}
4. 如果既要先回答用户，又要把补充要求转交给专家，输出 {"action":"respond-and-append","reply":"直接给用户的话","taskDescription":"补充说明","targetExpertIds":["专家ID"],"deliveryMode":"current-step|next-relevant|all-remaining"}
5. 如果既要先回答用户，又要用新的任务描述覆盖当前方向，输出 {"action":"respond-and-replace","reply":"直接给用户的话","taskDescription":"更新后的当前任务描述","targetExpertIds":["专家ID"],"deliveryMode":"current-step|next-relevant|all-remaining"}

规则：
- 主管直接和用户对话，不要把用户问题原样丢给子专家。
- 中途插话一律并入当前流水线，不要输出 new-plan，不要让用户“等这轮结束后再发一次”。
- 如果当前有正在处理的专家，优先把补充/更正直接交给对应专家，deliveryMode 优先用 current-step。
- reply 必须是自然中文，基于当前已知进度和专家输出；未知就坦诚说明，不要编造。
- targetExpertIds 必须从上面列出的专家 ID 中选择；如果影响所有后续专家，可传空数组并用 all-remaining。

仅输出 JSON。`;

  // === 配额前置校验（主管）===
  const quotaCheck = checkQuota("supervisor");
  if (!quotaCheck.allowed) {
    displayQuotaBlockMessage(quotaCheck.reason!);
    return { action: "append", taskDescription: followupMessage };
  }

  try {
    const rawReply = await invoke<string>("chat_with_expert", {
      messages: [{ role: "user", content: followupMessage }],
      apiKey: supervisorApiKey,
      systemPrompt: prompt,
      model,
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
      recordTokenUsage("supervisor", "江星图", model, keyId, usage, "主管").catch(console.error);
    }

    const parsed = extractJson(reply);
    const targetExpertIds = Array.isArray(parsed.targetExpertIds)
      ? (parsed.targetExpertIds as unknown[])
        .filter((item): item is string => typeof item === "string" && currentPlan.expertIds.includes(item))
      : [];
    const deliveryMode = parsed.deliveryMode === "current-step" || parsed.deliveryMode === "all-remaining"
      ? parsed.deliveryMode
      : "next-relevant";

    if (parsed.action === "replace") {
      return {
        action: "replace",
        taskDescription: typeof parsed.taskDescription === "string" && parsed.taskDescription.trim()
          ? parsed.taskDescription.trim()
          : currentPlan.taskDescription,
        targetExpertIds,
        deliveryMode,
      };
    }
    if (parsed.action === "respond-and-replace") {
      return {
        action: "respond-and-replace",
        reply: typeof parsed.reply === "string" ? parsed.reply.trim() : undefined,
        taskDescription: typeof parsed.taskDescription === "string" && parsed.taskDescription.trim()
          ? parsed.taskDescription.trim()
          : currentPlan.taskDescription,
        targetExpertIds,
        deliveryMode,
      };
    }
    if (parsed.action === "respond") {
      return {
        action: "respond",
        reply: typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : `${progressReport}\n\n如果你想调整目标，我也可以继续转达给后续专家。`,
      };
    }
    if (parsed.action === "respond-and-append") {
      return {
        action: "respond-and-append",
        reply: typeof parsed.reply === "string" && parsed.reply.trim()
          ? parsed.reply.trim()
          : `${progressReport}\n\n我也会把你的新增要求继续转达给后续专家。`,
        taskDescription: typeof parsed.taskDescription === "string" && parsed.taskDescription.trim()
          ? parsed.taskDescription.trim()
          : followupMessage,
        targetExpertIds,
        deliveryMode,
      };
    }
    return {
      action: "append",
      taskDescription: typeof parsed.taskDescription === "string" && parsed.taskDescription.trim()
        ? parsed.taskDescription.trim()
        : followupMessage,
      targetExpertIds,
      deliveryMode,
    };
  } catch {
    return { action: "append", taskDescription: followupMessage };
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
  activeStepExpertIds = [];
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
    "translation", "writing", "office", "data-analysis", "document-processing", "media-creation", "video-production", "research-with-search",
  ];
  const expertIds = Array.isArray(parsed.expertIds)
    ? (parsed.expertIds as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const rawPromptModuleHints = normalizePromptModuleHintMap(parsed.promptModuleHints);
  const promptModuleHints: PromptModuleHintMap = {};
  for (const expertId of expertIds) {
    const hintModules = rawPromptModuleHints[expertId];
    if (hintModules && hintModules.length > 0) {
      promptModuleHints[expertId] = hintModules;
    }
  }

  return {
    scene: validScenes.includes(scene) ? scene : "quick-answer",
    taskDescription: typeof parsed.taskDescription === "string" ? parsed.taskDescription : "",
    expertIds,
    requiresDesign: parsed.requiresDesign === true,
    promptModuleHints,
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
