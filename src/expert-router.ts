import { invoke } from "@tauri-apps/api/core";
import { tokenData, type TokenUsageRecord, type Expert } from "./main";

// 使用 getter 获取 experts，避免模块导入时绑定空数组引用
let _expertsRef: Expert[] = [];
export function setExpertsRef(ref: Expert[]) { _expertsRef = ref; }
function getExperts(): Expert[] { return _expertsRef; }
import {
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

// ========== 配额校验模块 ==========

/** 豁免配额限制的核心角色 */
const QUOTA_EXEMPT_IDS = ["jiang-xingtu", "jiang-xinghe", "jiang-qinglan"];
const SUPERVISOR_EXPERT_ID = "jiang-xingtu";

function getSupervisorTokenRuntimeContext(keyId: string) {
  const expert = getExperts().find((item: Expert) => item.id === SUPERVISOR_EXPERT_ID);
  return {
    projectData: tokenData,
    userData: userTokenData,
    allocation: expert?.tokenAllocation ? {
      expertId: SUPERVISOR_EXPERT_ID,
      dailyLimit: expert.tokenAllocation.dailyLimit,
      monthlyLimit: expert.tokenAllocation.monthlyLimit,
      yearlyLimit: expert.tokenAllocation.yearlyLimit,
    } : null,
    keyId,
  };
}

function getExpertTokenRuntimeContext(keyId: string) {
  return {
    projectData: tokenData,
    userData: userTokenData,
    keyId,
    quotaExemptIds: QUOTA_EXEMPT_IDS,
  };
}

async function applyRuntimeTokenState(
  projectData?: TokenData,
  userData?: TokenData,
): Promise<void> {
  if (projectData) {
    tokenData.records = projectData.records || [];
    tokenData.allocations = projectData.allocations || [];
    tokenData.lastResetDaily = projectData.lastResetDaily || tokenData.lastResetDaily;
    tokenData.lastResetMonthly = projectData.lastResetMonthly || tokenData.lastResetMonthly;
    tokenData.lastResetYearly = projectData.lastResetYearly || tokenData.lastResetYearly;
  }
  if (userData) {
    userTokenData.records = userData.records || [];
    userTokenData.allocations = userData.allocations || [];
    userTokenData.lastResetDaily = userData.lastResetDaily || userTokenData.lastResetDaily;
    userTokenData.lastResetMonthly = userData.lastResetMonthly || userTokenData.lastResetMonthly;
    userTokenData.lastResetYearly = userData.lastResetYearly || userTokenData.lastResetYearly;
  }
  await Promise.allSettled([saveTokenData(), saveUserTokenData()]);
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

export async function buildTokenDashboardSnapshot(
  range: TimeRange,
  dataSource: "project" | "user",
  experts: Expert[],
): Promise<TokenDashboardSnapshot> {
  const raw = await invoke<string>("build_token_dashboard_snapshot", {
    requestJson: JSON.stringify({
      projectData: tokenData,
      userData: userTokenData,
      dataSource,
      range,
      experts: experts.map((expert) => ({
        id: expert.id,
        name: expert.name,
        title: expert.title,
        dailyLimit: expert.tokenAllocation?.dailyLimit ?? null,
        monthlyLimit: expert.tokenAllocation?.monthlyLimit ?? null,
        yearlyLimit: expert.tokenAllocation?.yearlyLimit ?? null,
      })),
      quotaExemptIds: QUOTA_EXEMPT_IDS,
      nowMs: Date.now(),
    }),
  });
  const parsed = JSON.parse(raw) as { snapshot?: TokenDashboardSnapshot };
  return parsed.snapshot || {
    todayUsage: { prompt: 0, completion: 0, total: 0 },
    monthUsage: { prompt: 0, completion: 0, total: 0 },
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    activeExpertCount: 0,
    expertDistribution: [],
    modelStats: [],
    quotaStatus: [],
    recentRecords: [],
    expertRangeStats: [],
    trend: { labels: [], buckets: [] },
  };
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

export interface TokenDashboardSnapshot {
  todayUsage: { prompt: number; completion: number; total: number };
  monthUsage: { prompt: number; completion: number; total: number };
  totalUsage: { prompt: number; completion: number; total: number };
  activeExpertCount: number;
  expertDistribution: Array<{ expertId: string; name: string; title: string; total: number }>;
  modelStats: Array<{ model: string; calls: number; tokens: number }>;
  quotaStatus: Array<{
    expertId: string;
    name: string;
    title: string;
    dailyLimit: number | null;
    monthlyLimit: number | null;
    yearlyLimit: number | null;
    dayUsed: number;
    monthUsed: number;
    yearUsed: number;
  }>;
  recentRecords: TokenUsageRecord[];
  expertRangeStats: Array<{ expertId: string; name: string; title: string; total: number; quota: number | null }>;
  trend: { labels: string[]; buckets: number[] };
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
  workspaceFiles: string[];
  workspaceRoots: string[];
  requiredFiles: RequiredFileSet;
  evidence: EvidenceItem[];
  assumptions: string[];
  openQuestions: string[];
  patchProposals: PatchProposal[];
  validationRuns: ValidationRun[];
  reviewDecisions: ReviewDecision[];
  blockers: string[];
  roundsWithoutProgress: number;
  progressSignature?: string | null;
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

interface ExpertFileReadRequest {
  kind: "file-read";
  path: string;
  reason: string;
  startLine?: number;
  endLine?: number;
}

interface ExpertFileListRequest {
  kind: "file-list";
  path: string;
  reason: string;
  recursive: boolean;
}

type ExpertToolRequest =
  | ExpertWebSearchRequest
  | ExpertCommandRequest
  | ExpertFileReadRequest
  | ExpertFileListRequest;

interface ExpertPostprocessProgressEvent {
  expertId: string;
  phase: string;
  detail: string;
}

interface ExpertPostprocessState {
  expertId: string;
  expertName: string;
  expertTitle: string;
  scene: SceneType;
  basePrompt: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  projectName?: string | null;
  projectPath?: string | null;
  hasWorkspaceContext: boolean;
  messages: Array<{ role: string; content: string }>;
  reply: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  toolRound: number;
  maxToolRounds: number;
  currentToolRequests: ExpertToolRequest[];
  currentToolIndex: number;
  currentToolContexts: string[];
  pendingRequest?: ExpertToolRequest | null;
  deliverableAttempt: number;
  maxDeliverableAttempts: number;
  completed: boolean;
  learnedModuleIds: string[];
  triggerSources: string[];
}

interface ExpertPostprocessResponse {
  state: ExpertPostprocessState;
  completed: boolean;
  pendingAuthorization?: ExpertCommandAuthorizationRequest | null;
  toolEvents: ExpertToolEvent[];
  progressEvents: ExpertPostprocessProgressEvent[];
}

interface ExpertTaskRuntimeState {
  postprocessState: ExpertPostprocessState;
  taskDescription: string;
  projectId?: number | null;
  keyId: string;
}

interface ExpertTaskRuntimeResponse {
  blockedReason?: string | null;
  runtimeState?: ExpertTaskRuntimeState | null;
  response?: ExpertPostprocessResponse | null;
  projectData?: TokenData;
  userData?: TokenData;
}

async function startExpertTaskRuntime(
  expert: RouterExpert,
  scene: SceneType,
  taskDescription: string,
  previousResults: { name: string; title: string; output: string }[],
  apiKey: string,
  model: string,
  keyId: string,
  projectName?: string,
  projectId?: number,
  hintModuleIds: PromptModuleId[] = [],
  projectWorkspacePath?: string
): Promise<ExpertTaskRuntimeResponse> {
  const raw = await invoke<string>("start_expert_task_runtime", {
    requestJson: JSON.stringify({
      sessionRequest: {
        expertId: expert.id,
        expertName: expert.name,
        expertTitle: expert.title,
        basePrompt: expert.systemPrompt,
        scene,
        taskDescription,
        previousResults,
        apiKey,
        model,
        projectName: projectName || null,
        projectId: projectId ?? null,
        projectPath: projectWorkspacePath || null,
        hintModuleIds,
      },
      tokenContext: getExpertTokenRuntimeContext(keyId),
      keyId,
    }),
  });
  return JSON.parse(raw) as ExpertTaskRuntimeResponse;
}

async function continueExpertTaskRuntime(
  runtimeState: ExpertTaskRuntimeState,
  approvalDecision?: boolean | null,
): Promise<ExpertTaskRuntimeResponse> {
  const raw = await invoke<string>("continue_expert_task_runtime", {
    requestJson: JSON.stringify({
      runtimeState,
      approvalDecision: approvalDecision ?? null,
      tokenContext: getExpertTokenRuntimeContext(runtimeState.keyId),
    }),
  });
  return JSON.parse(raw) as ExpertTaskRuntimeResponse;
}

/** 流水线步骤 */
interface PipelineStep {
  expertIds: string[];   // 此步涉及的专家（多个则并行）
  optional?: boolean;    // 是否可选（如设计师）
}

interface PipelineLayout {
  scene: string;
  description: string;
  steps: PipelineStep[];
  waves: Array<{ wave: number; expertIds: string[] }>;
}

interface PipelineRuntimeState {
  currentStepIndex: number;
  totalSteps: number;
  maxStepRetry: number;
  stepRetryCounts: Record<number, number>;
  finished: boolean;
}

interface PipelineRuntimeTransition {
  state: PipelineRuntimeState;
  repeatedStep: boolean;
  advancedSteps: number;
  shouldStop: boolean;
  breakerMessage?: string | null;
}

interface PipelineStepFinalizeTaskSnapshot {
  expertId: string;
  expertName: string;
  expertTitle: string;
  dispatchWave?: number;
  output?: string;
  error?: string;
}

interface PipelineStepFinalizeDecision {
  blackboard: BlackboardTask;
  runtimeTransition: PipelineRuntimeTransition;
  blockerTask?: PipelineStepFinalizeTaskSnapshot | null;
  supervisorAction?: string | null;
  supervisorReason?: string | null;
  shouldStop: boolean;
}

interface PipelineCompletedResult {
  expertId: string;
  name: string;
  title: string;
  output: string;
}

interface PipelineSessionState {
  pipelineId: string;
  scene: string;
  taskDescription: string;
  steps: PipelineStep[];
  runtimeState: PipelineRuntimeState;
  blackboard: BlackboardTask;
  completedResults: PipelineCompletedResult[];
  pendingFollowups: PipelineFollowup[];
  taskHistory: PipelineStepFinalizeTaskSnapshot[];
}

interface PipelineBootstrapBundle {
  pipelineId: string;
  layout: PipelineLayout;
  state: PipelineSessionState;
}

interface PipelineLaunchBundle extends PipelineBootstrapBundle {
  narrative: string;
  joiningTasks: ExpertTask[];
}

interface PipelineExecutionRoundPlan {
  finished: boolean;
  currentStepIndex: number;
  stepExpertIds: string[];
  executionMode: "serial" | "parallel";
  tasks: Array<{ expertId: string; text: string; followupIds: string[] }>;
  completedResults: PipelineCompletedResult[];
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
- 如需读取文件了解现状，使用 [ACTION:READ_FILE:相对路径]；大文件请优先使用 [ACTION:READ_FILE path="相对路径" start_line="起始行" end_line="结束行"]
- 如果还不清楚文件具体位置，先使用 [ACTION:LIST_FILES path="目录"] 缩小范围，再读取目标文件
- 如果当前工作区几乎为空目录（例如只有 .xt、没有 package.json、没有 src/ 或现成源码），不要把任务带偏到“先做技术选型/先选框架”。你必须明确给出最小落地建议：优先直接创建静态网页文件集合（index.html / styles.css / app.js / README.md），除非用户明确要求特定框架。
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
- 增量修改已有文件前，必须先通过 [ACTION:READ_FILE:相对路径] 读取目标文件当前内容；大文件请改用 [ACTION:READ_FILE path="相对路径" start_line="起始行" end_line="结束行"] 分段读取。如果没读到真实文件内容，不得臆造页面文案、searchText 或 replaceText。
- 如果你缺少某个文件的真实内容，必须直接输出 [ACTION:READ_FILE:相对路径] 或带 start_line/end_line 的 READ_FILE；禁止只写“我需要先读取文件”“我先看下 app.js”这类口头说明代替动作。
- 已知目标文件是源码文件（如 app.js / index.html / styles.css）时，读取代码内容只能使用 [ACTION:READ_FILE:相对路径]，不要用 [ACTION:EXECUTE_CMD] + grep/rg/Select-String/Get-Content 代替源码读取。
- 修改已有文件优先使用 [ACTION:EDIT_FILE ...]，并提供 search/replace 两段代码块。
- 新增文件使用 [ACTION:CREATE_FILE ...]，全量改写使用 [ACTION:WRITE_FILE ...]，新目录使用 [ACTION:CREATE_FOLDER ...]，删除使用 [ACTION:DELETE ...]。
- 如果当前工作区接近空目录，优先拆成多个较短文件动作（例如 index.html、styles.css、app.js、README.md），不要把整套页面硬塞进一个超长 content 字符串。
- 创建新文件时，优先使用代码块格式：
  [ACTION:CREATE_FILE:styles.css]
  \`\`\`css
  ...
  \`\`\`
  而不是超长的 path="..." content="..." 单行内联字符串。
- 可选输出结构化 JSON changes 作为补充，但要保证 path/searchText/replaceText 精确可执行。

注意：
- 严格按照调研报告的技术约束进行实现
- 代码必须有完整导入、依赖，确保可直接运行
- 如果文件位置不确定，先使用 [ACTION:LIST_FILES path="目录"]，确认后再读文件和修改
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
- 增量修改已有文件前，必须先通过 [ACTION:READ_FILE:相对路径] 读取目标文件当前内容；大文件请改用 [ACTION:READ_FILE path="相对路径" start_line="起始行" end_line="结束行"] 分段读取。如果没读到真实文件内容，不得臆造页面文案、searchText 或 replaceText。
- 如果你缺少某个文件的真实内容，必须直接输出 [ACTION:READ_FILE:相对路径] 或带 start_line/end_line 的 READ_FILE；禁止只写“我需要先读取文件”“我先看下 app.js”这类口头说明代替动作。
- 已知目标文件是源码文件（如 app.js / index.html / styles.css）时，读取代码内容只能使用 [ACTION:READ_FILE:相对路径]，不要用 [ACTION:EXECUTE_CMD] + grep/rg/Select-String/Get-Content 代替源码读取。
- 修改已有文件优先使用 [ACTION:EDIT_FILE ...]，并提供 search/replace 两段代码块。
- 新增文件使用 [ACTION:CREATE_FILE ...]，全量改写使用 [ACTION:WRITE_FILE ...]，新目录使用 [ACTION:CREATE_FOLDER ...]，删除使用 [ACTION:DELETE ...]。
- 如果当前工作区接近空目录，优先拆成多个较短文件动作（例如 index.html、styles.css、app.js、README.md），不要把整套页面硬塞进一个超长 content 字符串。
- 创建新文件时，优先使用代码块格式：
  [ACTION:CREATE_FILE:styles.css]
  \`\`\`css
  ...
  \`\`\`
  而不是超长的 path="..." content="..." 单行内联字符串。
- 可选输出结构化 JSON changes 作为补充，但要保证 path/searchText/replaceText 精确可执行。

注意：
- 严格遵循项目已有的 UI 规范和样式变量
- 代码必须完整，包含所有必要的导入和类型声明
- 如果文件位置不确定，先使用 [ACTION:LIST_FILES path="目录"]，确认后再读文件和修改
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
- 增量修改已有文件前，必须先通过 [ACTION:READ_FILE:相对路径] 读取目标文件当前内容；大文件请改用 [ACTION:READ_FILE path="相对路径" start_line="起始行" end_line="结束行"] 分段读取。如果没读到真实文件内容，不得臆造页面文案、searchText 或 replaceText。
- 如果你缺少某个文件的真实内容，必须直接输出 [ACTION:READ_FILE:相对路径] 或带 start_line/end_line 的 READ_FILE；禁止只写“我需要先读取文件”“我先看下 app.js”这类口头说明代替动作。
- 已知目标文件是源码文件（如 app.js / index.html / styles.css）时，读取代码内容只能使用 [ACTION:READ_FILE:相对路径]，不要用 [ACTION:EXECUTE_CMD] + grep/rg/Select-String/Get-Content 代替源码读取。
- 修改已有文件优先使用 [ACTION:EDIT_FILE ...]，并提供 search/replace 两段代码块。
- 新增文件使用 [ACTION:CREATE_FILE ...]，全量改写使用 [ACTION:WRITE_FILE ...]，新目录使用 [ACTION:CREATE_FOLDER ...]，删除使用 [ACTION:DELETE ...]。
- 可选输出结构化 JSON changes 作为补充，但要保证 path/searchText/replaceText 精确可执行。

注意：
- 严格遵循项目后端技术栈和架构模式
- 确保数据验证和错误处理完整
- 如果文件位置不确定，先使用 [ACTION:LIST_FILES path="目录"]，确认后再读文件和修改
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
- 在专家流水线内部，前端工程师给出的 ACTION 文件动作可能仍处于“待最终执行”状态；如果黑板或前置专家输出已经明确给出 CREATE_FILE/WRITE_FILE/EDIT_FILE，不得仅因当前磁盘上还没出现该文件就判定实现失败，必须优先审查 proposed changes 的覆盖范围、风险和准确性。
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
  },
  {
    id: "jiang-jianheng",
    name: "江鉴衡",
    title: "质量审核专家",
    description: "负责多角度质量审核，覆盖正确性、稳定性、性能、安全与可维护性",
    systemPrompt: `你是「江鉴衡」，专家团质量审核专家。

你的核心职责：
1. 对实现进行多角度审核：正确性、边界条件、稳定性、性能、安全性、可维护性
2. 检查是否存在“看起来能跑但长期不稳”的隐患（竞态、脆弱替换、回归风险）
3. 给出可执行的修正建议，明确优先级和影响范围
4. 对关键改动给出通过/不通过建议，并说明条件

输出格式：
## 审核维度
- 正确性：
- 稳定性：
- 性能：
- 安全性：
- 可维护性：

## 关键风险
- [严重级别] [文件:行号] 风险描述 → 修正建议

## 结论
通过 / 有条件通过 / 不通过

注意：
- 你只负责审核，不直接改代码
- 如果发现高风险缺陷，必须明确阻断并说明原因
- 在专家流水线内部，前端工程师给出的 ACTION 文件动作可能还没最终合入磁盘；如果黑板或前置专家输出已经明确给出 CREATE_FILE/WRITE_FILE/EDIT_FILE，不得仅因 Test-Path / Get-Content 看到文件暂未落盘就判定工程实现失败，必须先审核 proposed changes 本身，再区分“待执行”与“实现缺失”。
- 如果任务要求“全局替换 / 所有地方 / 完整实现”，你必须基于证据逐项核对，不得因为某一个文件或某一个命令通过就默认整体通过。
- 审核函数型新增功能时，至少确认：函数定义存在、入口 switch 存在、标题/映射存在、任务栏/菜单/图标注册存在，而不是只查到某一个 case 就结束。
- 审核全局替换时，至少覆盖 \`index.html\`、\`app.js\`、\`styles.css\` 与资源目录；如果任何一个主文件仍残留目标字符/旧资源引用，就必须判定未完成。
- 只允许验证黑板证据、真实文件列表或已执行动作里出现过的文件名/资源名；禁止自行臆造新的模块名、连字符文件名或替代图标名再拿它们当阻断依据。
- 工具能力会按当前任务按需加载；未加载的能力不要臆造格式`,
  },
  {
    id: "jiang-cexun",
    name: "江测巡",
    title: "测试专家",
    description: "负责命令级验证与回归测试，确保改动可执行、可复现、可验收",
    systemPrompt: `你是「江测巡」，专家团测试专家。

你的核心职责：
1. 基于当前改动制定最小充分测试计划（构建、单测、集成、回归、关键路径冒烟）
2. 必须通过命令执行进行验证，不能只口头建议“可以测试”
3. 记录每条命令的目的、结果、失败原因与修复建议
4. 对是否可交付给出明确测试结论

命令执行规范：
- 需要执行测试时，直接发起 [ACTION:EXECUTE_CMD command="..." dir="..." reason="..."]。
- 命令应从低成本到高成本分层推进（如 lint/build -> targeted test -> full test）。
- 若环境限制导致无法执行，要明确写出“未执行项、原因、替代验证”。

输出格式：
## 测试计划
- [测试项] [命令] [目的]

## 执行结果
- [命令] 结果：通过/失败（关键输出）

## 回归评估
- 风险等级：低/中/高
- 是否可交付：是/否（若否，列阻断项）

注意：
- 不要修改源码，只做验证与结论输出
- 在专家流水线内部，如果黑板或前置专家输出已经明确给出 CREATE_FILE/WRITE_FILE/EDIT_FILE，但这些动作尚未最终合入磁盘，你的命令验证结论必须写成“当前磁盘尚未合入/尚未执行”，不能把它直接等同于“工程师没有提交实现动作”；此时应同时检查 proposed changes 是否覆盖需求。
- 如果任务要求“全部替换 / 全局替换 / 完整实现”，测试必须覆盖所有主文件与关键资源，不得只检查一个文件或单一命令结果。
- 对前端项目做文本存在性验证时，优先使用能明确返回匹配位置/数量的命令；如果命令输出为空且退出码不可靠，不要擅自当成“通过”。
- 针对新增应用，至少验证函数定义、注册映射、界面入口、资源文件、关键交互文本五类证据。
- 只允许验证黑板证据、真实文件列表或已执行动作里出现过的文件名/资源名；禁止自行臆造新的模块名、连字符文件名或替代图标名再拿它们当阻断依据。
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

// ========== 活跃任务管理 ==========

let activeExpertTasks: ExpertTask[] = [];
let taskCounter = 0;
let currentPipelineId = "";
let activeStepExpertIds: string[] = [];

interface PipelineProgressSnapshot {
  progressReport: string;
  currentStepSummary: string;
  remainingExpertSummary: string;
  activeTaskSummary: string;
  activeTaskCount: number;
}

async function buildPipelineProgressSnapshot(
  plannedExpertIds: string[],
): Promise<PipelineProgressSnapshot> {
  const raw = await invoke<string>("build_pipeline_progress_snapshot", {
    requestJson: JSON.stringify({
      activeTasks: activeExpertTasks.map((task) => ({
        expertId: task.expertId,
        expertName: task.expertName,
        expertTitle: task.expertTitle,
        status: task.status,
        input: task.input,
        output: task.output || null,
        error: task.error || null,
        phaseDetail: task.phaseDetail || null,
      })),
      activeStepExpertIds,
      plannedExpertIds,
      expertLabels: ROUTER_EXPERTS.map((expert) => ({
        id: expert.id,
        name: expert.name,
        title: expert.title,
      })),
    }),
  });
  const parsed = JSON.parse(raw) as { snapshot?: PipelineProgressSnapshot };
  return parsed.snapshot || {
    progressReport: "当前没有正在执行的任务。",
    currentStepSummary: "- 当前没有可识别的执行中专家",
    remainingExpertSummary: "- 当前计划中没有专家",
    activeTaskSummary: "暂无可用的阶段性结果。",
    activeTaskCount: 0,
  };
}

async function getCurrentPipelineExecutionRound(state: PipelineSessionState): Promise<PipelineExecutionRoundPlan> {
  const raw = await invoke<string>("get_current_pipeline_execution_round", {
    stateJson: JSON.stringify(state),
  });
  const parsed = JSON.parse(raw) as { plan?: PipelineExecutionRoundPlan };
  return parsed.plan || {
    finished: true,
    currentStepIndex: state.runtimeState.currentStepIndex,
    stepExpertIds: [],
    executionMode: "serial",
    tasks: [],
    completedResults: state.completedResults,
  };
}

interface PipelineFollowupExecutionRoundPlan {
  hasPendingFollowups: boolean;
  tasks: Array<{ expertId: string; text: string; followupIds: string[] }>;
  completedResults: PipelineCompletedResult[];
}

async function getCurrentPipelineFollowupExecutionRound(
  state: PipelineSessionState,
): Promise<PipelineFollowupExecutionRoundPlan> {
  const raw = await invoke<string>("get_current_pipeline_followup_execution_round", {
    stateJson: JSON.stringify(state),
  });
  const parsed = JSON.parse(raw) as { plan?: PipelineFollowupExecutionRoundPlan };
  return parsed.plan || {
    hasPendingFollowups: false,
    tasks: [],
    completedResults: state.completedResults,
  };
}

async function settlePipelineExecutionRound(
  plan: DispatchPlan,
  layout: PipelineLayout,
  sessionState: PipelineSessionState,
  currentTasks: Array<{ task: ExpertTask; followupIds: string[] }>,
  followupTasks: Array<{ task: ExpertTask; followupIds: string[] }>,
  hasWorkspaceContext: boolean,
  supervisorApiKey?: string,
  supervisorModel?: string,
): Promise<{ state: PipelineSessionState; decision: PipelineStepFinalizeDecision }> {
  const raw = await invoke<string>("settle_pipeline_execution_round", {
    requestJson: JSON.stringify({
      plan: {
        scene: plan.scene,
        taskDescription: plan.taskDescription,
        expertIds: plan.expertIds,
        requiresDesign: plan.requiresDesign,
      },
      layout,
      sessionState,
      currentTasks: currentTasks.map(({ task, followupIds }) => ({
        id: task.id,
        expertId: task.expertId,
        expertName: task.expertName,
        expertTitle: task.expertTitle,
        dispatchWave: task.dispatchWave ?? null,
        output: task.output || null,
        error: task.error || null,
        followupIds,
      })),
      followupTasks: followupTasks.map(({ task, followupIds }) => ({
        id: task.id,
        expertId: task.expertId,
        expertName: task.expertName,
        expertTitle: task.expertTitle,
        dispatchWave: task.dispatchWave ?? null,
        output: task.output || null,
        error: task.error || null,
        followupIds,
      })),
      hasWorkspaceContext,
      experts: getAvailableExpertInfos(),
    }),
    supervisorApiKey: supervisorApiKey || null,
    model: supervisorModel || null,
  });
  const parsed = JSON.parse(raw) as { state?: PipelineSessionState; decision?: PipelineStepFinalizeDecision };
  return {
    state: parsed.state || sessionState,
    decision: parsed.decision || {
      blackboard: sessionState.blackboard,
      runtimeTransition: {
        state: sessionState.runtimeState,
        repeatedStep: false,
        advancedSteps: 0,
        shouldStop: false,
        breakerMessage: null,
      },
      blockerTask: null,
      supervisorAction: null,
      supervisorReason: null,
      shouldStop: false,
    },
  };
}

async function executePipelineRoundTasks(
  plannedTasks: Array<{ expertId: string; text: string; followupIds: string[] }>,
  previousResults: PipelineCompletedResult[],
  scene: SceneType,
  dispatchWave: number,
  baseTaskInput: string,
  apiKeyResolver: (expertId: string) => string | null,
  modelResolver: (expertId: string) => string,
  projectName: string | undefined,
  projectId: number | undefined,
  promptModuleHints: PromptModuleHintMap | undefined,
  projectWorkspacePath: string | undefined,
  onProgress: (tasks: ExpertTask[]) => void,
  onExpertProgress?: (progress: { expertId: string; phase: string; detail: string }) => void,
  onToolEvent?: (event: ExpertToolEvent) => void,
  onCommandAuthorization?: (request: ExpertCommandAuthorizationRequest) => Promise<boolean>,
  executionMode: "serial" | "parallel" = "parallel",
): Promise<Array<{ task: ExpertTask; followupIds: string[] }>> {
  const runOne = async (plannedTask: { expertId: string; text: string; followupIds: string[] }) => {
    const apiKey = apiKeyResolver(plannedTask.expertId);
    if (!apiKey) {
      const expert = ROUTER_EXPERTS.find((e) => e.id === plannedTask.expertId);
      const errTask: ExpertTask = {
        id: `task-${++taskCounter}`,
        expertId: plannedTask.expertId,
        expertName: expert?.name || plannedTask.expertId,
        expertTitle: expert?.title || "未知",
        status: "error",
        input: baseTaskInput,
        error: `${expert?.name || plannedTask.expertId} 未配置 API 密钥，已跳过`,
        startTime: Date.now(),
        endTime: Date.now(),
        dispatchWave,
      };
      return { task: errTask, followupIds: plannedTask.followupIds };
    }

    const task = await callExpert(
      plannedTask.expertId,
      scene,
      plannedTask.text,
      previousResults,
      apiKey,
      modelResolver(plannedTask.expertId),
      plannedTask.expertId,
      undefined,
      projectName,
      projectId,
      promptModuleHints?.[plannedTask.expertId],
      projectWorkspacePath,
      onExpertProgress,
      onToolEvent,
      onCommandAuthorization
    );
    task.dispatchWave = dispatchWave;
    return { task, followupIds: plannedTask.followupIds };
  };

  const executed = executionMode === "serial"
    ? await (async () => {
      const results: Array<{ task: ExpertTask; followupIds: string[] }> = [];
      for (const plannedTask of plannedTasks) {
        results.push(await runOne(plannedTask));
      }
      return results;
    })()
    : await Promise.all(plannedTasks.map((plannedTask) => runOne(plannedTask)));

  for (const executedTask of executed) {
    activeExpertTasks.push(executedTask.task);
  }
  onProgress([...activeExpertTasks]);
  return executed;
}

async function runCurrentStepFollowupRound(
  sessionState: PipelineSessionState,
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
): Promise<Array<{ task: ExpertTask; followupIds: string[] }>> {
  const followupRound = await getCurrentPipelineFollowupExecutionRound(sessionState);
  if (!followupRound.hasPendingFollowups || followupRound.tasks.length === 0) return [];
  const dispatchWave = sessionState.runtimeState.currentStepIndex + 1;
  return executePipelineRoundTasks(
    followupRound.tasks,
    followupRound.completedResults,
    sessionState.scene as SceneType,
    dispatchWave,
    sessionState.taskDescription,
    apiKeyResolver,
    modelResolver,
    projectName,
    projectId,
    promptModuleHints,
    projectWorkspacePath,
    onProgress,
    onExpertProgress,
    onToolEvent,
    onCommandAuthorization,
    "serial",
  );
}

export async function preparePipelineLaunch(
  plan: DispatchPlan,
  projectName?: string,
  projectWorkspacePath?: string,
  pendingFollowups?: PipelineFollowup[],
): Promise<PipelineLaunchBundle> {
  const raw = await invoke<string>("prepare_pipeline_launch", {
    requestJson: JSON.stringify({
      plan: {
        scene: plan.scene,
        taskDescription: plan.taskDescription,
        expertIds: plan.expertIds,
        requiresDesign: plan.requiresDesign,
      },
      projectName: projectName || null,
      projectPath: projectWorkspacePath || null,
      pendingFollowups: pendingFollowups || [],
      maxStepRetry: 2,
      experts: getAvailableExpertInfos(),
    }),
  });
  const parsed = JSON.parse(raw) as {
    pipelineId?: string;
    layout?: PipelineLayout;
    state?: PipelineSessionState;
    narrative?: string;
    joiningTasks?: Array<{
      expertId: string;
      expertName: string;
      expertTitle: string;
      dispatchWave: number;
      input: string;
      status: string;
    }>;
  };
  return {
    pipelineId: parsed.pipelineId || "",
    layout: parsed.layout || { scene: plan.scene, description: "", steps: [], waves: [] },
    state: parsed.state!,
    narrative: parsed.narrative || "主管已完成任务拆解，专家准备开始执行。",
    joiningTasks: (parsed.joiningTasks || []).map((task, index) => ({
      id: `joining-${task.expertId}-${index}`,
      expertId: task.expertId,
      expertName: task.expertName,
      expertTitle: task.expertTitle,
      status: "pending",
      input: task.input,
      dispatchWave: task.dispatchWave,
    })),
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
    // AI 调用开始
    if (onProgress) onProgress({ expertId, phase: 'analyzing', detail: '分析中...' });

    const startedRuntime = await startExpertTaskRuntime(
      expert,
      scene,
      taskDescription,
      previousResults,
      apiKey,
      model,
      keyId,
      projectName,
      projectId,
      hintModuleIds || [],
      projectWorkspacePath
    );
    if (startedRuntime.blockedReason) {
      displayQuotaBlockMessage(startedRuntime.blockedReason);
      task.error = startedRuntime.blockedReason;
      task.status = "error";
      task.endTime = Date.now();
      await applyRuntimeTokenState(startedRuntime.projectData, startedRuntime.userData);
      onUpdate?.(task);
      return task;
    }

    let runtimeState = startedRuntime.runtimeState || null;
    let runtimeResponse = startedRuntime.response || null;
    await applyRuntimeTokenState(startedRuntime.projectData, startedRuntime.userData);

    while (runtimeResponse) {
      runtimeResponse.progressEvents.forEach((event) => onProgress?.(event));
      runtimeResponse.toolEvents.forEach((event) => onToolEvent?.(event));
      if (!runtimeResponse.pendingAuthorization) {
        break;
      }
      if (!runtimeState) {
        break;
      }
      const authorized = onCommandAuthorization
        ? await onCommandAuthorization(runtimeResponse.pendingAuthorization)
        : false;
      const resumedRuntime = await continueExpertTaskRuntime(runtimeState, authorized);
      runtimeState = resumedRuntime.runtimeState || null;
      runtimeResponse = resumedRuntime.response || null;
      await applyRuntimeTokenState(resumedRuntime.projectData, resumedRuntime.userData);
    }

    const postprocessState = runtimeResponse?.state;
    const reply = postprocessState?.reply || "";
    const usage = postprocessState?.usage || null;
    if (usage) {
      task.tokensUsed = usage.total_tokens;
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
  initialBootstrap: PipelineBootstrapBundle,
  projectName?: string,
  projectId?: number,
  projectWorkspacePath?: string,
  supervisorApiKey?: string,
  supervisorModel?: string,
  onSupervisorDecision?: (action: string, reason?: string) => void,
  onExpertProgress?: (progress: { expertId: string; phase: string; detail: string }) => void,
  onToolEvent?: (event: ExpertToolEvent) => void,
  onCommandAuthorization?: (request: ExpertCommandAuthorizationRequest) => Promise<boolean>
): Promise<{ tasks: ExpertTask[]; pipelineId: string }> {
  const bootstrap = initialBootstrap;
  const layout = bootstrap.layout;
  if (layout.steps.length === 0) return { tasks: [], pipelineId: "" };

  currentPipelineId = bootstrap.pipelineId;
  activeExpertTasks = [];
  activeStepExpertIds = [];
  const allResults: ExpertTask[] = [];

  let sessionState = bootstrap.state;
  while (sessionState.runtimeState.currentStepIndex < layout.steps.length && !sessionState.runtimeState.finished) {
    const roundPlan = await getCurrentPipelineExecutionRound(sessionState);
    if (roundPlan.finished) break;
    const stepIdx = roundPlan.currentStepIndex;
    activeStepExpertIds = [...roundPlan.stepExpertIds];
    const plannedStepTaskMap = new Map(
      roundPlan.tasks.map((task) => [task.expertId, task] as const)
    );
    let currentRoundAppliedTasks: Array<{ task: ExpertTask; followupIds: string[] }> = [];

    if (roundPlan.executionMode === "serial") {
      // 顺序执行
      const expertId = roundPlan.stepExpertIds[0];
      const expertTask = plannedStepTaskMap.get(expertId) || {
        expertId,
        text: plan.taskDescription,
        followupIds: [],
      };
      currentRoundAppliedTasks = await executePipelineRoundTasks(
        [expertTask],
        roundPlan.completedResults,
        plan.scene,
        stepIdx + 1,
        plan.taskDescription,
        apiKeyResolver,
        modelResolver,
        projectName,
        projectId,
        plan.promptModuleHints,
        projectWorkspacePath,
        onProgress,
        onExpertProgress,
        onToolEvent,
        onCommandAuthorization,
        "serial",
      );
      for (const appliedTask of currentRoundAppliedTasks) {
        allResults.push(appliedTask.task);
      }
    } else {
      // 并行执行
      currentRoundAppliedTasks = await executePipelineRoundTasks(
        roundPlan.stepExpertIds.map((expertId) => plannedStepTaskMap.get(expertId) || ({
          expertId,
          text: plan.taskDescription,
          followupIds: [],
        })),
        roundPlan.completedResults,
        plan.scene,
        stepIdx + 1,
        plan.taskDescription,
        apiKeyResolver,
        modelResolver,
        projectName,
        projectId,
        plan.promptModuleHints,
        projectWorkspacePath,
        onProgress,
        onExpertProgress,
        onToolEvent,
        onCommandAuthorization,
        "parallel",
      );
      for (const appliedTask of currentRoundAppliedTasks) {
        allResults.push(appliedTask.task);
      }
    }

    const followupAppliedTasks = await runCurrentStepFollowupRound(
      sessionState,
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
    for (const appliedTask of followupAppliedTasks) {
      allResults.push(appliedTask.task);
    }

    const settledRound = await settlePipelineExecutionRound(
      plan,
      layout,
      sessionState,
      currentRoundAppliedTasks,
      followupAppliedTasks,
      !!(projectWorkspacePath || projectName),
      supervisorApiKey,
      supervisorModel || "deepseek-chat",
    );
    sessionState = settledRound.state;
    const finalizeDecision = settledRound.decision;
    if (finalizeDecision.supervisorAction && onSupervisorDecision) {
      const reasonText = finalizeDecision.supervisorReason || (finalizeDecision.supervisorAction === "continue" ? "继续执行下一步" : "");
      onSupervisorDecision(finalizeDecision.supervisorAction, reasonText);
    }
    if (finalizeDecision.blockerTask?.error) {
      const blockerTask: ExpertTask = {
        id: `task-${++taskCounter}`,
        expertId: finalizeDecision.blockerTask.expertId,
        expertName: finalizeDecision.blockerTask.expertName,
        expertTitle: finalizeDecision.blockerTask.expertTitle,
        status: "error",
        input: plan.taskDescription,
        error: finalizeDecision.blockerTask.error,
        startTime: Date.now(),
        endTime: Date.now(),
        dispatchWave: finalizeDecision.blockerTask.dispatchWave,
      };
      allResults.push(blockerTask);
      activeExpertTasks.push(blockerTask);
      onProgress([...activeExpertTasks]);
    }
    if (finalizeDecision.shouldStop || finalizeDecision.runtimeTransition.shouldStop) {
      break;
    }
  }

  activeStepExpertIds = [];
  return { tasks: allResults, pipelineId: currentPipelineId };
}

// ========== 主管审核 ==========

export async function finalizePipelineDelivery(
  taskDescription: string,
  pendingFollowupMessages: string[],
  expertResults: ExpertTask[],
  actionSources: Array<{ content: string; expertId?: string; expertName?: string; expertTitle?: string }>,
  options: {
    workspacePath?: string | null;
    requireRealMutations: boolean;
  },
  apiKey: string,
  keyId: string = SUPERVISOR_EXPERT_ID,
  model: string = "deepseek-chat"
): Promise<{ reply: string; deliveryAnalysis: { hasExecutableMutation: boolean; workspaceIssues: string[] } }> {
  try {
    const rawReply = await invoke<string>("finalize_pipeline_delivery_runtime", {
      taskDescription,
      pendingFollowupMessages,
      expertResultsJson: JSON.stringify(expertResults),
      actionSourcesJson: JSON.stringify(actionSources.map((source) => ({ content: source.content }))),
      workspacePath: options.workspacePath || null,
      requireRealMutations: options.requireRealMutations,
      supervisorApiKey: apiKey,
      model,
      tokenContextJson: JSON.stringify(getSupervisorTokenRuntimeContext(keyId)),
    });

    let reply = rawReply;
    let blockedReason: string | undefined;
    let projectData: TokenData | undefined;
    let userData: TokenData | undefined;
    let deliveryAnalysis: { hasExecutableMutation: boolean; workspaceIssues: string[] } = {
      hasExecutableMutation: false,
      workspaceIssues: [],
    };
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.reply === "string") {
          reply = parsed.reply;
        }
        if (typeof parsed.blockedReason === "string") blockedReason = parsed.blockedReason;
        if (parsed.projectData && typeof parsed.projectData === "object") projectData = parsed.projectData as TokenData;
        if (parsed.userData && typeof parsed.userData === "object") userData = parsed.userData as TokenData;
        if (parsed.deliveryAnalysis && typeof parsed.deliveryAnalysis === "object") {
          deliveryAnalysis = parsed.deliveryAnalysis as { hasExecutableMutation: boolean; workspaceIssues: string[] };
        }
      }
    } catch {
      // ignore malformed runtime payloads
    }

    await applyRuntimeTokenState(projectData, userData);
    if (blockedReason) {
      displayQuotaBlockMessage(blockedReason);
    }
    return { reply, deliveryAnalysis };
  } catch (e) {
    return {
      reply: `专家团已执行完毕，但主管审核时遇到问题：${e}`,
      deliveryAnalysis: { hasExecutableMutation: false, workspaceIssues: [] },
    };
  }
}

export async function supervisorPrepareQuickAnswer(
  messages: { role: string; content: string }[],
  projectContext: {
    name?: string;
    workspacePath?: string;
    currentSessionLabel?: string;
  },
  apiKey: string,
  keyId: string = SUPERVISOR_EXPERT_ID,
  model: string = "deepseek-chat"
): Promise<string> {
  try {
    const rawReply = await invoke<string>("supervisor_prepare_quick_answer_runtime", {
      chatMessagesJson: JSON.stringify(messages),
      projectName: projectContext.name || null,
      projectPath: projectContext.workspacePath || null,
      currentSessionLabel: projectContext.currentSessionLabel || null,
      supervisorApiKey: apiKey,
      model,
      tokenContextJson: JSON.stringify(getSupervisorTokenRuntimeContext(keyId)),
    });

    let reply = rawReply;
    let blockedReason: string | undefined;
    let projectData: TokenData | undefined;
    let userData: TokenData | undefined;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.reply === "string") {
          reply = parsed.reply;
        }
        if (typeof parsed.blockedReason === "string") blockedReason = parsed.blockedReason;
        if (parsed.projectData && typeof parsed.projectData === "object") projectData = parsed.projectData as TokenData;
        if (parsed.userData && typeof parsed.userData === "object") userData = parsed.userData as TokenData;
      }
    } catch {
      // ignore malformed runtime payloads
    }

    await applyRuntimeTokenState(projectData, userData);
    if (blockedReason) {
      displayQuotaBlockMessage(blockedReason);
    }

    return reply;
  } catch (e) {
    return `抱歉，请求出错：${e}`;
  }
}

// ========== 主管意图分析 ==========

export async function supervisorPrepareAndAnalyzeDispatch(
  userMessage: string,
  conversationHistory: { role: string; content: string }[],
  availableExperts: ExpertInfo[],
  projectContext: {
    name?: string;
    workspacePath?: string;
    projectId?: number;
    currentSessionLabel?: string;
  },
  supervisorApiKey: string,
  keyId: string = SUPERVISOR_EXPERT_ID,
  model: string = "deepseek-chat"
): Promise<DispatchPlan> {
  try {
    const rawReply = await invoke<string>("supervisor_prepare_and_analyze_dispatch_runtime", {
      userMessage,
      chatMessagesJson: JSON.stringify(conversationHistory),
      availableExpertsJson: JSON.stringify(availableExperts),
      projectName: projectContext.name || null,
      projectPath: projectContext.workspacePath || null,
      projectId: projectContext.projectId ?? null,
      currentSessionLabel: projectContext.currentSessionLabel || null,
      supervisorApiKey,
      model,
      tokenContextJson: JSON.stringify(getSupervisorTokenRuntimeContext(keyId)),
    });

    let plan: DispatchPlan = { scene: "quick-answer", taskDescription: userMessage, expertIds: [] };
    let blockedReason: string | undefined;
    let projectData: TokenData | undefined;
    let userData: TokenData | undefined;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (parsed.plan && typeof parsed.plan === "object") {
          plan = parsed.plan as DispatchPlan;
        }
        if (typeof parsed.blockedReason === "string") blockedReason = parsed.blockedReason;
        if (parsed.projectData && typeof parsed.projectData === "object") projectData = parsed.projectData as TokenData;
        if (parsed.userData && typeof parsed.userData === "object") userData = parsed.userData as TokenData;
      }
    } catch {
      // ignore malformed runtime payloads
    }

    await applyRuntimeTokenState(projectData, userData);
    if (blockedReason) {
      displayQuotaBlockMessage(blockedReason);
    }
    return plan;
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
  keyId: string = SUPERVISOR_EXPERT_ID,
  model: string = "deepseek-chat"
): Promise<{
  action: "append" | "replace" | "respond" | "respond-and-append" | "respond-and-replace";
  taskDescription?: string;
  reply?: string;
  targetExpertIds?: string[];
  deliveryMode?: PipelineFollowup["deliveryMode"];
}> {
  const progressSnapshot = await buildPipelineProgressSnapshot(currentPlan.expertIds);
  const progressReport = progressSnapshot.progressReport;
  const currentStepSummary = progressSnapshot.currentStepSummary;
  const remainingExpertSummary = progressSnapshot.remainingExpertSummary;
  const activeTaskSummary = progressSnapshot.activeTaskSummary;

  try {
    const rawReply = await invoke<string>("supervisor_analyze_followup_runtime", {
      requestJson: JSON.stringify({
        followupMessage,
        currentScene: currentPlan.scene,
        currentTaskDescription: currentPlan.taskDescription,
        currentStepSummary,
        remainingExpertSummary,
        progressReport,
        activeTaskSummary,
        allowedExpertIds: currentPlan.expertIds,
      }),
      supervisorApiKey,
      model,
      tokenContextJson: JSON.stringify(getSupervisorTokenRuntimeContext(keyId)),
    });

    let decision: {
      action?: string;
      taskDescription?: string;
      reply?: string;
      targetExpertIds?: string[];
      deliveryMode?: PipelineFollowup["deliveryMode"];
    } = {};
    let blockedReason: string | undefined;
    let projectData: TokenData | undefined;
    let userData: TokenData | undefined;
    try {
      const parsed = JSON.parse(rawReply);
      if (parsed && typeof parsed === "object") {
        if (parsed.decision && typeof parsed.decision === "object") {
          decision = parsed.decision as {
            action?: string;
            taskDescription?: string;
            reply?: string;
            targetExpertIds?: string[];
            deliveryMode?: PipelineFollowup["deliveryMode"];
          };
        }
        if (typeof parsed.blockedReason === "string") blockedReason = parsed.blockedReason;
        if (parsed.projectData && typeof parsed.projectData === "object") projectData = parsed.projectData as TokenData;
        if (parsed.userData && typeof parsed.userData === "object") userData = parsed.userData as TokenData;
      }
    } catch {
      // 不是 JSON 则直接使用原始文本
    }

    await applyRuntimeTokenState(projectData, userData);
    if (blockedReason) {
      displayQuotaBlockMessage(blockedReason);
    }

    const targetExpertIds = Array.isArray(decision.targetExpertIds)
      ? decision.targetExpertIds.filter((item): item is string => typeof item === "string" && currentPlan.expertIds.includes(item))
      : [];
    const deliveryMode = decision.deliveryMode === "current-step" || decision.deliveryMode === "all-remaining"
      ? decision.deliveryMode
      : "next-relevant";

    if (decision.action === "replace") {
      return {
        action: "replace",
        taskDescription: typeof decision.taskDescription === "string" && decision.taskDescription.trim()
          ? decision.taskDescription.trim()
          : currentPlan.taskDescription,
        targetExpertIds,
        deliveryMode,
      };
    }
    if (decision.action === "respond-and-replace") {
      return {
        action: "respond-and-replace",
        reply: typeof decision.reply === "string" ? decision.reply.trim() : undefined,
        taskDescription: typeof decision.taskDescription === "string" && decision.taskDescription.trim()
          ? decision.taskDescription.trim()
          : currentPlan.taskDescription,
        targetExpertIds,
        deliveryMode,
      };
    }
    if (decision.action === "respond") {
      return {
        action: "respond",
        reply: typeof decision.reply === "string" && decision.reply.trim()
          ? decision.reply.trim()
          : `${progressReport}\n\n如果你想调整目标，我也可以继续转达给后续专家。`,
      };
    }
    if (decision.action === "respond-and-append") {
      return {
        action: "respond-and-append",
        reply: typeof decision.reply === "string" && decision.reply.trim()
          ? decision.reply.trim()
          : `${progressReport}\n\n我也会把你的新增要求继续转达给后续专家。`,
        taskDescription: typeof decision.taskDescription === "string" && decision.taskDescription.trim()
          ? decision.taskDescription.trim()
          : followupMessage,
        targetExpertIds,
        deliveryMode,
      };
    }
    return {
      action: "append",
      taskDescription: typeof decision.taskDescription === "string" && decision.taskDescription.trim()
        ? decision.taskDescription.trim()
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
export async function buildProgressReport(): Promise<string> {
  const snapshot = await buildPipelineProgressSnapshot([]);
  return snapshot.progressReport;
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
