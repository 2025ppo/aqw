import { invoke } from "@tauri-apps/api/core";
import { tokenData, type TokenUsageRecord, type Expert } from "./main";
import {
  QUOTA_EXEMPT_IDS,
  buildDispatchCandidateExperts,
  buildExpertSystemPrompt,
  buildTaskScopedExpertPrompt,
  evaluateExpertActivation,
  findExpertEntry,
  getDisciplineDisplayName,
  getDisciplineExperts,
} from "./expert-catalog";

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
  | "disciplinary-analysis"
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
  code?: string;
  categoryId?: string;
  categoryLabel?: string;
  toolProfile?: string;
  systemRole?: boolean;
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
  const catalogEntry = findExpertEntry(expert.id);
  const scopedPrompt = catalogEntry
    ? buildTaskScopedExpertPrompt(catalogEntry, taskDescription)
    : expert.systemPrompt;
  const raw = await invoke<string>("start_expert_task_runtime", {
    requestJson: JSON.stringify({
      sessionRequest: {
        expertId: expert.id,
        expertName: expert.name,
        expertTitle: expert.title,
        basePrompt: scopedPrompt,
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

const ROUTER_EXPERTS: RouterExpert[] = getDisciplineExperts().map((entry) => ({
  id: entry.id,
  name: `${entry.code} ${entry.name}`,
  title: entry.title,
  description: `${entry.categoryLabel} · ${entry.description}`,
  systemPrompt: buildExpertSystemPrompt(entry),
}));

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
    const shortlistedExperts = buildDispatchCandidateExperts(userMessage).map((entry) => {
      const activation = evaluateExpertActivation(entry, userMessage);
      return {
        id: entry.id,
        name: `${entry.code} ${entry.name}`,
        title: entry.title,
        description: `${entry.categoryLabel} · ${entry.description}`,
        code: entry.code,
        categoryId: entry.categoryId,
        categoryLabel: entry.categoryLabel,
        toolProfile: entry.toolProfile,
        systemRole: entry.systemRole,
        activationScore: activation.score,
        activationLevel: activation.level,
        activationProbability: activation.probability,
      };
    });
    const expertPayload = shortlistedExperts.length > 0 ? shortlistedExperts : availableExperts;
    const rawReply = await invoke<string>("supervisor_prepare_and_analyze_dispatch_runtime", {
      userMessage,
      chatMessagesJson: JSON.stringify(conversationHistory),
      availableExpertsJson: JSON.stringify(expertPayload),
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
  return getDisciplineExperts().map((entry) => ({
    id: entry.id,
    name: entry.name,
    title: [entry.code, getDisciplineDisplayName(entry.id), entry.title].filter(Boolean).join(" · "),
    description: entry.description,
    code: entry.code,
    categoryId: entry.categoryId,
    categoryLabel: entry.categoryLabel,
    toolProfile: entry.toolProfile,
    systemRole: entry.systemRole,
  }));
}

/** 获取指定专家信息 */
export function getRouterExpert(id: string): RouterExpert | undefined {
  return ROUTER_EXPERTS.find((e) => e.id === id);
}
