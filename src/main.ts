import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sidebar } from "./sidebar";
import { initCanvas, getCanvas, FileCanvas, DocBlock, CanvasNode, CanvasEdge } from "./canvas";
import { DraftCanvas, DraftToolbox, DraftSidebar, DraftTool } from "./draft";
import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import {
  supervisorPrepareAndAnalyzeDispatch,
  executePipeline,
  preparePipelineLaunch,
  finalizePipelineDelivery,
  supervisorPrepareQuickAnswer,
  resolveExpertApiKey,
  buildProgressReport,
  analyzeFollowupIntent,
  getAvailableExpertInfos,
  loadTokenData,
  loadUserTokenData,
  setExpertsRef,
  buildTokenDashboardSnapshot,
  type DispatchPlan,
  type ExpertCommandAuthorizationRequest,
  type ExpertToolEvent,
  type ExpertTask,
  type PipelineFollowup,
  type TimeRange,
} from "./expert-router";
import {
  CORE_EXPERT_IDS,
  getDisciplineDisplayName,
  getDisciplineExperts,
  findExpertEntry,
  isImplementationDisciplineExpert,
  QUOTA_EXEMPT_IDS,
  getExpertSpecializationSummary,
  getSystemExperts,
} from "./expert-catalog";
import {
  saveUserIntentMemory,
  searchMemory,
  deleteMemory,
  getMemoryStats,
  runMemoryLifecycle,
} from "./memory-store";
import { bootstrapPromptModuleHistoryFromSessions } from "./prompt-module-history";
import "./video-canvas";
import "./data-analysis";

// ========== 树节点类型（对应 Rust TreeEntry） ==========
interface TreeEntry {
  name: string;
  path: string;
  type: "folder" | "file";
  children: TreeEntry[] | null;
  size?: number | null;
  modifiedAtMs?: number | null;
}

interface ChangeSet {
  operation: "create_folder" | "create_file" | "write_file" | "edit_file" | "delete";
  path: string;
  searchText?: string;
  replaceText?: string;
  content?: string;
  rationale?: string;
  risk?: string;
  allowOverwrite?: boolean;
}

interface LogicCanvasPayloadNode {
  id: string;
  label: string;
  kind: string;
  detail: string;
  file_path?: string | null;
  line_start?: number | null;
  line_end?: number | null;
  weight: number;
}

interface LogicCanvasPayloadEdge {
  from: string;
  to: string;
  relation_type: string;
  weight: number;
}

interface ProjectLogicCanvasPayload {
  updated_at: string;
  nodes: LogicCanvasPayloadNode[];
  edges: LogicCanvasPayloadEdge[];
}

interface FileLogicCanvasPayload {
  file_path: string;
  language: string;
  updated_at: string;
  nodes: LogicCanvasPayloadNode[];
  edges: LogicCanvasPayloadEdge[];
}

// ========== 词元跟踪数据类型 ==========
export interface TokenUsageRecord {
  id: string;
  expertId: string;
  expertName: string;
  expertTitle?: string;
  model: string;
  keyId: string;
  timestamp: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TokenAllocation {
  expertId: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  yearlyLimit: number | null;
}

export interface TokenData {
  records: TokenUsageRecord[];
  allocations: TokenAllocation[];
  lastResetDaily: string;
  lastResetMonthly: string;
  lastResetYearly: string;
}

export let tokenData: TokenData = {
  records: [],
  allocations: [],
  lastResetDaily: new Date().toISOString().split("T")[0],
  lastResetMonthly: new Date().toISOString().slice(0, 7),
  lastResetYearly: new Date().getFullYear().toString(),
};

// 引用 tokenData 以避免 TS6133 未使用警告（词元面板后续将使用）
void tokenData;

// ========== 日志工具 ==========
function log(level: string, msg: string) {
  const line = `[${level}] ${msg}`;
  console.log(line);
}

log("INFO", "main.ts loaded");

// ========== 窗口控制按钮 ==========
function tryGetAppWindow() {
  try {
    const tauriWindow = getCurrentWindow();
    log("INFO", "appWindow acquired");
    return tauriWindow;
  } catch (error) {
    log("WARN", `appWindow unavailable in current runtime: ${error}`);
    return null;
  }
}

const appWindow = tryGetAppWindow();

document
  .getElementById("header-minimize")
  ?.addEventListener("click", () => {
    log("INFO", "minimize clicked");
    appWindow?.minimize();
  });

document
  .getElementById("header-maximize")
  ?.addEventListener("click", () => {
    log("INFO", "maximize clicked");
    appWindow?.toggleMaximize();
  });

document
  .getElementById("header-close")
  ?.addEventListener("click", () => {
    log("INFO", "close clicked");
    appWindow?.close();
  });

// ========== 手动实现拖拽（替代 data-tauri-drag-region） ==========
document.addEventListener("DOMContentLoaded", () => {
  const dragRegion = document.getElementById("header-drag-region");
  if (dragRegion) {
    dragRegion.addEventListener("mousedown", async (e) => {
      if (e.button === 0) {
        log("INFO", "drag started");
        await appWindow?.startDragging();
      }
    });
  }
});

// ========== 菜单绑定 ==========
window.addEventListener("DOMContentLoaded", () => {
  log("INFO", "DOMContentLoaded fired");

  // 下拉菜单交互：点击触发按钮切换显隐
  document.querySelectorAll(".menu-dropdown").forEach((dropdown, idx) => {
    const trigger = dropdown.querySelector(".menu-trigger");
    log("INFO", `menu-dropdown #${idx} trigger found: ${!!trigger}`);
    trigger?.addEventListener("click", (e) => {
      log("INFO", `menu trigger #${idx} clicked`);
      e.stopPropagation();
      // 先关闭其他菜单
      document.querySelectorAll(".menu-dropdown.active").forEach((d) => {
        if (d !== dropdown) d.classList.remove("active");
      });
      dropdown.classList.toggle("active");
      log("INFO", `menu-dropdown #${idx} active=${dropdown.classList.contains("active")}`);
    });
  });

  // 点击页面其他地方关闭菜单
  document.addEventListener("click", () => {
    document.querySelectorAll(".menu-dropdown.active").forEach((d) => {
      d.classList.remove("active");
    });
  });

  // 文件菜单 - 打开/新建项目
  const menuNewProject = document.getElementById("menu-new-project");
  log("INFO", `menu-new-project found: ${!!menuNewProject}`);
  menuNewProject?.addEventListener("click", (e) => {
    log("INFO", "menu-new-project CLICKED!");
    e.stopPropagation();
    sidebar.showProjectDialog();
  });

  // 不再默认创建项目，用户需要手动创建
  log("INFO", "no initial project created, waiting for user action");

  // 初始化无限画布
  initCanvas();
  log("INFO", "canvas initialized");

  // 拖拽文件夹打开项目
  appWindow?.onDragDropEvent(async (event) => {
    if (event.payload.type === "drop") {
      const paths = event.payload.paths;
      log("INFO", `拖拽释放: ${paths.length} 个路径`);
      for (const p of paths) {
        // 检查是否为文件夹
        try {
          const isDir = await invoke<boolean>("open_project_is_dir", { path: p });
          if (isDir) {
            log("INFO", `拖拽打开项目: ${p}`);
            await sidebar.openProjectFromPath(p);
          }
        } catch {
          // 忽略无效路径
        }
      }
    }
  });
  log("INFO", "drag-drop listener registered");

});

// ========== 主题切换 ==========
let isDarkMode = false;

function applyTheme(dark: boolean) {
  isDarkMode = dark;
  log("INFO", `theme toggled: isDarkMode=${isDarkMode}`);

  const root = document.documentElement;
  root.dataset.theme = isDarkMode ? "dark" : "light";

  // 同步设置页面开关状态
  const themeToggle = document.getElementById("settings-theme-toggle") as HTMLInputElement;
  if (themeToggle && themeToggle.checked !== dark) {
    themeToggle.checked = dark;
  }
}

document.getElementById("header-theme")?.addEventListener("click", () => {
  applyTheme(!isDarkMode);
});

applyTheme(false);

// ========== 设置页面 ==========
const settingsPage = document.getElementById("settings-page")!;
const settingsBackBtn = document.getElementById("settings-back-btn")!;
const workspaceSettingsPanel = document.getElementById("workspace-settings-panel")!;
const workspaceSettingsBackBtn = document.getElementById("workspace-settings-back-btn")!;

// 需要在设置页面打开时隐藏的 UI 元素
const normalUIElements = [
  "canvas-container",
  "canvas-directory-stack",
  "draft-canvas",
  "draft-toolbox",
  "draft-sidebar",
  "floating-actions",
  "chat-card",
  "preview-chat-card",
  "file-preview-card",
  "file-browser-card",
  "wiki-panel",
  "repo-browser",
  "git-panel",
  "git-browser",
  "token-panel",
  "token-browser",
  "image-browser",
  "data-browser",
  "workspace-settings-panel",
];

// 保存打开设置前的 display 状态，以便关闭时正确恢复
const savedDisplayStates = new Map<string, string>();

async function openSettings() {
  workspaceSettingsPanel.classList.remove("active");
  settingsPage.classList.add("active");
  normalUIElements.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      savedDisplayStates.set(id, el.style.display);
      el.style.display = "none";
    }
  });

  // 同步主题开关
  const themeToggle = document.getElementById("settings-theme-toggle") as HTMLInputElement;
  if (themeToggle) themeToggle.checked = isDarkMode;

  log("INFO", "settings opened");
}

function closeSettings() {
  settingsPage.classList.remove("active");
  // 恢复原始显示状态 - 如果之前是空字符串则恢复为默认显示
  normalUIElements.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      const saved = savedDisplayStates.get(id);
      // 如果保存的状态是空字符串或未设置，恢复为默认的 block/flex
      if (!saved || saved === "none") {
        el.style.display = "";
      } else {
        el.style.display = saved;
      }
    }
  });
  savedDisplayStates.clear();

  log("INFO", "settings closed");
}

// 设置按钮 -> 打开设置
document.getElementById("header-settings")?.addEventListener("click", (e) => {
  e.stopPropagation();
  openSettings();
});

// 返回按钮 -> 关闭设置
settingsBackBtn.addEventListener("click", closeSettings);

// 侧边栏导航切换
settingsPage.querySelectorAll(".settings-nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    const section = (item as HTMLElement).dataset.section;
    if (!section) return;

    // 切换导航高亮
    settingsPage.querySelectorAll(".settings-nav-item").forEach((i) => i.classList.remove("active"));
    item.classList.add("active");

    // 切换内容区
    settingsPage.querySelectorAll(".settings-section").forEach((s) => s.classList.remove("active"));
    const target = document.getElementById(`settings-${section}`);
    if (target) target.classList.add("active");
  });
});

// 设置页面的主题开关
document.getElementById("settings-theme-toggle")?.addEventListener("change", (e) => {
  const checked = (e.target as HTMLInputElement).checked;
  applyTheme(checked);
});

function activateWorkspaceSettingsSection(section: "experts" | "keys") {
  workspaceSettingsPanel.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.workspaceSection === section);
  });
  workspaceSettingsPanel.querySelectorAll<HTMLElement>(".settings-section").forEach((item) => {
    item.classList.toggle("active", item.id === `settings-${section}`);
  });
}

workspaceSettingsPanel.querySelectorAll<HTMLElement>(".settings-nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    const section = item.dataset.workspaceSection as "experts" | "keys" | undefined;
    if (!section) return;
    activateWorkspaceSettingsSection(section);
  });
});

// ========== 密钥池配置 ==========
type Modality = "text" | "image" | "video" | "audio";

interface PresetProvider {
  id: string;
  name: string;
  models: string[];
}

interface PresetKey {
  id: string;
  providerId: string;
  model: string;
  apiKey: string;
  label: string;
  inputModalities: Modality[];
  outputModalities: Modality[];
}

interface RelayKey {
  id: string;
  name: string;
  model: string;
  endpoint: string;
  apiKey: string;
  label: string;
  inputModalities: Modality[];
  outputModalities: Modality[];
}

interface CustomCodeKey {
  id: string;
  name: string;
  code: string;
  label: string;
}

type KeyPoolItem =
  | { type: "preset"; data: PresetKey }
  | { type: "relay"; data: RelayKey }
  | { type: "custom"; data: CustomCodeKey };

const PRESET_PROVIDERS: PresetProvider[] = [
  { id: "deepseek", name: "DeepSeek", models: ["deepseek-v4-flash", "deepseek-chat", "deepseek-coder"] },
  { id: "openai", name: "OpenAI", models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"] },
  { id: "anthropic", name: "Anthropic", models: ["claude-3-5-sonnet", "claude-3-opus", "claude-3-haiku"] },
  { id: "aliyun", name: "阿里云", models: ["qwen-max", "qwen-plus", "qwen-turbo"] },
  { id: "tencent", name: "腾讯云", models: ["hunyuan-pro", "hunyuan-standard", "hunyuan-lite"] },
];

/** 预设模型的默认模态能力配置 */
const MODEL_DEFAULT_MODALITIES: Record<string, { input: Modality[], output: Modality[] }> = {
  "deepseek-v4-flash": { input: ["text"], output: ["text"] },
  "deepseek-chat": { input: ["text"], output: ["text"] },
  "deepseek-coder": { input: ["text"], output: ["text"] },
  "gpt-4o": { input: ["text", "image"], output: ["text", "image"] },
  "gpt-4o-mini": { input: ["text", "image"], output: ["text"] },
  "gpt-4-turbo": { input: ["text", "image"], output: ["text"] },
  "gpt-3.5-turbo": { input: ["text"], output: ["text"] },
  "claude-3-5-sonnet": { input: ["text", "image"], output: ["text"] },
  "claude-3-opus": { input: ["text", "image"], output: ["text"] },
  "claude-3-haiku": { input: ["text", "image"], output: ["text"] },
  "qwen-max": { input: ["text"], output: ["text"] },
  "qwen-plus": { input: ["text"], output: ["text"] },
  "qwen-turbo": { input: ["text"], output: ["text"] },
  "hunyuan-pro": { input: ["text"], output: ["text"] },
  "hunyuan-standard": { input: ["text"], output: ["text"] },
  "hunyuan-lite": { input: ["text"], output: ["text"] },
};

let keyPoolItems: KeyPoolItem[] = [];
let keyPoolCounter = 1;

// 获取当前可用的 API 密钥（优先预设密钥，其次中转密钥）
function getActiveApiKey(): string | null {
  const presetKey = keyPoolItems.find((i) => i.type === "preset") as { type: "preset"; data: PresetKey } | undefined;
  if (presetKey) return presetKey.data.apiKey;
  const relayKey = keyPoolItems.find((i) => i.type === "relay") as { type: "relay"; data: RelayKey } | undefined;
  if (relayKey) return relayKey.data.apiKey;
  return null;
}

/** 根据专家 ID 解析其绑定的 API 密钥（封装 resolveExpertApiKey） */
function getExpertApiKey(expertId: string): string | null {
  return resolveExpertApiKey(expertId, experts, keyPoolItems as any);
}

/** 根据专家 ID 解析其绑定的密钥记录 ID */
function getExpertKeyId(expertId: string): string | null {
  const expert = experts.find((item) => item.id === expertId);
  return expert?.keyId || null;
}

/** 查询密钥的多模态能力 */
function getKeyModalities(keyId: string): { input: Modality[], output: Modality[] } {
  const item = keyPoolItems.find(k => {
    if (k.type === "preset") return k.data.id === keyId;
    if (k.type === "relay") return k.data.id === keyId;
    if (k.type === "custom") return k.data.id === keyId;
    return false;
  });
  if (!item) return { input: ["text"], output: ["text"] };
  if (item.type === "preset") return { input: item.data.inputModalities || ["text"], output: item.data.outputModalities || ["text"] };
  if (item.type === "relay") return { input: item.data.inputModalities || ["text"], output: item.data.outputModalities || ["text"] };
  return { input: ["text"], output: ["text"] };
}

/** 按模态能力筛选密钥 */
export function findKeysByModality(required: { input?: Modality[], output?: Modality[] }): typeof keyPoolItems {
  return keyPoolItems.filter(item => {
    const modalities = getKeyModalities(
      item.type === "preset" ? item.data.id : item.type === "relay" ? item.data.id : item.data.id
    );
    if (required.input && !required.input.every(m => modalities.input.includes(m))) return false;
    if (required.output && !required.output.every(m => modalities.output.includes(m))) return false;
    return true;
  });
}

/** 根据专家 ID 解析其绑定的模型名称 */
function getExpertModel(expertId: string): string {
  return resolveExpertModel(expertId, experts, keyPoolItems as any);
}

/** 从密钥池中解析模型名称 */
function resolveExpertModel(
  expertId: string,
  expertsList: Expert[],
  keyPool: KeyPoolItem[]
): string {
  const expert = expertsList.find((e) => e.id === expertId);
  if (!expert?.keyId) return "deepseek-chat";
  const item = keyPool.find((k) => k.data.id === expert.keyId);
  if (item?.type === "preset" || item?.type === "relay") {
    return (item.data as PresetKey | RelayKey).model || "deepseek-chat";
  }
  return "deepseek-chat";
}

/** 获取当前激活密钥池项的模型名称（供 Wiki/画布等非专家调用使用） */
function getActiveKeyModel(): string {
  const presetKey = keyPoolItems.find((i) => i.type === "preset") as { type: "preset"; data: PresetKey } | undefined;
  if (presetKey) return presetKey.data.model || "deepseek-chat";
  const relayKey = keyPoolItems.find((i) => i.type === "relay") as { type: "relay"; data: RelayKey } | undefined;
  if (relayKey) return relayKey.data.model || "deepseek-chat";
  return "deepseek-chat";
}

// 错误提示 Toast
function showError(msg: string) {
  const toast = document.getElementById("error-toast")!;
  const msgEl = document.getElementById("error-toast-msg")!;
  msgEl.textContent = msg;
  toast.classList.add("show");
  clearTimeout((toast as any).__timeout);
  (toast as any).__timeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

window.addEventListener("show-error", (event) => {
  const message = (event as CustomEvent<{ message?: string }>).detail?.message;
  if (message) {
    showError(message);
  }
});

async function resolveActiveProjectForView(viewLabel: string) {
  try {
    await sidebar.ready;
  } catch {
    // 继续走兜底恢复逻辑
  }

  const activeProject = sidebar.getActiveChat();
  if (activeProject) {
    return activeProject;
  }

  const fallbackProject = sidebar.getFirstChat();
  if (fallbackProject) {
    sidebar.setActiveChat(fallbackProject.id);
    log("INFO", `${viewLabel}: 已自动恢复活跃项目 ${fallbackProject.name}`);
    return fallbackProject;
  }

  log("WARN", `${viewLabel}: 没有可用项目`);
  showError(`请先打开或创建一个项目，再进入${viewLabel}`);
  sidebar.showProjectDialog();
  return null;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function detectAttachmentKind(file: File): AttachmentKind {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || /\.(md|txt|json|csv|ts|tsx|js|jsx|css|html|xml|yml|yaml|toml|ini|py|rs|java|c|cpp|h|hpp|sh)$/i.test(name)) {
    return "text";
  }
  return "file";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

function getProviderEndpoint(providerId: string): string {
  switch (providerId) {
    case "deepseek":
      return "https://api.deepseek.com/v1/chat/completions";
    case "openai":
      return "https://api.openai.com/v1/chat/completions";
    case "anthropic":
      return "https://api.anthropic.com/v1/messages";
    case "aliyun":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
    case "tencent":
      return "https://api.hunyuan.cloud.tencent.com/v1/chat/completions";
    default:
      return "https://api.deepseek.com/v1/chat/completions";
  }
}

function resolveKeyTransport(keyId: string | null): { apiKey: string; model: string; endpoint: string; inputModalities: Modality[]; outputModalities: Modality[] } | null {
  if (!keyId) return null;
  const item = keyPoolItems.find((entry) => entry.data.id === keyId);
  if (!item) return null;
  if (item.type === "preset") {
    return {
      apiKey: item.data.apiKey,
      model: item.data.model,
      endpoint: getProviderEndpoint(item.data.providerId),
      inputModalities: item.data.inputModalities || ["text"],
      outputModalities: item.data.outputModalities || ["text"],
    };
  }
  if (item.type === "relay") {
    return {
      apiKey: item.data.apiKey,
      model: item.data.model,
      endpoint: item.data.endpoint,
      inputModalities: item.data.inputModalities || ["text"],
      outputModalities: item.data.outputModalities || ["text"],
    };
  }
  return null;
}

function buildUserMessagePayloadText(text: string, mode: ChatRunMode, attachments: StoredAttachmentMeta[]): string {
  if (mode === "normal" && attachments.length === 0) return text;
  const payload: UserMessageMetaPayload = {
    version: 1,
    text,
    mode,
    attachments,
  };
  return `${USER_MESSAGE_META_PREFIX}${JSON.stringify(payload)}`;
}

function parseUserMessagePayload(content: string): UserMessageMetaPayload | null {
  if (!content.startsWith(USER_MESSAGE_META_PREFIX)) return null;
  try {
    const raw = JSON.parse(content.slice(USER_MESSAGE_META_PREFIX.length)) as Partial<UserMessageMetaPayload>;
    return {
      version: 1,
      text: typeof raw.text === "string" ? raw.text : "",
      mode: raw.mode === "plan" || raw.mode === "goal" ? raw.mode : "normal",
      attachments: Array.isArray(raw.attachments)
        ? raw.attachments.filter((item): item is StoredAttachmentMeta =>
          !!item
          && typeof item.name === "string"
          && typeof item.mimeType === "string"
          && typeof item.size === "number"
          && typeof item.kind === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function formatUserMessageForSupervisor(content: string): string {
  const payload = parseUserMessagePayload(content);
  if (!payload) return content;
  const lines = [payload.text.trim() || "请结合我附带的文件处理。"];
  if (payload.mode === "plan") {
    lines.push("", "[执行方式] 按计划进行");
  } else if (payload.mode === "goal") {
    lines.push("", "[执行方式] 按目标进行");
  }
  if (payload.attachments.length > 0) {
    lines.push("", "[已附带文件]");
    payload.attachments.forEach((item) => {
      lines.push(`- ${item.name}（${item.kind}，${formatFileSize(item.size)}）`);
    });
  }
  return lines.join("\n").trim();
}

function applyRunModeToPrompt(text: string, mode: ChatRunMode): string {
  const normalized = text.trim() || "请结合我附带的文件处理。";
  if (mode === "plan") {
    return `请先给出一份简洁、可执行的计划，再按计划逐步完成任务；执行过程中如果需要调整计划，请明确说明。用户原始请求：${normalized}`;
  }
  if (mode === "goal") {
    return `以下内容是当前目标。请自主拆解任务、持续推进，并以是否达成目标作为停止条件；除非明确阻塞，否则不要停留在建议层。目标：${normalized}`;
  }
  return normalized;
}

// 生成自动编号标签
function generateLabel(prefix: string): string {
  const num = keyPoolCounter++;
  return `${prefix}-${String(num).padStart(4, "0")}`;
}

async function loadKeyPool() {
  try {
    const json = await invoke<string>("load_key_pool");
    const parsed = JSON.parse(json || "[]");
    const raw = parsed.items || parsed;
    keyPoolItems = Array.isArray(raw) ? raw.filter((i: any) => i && i.type && i.data).map((i: any) => {
      // 兼容旧数据：补充默认模态能力
      if ((i.type === "preset" || i.type === "relay") && i.data) {
        if (!i.data.inputModalities) i.data.inputModalities = ["text"];
        if (!i.data.outputModalities) i.data.outputModalities = ["text"];
      }
      return i;
    }) : [];
    keyPoolCounter = parsed.counter || (keyPoolItems.length > 0 ? keyPoolItems.length + 1 : 1);
  } catch {
    keyPoolItems = [];
    keyPoolCounter = 1;
  }
  renderKeyPool();
}

async function saveKeyPool() {
  await invoke("save_key_pool", {
    items: JSON.stringify({ items: keyPoolItems, counter: keyPoolCounter }),
  });
}

function renderKeyPool() {
  const providerSelect = document.getElementById("keypool-preset-provider") as HTMLSelectElement;
  const modelSelect = document.getElementById("keypool-preset-model") as HTMLSelectElement;
  const presetList = document.getElementById("keypool-preset-list")!;
  const relayList = document.getElementById("keypool-relay-list")!;
  const customList = document.getElementById("keypool-custom-list")!;

  // 更新模型下拉（根据厂商）
  if (providerSelect && modelSelect) {
    const provider = PRESET_PROVIDERS.find((p) => p.id === providerSelect.value);
    modelSelect.innerHTML = (provider?.models || [])
      .map((m) => `<option value="${m}">${m}</option>`)
      .join("");

    // 根据选中模型自动同步默认模态能力复选框
    const selectedModel = modelSelect.value;
    const defaults = MODEL_DEFAULT_MODALITIES[selectedModel] || { input: ["text"], output: ["text"] };
    const presetConfig = document.getElementById("preset-modality-config");
    if (presetConfig) {
      presetConfig.querySelectorAll<HTMLInputElement>("input[name='input-modality']").forEach(cb => {
        cb.checked = defaults.input.includes(cb.value as Modality);
      });
      presetConfig.querySelectorAll<HTMLInputElement>("input[name='output-modality']").forEach(cb => {
        cb.checked = defaults.output.includes(cb.value as Modality);
      });
    }
  }

  /** 构建单个密钥项的 HTML（预设/中转/自定义共用） */
  const keypoolItemHtml = (id: string, label: string, metaHtml: string, hasModality: boolean) => `
    <div class="keypool-item" data-id="${id}">
      <div class="keypool-item-info">
        <span class="keypool-item-name">${label}</span>
        <span class="keypool-item-meta">${metaHtml}</span>
      </div>
      <div class="keypool-item-actions">
        ${hasModality ? `<button class="keypool-item-edit" data-id="${id}" type="button" title="编辑模态能力">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>` : ""}
        <button class="keypool-item-delete" data-id="${id}" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>`;

  // 渲染预设列表
  const presets = keyPoolItems.filter((i): i is { type: "preset"; data: PresetKey } => i.type === "preset");
  presetList.innerHTML = presets
    .map((item) => {
      const provider = PRESET_PROVIDERS.find((p) => p.id === item.data.providerId);
      return keypoolItemHtml(
        item.data.id,
        item.data.label,
        `${provider?.name || item.data.providerId} / ${item.data.model} &middot; ${item.data.apiKey.slice(0, 8)}****`,
        true,
      );
    })
    .join("");

  // 渲染中转列表
  const relays = keyPoolItems.filter((i): i is { type: "relay"; data: RelayKey } => i.type === "relay");
  relayList.innerHTML = relays
    .map((item) => keypoolItemHtml(
      item.data.id,
      item.data.label,
      `${item.data.name} / ${item.data.model} &middot; ${item.data.endpoint}`,
      true,
    ))
    .join("");

  // 渲染自定义代码列表
  const customs = keyPoolItems.filter((i): i is { type: "custom"; data: CustomCodeKey } => i.type === "custom");
  customList.innerHTML = customs
    .map((item) => keypoolItemHtml(
      item.data.id,
      item.data.label,
      `${item.data.name} &middot; 自定义代码接口`,
      false,
    ))
    .join("");

  // 绑定删除事件
  document.querySelectorAll(".keypool-item-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.id;
      if (id) {
        keyPoolItems = keyPoolItems.filter((i) => i.data.id !== id);
        // 清理专家团中绑定到此密钥的引用
        let expertChanged = false;
        experts.forEach((ex) => {
          if (ex.keyId === id) { ex.keyId = null; expertChanged = true; }
        });
        if (expertChanged) await saveExperts();
        await saveKeyPool();
        renderKeyPool();
        renderExperts();
      }
    });
  });

  // 绑定编辑事件（模态能力编辑）
  document.querySelectorAll(".keypool-item-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.id;
      if (id) showModalityEditor(id);
    });
  });
}

// 模态能力编辑器
function showModalityEditor(keyId: string) {
  const item = keyPoolItems.find((i) => i.data.id === keyId);
  if (!item || item.type === "custom") return;

  const data = item.data as PresetKey | RelayKey;
  const modal = document.getElementById("modality-editor-modal")!;
  const inputCbs = modal.querySelectorAll<HTMLInputElement>("input[name='edit-input-modality']");
  const outputCbs = modal.querySelectorAll<HTMLInputElement>("input[name='edit-output-modality']");

  // 填充当前值
  inputCbs.forEach((cb) => { cb.checked = data.inputModalities.includes(cb.value as Modality); });
  outputCbs.forEach((cb) => { cb.checked = data.outputModalities.includes(cb.value as Modality); });

  // 绑定保存
  const saveBtn = modal.querySelector("#modality-editor-save")!;
  const cancelBtn = modal.querySelector("#modality-editor-cancel")!;

  const handler = async () => {
    const newInput = Array.from(inputCbs).filter((cb) => cb.checked).map((cb) => cb.value as Modality);
    const newOutput = Array.from(outputCbs).filter((cb) => cb.checked).map((cb) => cb.value as Modality);
    if (item.type === "preset") {
      (item.data as PresetKey).inputModalities = newInput.length > 0 ? newInput : ["text"];
      (item.data as PresetKey).outputModalities = newOutput.length > 0 ? newOutput : ["text"];
    } else {
      (item.data as RelayKey).inputModalities = newInput.length > 0 ? newInput : ["text"];
      (item.data as RelayKey).outputModalities = newOutput.length > 0 ? newOutput : ["text"];
    }
    await saveKeyPool();
    modal.classList.remove("active");
    saveBtn.removeEventListener("click", handler);
    cancelBtn.removeEventListener("click", closeHandler);
    renderKeyPool();
  };

  const closeHandler = () => {
    modal.classList.remove("active");
    saveBtn.removeEventListener("click", handler);
    cancelBtn.removeEventListener("click", closeHandler);
  };

  saveBtn.addEventListener("click", handler);
  cancelBtn.addEventListener("click", closeHandler);
  modal.classList.add("active");
}

// 密钥池页签切换
document.querySelectorAll("[data-keypool-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = (tab as HTMLElement).dataset.keypoolTab;
    if (!target) return;

    document.querySelectorAll("[data-keypool-tab]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    document.querySelectorAll("[data-keypool-panel]").forEach((p) => p.classList.remove("active"));
    const panel = document.querySelector(`[data-keypool-panel="${target}"]`);
    if (panel) panel.classList.add("active");
  });
});

// 厂商选择变化时更新模型列表
document.getElementById("keypool-preset-provider")?.addEventListener("change", renderKeyPool);
// 模型选择变化时同步模态能力复选框
document.getElementById("keypool-preset-model")?.addEventListener("change", renderKeyPool);

// 设置按钮 loading 状态
function setButtonLoading(btn: HTMLElement, isLoading: boolean) {
  if (isLoading) {
    btn.textContent = "验证中...";
    (btn as HTMLButtonElement).disabled = true;
  } else {
    btn.textContent = btn.id === "keypool-custom-add" ? "添加" : "认证并添加";
    (btn as HTMLButtonElement).disabled = false;
  }
}

// 添加预设厂商密钥（需认证）
document.getElementById("keypool-preset-add")?.addEventListener("click", async () => {
  const btn = document.getElementById("keypool-preset-add")!;
  const provider = (document.getElementById("keypool-preset-provider") as HTMLSelectElement).value;
  const model = (document.getElementById("keypool-preset-model") as HTMLSelectElement).value;
  const key = (document.getElementById("keypool-preset-key") as HTMLInputElement).value.trim();
  if (!key) { showError("请输入 API 密钥"); return; }

  // 读取模态能力配置
  let inputModalities = Array.from(document.querySelectorAll<HTMLInputElement>("#preset-modality-config input[name='input-modality']:checked")).map(el => el.value as Modality);
  let outputModalities = Array.from(document.querySelectorAll<HTMLInputElement>("#preset-modality-config input[name='output-modality']:checked")).map(el => el.value as Modality);

  // 合并去重要测试的模态
  const testModalities = [...new Set([...inputModalities, ...outputModalities])];

  setButtonLoading(btn, true);
  try {
    const resultJson = await invoke<string>("test_api_key", {
      config: { type: provider, api_key: key, model, modalities: testModalities },
    });
    const result = JSON.parse(resultJson);

    if (result.ok.length === 0) {
      const errors = result.failed.map((f: any) => `${f.modality}: ${f.error}`).join("; ");
      showError(`密钥验证失败：${errors}`);
      return;
    }

    if (result.failed.length > 0) {
      const failedNames = result.failed.map((f: any) => f.modality).join(", ");
      showError(`部分模态认证失败：${failedNames}。已自动仅保留验证通过的模态能力。`);
      // 仅保留成功的模态
      inputModalities = inputModalities.filter(m => result.ok.includes(m));
      outputModalities = outputModalities.filter(m => result.ok.includes(m));
    }

    keyPoolItems.push({
      type: "preset",
      data: {
        id: crypto.randomUUID(),
        providerId: provider,
        model,
        apiKey: key,
        label: generateLabel(model),
        inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
        outputModalities: outputModalities.length > 0 ? outputModalities : ["text"],
      },
    });
    await saveKeyPool();
    (document.getElementById("keypool-preset-key") as HTMLInputElement).value = "";
    renderKeyPool();
    renderExperts();
  } catch (e) {
    showError(typeof e === "string" ? e : String(e));
  } finally {
    setButtonLoading(btn, false);
  }
});

// 添加中转服务（需认证）
document.getElementById("keypool-relay-add")?.addEventListener("click", async () => {
  const btn = document.getElementById("keypool-relay-add")!;
  const name = (document.getElementById("keypool-relay-name") as HTMLInputElement).value.trim();
  const model = (document.getElementById("keypool-relay-model") as HTMLInputElement).value.trim();
  const endpoint = (document.getElementById("keypool-relay-endpoint") as HTMLInputElement).value.trim();
  const key = (document.getElementById("keypool-relay-key") as HTMLInputElement).value.trim();
  if (!name) { showError("请输入名称"); return; }
  if (!model) { showError("请输入模型名称"); return; }
  if (!endpoint) { showError("请输入端点 URL"); return; }
  if (!key) { showError("请输入 API 密钥"); return; }

  // 读取模态能力配置
  let inputModalities = Array.from(document.querySelectorAll<HTMLInputElement>("#relay-modality-config input[name='input-modality']:checked")).map(el => el.value as Modality);
  let outputModalities = Array.from(document.querySelectorAll<HTMLInputElement>("#relay-modality-config input[name='output-modality']:checked")).map(el => el.value as Modality);

  // 合并去重要测试的模态
  const testModalities = [...new Set([...inputModalities, ...outputModalities])];

  setButtonLoading(btn, true);
  try {
    const resultJson = await invoke<string>("test_api_key", {
      config: { type: "relay", api_key: key, endpoint, model, modalities: testModalities },
    });
    const result = JSON.parse(resultJson);

    if (result.ok.length === 0) {
      const errors = result.failed.map((f: any) => `${f.modality}: ${f.error}`).join("; ");
      showError(`密钥验证失败：${errors}`);
      return;
    }

    if (result.failed.length > 0) {
      const failedNames = result.failed.map((f: any) => f.modality).join(", ");
      showError(`部分模态认证失败：${failedNames}。已自动仅保留验证通过的模态能力。`);
      // 仅保留成功的模态
      inputModalities = inputModalities.filter(m => result.ok.includes(m));
      outputModalities = outputModalities.filter(m => result.ok.includes(m));
    }

    keyPoolItems.push({
      type: "relay",
      data: {
        id: crypto.randomUUID(),
        name,
        model,
        endpoint,
        apiKey: key,
        label: generateLabel(model),
        inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
        outputModalities: outputModalities.length > 0 ? outputModalities : ["text"],
      },
    });
    await saveKeyPool();
    (document.getElementById("keypool-relay-name") as HTMLInputElement).value = "";
    (document.getElementById("keypool-relay-model") as HTMLInputElement).value = "";
    (document.getElementById("keypool-relay-endpoint") as HTMLInputElement).value = "";
    (document.getElementById("keypool-relay-key") as HTMLInputElement).value = "";
    renderKeyPool();
    renderExperts();
  } catch (e) {
    showError(typeof e === "string" ? e : String(e));
  } finally {
    setButtonLoading(btn, false);
  }
});

// 添加自定义代码（无需认证）
document.getElementById("keypool-custom-add")?.addEventListener("click", async () => {
  const name = (document.getElementById("keypool-custom-name") as HTMLInputElement).value.trim();
  const code = (document.getElementById("keypool-custom-code") as HTMLTextAreaElement).value.trim();
  if (!name) { showError("请输入名称"); return; }
  if (!code) { showError("请输入接口代码"); return; }

  keyPoolItems.push({
    type: "custom",
    data: { id: crypto.randomUUID(), name, code, label: generateLabel(name) },
  });
  await saveKeyPool();
  (document.getElementById("keypool-custom-name") as HTMLInputElement).value = "";
  (document.getElementById("keypool-custom-code") as HTMLTextAreaElement).value = "";
  renderKeyPool();
  renderExperts();
});

// ========== 专家团配置 ==========
export interface Expert {
  id: string;
  name: string;
  title: string;
  description: string;
  gender?: "male" | "female";
  disciplineName?: string;
  code?: string;
  categoryId?: string;
  categoryLabel?: string;
  toolProfile?: string;
  systemRole?: boolean;
  keyId: string | null;
  tokenAllocation?: {
    dailyLimit: number | null;
    monthlyLimit: number | null;
    yearlyLimit: number | null;
  };
}

function toolProfileLabel(profile?: string): string {
  switch (profile) {
    case "engineering":
      return "工程落地";
    case "analysis":
      return "分析研判";
    case "documentation":
      return "资料整理";
    case "creative":
      return "创意设计";
    case "review":
      return "审查把关";
    default:
      return "研究支撑";
  }
}

function buildDefaultExperts(): Expert[] {
  const systemExperts: Expert[] = getSystemExperts().map((entry) => ({
    id: entry.id,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    gender: entry.gender,
    disciplineName: entry.title,
    code: entry.code,
    categoryId: entry.categoryId,
    categoryLabel: entry.categoryLabel,
    toolProfile: entry.toolProfile,
    systemRole: entry.systemRole,
    keyId: null,
  }));
  const disciplineExperts: Expert[] = getDisciplineExperts().map((entry) => ({
    id: entry.id,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    gender: entry.gender,
    disciplineName: getDisciplineDisplayName(entry.id),
    code: entry.code,
    categoryId: entry.categoryId,
    categoryLabel: entry.categoryLabel,
    toolProfile: entry.toolProfile,
    systemRole: entry.systemRole,
    keyId: null,
  }));

  return [...systemExperts, ...disciplineExperts].map((expert) => ({
    ...expert,
    keyId: null,
  }));
}

export let experts: Expert[] = [];

async function loadExperts() {
  await loadExpertsData();
  renderExperts();
}

/** 仅加载专家数据，不渲染 UI（供启动时使用） */
async function loadExpertsData() {
  const defaults = buildDefaultExperts();
  try {
    const json = await invoke<string>("load_experts");
    const saved = JSON.parse(json || "[]") as Expert[];
    const merged = defaults.map((defaultExpert) => {
      const existing = saved.find((expert) => expert.id === defaultExpert.id);
      return {
        ...defaultExpert,
        keyId: existing?.keyId ?? null,
        tokenAllocation: existing?.tokenAllocation
          ? {
            dailyLimit: existing.tokenAllocation.dailyLimit ?? null,
            monthlyLimit: existing.tokenAllocation.monthlyLimit ?? null,
            yearlyLimit: existing.tokenAllocation.yearlyLimit ?? null,
          }
          : defaultExpert.tokenAllocation,
      };
    });
    const changed =
      merged.length !== saved.length
      || merged.some((expert, index) => JSON.stringify(expert) !== JSON.stringify(saved[index]));
    experts = merged;
    if (changed) {
      await saveExperts();
    }
  } catch {
    experts = JSON.parse(JSON.stringify(defaults));
    try { await saveExperts(); } catch { /* 静默忽略 */ }
  }
  // 同步 experts 引用到 expert-router.ts
  setExpertsRef(experts);
}

async function saveExperts() {
  await invoke("save_experts", { config: JSON.stringify(experts) });
}

/** 检查核心角色（江星图/江星河/江青澜）是否全部配置了密钥 */
function isCoreKeyConfigured(): boolean {
  return CORE_EXPERT_IDS.every((id) => {
    const expert = experts.find((e) => e.id === id);
    return expert && expert.keyId && expert.keyId.length > 0;
  });
}

/** 获取未配置密钥的核心角色名称列表 */
function getUnconfiguredCoreNames(): string[] {
  return CORE_EXPERT_IDS
    .filter((id) => {
      const expert = experts.find((e) => e.id === id);
      return !expert || !expert.keyId || expert.keyId.length === 0;
    })
    .map((id) => {
      const expert = experts.find((e) => e.id === id);
      return expert ? expert.name : id;
    });
}

function renderExperts() {
  const gridSpecial = document.getElementById("expert-grid-special") as HTMLElement | null;
  const gridRegular = document.getElementById("expert-grid-regular") as HTMLElement | null;
  const filterWrap = document.getElementById("expert-filter-pills") as HTMLElement | null;
  const searchInput = document.getElementById("expert-search-input") as HTMLInputElement | null;
  const unboundToggle = document.getElementById("expert-filter-unbound") as HTMLInputElement | null;
  const resultCopy = document.getElementById("expert-result-copy");
  const totalStat = document.getElementById("expert-stat-total");
  const activeStat = document.getElementById("expert-stat-active");
  const systemStat = document.getElementById("expert-stat-system");
  const unboundStat = document.getElementById("expert-stat-unbound");
  const systemDeck = document.getElementById("expert-command-deck");
  const emptyState = document.getElementById("expert-empty");
  const globalKeySelect = document.getElementById("expert-global-key") as HTMLSelectElement | null;
  const applyAllCheckbox = document.getElementById("apply-key-to-all") as HTMLInputElement | null;
  const applyModelBtn = document.getElementById("apply-model-btn") as HTMLButtonElement | null;
  const expandAllBtn = document.getElementById("expert-expand-all") as HTMLButtonElement | null;
  const collapseAllBtn = document.getElementById("expert-collapse-all") as HTMLButtonElement | null;
  const configNote = document.getElementById("expert-config-note");

  if (!gridSpecial || !gridRegular || !filterWrap || !searchInput || !unboundToggle || !globalKeySelect || !applyAllCheckbox || !applyModelBtn) {
    return;
  }

  const escapeHtml = (text: string): string => {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  };
  const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, "&quot;");

  const previousSearch = searchInput.value || "";
  const previousFilter = filterWrap.querySelector<HTMLElement>(".is-active")?.dataset.filter || "all";
  const previousUnboundOnly = unboundToggle.checked;
  const previousGlobalKey = globalKeySelect.value;

  const categoryDescriptions: Record<string, string> = {
    system: "负责调度、协作和最终收敛，是整套专家机制的中枢层。",
    natural: "偏基础研究与分析推演，适合处理模型、机理与理论问题。",
    agriculture: "围绕农业系统、资源利用与生产条件给出专业判断。",
    medical: "聚焦医学证据、诊疗体系和健康相关风险分析。",
    engineering: "偏工程实现、产品落地与复杂系统的方案拆解。",
    humanities: "处理写作、法务、传播、社会分析等人文社科场景。",
  };
  const categoryOrder = ["natural", "agriculture", "medical", "engineering", "humanities"];

  const keyOptions = keyPoolItems
    .map((item) => `<option value="${escapeAttr(item.data.id)}">${escapeHtml(item.data.label)}</option>`)
    .join("");

  globalKeySelect.innerHTML = `<option value="">选择统一绑定的密钥...</option>${keyOptions}`;
  if (previousGlobalKey) {
    globalKeySelect.value = previousGlobalKey;
  }

  const getBindingLabel = (keyId: string | null): string => {
    if (!keyId) return "未绑定模型";
    const matched = keyPoolItems.find((item) => item.data.id === keyId);
    return matched ? matched.data.label : "已绑定密钥";
  };

  const buildSearchText = (expert: Expert, specialization: ReturnType<typeof getExpertSpecializationSummary>): string => {
    return [
      expert.name,
      expert.disciplineName,
      expert.title,
      expert.description,
      expert.code,
      expert.categoryLabel,
      toolProfileLabel(expert.toolProfile),
      expert.gender === "male" ? "男" : expert.gender === "female" ? "女" : "",
      specialization.knowledge.join(" "),
      specialization.methodology.join(" "),
      specialization.promptFocus.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  };

  const renderArchive = (expert: Expert, specialization: ReturnType<typeof getExpertSpecializationSummary>): string => {
    if (expert.systemRole) {
      return `
        <div class="expert-archive-panel is-static">
          <div class="expert-archive-grid">
            <div class="expert-archive-block">
              <div class="expert-archive-title">角色定位</div>
              <ul class="expert-archive-list">
                <li>${escapeHtml(expert.description)}</li>
              </ul>
            </div>
            <div class="expert-archive-block">
              <div class="expert-archive-title">当前状态</div>
              <ul class="expert-archive-list">
                <li>${escapeHtml(getBindingLabel(expert.keyId))}</li>
                <li>核心角色默认不参与词元配额限制。</li>
              </ul>
            </div>
          </div>
        </div>
      `;
    }

    const knowledge = specialization.knowledge.slice(0, 2);
    const methodology = specialization.methodology.slice(0, 2);
    const focus = specialization.promptFocus.slice(0, 4);

    return `
      <button class="expert-archive-toggle" type="button" data-archive-toggle="${escapeAttr(expert.id)}">展开角色档案</button>
      <div class="expert-archive-panel" data-archive-panel="${escapeAttr(expert.id)}" hidden>
        ${focus.length > 0 ? `
          <div class="expert-archive-focus">
            ${focus.map((item) => `<span class="expert-archive-tag">${escapeHtml(item)}</span>`).join("")}
          </div>
        ` : ""}
        <div class="expert-archive-grid">
          <div class="expert-archive-block">
            <div class="expert-archive-title">知识抓手</div>
            <ul class="expert-archive-list">
              ${knowledge.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </div>
          <div class="expert-archive-block">
            <div class="expert-archive-title">方法偏好</div>
            <ul class="expert-archive-list">
              ${methodology.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </div>
        </div>
      </div>
    `;
  };

  const cardHtml = (expert: Expert) => {
    const specialization = getExpertSpecializationSummary(expert.id);
    const searchText = buildSearchText(expert, specialization);
    const disciplineLabel = expert.systemRole
      ? expert.title
      : [expert.code, expert.disciplineName].filter(Boolean).join(" · ");
    const keywords = specialization.promptFocus.length > 0
      ? specialization.promptFocus.slice(0, 4)
      : (findExpertEntry(expert.id)?.keywords || []).slice(0, 4);
    const bindingState = expert.keyId ? "configured" : "unbound";
    const bindingText = getBindingLabel(expert.keyId);
    const quotaHtml = QUOTA_EXEMPT_IDS.includes(expert.id) ? `
      <div class="expert-card-quota is-exempt">
        <span class="expert-field-label">词元配额</span>
        <span class="expert-quota-exempt">核心角色默认不限额</span>
      </div>
    ` : `
      <div class="expert-card-quota">
        <span class="expert-field-label">词元配额</span>
        <div class="expert-quota-grid">
          <label class="expert-mini-field">
            <span>日</span>
            <input type="number" placeholder="不限" class="quota-input quota-daily" data-expert-id="${escapeAttr(expert.id)}" value="${expert.tokenAllocation?.dailyLimit ?? ""}" min="0" />
          </label>
          <label class="expert-mini-field">
            <span>月</span>
            <input type="number" placeholder="不限" class="quota-input quota-monthly" data-expert-id="${escapeAttr(expert.id)}" value="${expert.tokenAllocation?.monthlyLimit ?? ""}" min="0" />
          </label>
          <label class="expert-mini-field">
            <span>年</span>
            <input type="number" placeholder="不限" class="quota-input quota-yearly" data-expert-id="${escapeAttr(expert.id)}" value="${expert.tokenAllocation?.yearlyLimit ?? ""}" min="0" />
          </label>
        </div>
      </div>
    `;

    return `
      <article
        class="expert-card${CORE_EXPERT_IDS.includes(expert.id) ? " expert-card-core" : ""}"
        data-expert-id="${escapeAttr(expert.id)}"
        data-category="${escapeAttr(expert.systemRole ? "system" : (expert.categoryId || "uncategorized"))}"
        data-configured="${expert.keyId ? "true" : "false"}"
        data-search="${escapeAttr(searchText)}"
      >
        <div class="expert-card-topline">
          <span class="expert-status-chip ${bindingState}">${escapeHtml(bindingText)}</span>
          <div class="expert-badges">
            ${expert.code ? `<span class="expert-badge expert-badge-code">${escapeHtml(expert.code)}</span>` : ""}
            ${expert.toolProfile ? `<span class="expert-badge expert-badge-profile">${escapeHtml(toolProfileLabel(expert.toolProfile))}</span>` : ""}
            ${expert.gender === "male" ? `<span class="expert-badge expert-badge-gender">男</span>` : expert.gender === "female" ? `<span class="expert-badge expert-badge-gender">女</span>` : ""}
          </div>
        </div>
        <div class="expert-card-head">
          <div class="expert-name">${escapeHtml(expert.name)}</div>
          <div class="expert-title">${escapeHtml(disciplineLabel || "未定义角色")}</div>
          <div class="expert-desc">${escapeHtml(expert.description)}</div>
        </div>
        <div class="expert-traits">
          ${(keywords.length > 0 ? keywords : ["职责清晰", "可协作", "可调度"])
            .map((item: string) => `<span class="expert-trait">${escapeHtml(item)}</span>`)
            .join("")}
        </div>
        <div class="expert-card-controls">
          <label class="expert-select-block">
            <span class="expert-field-label">绑定模型</span>
            <select class="expert-key-select" data-expert-id="${escapeAttr(expert.id)}">
              <option value="">未配置</option>
              ${keyOptions}
            </select>
          </label>
          ${quotaHtml}
        </div>
        ${renderArchive(expert, specialization)}
      </article>
    `;
  };

  const systemExperts = experts.filter((expert) => expert.systemRole);
  const regularExperts = experts.filter((expert) => !expert.systemRole);
  const groupedExperts = regularExperts.reduce((map, expert) => {
    const key = expert.categoryLabel || "未分类";
    const current = map.get(key) || [];
    current.push(expert);
    map.set(key, current);
    return map;
  }, new Map<string, Expert[]>());

  gridSpecial.innerHTML = systemExperts.map(cardHtml).join("");

  const sortedGroups = Array.from(groupedExperts.entries()).sort((left, right) => {
    const leftCategoryId = left[1][0]?.categoryId || "";
    const rightCategoryId = right[1][0]?.categoryId || "";
    return categoryOrder.indexOf(leftCategoryId) - categoryOrder.indexOf(rightCategoryId);
  });

  gridRegular.innerHTML = sortedGroups
    .map(([label, groupExperts]) => {
      const sortedExperts = [...groupExperts].sort((left, right) => (left.code || left.name).localeCompare(right.code || right.name, "zh-Hans-CN", { numeric: true }));
      const categoryId = sortedExperts[0]?.categoryId || "uncategorized";
      return `
        <section class="expert-cluster" data-category="${escapeAttr(categoryId)}" data-cluster="${escapeAttr(categoryId)}">
          <div class="expert-cluster-head">
            <div class="expert-cluster-copy">
              <div class="expert-cluster-kicker">一级学科分组</div>
              <div class="expert-cluster-title">${escapeHtml(label)}</div>
              <div class="expert-cluster-meta">${escapeHtml(categoryDescriptions[categoryId] || "按学科结构组织专家，便于快速配置和筛选。")}</div>
            </div>
            <div class="expert-cluster-actions">
              <span class="expert-cluster-count">${sortedExperts.length} 人</span>
              <button class="expert-cluster-toggle" type="button" data-cluster-toggle="${escapeAttr(categoryId)}">收起</button>
            </div>
          </div>
          <div class="expert-cluster-body" data-cluster-body="${escapeAttr(categoryId)}">
            <div class="expert-card-grid">
              ${sortedExperts.map(cardHtml).join("")}
            </div>
          </div>
        </section>
      `;
    })
    .join("");

  totalStat && (totalStat.textContent = String(experts.length));
  systemStat && (systemStat.textContent = String(systemExperts.length));
  unboundStat && (unboundStat.textContent = String(experts.filter((expert) => !expert.keyId).length));
  if (configNote) {
    configNote.textContent = `${experts.length} 位角色已装入主项目结构。当前界面以“人名 + 学科 + 配置状态”为主视图。`;
  }

  experts.forEach((expert) => {
    [gridSpecial, gridRegular].forEach((grid) => {
      const select = grid.querySelector(`select[data-expert-id="${expert.id}"]`) as HTMLSelectElement | null;
      if (select && expert.keyId) {
        select.value = expert.keyId;
      }
    });
  });

  [gridSpecial, gridRegular].forEach((grid) => {
    grid.querySelectorAll<HTMLSelectElement>(".expert-key-select").forEach((select) => {
      select.onchange = async (e) => {
        const target = e.target as HTMLSelectElement;
        const expertId = target.dataset.expertId;
        const expert = experts.find((item) => item.id === expertId);
        if (!expert) return;
        expert.keyId = target.value || null;
        await saveExperts();
        renderExperts();
      };
    });

    grid.querySelectorAll<HTMLInputElement>(".quota-input").forEach((input) => {
      input.onchange = async (e) => {
        const target = e.target as HTMLInputElement;
        const expertId = target.dataset.expertId;
        const expert = experts.find((item) => item.id === expertId);
        if (!expert) return;
        if (!expert.tokenAllocation) {
          expert.tokenAllocation = { dailyLimit: null, monthlyLimit: null, yearlyLimit: null };
        }
        const value = target.value ? parseInt(target.value, 10) : null;
        if (target.classList.contains("quota-daily")) expert.tokenAllocation.dailyLimit = value;
        if (target.classList.contains("quota-monthly")) expert.tokenAllocation.monthlyLimit = value;
        if (target.classList.contains("quota-yearly")) expert.tokenAllocation.yearlyLimit = value;
        await saveExperts();
      };
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-archive-toggle]").forEach((button) => {
    button.onclick = () => {
      const targetId = button.dataset.archiveToggle;
      const panel = document.querySelector<HTMLElement>(`[data-archive-panel="${targetId}"]`);
      if (!panel) return;
      const nextHidden = !panel.hidden;
      panel.hidden = nextHidden;
      button.textContent = nextHidden ? "展开角色档案" : "收起角色档案";
    };
  });

  const setClusterState = (clusterId: string, collapsed: boolean) => {
    const body = document.querySelector<HTMLElement>(`[data-cluster-body="${clusterId}"]`);
    const button = document.querySelector<HTMLButtonElement>(`[data-cluster-toggle="${clusterId}"]`);
    if (!body || !button) return;
    body.hidden = collapsed;
    button.textContent = collapsed ? "展开" : "收起";
  };

  document.querySelectorAll<HTMLButtonElement>("[data-cluster-toggle]").forEach((button) => {
    button.onclick = () => {
      const clusterId = button.dataset.clusterToggle;
      if (!clusterId) return;
      const body = document.querySelector<HTMLElement>(`[data-cluster-body="${clusterId}"]`);
      if (!body) return;
      setClusterState(clusterId, !body.hidden);
    };
  });

  expandAllBtn && (expandAllBtn.onclick = () => {
    document.querySelectorAll<HTMLElement>("[data-cluster-body]").forEach((body) => {
      const clusterId = body.dataset.clusterBody;
      if (clusterId) setClusterState(clusterId, false);
    });
  });
  collapseAllBtn && (collapseAllBtn.onclick = () => {
    document.querySelectorAll<HTMLElement>("[data-cluster-body]").forEach((body) => {
      const clusterId = body.dataset.clusterBody;
      if (clusterId) setClusterState(clusterId, true);
    });
  });

  const filters = [
    { id: "all", label: "全部专家" },
    { id: "system", label: "系统角色" },
    ...sortedGroups.map(([label, groupExperts]) => ({
      id: groupExperts[0]?.categoryId || "uncategorized",
      label,
    })),
  ];

  filterWrap.innerHTML = filters
    .map((filter) => `<button class="expert-filter-chip${filter.id === "all" ? " is-active" : ""}" type="button" data-filter="${escapeAttr(filter.id)}">${escapeHtml(filter.label)}</button>`)
    .join("");

  const applyFilters = () => {
    const activeFilter = filterWrap.querySelector<HTMLElement>(".is-active")?.dataset.filter || "all";
    const tokens = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const includeTerms = tokens.filter((item) => !item.startsWith("-"));
    const excludeTerms = tokens.filter((item) => item.startsWith("-") && item.length > 1).map((item) => item.slice(1));
    let visibleCards = 0;

    document.querySelectorAll<HTMLElement>(".expert-card").forEach((card) => {
      const searchText = card.dataset.search || "";
      const cardCategory = card.dataset.category || "uncategorized";
      const isConfigured = card.dataset.configured === "true";
      const matchedText = includeTerms.every((term) => searchText.includes(term))
        && excludeTerms.every((term) => !searchText.includes(term));
      const matchedFilter = activeFilter === "all" || activeFilter === cardCategory;
      const matchedUnbound = !unboundToggle.checked || !isConfigured;
      const matched = matchedText && matchedFilter && matchedUnbound;
      card.hidden = !matched;
      if (matched) visibleCards += 1;
    });

    document.querySelectorAll<HTMLElement>(".expert-cluster").forEach((cluster) => {
      const cards = Array.from(cluster.querySelectorAll<HTMLElement>(".expert-card"));
      const visibleInCluster = cards.filter((card) => !card.hidden).length;
      cluster.hidden = visibleInCluster === 0;
      const countEl = cluster.querySelector<HTMLElement>(".expert-cluster-count");
      if (countEl) {
        countEl.textContent = `${visibleInCluster} / ${cards.length} 人`;
      }
    });

    if (systemDeck) {
      const visibleSystemCount = Array.from(gridSpecial.querySelectorAll<HTMLElement>(".expert-card")).filter((card) => !card.hidden).length;
      systemDeck.hidden = visibleSystemCount === 0;
    }

    activeStat && (activeStat.textContent = String(visibleCards));
    if (resultCopy) {
      const filterLabel = filterWrap.querySelector<HTMLElement>(".is-active")?.textContent || "全部专家";
      const suffix = excludeTerms.length > 0 ? `，已排除 ${excludeTerms.map((item) => `-${item}`).join(" ")}` : "";
      resultCopy.textContent = `当前显示 ${visibleCards} / ${experts.length} 位角色，筛选范围：${filterLabel}${suffix}。`;
    }
    if (emptyState) {
      emptyState.hidden = visibleCards > 0;
    }
  };

  filterWrap.querySelectorAll<HTMLButtonElement>(".expert-filter-chip").forEach((button) => {
    if (button.dataset.filter === previousFilter) {
      filterWrap.querySelector(".is-active")?.classList.remove("is-active");
      button.classList.add("is-active");
    }
    button.onclick = () => {
      filterWrap.querySelector(".is-active")?.classList.remove("is-active");
      button.classList.add("is-active");
      applyFilters();
    };
  });

  searchInput.value = previousSearch;
  unboundToggle.checked = previousUnboundOnly;
  searchInput.oninput = applyFilters;
  unboundToggle.onchange = applyFilters;

  applyModelBtn.onclick = async () => {
    const selectedKeyId = globalKeySelect.value;
    const selectedLabel = globalKeySelect.selectedOptions[0]?.textContent?.trim() || "所选密钥";
    if (!applyAllCheckbox.checked) {
      showError("请先确认“覆盖全部专家团”。");
      return;
    }
    if (!selectedKeyId) {
      showError("请先选择一个可绑定的密钥。");
      return;
    }

    const targetExperts = [...experts];

    if (targetExperts.length === 0) {
      showError("当前没有可配置的专家。");
      return;
    }

    const originalButtonText = applyModelBtn.textContent || "一键配置";
    applyModelBtn.disabled = true;
    applyModelBtn.textContent = "配置中...";

    try {
      targetExperts.forEach((expert) => {
        expert.keyId = selectedKeyId;
      });
      await saveExperts();
      renderExperts();
      applyAllCheckbox.checked = false;
      const latestConfigNote = document.getElementById("expert-config-note");
      if (latestConfigNote) {
        latestConfigNote.textContent = `已将 ${targetExperts.length} 位专家统一绑定到 ${selectedLabel}。`;
      }
    } catch (error) {
      showError(`统一配置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      applyModelBtn.disabled = false;
      applyModelBtn.textContent = originalButtonText;
    }
  };

  applyFilters();
}

// ========== 监听对话切换 ==========
window.addEventListener("chat-changed", ((e: CustomEvent) => {
  const { chatId } = e.detail;
  log("INFO", `切换到项目 ${chatId}`);
}) as EventListener);

// ========== 聊天区域逻辑 ==========
// 每个项目下可以有多个对话历史（对话一、对话二...）
interface ChatMessage {
  /** expert-tasks 表示一组专家任务卡片快照（content 为 JSON 序列化的 ExpertTask[]） */
  role: "user" | "assistant" | "expert-tasks" | "tool-event" | "command-auth";
  content: string;
}

type ChatRunMode = "normal" | "plan" | "goal";
type AttachmentKind = "image" | "video" | "audio" | "text" | "file";

interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  file: File;
}

interface StoredAttachmentMeta {
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

interface UserMessageMetaPayload {
  version: 1;
  text: string;
  mode: ChatRunMode;
  attachments: StoredAttachmentMeta[];
}

const USER_MESSAGE_META_PREFIX = "__XT_USER_META__:";

interface ToolEventMessage {
  kind: "web-search" | "command";
  createdAt: number;
  initiator: {
    expertId: string;
    expertName: string;
    expertTitle: string;
  };
  reason: string;
  query?: string;
  command?: string;
  workingDir?: string;
  authMode?: "auto" | "restricted" | "admin";
  status: "success" | "blocked" | "denied" | "error";
  safetyReason?: string;
  results?: Array<{ title: string; url: string; snippet: string }>;
  output?: {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  error?: string;
}

interface CommandAuthMessage {
  id: string;
  createdAt: number;
  initiator: {
    expertName: string;
    expertTitle: string;
  };
  command: string;
  workingDir: string;
  reason: string;
  authMode: "auto" | "restricted" | "admin";
  safetyReason?: string;
  status: "pending" | "approved" | "denied";
}

interface ChatSession {
  id: number;
  name: string;
  messages: ChatMessage[];
}

const projectSessions = new Map<number, ChatSession[]>();
let currentProjectId: number | null = null;
let currentSessionId: number | null = null;
let nextSessionId = 1;

// ========== DB 就绪检测 ==========
async function waitForDbReady(maxRetries = 10, interval = 300): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await invoke("db_load_projects");
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  return false;
}

// ========== 感知索引状态 ==========
let perceptualIndexReady = false;
let perceptualIndexBuilding = false;

// ========== 专家团流水线状态 ==========
let pipelineRunning = false;
let currentDispatchPlan: DispatchPlan | null = null;
let pendingFollowups: PipelineFollowup[] = [];
let currentMemoryFilter: "all" | "ephemeral" | "working" | "longterm" = "all";
const pendingCommandAuthResolvers = new Map<string, (approved: boolean) => void>();

document.addEventListener("DOMContentLoaded", async () => {
  // 初始化时加载密钥池和专家团数据（供画布分析和消息发送使用）
  await loadKeyPool();
  await loadExpertsData();
  await Promise.all([loadTokenData(), loadUserTokenData()]);

  const historyDropdownBtn = document.getElementById("chat-history-dropdown");
  const historyPanel = document.getElementById("history-dropdown-panel");
  const historyList = document.getElementById("chat-history-list");
  const historyDropdownList = document.getElementById("history-dropdown-list");
  const chatNewBtn = document.getElementById("chat-new-btn");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
  const chatSendBtn = document.getElementById("chat-send-btn");
  const chatActionTrigger = document.getElementById("chat-action-trigger") as HTMLButtonElement | null;
  const chatActionMenu = document.getElementById("chat-action-menu") as HTMLElement | null;
  const chatComposerMeta = document.getElementById("chat-composer-meta") as HTMLElement | null;
  const chatFileInput = document.getElementById("chat-file-input") as HTMLInputElement | null;
  let currentChatRunMode: ChatRunMode = "normal";
  let pendingAttachments: PendingAttachment[] = [];

  const renderComposerMeta = () => {
    if (!chatComposerMeta) return;
    const chips: string[] = [];
    if (currentChatRunMode !== "normal") {
      chips.push(`
        <span class="chat-composer-pill mode" data-chip-kind="mode">
          <span class="chat-composer-pill-label">${currentChatRunMode === "plan" ? "按计划进行" : "按目标进行"}</span>
          <button class="chat-composer-pill-remove" data-remove-mode="true" type="button" title="恢复普通发送">×</button>
        </span>
      `);
    }
    pendingAttachments.forEach((attachment) => {
      chips.push(`
        <span class="chat-composer-pill file" data-chip-kind="file">
          <span class="chat-composer-pill-label">${attachment.kind === "image" ? "图片" : attachment.kind === "video" ? "视频" : attachment.kind === "audio" ? "音频" : attachment.kind === "text" ? "文本" : "文件"}</span>
          <span class="chat-composer-pill-name">${escapeHtml(attachment.name)}</span>
          <span class="chat-composer-pill-size">${formatFileSize(attachment.size)}</span>
          <button class="chat-composer-pill-remove" data-remove-attachment="${attachment.id}" type="button" title="移除文件">×</button>
        </span>
      `);
    });
    chatComposerMeta.innerHTML = chips.join("");
    chatComposerMeta.classList.toggle("has-items", chips.length > 0);
    chatComposerMeta.querySelector<HTMLElement>("[data-remove-mode='true']")?.addEventListener("click", () => {
      currentChatRunMode = "normal";
      renderComposerMeta();
    });
    chatComposerMeta.querySelectorAll<HTMLElement>("[data-remove-attachment]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.removeAttachment;
        pendingAttachments = pendingAttachments.filter((item) => item.id !== id);
        renderComposerMeta();
      });
    });
  };

  const closeChatActionMenu = () => {
    chatActionMenu?.classList.remove("open");
    chatActionTrigger?.setAttribute("aria-expanded", "false");
  };

  const openChatActionMenu = () => {
    chatActionMenu?.classList.add("open");
    chatActionTrigger?.setAttribute("aria-expanded", "true");
  };

  // === 启动时恢复上次活跃项目的对话 ===
  // 解决 sidebar.loadProjects() 中 setActiveChat() 触发的 chat-changed 事件
  // 可能早于本 DOMContentLoaded 注册监听器导致的时序竞态问题

  // 等待 DB 就绪，避免后端未初始化时静默失败
  const dbReady = await waitForDbReady();
  if (!dbReady) {
    log("ERROR", "数据库初始化超时，无法加载对话记录");
    if (chatMessages) {
      const errorNotice = document.createElement("div");
      errorNotice.className = "system-notice error-notice";
      errorNotice.textContent = "数据库初始化超时，无法加载对话记录，请重启应用";
      errorNotice.style.cssText = "color: #e74c3c; padding: 8px 12px; margin: 8px; border-radius: 4px; background: rgba(231,76,60,0.1); font-size: 13px;";
      chatMessages.appendChild(errorNotice);
    }
  }
  await sidebar.ready;

  const activeChat = sidebar.getActiveChat();
  if (activeChat) {
    currentProjectId = activeChat.id;
    log("INFO", `启动恢复：检测到上次活跃项目 [${activeChat.name}]，加载对话记录`);
    await loadSessionsFromDb(activeChat.id);
    const sessions = getSessions(activeChat.id);
    if (sessions.length > 0) {
      currentSessionId = sessions[0].id;
      renderMessages();
      log("INFO", `启动恢复：已加载 ${sessions.length} 个会话，当前会话 [${sessions[0].name}]`);
    }
    updateHistoryDisplay();
    // 加载可视化目录画布
    loadProjectCanvas(activeChat.id);
  } else {
    // 尝试从项目列表获取第一个可用项目
    const allChats = sidebar.getChats();
    if (allChats && allChats.length > 0) {
      const firstProject = allChats[0];
      log("INFO", `启动恢复：无上次活跃项目，尝试加载第一个项目: ${firstProject.name}`);
      sidebar.setActiveChat(firstProject.id);
      currentProjectId = firstProject.id;
      await loadSessionsFromDb(firstProject.id);
      const sessions = getSessions(firstProject.id);
      if (sessions.length > 0) {
        currentSessionId = sessions[0].id;
        renderMessages();
        log("INFO", `启动恢复：已加载 ${sessions.length} 个会话，当前会话 [${sessions[0].name}]`);
      }
      updateHistoryDisplay();
      // 加载可视化目录画布
      loadProjectCanvas(firstProject.id);
    } else {
      log("INFO", "启动恢复：无任何项目，跳过对话恢复");
    }
  }

  // 从数据库加载项目的会话数据
  async function loadSessionsFromDb(projectId: number): Promise<void> {
    const project = sidebar.getChats().find((c) => c.id === projectId);
    if (!project) return;

    const bootstrapPromptModuleHistory = async (sessions: ChatSession[]) => {
      if (sessions.length === 0) return;
      try {
        const report = await bootstrapPromptModuleHistoryFromSessions(project.name, sessions);
        if (report.imported > 0) {
          log(
            "INFO",
            `提示模块历史已从旧会话回灌：新增 ${report.imported} 条，当前总计 ${report.total} 条`
          );
        }
      } catch (e) {
        log("WARN", `提示模块历史回灌失败: ${e}`);
      }
    };

    try {
      // 优先从项目文件 .xt/chat_sessions.json 加载（项目级持久化）
      const fileData = await invoke<string>("load_chat_sessions", {
        projectName: project.name,
      });
      if (fileData && fileData !== "null") {
        const sessions = normalizeSessions(projectId, JSON.parse(fileData));
        if (sessions.length > 0) {
          projectSessions.set(projectId, sessions);
          await bootstrapPromptModuleHistory(sessions);
          await persistSessionsToFile(projectId);
          log("INFO", `从项目文件加载了 ${sessions.length} 个会话`);
          return;
        }
      }
    } catch (e) {
      log("WARN", `从项目文件加载会话失败，尝试数据库: ${e}`);
    }

    // 回退：从 SQLite 数据库加载
    try {
      const data = await invoke<string>("db_load_project_data", { projectId });
      const sessions = normalizeSessions(projectId, JSON.parse(data));
      if (sessions.length > 0) {
        projectSessions.set(projectId, sessions);
        await bootstrapPromptModuleHistory(sessions);
        log("INFO", `从数据库加载了 ${sessions.length} 个会话`);
        // 迁移到项目文件
        await invoke("save_chat_sessions", {
          projectName: project.name,
          data: JSON.stringify(sessions),
        });
      }
    } catch (e) {
      log("ERROR", `加载会话数据失败: ${e}`);
      // 增加用户可见的错误提示
      const messagesEl = document.getElementById("chat-messages");
      if (messagesEl) {
        const errorNotice = document.createElement("div");
        errorNotice.className = "system-notice error-notice";
        errorNotice.textContent = `对话记录加载失败: ${e}`;
        errorNotice.style.cssText = "color: #e74c3c; padding: 8px 12px; margin: 8px; border-radius: 4px; background: rgba(231,76,60,0.1); font-size: 13px;";
        messagesEl.appendChild(errorNotice);
      }
    }

    if (!projectSessions.has(projectId)) {
      projectSessions.set(projectId, []);
    }
  }

  // 保存会话消息到数据库
  async function saveSessionToDb(sessionId: number, projectId: number): Promise<void> {
    const sessions = projectSessions.get(projectId);
    if (!sessions) return;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

    try {
      await persistSessionsToFile(projectId);
    } catch (e) {
      log("ERROR", `保存会话到项目文件失败: ${e}`);
    }

    try {
      // 先清除该会话的旧消息，再重新插入（避免重复）
      await invoke("db_clear_messages", { sessionId });
      for (const msg of session.messages) {
        await invoke("db_save_message", {
          sessionId,
          role: msg.role,
          content: msg.content,
        });
      }
    } catch (e) {
      log("WARN", `保存会话到数据库失败，项目文件已保存: ${e}`);
    }
  }

  // 获取当前项目的所有会话
  function getSessions(projectId: number): ChatSession[] {
    if (!projectSessions.has(projectId)) {
      projectSessions.set(projectId, []);
    }
    return projectSessions.get(projectId)!;
  }

  function normalizeSessions(projectId: number, rawSessions: unknown): ChatSession[] {
    if (!Array.isArray(rawSessions)) return [];

    const rawIds = rawSessions
      .map((s: any) => Number(s?.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const maxId = Math.max(0, ...rawIds);
    if (maxId >= nextSessionId) nextSessionId = maxId + 1;

    const usedIds = new Set<number>();
    const normalized: ChatSession[] = [];

    for (const raw of rawSessions as any[]) {
      let id = Number(raw?.id);
      if (!Number.isInteger(id) || id <= 0 || usedIds.has(id)) {
        while (usedIds.has(nextSessionId)) nextSessionId++;
        id = nextSessionId++;
      }
      usedIds.add(id);

      const messages = Array.isArray(raw?.messages)
        ? raw.messages.filter((msg: any) =>
          (msg?.role === "user"
              || msg?.role === "assistant"
              || msg?.role === "expert-tasks"
              || msg?.role === "tool-event"
              || msg?.role === "command-auth")
            && typeof msg?.content === "string"
          )
        : [];

      normalized.push({
        id,
        name: typeof raw?.name === "string" && raw.name.trim()
          ? raw.name
          : `对话 ${normalized.length + 1}`,
        messages,
      });
    }

    if (normalized.length !== rawSessions.length || new Set(rawIds).size !== rawIds.length) {
      log("WARN", `项目 ${projectId} 的会话数据存在重复或异常 ID，已自动修复`);
    }

    return normalized;
  }

  // 将项目的所有会话持久化到 .xt/chat_sessions.json
  async function persistSessionsToFile(projectId: number): Promise<void> {
    const project = sidebar.getChats().find((c) => c.id === projectId);
    if (!project) return;
    const allSessions = projectSessions.get(projectId) || [];
    try {
      await invoke("save_chat_sessions", {
        projectName: project.name,
        data: JSON.stringify(allSessions),
      });
    } catch (e) {
      log("ERROR", `持久化会话到项目文件失败: ${e}`);
    }
  }

  // 获取下一个会话名称
  function getNextSessionName(projectId: number): string {
    const sessions = getSessions(projectId);
    let index = sessions.length + 1;
    return `对话 ${index}`;
  }

  // 创建新会话
  async function createSession(projectId: number, name?: string): Promise<ChatSession> {
    const sessions = getSessions(projectId);
    const session: ChatSession = {
      id: nextSessionId++,
      name: name || getNextSessionName(projectId),
      messages: [],
    };
    sessions.push(session);

    // 保存到数据库
    try {
      const dbSessionId = await invoke<number>("db_save_session", {
        projectId,
        name: session.name,
      });
      const dbIdConflicts = sessions.some((s) => s !== session && s.id === dbSessionId);
      if (!dbIdConflicts) {
        session.id = dbSessionId;
      }
    } catch (e) {
      log("ERROR", `保存会话到数据库失败: ${e}`);
    }

    // 持久化到项目文件
    await persistSessionsToFile(projectId);

    return session;
  }

  // 删除会话
  async function deleteSession(sessionId: number) {
    if (!currentProjectId) return;
    const sessions = projectSessions.get(currentProjectId);
    if (!sessions) return;

    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) {
      const deleted = sessions[idx];
      sessions.splice(idx, 1);
      // 如果删除的是当前会话，切换到第一个
      if (currentSessionId === sessionId) {
        currentSessionId = sessions[0]?.id || null;
      }
      // 持久化到项目文件
      await persistSessionsToFile(currentProjectId);
      try {
        await invoke("db_delete_session", { sessionId: deleted.id });
      } catch (e) {
        log("WARN", `删除数据库会话失败: ${e}`);
      }
      renderMessages();
      updateHistoryDisplay();
    }
  }

  // ========== 感知索引管理 ==========

  /** 更新索引状态（仅内部状态管理，不向用户展示） */
  function updateIndexStatus(status: string, _message: string) {
    if (status === "ready") {
      perceptualIndexReady = true;
      perceptualIndexBuilding = false;
    } else if (status === "building") {
      perceptualIndexReady = false;
      perceptualIndexBuilding = true;
    } else {
      perceptualIndexReady = false;
      perceptualIndexBuilding = false;
    }
  }

  /** 检查并构建感知索引 */
  async function checkAndBuildIndex(projectName: string, force: boolean = false): Promise<void> {
    if (perceptualIndexBuilding) {
      const startedAt = Date.now();
      while (perceptualIndexBuilding && Date.now() - startedAt < 30000) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (perceptualIndexBuilding) return;
    }

    try {
      // 先查询索引状态
      const statusJson = await invoke<string>("perceptual_index_status", {
        projectName: projectName,
      });
      const status = JSON.parse(statusJson);

      if (status.total_chunks > 0 && !force) {
        updateIndexStatus("ready", `${status.total_chunks} 个代码段`);
        log("INFO", `感知索引已存在: ${status.total_chunks} 个代码段`);
        return;
      }

      // 索引不存在或强制重建
      updateIndexStatus("building", "构建中...");
      log("INFO", `开始构建感知索引: ${projectName}${force ? " (强制)" : ""}`);

      const resultJson = await invoke<string>("perceptual_index_build", {
        projectName: projectName,
      });
      const result = JSON.parse(resultJson);

      updateIndexStatus("ready", `${result.total_chunks} 个代码段`);
      log("INFO", `感知索引构建完成: ${result.total_chunks} 个代码段`);
    } catch (e) {
      updateIndexStatus("error", "构建失败");
      log("ERROR", `感知索引构建失败: ${e}`);
    }
  }

  let projectIntelligenceSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let projectIntelligenceSyncRunning = false;
  let pendingProjectIntelligenceName: string | null = null;
  const pendingProjectChangedFiles = new Set<string>();

  function formatGraphTimestamp(raw?: string | null): string {
    if (!raw) return "刚刚同步";
    if (/^\d+$/.test(raw)) {
      const ts = Number(raw) * 1000;
      if (!Number.isNaN(ts)) {
        return new Date(ts).toLocaleString("zh-CN");
      }
    }
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString("zh-CN");
    }
    return raw;
  }

  function scheduleProjectIntelligenceSync(
    projectName: string,
    changedFiles: string[] = [],
    reason: "agent-change" | "editor-save" | "manual-refresh" = "editor-save",
  ) {
    pendingProjectIntelligenceName = projectName;
    changedFiles.filter(Boolean).forEach((path) => pendingProjectChangedFiles.add(path));

    if (projectIntelligenceSyncTimer) {
      clearTimeout(projectIntelligenceSyncTimer);
    }

    projectIntelligenceSyncTimer = setTimeout(() => {
      const targetProject = pendingProjectIntelligenceName;
      if (!targetProject) return;
      void runProjectIntelligenceSync(targetProject, reason);
    }, reason === "manual-refresh" ? 120 : 900);
  }

  async function runProjectIntelligenceSync(
    projectName: string,
    reason: "agent-change" | "editor-save" | "manual-refresh",
  ): Promise<void> {
    if (projectIntelligenceSyncRunning) {
      scheduleProjectIntelligenceSync(projectName, [...pendingProjectChangedFiles], reason);
      return;
    }

    projectIntelligenceSyncRunning = true;
    const changedFiles = [...pendingProjectChangedFiles];
    pendingProjectChangedFiles.clear();

    try {
      updateDirectoryStatus("updating");
      await checkAndBuildIndex(projectName, true);
      const activeProject = sidebar.getActiveChat();
      const targetProject = activeProject?.name === projectName
        ? activeProject
        : sidebar.getChats().find((project) => project.name === projectName);
      await refreshProjectCanvasCaches(
        projectName,
        reason === "manual-refresh",
        targetProject?.workspacePath,
      );
      if (
        activeProject &&
        activeProject.name === projectName &&
        currentPreviewFile &&
        changedFiles.includes(currentPreviewFile)
      ) {
        if (currentPreviewMode === "canvas") {
          await refreshFileCanvas(reason === "manual-refresh");
        } else if (!isMarkdownFile(currentPreviewFile) && !isImageFile(currentPreviewFile)) {
          setFileCanvasSyncState("ready", "后台图谱已同步", `最近同步：${new Date().toLocaleString("zh-CN")}`);
        }
      }

      if (activeProject && activeProject.name === projectName) {
        await loadFileBrowser(projectName, activeProject.workspacePath);
        highlightCurrentFile();
      }
    } catch (e) {
      log("ERROR", `项目图谱自动同步失败: ${e}`);
      updateDirectoryStatus("needs-update");
      setFileCanvasSyncState("error", "图谱自动同步失败", "可点击重建图谱重试");
    } finally {
      projectIntelligenceSyncRunning = false;
      pendingProjectIntelligenceName = null;
      if (pendingProjectChangedFiles.size > 0 && projectName) {
        scheduleProjectIntelligenceSync(projectName, [...pendingProjectChangedFiles], reason);
      }
    }
  }

  // 更新顶部横向历史记录显示
  function updateHistoryDisplay() {
    if (!historyList) return;

    const activeProject = sidebar.getActiveChat();
    historyList.innerHTML = "";

    if (!activeProject) {
      historyList.innerHTML = '<span class="history-placeholder">请先选择项目</span>';
      return;
    }

    currentProjectId = activeProject.id;
    const sessions = getSessions(activeProject.id);

    if (sessions.length === 0) {
      historyList.innerHTML = '<span class="history-placeholder">暂无历史对话</span>';
    } else {
      sessions.forEach((session) => {
        const chip = document.createElement("span");
        chip.className = "history-chip";
        if (currentSessionId === session.id) {
          chip.classList.add("active");
        }

        // 对话名称
        const nameSpan = document.createElement("span");
        nameSpan.textContent = session.name;
        chip.appendChild(nameSpan);

        // 叉号按钮
        const closeBtn = document.createElement("button");
        closeBtn.className = "chip-close";
        closeBtn.title = "删除对话";
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteSession(session.id);
        });
        chip.appendChild(closeBtn);

        chip.addEventListener("click", () => {
          currentSessionId = session.id;
          renderMessages();
          updateHistoryDisplay();
        });
        historyList.appendChild(chip);
      });
    }

    // 更新下拉面板列表
    if (historyDropdownList) {
      historyDropdownList.innerHTML = "";
      if (!activeProject || sessions.length === 0) {
        historyDropdownList.innerHTML = '<div class="history-dropdown-item">暂无记录</div>';
      } else {
        sessions.forEach((session) => {
          const item = document.createElement("div");
          item.className = "history-dropdown-item";
          item.textContent = session.name;
          if (currentSessionId === session.id) {
            item.classList.add("active");
          }
          item.addEventListener("click", () => {
            currentSessionId = session.id;
            renderMessages();
            updateHistoryDisplay();
            historyPanel?.classList.remove("active");
          });
          historyDropdownList.appendChild(item);
        });
      }
    }
  }

  // 下拉面板切换
  historyDropdownBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    updateHistoryDisplay();
    historyPanel?.classList.toggle("active");
  });

  // 点击其他地方关闭下拉
  document.addEventListener("click", () => {
    historyPanel?.classList.remove("active");
    closeChatActionMenu();
  });

  // 新建对话按钮（卡片顶部）
  chatNewBtn?.addEventListener("click", async () => {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) {
      const newProject = await sidebar.createChat();
      if (!newProject) return;
      currentProjectId = newProject.id;
    } else {
      currentProjectId = activeProject.id;
    }

    const session = await createSession(currentProjectId);
    currentSessionId = session.id;
    renderMessages();
    updateHistoryDisplay();
  });

  chatActionTrigger?.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = chatActionMenu?.classList.contains("open");
    if (isOpen) {
      closeChatActionMenu();
    } else {
      openChatActionMenu();
    }
  });

  chatActionMenu?.addEventListener("click", (e) => {
    e.stopPropagation();
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-chat-action]")?.dataset.chatAction;
    if (!action) return;
    if (action === "file") {
      chatFileInput?.click();
      closeChatActionMenu();
      return;
    }
    currentChatRunMode = action === "plan" ? "plan" : "goal";
    renderComposerMeta();
    closeChatActionMenu();
  });

  chatFileInput?.addEventListener("change", async () => {
    const files = Array.from(chatFileInput.files || []);
    if (files.length === 0) return;
    const nextAttachments = [...pendingAttachments];
    const maxCount = 6;
    const maxSingleSize = 20 * 1024 * 1024;

    for (const file of files) {
      if (nextAttachments.length >= maxCount) {
        showError(`一次最多附带 ${maxCount} 个文件，多出的文件已忽略。`);
        break;
      }
      if (file.size > maxSingleSize) {
        showError(`文件「${file.name}」超过 20 MB，当前发送链暂不支持。`);
        continue;
      }
      const duplicate = nextAttachments.find((item) =>
        item.name === file.name && item.size === file.size && item.mimeType === file.type);
      if (duplicate) continue;
      nextAttachments.push({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        kind: detectAttachmentKind(file),
        file,
      });
    }
    pendingAttachments = nextAttachments;
    chatFileInput.value = "";
    renderComposerMeta();
  });
  renderComposerMeta();

  const buildSupervisorSessionMessages = (messages: ChatMessage[]): ChatMessage[] =>
    messages.map((message) => {
      if (message.role !== "user") return message;
      return {
        ...message,
        content: formatUserMessageForSupervisor(message.content),
      };
    });

  const buildAttachmentContext = async (
    rawText: string,
    supervisorTransport: { apiKey: string; model: string; endpoint: string; inputModalities: Modality[]; outputModalities: Modality[] },
    attachments: PendingAttachment[],
  ): Promise<string> => {
    if (attachments.length === 0) return "";

    const imageAttachments = attachments.filter((item) => item.kind === "image");
    const textAttachments = attachments.filter((item) => item.kind === "text");
    const unsupportedMedia = attachments.filter((item) => item.kind === "video" || item.kind === "audio");
    const genericFiles = attachments.filter((item) => item.kind === "file");
    const sections: string[] = [];

    if (imageAttachments.length > 0) {
      if (!supervisorTransport.inputModalities.includes("image")) {
        const available = findKeysByModality({ input: ["image"] });
        const suggestion = available.length > 0 ? ` 可切换到支持图像输入的密钥，例如：${available.slice(0, 3).map((item) => item.data.label).join("、")}。` : "";
        throw new Error(`当前主管模型不支持图像输入，无法直接分析图片附件。${suggestion}`);
      }
      if (supervisorTransport.endpoint.includes("/v1/messages")) {
        throw new Error("当前多模态直读桥接暂未接入 Anthropic Messages 协议，请先切换到 OpenAI 兼容端点后再发送图片。");
      }
      try {
        const messageParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> = [
          {
            type: "text",
            text: `请先结合用户问题，提炼这些图片附件里与任务最相关的信息，输出精炼要点，供后续专家协作继续使用。\n\n用户请求：${rawText || "请结合附件处理当前任务。"}`,
          },
        ];
        for (const attachment of imageAttachments) {
          const dataUrl = await readFileAsDataUrl(attachment.file);
          messageParts.push({
            type: "image_url",
            image_url: { url: dataUrl, detail: "high" },
          });
        }
        const summaryJson = await invoke<string>("chat_multimodal", {
          messages: [{ role: "user", content: messageParts }],
          apiKey: supervisorTransport.apiKey,
          model: supervisorTransport.model,
          endpoint: supervisorTransport.endpoint,
        });
        const summary = JSON.parse(summaryJson) as { content?: string };
        if (summary.content?.trim()) {
          sections.push(`[图片附件理解]\n${summary.content.trim()}`);
        }
      } catch (error) {
        throw new Error(`图片附件分析失败：${String(error)}`);
      }
    }

    if (textAttachments.length > 0) {
      const textLines: string[] = [];
      for (const attachment of textAttachments) {
        try {
          const content = await readFileAsText(attachment.file);
          const excerpt = content.slice(0, 6000);
          textLines.push(`### ${attachment.name}\n${excerpt}${content.length > excerpt.length ? "\n...[内容已截断]" : ""}`);
        } catch (error) {
          textLines.push(`### ${attachment.name}\n[读取失败] ${String(error)}`);
        }
      }
      sections.push(`[文本附件内容]\n${textLines.join("\n\n")}`);
    }

    if (genericFiles.length > 0) {
      sections.push(`[文件附件元数据]\n${genericFiles.map((item) => `- ${item.name}（${item.mimeType || "未知类型"}，${formatFileSize(item.size)}）`).join("\n")}`);
    }

    if (unsupportedMedia.length > 0) {
      const lackingVideo = unsupportedMedia.some((item) => item.kind === "video" && !supervisorTransport.inputModalities.includes("video"));
      const lackingAudio = unsupportedMedia.some((item) => item.kind === "audio" && !supervisorTransport.inputModalities.includes("audio"));
      const missingKinds = [lackingVideo ? "视频" : "", lackingAudio ? "音频" : ""].filter(Boolean).join("、");
      throw new Error(
        missingKinds
          ? `当前主管模型未声明 ${missingKinds} 输入能力，无法直接解析这类附件。请切换到支持对应模态的密钥，或先改传截图、转写文本后再发送。`
          : "当前版本的多模态直读链已支持图片与文本附件；音视频附件还需要接入支持对应模态的兼容端点后才能直接解析。"
      );
    }

    return sections.join("\n\n").trim();
  };

  // 发送消息
  async function sendMessage() {
    const text = chatInput?.value.trim() || "";
    if (!text && pendingAttachments.length === 0) return;
    const displayText = text || "请结合我附带的文件处理当前任务。";
    await reportFrontendE2ECheckpoint("sendMessage:start", { promptPreview: text.slice(0, 120) });

    // 核心角色密钥校验：江星图/江星河/江青澜/江若溪/江映秋 必须全部配置密钥
    if (!isCoreKeyConfigured()) {
      await reportFrontendE2ECheckpoint("sendMessage:missing-core-key");
      const names = getUnconfiguredCoreNames();
      showError(`核心角色「${names.join("、")}」未配置密钥，请先在设置 → 专家团配置中为它们绑定 API 密钥`);
      return;
    }

    const activeProject = sidebar.getActiveChat();
    if (!activeProject) {
      // 没有活跃项目，自动创建一个
      const newProject = await sidebar.createChat();
      if (!newProject) return;
      currentProjectId = newProject.id;
    } else {
      currentProjectId = activeProject.id;
    }

    // 确保有会话
    const sessions = getSessions(currentProjectId);
    if (!currentSessionId || !sessions.find((s) => s.id === currentSessionId)) {
      const session = await createSession(currentProjectId);
      currentSessionId = session.id;
    }

    const session = sessions.find((s) => s.id === currentSessionId)!;
    const attachmentMeta = pendingAttachments.map((item) => ({
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      kind: item.kind,
    }));
    session.messages.push({
      role: "user",
      content: buildUserMessagePayloadText(displayText, currentChatRunMode, attachmentMeta),
    });

    // 保存用户消息到数据库
    await reportFrontendE2ECheckpoint("sendMessage:before-save-user");
    await saveSessionToDb(currentSessionId, currentProjectId);
    await reportFrontendE2ECheckpoint("sendMessage:after-save-user", {
      currentProjectId,
      currentSessionId,
    });

    // 保存用户意图到 Ephemeral 记忆
    const projectForMemory = sidebar.getActiveChat();
    if (projectForMemory) {
      saveUserIntentMemory(projectForMemory.name, currentProjectId, displayText).catch(console.error);
    }

    // 清空输入框
    chatInput.value = "";
    chatInput.style.height = "auto";
    const attachmentsForThisTurn = [...pendingAttachments];
    pendingAttachments = [];
    renderComposerMeta();

    // 显示用户消息
    renderMessages();
    updateHistoryDisplay();
    await reportFrontendE2ECheckpoint("sendMessage:after-render-user");

    // 获取主管（江星图）的 API 密钥
    const supervisorKey = getExpertApiKey("jiang-xingtu");
    const supervisorModel = getExpertModel("jiang-xingtu");
    if (!supervisorKey) {
      await reportFrontendE2ECheckpoint("sendMessage:missing-supervisor-key");
      showError("主管「江星图」未配置密钥，请在设置中绑定");
      session.messages.push({ role: "assistant", content: "请先为「江星图」配置 API 密钥。" });
      renderMessages();
      return;
    }

    const supervisorTransport = resolveKeyTransport(getExpertKeyId("jiang-xingtu"));
    if (!supervisorTransport) {
      showError("主管「江星图」当前绑定的密钥缺少模型或端点信息，无法继续发送。");
      session.messages.push({ role: "assistant", content: "主管当前绑定的密钥配置不完整，请在设置中重新配置后再试。" });
      renderMessages();
      return;
    }

    let effectiveText = applyRunModeToPrompt(displayText, currentChatRunMode);
    if (attachmentsForThisTurn.length > 0) {
      try {
        const attachmentContext = await buildAttachmentContext(displayText, supervisorTransport, attachmentsForThisTurn);
        if (attachmentContext) {
          effectiveText = `${effectiveText}\n\n${attachmentContext}`;
        }
      } catch (error) {
        const errorMessage = String(error);
        showError(errorMessage);
        session.messages.push({ role: "assistant", content: errorMessage });
        await saveSessionToDb(currentSessionId, currentProjectId);
        renderMessages();
        return;
      }
    }
    const supervisorSessionMessages = buildSupervisorSessionMessages(session.messages);
    const supervisorCurrentMessages = [
      ...supervisorSessionMessages.slice(0, -1),
      { role: "user", content: effectiveText } as ChatMessage,
    ];

    // 如果流水线正在执行：将新消息作为增量提交
    if (pipelineRunning) {
      showLoading("主管正在分析补充要求...");
      try {
        const decision = await analyzeFollowupIntent(
          effectiveText,
          currentDispatchPlan!,
          supervisorKey,
          getExpertKeyId("jiang-xingtu") || "jiang-xingtu",
          supervisorModel
        );
        const followupExperts = (decision.targetExpertIds || [])
          .map((id) => getAvailableExpertInfos().find((item) => item.id === id)?.name || id);
        const followupTargetText = followupExperts.length > 0
          ? `我会直接转给 ${followupExperts.join("、")}。`
          : "我会直接并入当前这轮专家协作。";
        const appendFollowup = (message: string, resetTask = false) => {
          if (resetTask && currentDispatchPlan) {
            currentDispatchPlan.taskDescription = message;
            pendingFollowups.length = 0;
          }
          pendingFollowups.push({
            id: `followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            message,
            targetExpertIds: decision.targetExpertIds || [],
            deliveryMode: decision.deliveryMode || "next-relevant",
            consumedBy: [],
            createdAt: Date.now(),
          });
        };
        let reply = "";
        const progressReport = await buildProgressReport();

        switch (decision.action) {
          case "respond":
            reply = decision.reply || `${progressReport}\n\n我会继续盯着当前这轮执行。`;
            break;
          case "replace":
            appendFollowup(decision.taskDescription || effectiveText, true);
            reply = `我已按你的最新意思改写当前任务目标，并会直接同步给对应专家。${followupTargetText}\n\n${progressReport}`;
            break;
          case "respond-and-append":
            appendFollowup(decision.taskDescription || effectiveText);
            reply = decision.reply || `我已经理解你的插话，并会直接转给对应专家处理。${followupTargetText}\n\n${progressReport}`;
            break;
          case "respond-and-replace":
            appendFollowup(decision.taskDescription || effectiveText, true);
            reply = decision.reply || `我已按你的更正更新当前任务方向，并会直接同步给对应专家。${followupTargetText}\n\n${progressReport}`;
            break;
          case "append":
          default:
            appendFollowup(decision.taskDescription || effectiveText);
            reply = `已收到新消息。当前专家团执行中，我会直接把这条补充交给对应专家。${followupTargetText}\n\n${progressReport}`;
            break;
        }

        session.messages.push({ role: "assistant", content: reply });
        await saveSessionToDb(currentSessionId, currentProjectId);
      } catch (e) {
        log("WARN", `增量意图分析失败: ${e}`);
        pendingFollowups.push({
          id: `followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          message: effectiveText,
          targetExpertIds: [],
          deliveryMode: "all-remaining",
          consumedBy: [],
          createdAt: Date.now(),
        });
        session.messages.push({ role: "assistant", content: "已记录你的补充要求，我会继续并入当前这轮专家协作里处理。" });
      } finally {
        hideLoading();
        renderMessages();
      }
      return;
    }

    // === 主管意图分析 ===
    showLoading("主管正在安排合适的专家...");
    let dispatchPlan: DispatchPlan;
    try {
      await reportFrontendE2ECheckpoint("sendMessage:before-artifact-followup");
      const artifactFollowupPlan = await buildArtifactFollowupPlan(
        effectiveText,
        supervisorSessionMessages.slice(0, -1),
        activeProject?.name,
        activeProject?.workspacePath
      );
      await reportFrontendE2ECheckpoint("sendMessage:after-artifact-followup", {
        matchedArtifactFollowup: !!artifactFollowupPlan,
      });
      if (artifactFollowupPlan) {
        dispatchPlan = artifactFollowupPlan;
        log("INFO", `产物追改命中增量开发分流：scene=${dispatchPlan.scene}, experts=[${dispatchPlan.expertIds.join(",")}]`);
      } else {
        // 构建对话历史上下文（排除当前用户消息，避免重复）
        // 可用专家列表（不含主管和助手）
        const availableExperts = getAvailableExpertInfos();

        await reportFrontendE2ECheckpoint("sendMessage:before-supervisor-analyze");
        dispatchPlan = await supervisorPrepareAndAnalyzeDispatch(
          effectiveText,
          supervisorSessionMessages.slice(0, -1),
          availableExperts,
          {
            name: activeProject?.name,
            workspacePath: activeProject?.workspacePath,
            projectId: currentProjectId ?? undefined,
            currentSessionLabel: currentSessionId ? `对话 ${currentSessionId}` : "未命名对话",
          },
          supervisorKey,
          getExpertKeyId("jiang-xingtu") || "jiang-xingtu",
          supervisorModel
        );
        await reportFrontendE2ECheckpoint("sendMessage:after-supervisor-analyze", {
          scene: dispatchPlan.scene,
          expertCount: dispatchPlan.expertIds.length,
        });
        log("INFO", `主管决策：scene=${dispatchPlan.scene}, experts=[${dispatchPlan.expertIds.join(",")}]`);
      }
    } catch (e) {
      await reportFrontendE2ECheckpoint("sendMessage:dispatch-plan-error", {
        error: String(e),
      });
      log("ERROR", `主管意图分析失败: ${e}`);
      dispatchPlan = { scene: "quick-answer", taskDescription: effectiveText, expertIds: [] };
    }

    // === 根据场景执行 ===
    let finalReply: string;
    let actionExecutionSources: Array<{ content: string; expertId: string; expertName: string; expertTitle: string }> = [];
    let deliverableMarkdownPath: string | null = null;

    if (dispatchPlan.scene === "quick-answer" || dispatchPlan.expertIds.length === 0) {
      // 简单问题：主管直接回答
      try {
        await reportFrontendE2ECheckpoint("sendMessage:before-quick-answer");
        const reply = await supervisorPrepareQuickAnswer(
          supervisorCurrentMessages,
          {
            name: activeProject?.name,
            workspacePath: activeProject?.workspacePath,
            currentSessionLabel: currentSessionId ? `对话 ${currentSessionId}` : "未命名对话",
          },
          supervisorKey,
          getExpertKeyId("jiang-xingtu") || "jiang-xingtu",
          getExpertModel("jiang-xingtu")
        );
        await reportFrontendE2ECheckpoint("sendMessage:after-quick-answer");

        finalReply = reply;
      } catch (e) {
        await reportFrontendE2ECheckpoint("sendMessage:quick-answer-error", {
          error: String(e),
        });
        finalReply = `抱歉，请求出错：${e}`;
      }
    } else {
      // 专家协作执行：按主管动态分配的专家逐步推进
      pipelineRunning = true;
      currentDispatchPlan = dispatchPlan;
      pendingFollowups = [];
      hideLoading();
      const activeProjectForPipeline = sidebar.getActiveChat();
      const preparedLaunch = await preparePipelineLaunch(
        dispatchPlan,
        activeProjectForPipeline?.name,
        activeProjectForPipeline?.workspacePath,
        pendingFollowups,
      );
      if (preparedLaunch.narrative?.trim()) {
        session.messages.push({ role: "assistant", content: preparedLaunch.narrative.trim() });
        renderMessages();
      }
      // 立即渲染所有专家的 pending 卡片，让用户看到专家团正在加入
      const joiningTasks: ExpertTask[] = preparedLaunch.joiningTasks;
      window.dispatchEvent(new CustomEvent("expert-tasks-update", { detail: { tasks: joiningTasks } }));

      try {
        // 执行流水线（onProgress 回调实时更新 UI，主管中途检查）
        let currentPipelineTasks: ExpertTask[] = [];
        await reportFrontendE2ECheckpoint("sendMessage:before-pipeline", {
          scene: dispatchPlan.scene,
          expertCount: dispatchPlan.expertIds.length,
        });
        const pipelineResult = await executePipeline(
          dispatchPlan,
          getExpertApiKey,
          getExpertModel,
          (tasks: ExpertTask[]) => {
            // 实时渲染专家任务卡片（通过全局事件）
            currentPipelineTasks = tasks;
            window.dispatchEvent(new CustomEvent("expert-tasks-update", { detail: { tasks } }));
            if (frontendE2ERunning) {
              const finished = tasks.filter((item) => item.status === "done").length;
              const failed = tasks.filter((item) => item.status === "error").length;
              const running = tasks.filter((item) => item.status === "running").length;
              const latest = tasks[tasks.length - 1];
              void reportFrontendE2ECheckpoint("pipeline:tasks-update", {
                finishedTasks: finished,
                failedTasks: failed,
                runningTasks: running,
                latestExpert: latest?.expertName || "",
                latestStatus: latest?.status || "",
              });
            }
          },
          {
            pipelineId: preparedLaunch.pipelineId,
            layout: preparedLaunch.layout,
            state: preparedLaunch.state,
          },
          activeProjectForPipeline?.name,
          activeProjectForPipeline?.id,
          activeProjectForPipeline?.workspacePath,
          supervisorKey,
          supervisorModel,
          (action: string, reason?: string) => {
            // 主管中途决策只写入日志，不进入聊天消息，避免元数据泄露。
            const actionLabels: Record<string, string> = {
              "continue": "继续执行下一步",
              "retry": "要求重新执行当前步骤",
              "skip-next": "跳过下一步",
              "abort": "终止流水线",
            };
            const label = actionLabels[action] || action;
            const reasonText = reason ? `：${reason}` : "";
            log("INFO", `主管中途检查 ${label}${reasonText}`);
          },
          (progress: { expertId: string; phase: string; detail: string }) => {
            const task = currentPipelineTasks.find(t => t.expertId === progress.expertId);
            if (task) {
              task.phase = progress.phase;
              task.phaseDetail = progress.detail;
              window.dispatchEvent(new CustomEvent("expert-tasks-update", { detail: { tasks: [...currentPipelineTasks] } }));
            }
            if (frontendE2ERunning) {
              void reportFrontendE2ECheckpoint("pipeline:expert-progress", {
                expertId: progress.expertId,
                phase: progress.phase,
                detail: progress.detail,
              });
            }
          },
          (event: ExpertToolEvent) => {
            if (frontendE2ERunning) {
              void reportFrontendE2ECheckpoint("pipeline:tool-event", {
                toolEventKind: event.kind,
                toolEventStatus: event.status,
                toolEventExpertId: event.expertId,
                toolEventReason: event.reason.slice(0, 120),
              });
            }
            appendToolEventToCurrentSession(
              event.kind === "web-search"
                ? {
                  kind: "web-search",
                  createdAt: Date.now(),
                  initiator: {
                    expertId: event.expertId,
                    expertName: event.expertName,
                    expertTitle: event.expertTitle,
                  },
                  reason: event.reason,
                  query: event.query,
                  status: event.status,
                  results: event.results,
                  error: event.error,
                }
                : {
                  kind: "command",
                  createdAt: Date.now(),
                  initiator: {
                    expertId: event.expertId,
                    expertName: event.expertName,
                    expertTitle: event.expertTitle,
                  },
                  reason: event.reason,
                  command: event.command,
                  workingDir: event.workingDir,
                  authMode: event.authMode,
                  status: event.status,
                  safetyReason: event.safetyReason,
                  output: event.output,
                  error: event.error,
                }
            ).catch(console.error);
          },
          async (request: ExpertCommandAuthorizationRequest) => {
            if (frontendE2ERunning) {
              await reportFrontendE2ECheckpoint("pipeline:awaiting-command-auth", {
                authExpertId: request.expertId,
                authMode: request.authMode,
                authCommand: request.command.slice(0, 200),
                authWorkingDir: request.workingDir,
              });
              await appendFrontendE2ELog(`自动授权命令：${request.command}`);
              return true;
            }
            return showCommandAuthDialog(
              request.command,
              request.workingDir,
              request.reason,
              `${request.expertName}（${request.expertTitle}）`,
              request.authMode,
              request.safetyReason
            );
          }
        );
        await reportFrontendE2ECheckpoint("sendMessage:after-pipeline", {
          taskCount: pipelineResult.tasks.length,
          pipelineId: pipelineResult.pipelineId,
        });
        const expertResults = pipelineResult.tasks;
        const pipelineId = pipelineResult.pipelineId;
        actionExecutionSources = compactLatestActionSources(expertResults
          .filter((t) => !!t.output)
          .map((t) => ({
            content: t.output || "",
            expertId: t.expertId,
            expertName: t.expertName,
            expertTitle: t.expertTitle,
          })));

        // 将专家卡片快照作为消息推入会话历史（作为对话的一部分永久保留）
        session.messages.push({
          role: "expert-tasks",
          content: JSON.stringify(expertResults.map((t) => ({
            id: t.id,
            expertId: t.expertId,
            expertName: t.expertName,
            expertTitle: t.expertTitle,
            status: t.status,
            input: t.input,
            output: t.output,
            error: t.error,
            dispatchWave: t.dispatchWave,
          }))),
        });

        // 主管审核所有专家结果，并由后端统一做交付真实性校验
        showLoading("主管正在审核专家成果...");
        await reportFrontendE2ECheckpoint("sendMessage:before-supervisor-review");
        const finalizedDelivery = await finalizePipelineDelivery(
          dispatchPlan.taskDescription,
          pendingFollowups.map((item) => item.message),
          expertResults,
          actionExecutionSources,
          {
            workspacePath: activeProjectForPipeline?.workspacePath,
            requireRealMutations: !!activeProjectForPipeline?.workspacePath
              && dispatchPlan.expertIds.some((expertId) => isImplementationDisciplineExpert(expertId)),
          },
          supervisorKey,
          getExpertKeyId("jiang-xingtu") || "jiang-xingtu",
          supervisorModel
        );
        finalReply = finalizedDelivery.reply;
        await reportFrontendE2ECheckpoint("sendMessage:after-supervisor-review");

        // 生成交付清单 Markdown，供自动跳转到文件页直接预览
        if (activeProjectForPipeline?.name && pipelineId) {
          try {
            const { generateDeliverable, getDeliverableMarkdownPath } = await import("./task-tracker");
            await generateDeliverable(
              activeProjectForPipeline.name,
              pipelineId,
              dispatchPlan.taskDescription,
              expertResults
            );
            deliverableMarkdownPath = getDeliverableMarkdownPath(pipelineId);
          } catch (error) {
            console.error("生成交付清单失败:", error);
          }
        }

        if (activeProjectForPipeline?.name) {
          runMemoryLifecycle(activeProjectForPipeline.name).catch(console.error);
        }

      } catch (e) {
        await reportFrontendE2ECheckpoint("sendMessage:pipeline-error", {
          error: String(e),
        });
        log("ERROR", `专家协作执行失败: ${e}`);
        finalReply = `专家团执行出错：${e}`;
      } finally {
        pipelineRunning = false;
        currentDispatchPlan = null;
      }
    }

    // 解析专家原始输出中的结构化 ChangeSet/ACTION，直接执行文件变更。
    await reportFrontendE2ECheckpoint("sendMessage:before-execute-actions");
    const actionExecutionResult = await executeAgentActions(
      actionExecutionSources.length > 0
        ? actionExecutionSources
        : [{ content: finalReply, expertId: "jiang-xingtu", expertName: "江星图", expertTitle: "主管" }],
      effectiveText,
      { emitSummaryMessage: false }
    );
    const activeProjectAfterActions = sidebar.getActiveChat();
    finalReply = await reconcileSupervisorReplyWithWorkspaceFacts(
      finalReply,
      effectiveText,
      activeProjectAfterActions,
      actionExecutionResult
    );

    // 主管最终回复极简化：剥离代码块与元数据，仅保留一句交付语
    const sanitizedReply = sanitizeSupervisorReply(finalReply);

    // 将最终回复推入会话，确保主管汇报始终出现在协作记录之后
    session.messages.push({ role: "assistant", content: sanitizedReply });
    const actionExecutionSummary = buildAgentActionExecutionSummaryMessage(actionExecutionResult);
    if (actionExecutionSummary) {
      session.messages.push({ role: "assistant", content: actionExecutionSummary });
    }

    // 保存到数据库
    await reportFrontendE2ECheckpoint("sendMessage:before-save-assistant");
    await saveSessionToDb(currentSessionId, currentProjectId);
    await reportFrontendE2ECheckpoint("sendMessage:after-save-assistant");

    hideLoading();
    // 移除运行中的实时卡片占位（已通过 expert-tasks 消息持久化）
    document.getElementById("chat-messages")?.querySelector('.expert-tasks-group[data-live="true"]')?.remove();
    renderMessages();
    const autoOpenPath = pickAutoOpenGeneratedFilePath(actionExecutionResult.touchedFiles, deliverableMarkdownPath);
    if (autoOpenPath) {
      void (window as any).openFilePreview?.(autoOpenPath);
    }
    await reportFrontendE2ECheckpoint("sendMessage:completed");
  }

  // ========== 流式渲染支持 ==========
  let currentStreamDiv: HTMLElement | null = null;
  let currentStreamContent = '';

  listen<{ stream_id: string; token: string }>('llm-stream-token', (event) => {
    if (!currentStreamDiv) {
      currentStreamDiv = createStreamingMessageBubble();
      currentStreamContent = '';
    }
    currentStreamContent += event.payload.token;
    updateStreamingContent(currentStreamDiv, currentStreamContent);
  });

  listen<{ stream_id: string }>('llm-stream-done', () => {
    if (currentStreamDiv) {
      finalizeStreamingMessage(currentStreamDiv, currentStreamContent);
      currentStreamDiv = null;
      currentStreamContent = '';
    }
  });

  listen<{ stream_id: string; error: string }>('llm-stream-error', (event) => {
    if (currentStreamDiv) {
      currentStreamDiv.classList.add('error');
      currentStreamDiv.innerHTML += `<div class="stream-error">\u26A0\uFE0F ${escapeHtml(event.payload.error)}</div>`;
      currentStreamDiv = null;
      currentStreamContent = '';
    }
  });

  function createStreamingMessageBubble(): HTMLElement {
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message assistant streaming';
    msgEl.innerHTML = `<div class="assistant-panel"><div class="msg-text"></div></div>`;
    chatMessages?.appendChild(msgEl);
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    return msgEl;
  }

  function updateStreamingContent(div: HTMLElement, content: string): void {
    const textEl = div.querySelector('.msg-text');
    if (textEl) {
      textEl.textContent = content;
    }
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function finalizeStreamingMessage(div: HTMLElement, content: string): void {
    div.classList.remove('streaming');
    const panel = div.querySelector('.assistant-panel');
    if (panel) {
      panel.innerHTML = renderAiMessage(content);
    }
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ========== Pipeline 进度面板 ==========
  interface PipelineProgress {
    pipelineScene: string;
    currentStep: number;
    totalSteps: number;
    currentExpertId: string;
    currentExpertName: string;
    currentToolRound: number;
    status: 'running' | 'tool-calling' | 'waiting-approval' | 'completed' | 'error';
  }

  listen<PipelineProgress>('pipeline-progress', (event) => {
    updatePipelineProgress(event.payload);
  });

  function updatePipelineProgress(progress: PipelineProgress): void {
    document.getElementById('pipeline-progress-panel')?.remove();
    void progress;
  }

  // ========== 工具调用实时展示 ==========
  listen<{ expertId: string; toolName: string; args: Record<string, unknown> }>('tool-call-start', (event) => {
    const toolDiv = showToolCallInChat(event.payload.expertId, event.payload.toolName, event.payload.args);
    toolDiv.dataset.toolId = `${event.payload.expertId}-${Date.now()}`;
  });

  listen<{ expertId: string; toolName: string; result: string; success: boolean }>('tool-call-end', (event) => {
    const indicators = document.querySelectorAll<HTMLElement>('.tool-call-indicator');
    const last = indicators[indicators.length - 1];
    if (last) {
      updateToolCallResult(last, event.payload.result, event.payload.success);
    }
  });

  function showToolCallInChat(_expertId: string, toolName: string, args: unknown): HTMLElement {
    const toolDiv = document.createElement('div');
    toolDiv.className = 'tool-call-indicator';
    toolDiv.innerHTML = `
      <div class="tool-call-header" onclick="this.parentElement.classList.toggle('expanded')">
        <span class="tool-icon">\uD83D\uDD27</span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="tool-status spinning">\u6267\u884C\u4E2D...</span>
      </div>
      <div class="tool-call-details">
        <pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>
      </div>
    `;
    chatMessages?.appendChild(toolDiv);
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    return toolDiv;
  }

  function updateToolCallResult(toolDiv: HTMLElement, result: string, success: boolean): void {
    const status = toolDiv.querySelector('.tool-status');
    if (status) {
      status.classList.remove('spinning');
      status.textContent = success ? '\u2713 \u5B8C\u6210' : '\u2717 \u5931\u8D25';
      status.className = `tool-status ${success ? 'success' : 'error'}`;
    }
    const details = toolDiv.querySelector('.tool-call-details');
    if (details) {
      details.innerHTML += `<div class="tool-result ${success ? '' : 'error'}">${escapeHtml(result.slice(0, 500))}</div>`;
    }
  }

  // ========== 审批弹窗 ==========
  listen<{ command: string; reason: string; requestId: string }>('approval-request', async (event) => {
    const decision = await showApprovalDialog(event.payload.command, event.payload.reason);
    await invoke('record_tool_approval', {
      command: event.payload.command,
      decision: decision,
    });
  });

  function showApprovalDialog(command: string, reason: string): Promise<string> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'approval-overlay';
      overlay.innerHTML = `
        <div class="approval-dialog">
          <h3>\uD83D\uDD12 \u547D\u4EE4\u6267\u884C\u786E\u8BA4</h3>
          <p class="approval-reason">${escapeHtml(reason || '\u6B64\u547D\u4EE4\u9700\u8981\u786E\u8BA4\u540E\u6267\u884C')}</p>
          <div class="approval-command">
            <code>${escapeHtml(command)}</code>
          </div>
          <div class="approval-actions">
            <button class="btn-approve" data-action="approved">\u5141\u8BB8\u6267\u884C</button>
            <button class="btn-approve-always" data-action="approved_always">\u603B\u662F\u5141\u8BB8\u6B64\u7C7B\u547D\u4EE4</button>
            <button class="btn-deny" data-action="denied">\u62D2\u7EDD</button>
          </div>
        </div>
      `;

      overlay.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          resolve((btn as HTMLElement).dataset.action || 'denied');
          overlay.remove();
        });
      });

      document.body.appendChild(overlay);
    });
  }

  // ========== Agent 动作解析与执行 ==========
  interface AgentActionSource {
    content: string;
    expertId: string;
    expertName: string;
    expertTitle: string;
  }

  function compactLatestActionSources(
    sources: AgentActionSource[]
  ): AgentActionSource[] {
    const latestByExpert = new Map<string, AgentActionSource>();
    const latestMutationByExpert = new Map<string, AgentActionSource>();
    const hasExecutableMutationPayload = (content: string) =>
      /\[ACTION:(?:CREATE_FOLDER|DELETE):[^\]]+\]/i.test(content)
      || /\[ACTION:(?:CREATE_FOLDER|DELETE)\s+[^\]]*path="/i.test(content)
      || /\[ACTION:(?:CREATE_FILE|WRITE_FILE)(?::[^\]]+|\s+[^\]]*)\]\s*```/i.test(content)
      || /\[ACTION:(?:CREATE_FILE|WRITE_FILE)\s+[^\]]*content=(?:"[\s\S]*?"|'[\s\S]*?')\]/i.test(content)
      || /\[ACTION:EDIT_FILE(?::[^\]]+|\s+[^\]]*)\](?:\*\*)?\s*```(?:search|replace|\w+)/i.test(content)
      || /\[ACTION:EDIT_FILE\s+[^\]]*(?:searchText|replaceText)=(?:"[\s\S]*?"|'[\s\S]*?')/i.test(content)
      || /"changes"\s*:|"operation"\s*:\s*"(?:create_file|write_file|edit_file|create_folder|delete)"/i.test(content);
    for (const source of sources) {
      if (!source.content?.trim()) continue;
      latestByExpert.set(source.expertId, source);
      if (hasExecutableMutationPayload(source.content)) {
        latestMutationByExpert.set(source.expertId, source);
      }
    }
    return [...latestByExpert.keys()].map((expertId) =>
      latestMutationByExpert.get(expertId) || latestByExpert.get(expertId)!
    );
  }

  interface AgentAction {
    type: "CREATE_FOLDER" | "CREATE_FILE" | "WRITE_FILE" | "EDIT_FILE" | "DELETE" | "INDEX_BUILD" | "INDEX_SEARCH"
      | "WEB_SEARCH" | "EXECUTE_CMD" | "READ_DOCUMENT" | "WRITE_DOCUMENT" | "GENERATE_IMAGE"
      | "SWITCH_VIEW" | "OPEN_BROWSER" | "CANVAS_ADD_NODE" | "CANVAS_CONNECT" | "TIMELINE_ADD" | "TIMELINE_CUT";
    path: string;
    content?: string;
    searchText?: string;
    replaceText?: string;
    params?: Record<string, string>;
    sourceExpertId: string;
    sourceExpertName: string;
    sourceExpertTitle: string;
    requestReason?: string;
  }

  function isFileMutationAction(action: AgentAction): boolean {
    return action.type === "CREATE_FILE"
      || action.type === "WRITE_FILE"
      || action.type === "EDIT_FILE"
      || action.type === "CREATE_FOLDER"
      || action.type === "DELETE";
  }

  function parseLabeledEditPayload(payload: string): { searchText: string; replaceText: string } | null {
    const normalized = payload.replace(/\r\n/g, "\n").trim();
    const match = normalized.match(/^\s*searchText:\s*([\s\S]*?)\n\s*replaceText:\s*([\s\S]*)$/i);
    if (!match) return null;
    const searchText = match[1].trim();
    const replaceText = match[2].trim();
    if (!searchText) return null;
    return { searchText, replaceText };
  }

  function parseTaggedEditPayload(payload: string): { searchText: string; replaceText: string } | null {
    const normalized = payload.replace(/\r\n/g, "\n").trim();
    const match = normalized.match(/^\s*<searchText>\s*([\s\S]*?)\s*<\/searchText>\s*<replaceText>\s*([\s\S]*?)\s*<\/replaceText>\s*$/i);
    if (!match) return null;
    const searchText = match[1].trimEnd();
    const replaceText = match[2].trimEnd();
    if (!searchText || !replaceText) return null;
    return { searchText, replaceText };
  }

  function parseAnnotatedEditPayload(payload: string): { searchText: string; replaceText: string } | null {
    const normalized = payload.replace(/\r\n/g, "\n").trim();
    const match = normalized.match(
      /^\s*(?:(?:\/\*|<!--)\s*[^\n]*(?:搜索块|当前|原始|旧|before|search)[^\n]*(?:\*\/|-->)\s*)([\s\S]*?)\s*(?:(?:\/\*|<!--)\s*[^\n]*(?:替换|改为|修改后|after|replace)[^\n]*(?:\*\/|-->)\s*)([\s\S]*)$/i
    );
    if (!match) return null;
    const searchText = match[1].trimEnd();
    const replaceText = match[2].trimEnd();
    if (!searchText || !replaceText) return null;
    return { searchText, replaceText };
  }

  function decodeActionParamValue(value: string): string {
    return value
      .replace(/'\\''/g, "'")
      .replace(/\\"/g, "\"")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n");
  }

  interface InlineActionParamBlock {
    type: string;
    raw: string;
    paramsStr: string;
    legacyArg?: string;
    params: Record<string, string>;
  }

  interface AgentActionExecutionResult {
    applied: number;
    failed: number;
    fileMutationsApplied: number;
    folderOpsApplied: number;
    touchedFiles: string[];
    errors: string[];
  }

  interface AgentDeliveryAnalysis {
    parsedActionCount: number;
    structuredChangeCount: number;
    requiredFiles: string[];
    executableMutations: Array<{ actionType: string; path: string }>;
    hasExecutableMutation: boolean;
    hasSourceMutation: boolean;
    workspaceIssues: string[];
  }

  async function analyzeAgentDelivery(
    sources: Array<{ content: string; expertId?: string; expertName?: string; expertTitle?: string }>,
    userTaskText: string,
    workspacePath?: string | null
  ): Promise<AgentDeliveryAnalysis> {
    const raw = await invoke<string>("analyze_agent_delivery", {
      sourcesJson: JSON.stringify(sources.map((source) => ({ content: source.content }))),
      userTaskText,
      workspacePath: workspacePath || null,
    });
    return JSON.parse(raw) as AgentDeliveryAnalysis;
  }

  function appendCleanSystemMessage(text: string): void {
    if (!currentProjectId || !currentSessionId) return;
    const sessions = projectSessions.get(currentProjectId);
    const session = sessions?.find((s) => s.id === currentSessionId);
    if (!session) return;
    session.messages.push({ role: "assistant", content: text });
    renderMessages();
  }

  function buildAgentActionExecutionSummaryMessage(result: AgentActionExecutionResult): string | null {
    if (result.failed > 0) {
      const topErrors = result.errors.slice(0, 5).map((item, index) => `${index + 1}. ${item}`).join("\n");
      return `部分文件变更未成功（成功 ${result.applied}，失败 ${result.failed}）：\n${topErrors}`;
    }
    if (result.folderOpsApplied > 0) {
      return `已完成 ${result.folderOpsApplied} 项目录准备动作，但尚未写入项目源码。`;
    }
    return null;
  }

  function emitAgentActionExecutionSummary(result: AgentActionExecutionResult): void {
    const text = buildAgentActionExecutionSummaryMessage(result);
    if (text) {
      appendCleanSystemMessage(text);
    }
  }

  function pickAutoOpenGeneratedFilePath(
    touchedFiles: string[],
    deliverablePath?: string | null,
  ): string | null {
    const seen = new Set<string>();
    const candidates = [deliverablePath || "", ...touchedFiles]
      .map((item) => item.trim())
      .filter((item) => !!item && !item.startsWith(".xt/") && !item.startsWith(".xt\\"))
      .filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
    if (candidates.length === 0) return null;

    const priorityGroups = [
      candidates.filter((item) => isMarkdownFile(item)),
      candidates.filter((item) => isWebPreviewFile(item)),
      candidates,
    ];

    for (const group of priorityGroups) {
      if (group.length > 0) return group[0];
    }
    return null;
  }

  async function verifyWorkspaceDeliveryAgainstTask(
    userTaskText: string,
    project: { name: string; workspacePath?: string | null } | null,
    actionResult: AgentActionExecutionResult
  ): Promise<string[]> {
    if (!project?.workspacePath) return [];
    if (actionResult.failed > 0) {
      return ["仍有文件变更执行失败，项目源码未被完整写入"];
    }

    try {
      const analysis = await analyzeAgentDelivery([], userTaskText, project.workspacePath);
      return Array.isArray(analysis.workspaceIssues)
        ? analysis.workspaceIssues.map((item) => String(item))
        : [];
    } catch (error) {
      return [`无法验证项目交付结果：${String(error)}`];
    }
  }

  async function reconcileSupervisorReplyWithWorkspaceFacts(
    originalReply: string,
    userTaskText: string,
    project: { name: string; workspacePath?: string | null } | null,
    actionResult: AgentActionExecutionResult
  ): Promise<string> {
    const issues = await verifyWorkspaceDeliveryAgainstTask(userTaskText, project, actionResult);
    if (issues.length === 0) {
      return originalReply;
    }

    if (frontendE2ERunning) {
      void appendFrontendE2ELog(`delivery verification failed: ${issues.join(" | ")}`);
    }

    const prefix = actionResult.fileMutationsApplied > 0 || actionResult.folderOpsApplied > 0
      ? "本轮已执行部分修改，但尚未完全达成要求"
      : "本轮尚未完成要求";
    return `${prefix}：${issues.join("；")}。请继续修复后再试。`;
  }

  const ACTION_PARAM_KEYS = [
    "path",
    "content",
    "searchText",
    "replaceText",
    "dir",
    "reason",
    "rationale",
    "query",
    "recursive",
    "startLine",
    "endLine",
    "command",
    "format",
    "prompt",
    "size",
    "target",
    "type",
    "src",
    "from",
    "to",
    "track",
    "at",
    "duration",
  ];

  function parseActionParams(paramsStr: string): Record<string, string> {
    const params: Record<string, string> = {};
    const keyPattern = ACTION_PARAM_KEYS.join("|");
    const matcher = new RegExp(`(?:^|\\s)(${keyPattern})=(["'])`, "g");
    const matches: Array<{ key: string; quote: string; keyStart: number; valueStart: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = matcher.exec(paramsStr)) !== null) {
      const raw = match[0];
      const key = match[1];
      const quote = match[2];
      const prefixLength = raw.length - (key.length + 2);
      const keyStart = match.index + prefixLength;
      matches.push({
        key,
        quote,
        keyStart,
        valueStart: keyStart + key.length + 2,
      });
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const rawSegment = paramsStr
        .slice(current.valueStart, next ? next.keyStart - 1 : paramsStr.length)
        .trimEnd();
      const value = rawSegment.endsWith(current.quote)
        ? rawSegment.slice(0, -1)
        : rawSegment;
      params[current.key] = value;
    }
    return params;
  }

  function normalizeActionPath(rawPath: string | undefined): string {
    if (!rawPath) return "";
    let value = decodeActionParamValue(rawPath).trim();
    if (!value) return "";

    const markerPatterns = [
      /\r?\n\s*(?:searchText|replaceText|content|reason|dir)\s*:/i,
      /\s+(?:searchText|replaceText|content|reason|dir)\s*:/i,
    ];
    for (const pattern of markerPatterns) {
      const match = pattern.exec(value);
      if (match && typeof match.index === "number") {
        value = value.slice(0, match.index).trim();
      }
    }

    value = value
      .split(/\r?\n/, 1)[0]
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .replace(/[,\]]+$/, "")
      .trim();

    return value;
  }

  function extractInlineActionParamBlocks(content: string): InlineActionParamBlock[] {
    const blocks: InlineActionParamBlock[] = [];
    let start = 0;
    while (start < content.length) {
      const marker = content.indexOf("[ACTION:", start);
      if (marker === -1) break;
      let cursor = marker + "[ACTION:".length;
      let quote: "\"" | "'" | null = null;
      let escaped = false;
      while (cursor < content.length) {
        const char = content[cursor];
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (quote) {
          if (char === quote) quote = null;
        } else if (char === "\"" || char === "'") {
          quote = char;
        } else if (char === "]") {
          break;
        }
        cursor += 1;
      }
      if (cursor >= content.length || content[cursor] !== "]") {
        start = marker + "[ACTION:".length;
        continue;
      }

      const raw = content.slice(marker, cursor + 1);
      const inner = content.slice(marker + "[ACTION:".length, cursor).trim();
      const spaceIndex = inner.search(/\s/);
      const colonIndex = inner.indexOf(":");

      if (spaceIndex !== -1) {
        const type = inner.slice(0, spaceIndex).trim();
        const paramsStr = inner.slice(spaceIndex).trim();
        if (type) {
          blocks.push({
            type,
            raw,
            paramsStr,
            params: parseActionParams(paramsStr),
          });
        }
      } else if (colonIndex !== -1) {
        const type = inner.slice(0, colonIndex).trim();
        const legacyArg = inner.slice(colonIndex + 1).trim();
        if (type) {
          blocks.push({
            type,
            raw,
            paramsStr: "",
            legacyArg,
            params: {},
          });
        }
      }

      start = cursor + 1;
    }
    return blocks;
  }

  function hasUnsafeInlineFileMutationPayload(block: InlineActionParamBlock): boolean {
    if (!["CREATE_FILE", "WRITE_FILE", "EDIT_FILE"].includes(block.type)) return false;
    return /\b(?:content|searchText|replaceText)\s*="/.test(block.paramsStr);
  }

  function extractArtifactPathsFromText(content: string): string[] {
    const paths = new Set<string>();
    const actionRegex = /\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER)(?::([^\]]+)|(\s+[^\]]+))\]/g;
    let match;
    while ((match = actionRegex.exec(content)) !== null) {
      const legacyPath = match[1]?.trim();
      const paramPath = match[2] ? parseActionParams(match[2]).path?.trim() : "";
      const path = legacyPath || paramPath;
      if (path) paths.add(path);
    }
    for (const block of extractInlineActionParamBlocks(content)) {
      if (!["CREATE_FILE", "WRITE_FILE", "EDIT_FILE", "CREATE_FOLDER"].includes(block.type)) continue;
      const path = (block.params.path || block.legacyArg || "").trim();
      if (path) paths.add(path);
    }
    const jsonPathRegex = /"path"\s*:\s*"([^"]+)"/g;
    while ((match = jsonPathRegex.exec(content)) !== null) {
      if (match[1]?.trim()) paths.add(match[1].trim());
    }
    return [...paths];
  }

  function collectGeneratedArtifactPaths(messages: ChatMessage[]): string[] {
    const paths = new Set<string>();
    for (const message of messages) {
      if (message.role === "expert-tasks") {
        try {
          const tasks = JSON.parse(message.content);
          if (Array.isArray(tasks)) {
            for (const task of tasks) {
              if (task && typeof task.output === "string") {
                extractArtifactPathsFromText(task.output).forEach((path) => paths.add(path));
              }
            }
          }
        } catch {
          // ignore malformed historical snapshots
        }
        continue;
      }
      extractArtifactPathsFromText(message.content).forEach((path) => paths.add(path));
    }
    return [...paths];
  }

  function isWebArtifactPath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return /\.(html|css|scss|sass|js|jsx|ts|tsx|vue|svelte|astro)$/.test(normalized)
      || /(^|\/)(pages|components|public|src|assets)\//.test(normalized);
  }

  function isBackendArtifactPath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return /\.(rs|py|go|java|kt|cs|rb|php|sql)$/.test(normalized)
      || /(^|\/)(server|api|backend|services)\//.test(normalized);
  }

  function isArtifactModificationRequest(text: string): boolean {
    if (!text) return false;
    if (/(规范文档|设计文档|方案文档|只出方案|只要规范)/i.test(text)) return false;
    return /(修改|改成|调整|优化|重做|继续改|基于.*产物|在.*基础上|把.*改|更新一下|换成|希望.*风格|偏向.*风格|科技风|简洁风|高级感)/i.test(text);
  }

  async function buildArtifactFollowupPlan(
    text: string,
    messages: ChatMessage[],
    projectName?: string,
    projectPath?: string
  ): Promise<DispatchPlan | null> {
    if (!isArtifactModificationRequest(text)) return null;
    const artifactPaths = collectGeneratedArtifactPaths(messages);
    if (artifactPaths.length === 0) return null;

    const webArtifacts = artifactPaths.filter(isWebArtifactPath);
    const backendArtifacts = artifactPaths.filter(isBackendArtifactPath);
    const relevantArtifacts = (webArtifacts.length > 0 ? webArtifacts : artifactPaths).slice(0, 12);
    const engineerId = webArtifacts.length > 0 || backendArtifacts.length > 0
      ? "discipline-520"
      : "discipline-413";
    let fileContext = "";
    if (projectName && relevantArtifacts.length > 0) {
      const previews: string[] = [];
      for (const path of relevantArtifacts.slice(0, 4)) {
        try {
          const content = await invoke<string>("sandbox_read_file", {
            projectName,
            relativePath: path,
            projectPath,
          });
          const snippet = content.length > 2400 ? `${content.slice(0, 2400)}\n...(truncated)` : content;
          previews.push(`文件：${path}\n\`\`\`\n${snippet}\n\`\`\``);
        } catch {
          previews.push(`文件：${path}\n（读取失败，需优先重新确认当前文件内容）`);
        }
      }
      if (previews.length > 0) {
        fileContext = `\n当前文件内容（生成补丁时必须以此为准）：\n${previews.join("\n\n")}`;
      }
    }

    return {
      scene: "code-development",
      taskDescription: `这是对现有产物的增量修改任务。必须直接修改已有文件或新增实现文件，不要只输出规范文档。\n已生成文件：${relevantArtifacts.join(", ")}\n用户的新要求：${text}${fileContext}\n补丁要求：对短小、展示型、文本型文件（例如 index.html、styles.css、README.md）优先使用 WRITE_FILE，直接基于上面的真实文件内容给出完整最新文件；只有在文件较大、确实适合局部修改时才使用 EDIT_FILE。无论哪种方式，目标文件内容不完整、未展示或仍不确定时，都必须先发起 [ACTION:READ_FILE:相对路径] 读取真实文件后再修改，禁止臆造页面文案、组件结构或 searchText。若使用 EDIT_FILE，searchText 必须直接来自上面的当前文件内容，不要只在代码块里用“搜索块”“替换为”这类注释描述旧内容和新内容。同一个文件如果有多个改动，优先合并成一次可完整命中的 EDIT_FILE，不要对同一文件连续输出多条依赖旧内容的局部编辑。`,
      expertIds: [engineerId],
      requiresDesign: false,
    };
  }

  function isWebsiteIntent(taskText: string): boolean {
    if (!taskText) return false;
    return /(网站|网页|web\s*site|website|landing\s*page|首页|前端页面|html页面|页面开发|做个站)/i.test(taskText);
  }

  function isEnvPath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return /(^|\/)\.env(\.[^/]+)?$/.test(normalized) || /(^|\/)env(\.[^/]+)?$/.test(normalized);
  }

  function isWebFilePath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").toLowerCase();
    return /\.(html|css|scss|sass|js|jsx|ts|tsx|vue|svelte|astro)$/.test(normalized)
      || /(^|\/)(public|src|pages|components|assets)\//.test(normalized);
  }

  function isEnvExplicitlyRequested(taskText: string): boolean {
    if (!taskText) return false;
    return /(env|环境变量|配置密钥|api[_\s-]?key|token|secret|dotenv|\.env)/i.test(taskText);
  }

  function validateChangeIntent(taskText: string, changes: ChangeSet[]): string[] {
    const issues: string[] = [];
    if (changes.length === 0) return issues;

    const changedPaths = changes.map((c) => c.path.trim()).filter(Boolean);
    const envChanges = changedPaths.filter(isEnvPath);
    const nonEnvChanges = changedPaths.filter((p) => !isEnvPath(p));
    const webChanges = changedPaths.filter(isWebFilePath);

    if (isWebsiteIntent(taskText)) {
      if (webChanges.length === 0) {
        issues.push("当前任务是网站/页面开发，但本次变更未包含任何前端页面文件（如 html/css/js/tsx/vue）。");
      }
      if (envChanges.length > 0 && nonEnvChanges.length === 0) {
        issues.push(`当前任务是网站/页面开发，但本次只修改了环境配置文件：${envChanges.join(", ")}`);
      }
    }

    if (envChanges.length > 0 && !isEnvExplicitlyRequested(taskText) && nonEnvChanges.length === 0) {
      issues.push(`检测到仅修改环境配置文件（${envChanges.join(", ")}），但任务描述未明确要求修改环境变量。`);
    }

    return issues;
  }

  interface DirectChangeApplyResult {
    applied: number;
    fileMutationsApplied: number;
    folderOpsApplied: number;
    failed: number;
    errors: string[];
    touchedFiles: string[];
  }

  interface BackendChangeSession {
    id: string;
    status: string;
    errors: string[];
    changes: Array<{
      change: {
        operation: string;
        path: string;
      };
    }>;
  }

  async function proposeAndMaybeApplyChanges(
    projectName: string,
    taskDescription: string,
    changes: ChangeSet[],
    requiredFiles: string[] = [],
    userTaskText = "",
    projectPath?: string,
    options: { emitSummaryMessage?: boolean } = {}
  ): Promise<DirectChangeApplyResult | null> {
    if (changes.length === 0) return null;
    void requiredFiles;
    void projectPath;

    const result: DirectChangeApplyResult = {
      applied: 0,
      fileMutationsApplied: 0,
      folderOpsApplied: 0,
      failed: 0,
      errors: [],
      touchedFiles: [],
    };

    const intentIssues = validateChangeIntent(userTaskText || taskDescription, changes);
    if (intentIssues.length > 0) {
      const top = intentIssues.slice(0, 5).map((e, i) => `${i + 1}. ${e}`).join("\n");
      appendCleanSystemMessage(`检测到潜在变更风险，已继续执行并请你留意：\n${top}`);
    }

    try {
      const proposedRaw = await invoke<string>("propose_patch", {
        projectName,
        taskDescription,
        changes,
        requiredFiles,
        projectPath: projectPath || null,
      });
      const proposed = JSON.parse(proposedRaw) as BackendChangeSession;

      if (proposed.status === "blocked") {
        result.failed = Math.max(proposed.errors.length, 1);
        result.errors.push(...proposed.errors);
      } else {
        const appliedRaw = await invoke<string>("apply_approved_patch", {
          projectName,
          sessionId: proposed.id,
          projectPath: projectPath || null,
        });
        const applied = JSON.parse(appliedRaw) as BackendChangeSession;
        const touchedFiles = applied.changes
          .map((item) => item?.change?.path?.trim())
          .filter((item): item is string => !!item);
        const operations = applied.changes
          .map((item) => item?.change?.operation?.trim().toLowerCase())
          .filter((item): item is string => !!item);

        result.applied = touchedFiles.length;
        result.touchedFiles.push(...touchedFiles);
        result.folderOpsApplied = operations.filter((op) => op === "create_folder").length;
        result.fileMutationsApplied = operations.filter((op) => op !== "create_folder").length;
        result.errors.push(...applied.errors);
        result.failed = applied.errors.length;
      }
    } catch (e) {
      result.failed += 1;
      result.errors.push(`后端变更会话执行失败: ${String(e)}`);
    }

    if (options.emitSummaryMessage !== false) {
      emitAgentActionExecutionSummary(result);
    }

    return result;
  }

  /** 解析 AI 返回中的动作标记 */
  function parseAgentActions(sources: AgentActionSource[]): AgentAction[] {
    const actions: AgentAction[] = [];
    const seen = new Set<string>();
    const pushUniqueAction = (
      source: AgentActionSource,
      action: Omit<AgentAction, "sourceExpertId" | "sourceExpertName" | "sourceExpertTitle" | "requestReason"> & { requestReason?: string }
    ) => {
      const key = [
        source.expertId,
        action.type,
        action.path || "",
        action.searchText || "",
        action.replaceText || "",
        action.content || "",
        JSON.stringify(action.params || {}),
      ].join("::");
      if (seen.has(key)) return;
      seen.add(key);
      actions.push({
        ...action,
        sourceExpertId: source.expertId,
        sourceExpertName: source.expertName,
        sourceExpertTitle: source.expertTitle,
        requestReason: action.requestReason,
      });
    };
    const resolvePath = (legacyPath: string | undefined, paramStr: string | undefined): string => {
      if (legacyPath && legacyPath.trim()) return normalizeActionPath(legacyPath);
      if (paramStr) {
        const params = parseActionParams(paramStr);
        return normalizeActionPath(params.path || "");
      }
      return "";
    };

    for (const source of sources) {
      const content = source.content;
      const pushAction = (action: Omit<AgentAction, "sourceExpertId" | "sourceExpertName" | "sourceExpertTitle" | "requestReason"> & { requestReason?: string }) => {
        pushUniqueAction(source, action);
      };

      const folderRegex = /\[ACTION:CREATE_FOLDER(?::([^\]]+)|(\s+[^\]]+))\]/g;
      let match;
      while ((match = folderRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({ type: "CREATE_FOLDER", path });
      }

      const fileRegex = /\[ACTION:CREATE_FILE(?::([^\]]+)|(\s+[^\]]+))\]\s*```(?:\w*\n)?([\s\S]*?)```/g;
      while ((match = fileRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({
          type: "CREATE_FILE",
          path,
          content: match[3].trimEnd(),
        });
      }

      const inlineCreateRegex = /\[ACTION:CREATE_FILE\s+path="([^"]+)"\s+content='([\s\S]*?)'\]/g;
      while ((match = inlineCreateRegex.exec(content)) !== null) {
        pushAction({
          type: "CREATE_FILE",
          path: normalizeActionPath(match[1]),
          content: decodeActionParamValue(match[2]),
        });
      }

      const editRegex = /\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?\s*```(?:search|SEARCH)\r?\n([\s\S]*?)```\s*```(?:replace|REPLACE)\r?\n([\s\S]*?)```/g;
      while ((match = editRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({
          type: "EDIT_FILE",
          path,
          searchText: match[3].trimEnd(),
          replaceText: match[4].trimEnd(),
        });
      }

      const labeledEditRegex = /\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?[\s\S]*?`?searchText`?:\s*```(?:\w*\r?\n)?([\s\S]*?)```\s*`?replaceText`?:\s*```(?:\w*\r?\n)?([\s\S]*?)```/g;
      while ((match = labeledEditRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({
          type: "EDIT_FILE",
          path,
          searchText: match[3].trimEnd(),
          replaceText: match[4].trimEnd(),
        });
      }

      const replaceMarkerEditRegex = /\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?\s*```(?:\w*\r?\n)?([\s\S]*?)```\s*(?:替换为|替换成|replace(?:\s+with)?)[：: ]*\s*```(?:\w*\r?\n)?([\s\S]*?)```/gi;
      while ((match = replaceMarkerEditRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({
          type: "EDIT_FILE",
          path,
          searchText: match[3].trimEnd(),
          replaceText: match[4].trimEnd(),
        });
      }

      const compactEditRegex = /\[ACTION:EDIT_FILE(?::([^\]]+)|(\s+[^\]]+))\](?:\*\*)?\s*```(?:\w+)?\r?\n([\s\S]*?)```/g;
      while ((match = compactEditRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        const payload = parseLabeledEditPayload(match[3])
          || parseTaggedEditPayload(match[3])
          || parseAnnotatedEditPayload(match[3]);
        if (!payload) continue;
        pushAction({
          type: "EDIT_FILE",
          path,
          searchText: payload.searchText,
          replaceText: payload.replaceText,
        });
      }

      const writeRegex = /\[ACTION:WRITE_FILE(?::([^\]]+)|(\s+[^\]]+))\]\s*```(?:\w*\n)?([\s\S]*?)```/g;
      while ((match = writeRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({
          type: "WRITE_FILE",
          path,
          content: match[3].trimEnd(),
        });
      }

      const inlineWriteRegex = /\[ACTION:WRITE_FILE\s+path="([^"]+)"\s+content='([\s\S]*?)'\]/g;
      while ((match = inlineWriteRegex.exec(content)) !== null) {
        pushAction({
          type: "WRITE_FILE",
          path: normalizeActionPath(match[1]),
          content: decodeActionParamValue(match[2]),
        });
      }

      const deleteRegex = /\[ACTION:DELETE(?::([^\]]+)|(\s+[^\]]+))\]/g;
      while ((match = deleteRegex.exec(content)) !== null) {
        const path = resolvePath(match[1], match[2]);
        if (!path) continue;
        pushAction({ type: "DELETE", path });
      }

      const indexBuildRegex = /\[INDEX_BUILD\]/g;
      while ((match = indexBuildRegex.exec(content)) !== null) {
        pushAction({ type: "INDEX_BUILD", path: "" });
      }

      const indexSearchRegex = /\[INDEX_SEARCH:([^\]]+)\]/g;
      while ((match = indexSearchRegex.exec(content)) !== null) {
        pushAction({ type: "INDEX_SEARCH", path: match[1].trim() });
      }

      for (const block of extractInlineActionParamBlocks(content)) {
        const actionType = block.type;
        if (hasUnsafeInlineFileMutationPayload(block)) continue;
        const params = Object.fromEntries(
          Object.entries(block.params).map(([key, value]) => [key, decodeActionParamValue(value)])
        );
        const path = normalizeActionPath(params.path || block.legacyArg || "");

        if (actionType === "CREATE_FILE" && params.path && Object.prototype.hasOwnProperty.call(params, "content")) {
          pushAction({
            type: "CREATE_FILE",
            path,
            content: decodeActionParamValue(params.content || ""),
          });
          continue;
        }

        if (actionType === "WRITE_FILE" && params.path && Object.prototype.hasOwnProperty.call(params, "content")) {
          pushAction({
            type: "WRITE_FILE",
            path,
            content: decodeActionParamValue(params.content || ""),
          });
          continue;
        }

        if (actionType === "EDIT_FILE" && params.path && Object.prototype.hasOwnProperty.call(params, "searchText")) {
          pushAction({
            type: "EDIT_FILE",
            path,
            searchText: decodeActionParamValue(params.searchText || ""),
            replaceText: decodeActionParamValue(params.replaceText || ""),
          });
          continue;
        }

        if (["CREATE_FILE", "WRITE_FILE", "EDIT_FILE", "CREATE_FOLDER", "DELETE"].includes(actionType)) continue;
        pushAction({
          type: actionType as AgentAction["type"],
          path,
          params,
          requestReason: decodeActionParamValue(params.reason || params.rationale || ""),
        });
      }
    }

    return actions;
  }

  /** 执行 Agent 动作 */
  async function executeAgentActions(
    sources: AgentActionSource[],
    userTaskText = "",
    options: { emitSummaryMessage?: boolean } = {}
  ): Promise<AgentActionExecutionResult> {
    const executionResult: AgentActionExecutionResult = {
      applied: 0,
      failed: 0,
      fileMutationsApplied: 0,
      folderOpsApplied: 0,
      touchedFiles: [],
      errors: [],
    };
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return executionResult;

    const deliveryAnalysis = await analyzeAgentDelivery(
      sources,
      userTaskText,
      activeProject.workspacePath
    );
    const actions = parseAgentActions(sources);
    const nonFileActions = actions.filter((action) => !isFileMutationAction(action));

    if (frontendE2ERunning) {
      const actionPreview = deliveryAnalysis.executableMutations
        .slice(0, 12)
        .map((action) => `${action.actionType}:${action.path}`)
        .join(", ");
      void appendFrontendE2ELog(
        `executeAgentActions: parsed actions=${deliveryAnalysis.parsedActionCount}, structuredChanges=${deliveryAnalysis.structuredChangeCount}, preview=${actionPreview || "(none)"}`
      );
    }
    if (!deliveryAnalysis.hasExecutableMutation && nonFileActions.length === 0) return executionResult;

    // 检查是否有文件生成操作，显示反馈
    const hasFileActions = deliveryAnalysis.hasExecutableMutation || actions.some((a) => a.type === "WRITE_DOCUMENT");
    if (hasFileActions) {
      showLoading("正在应用文件变更...");
    }
    const hasCmdActions = nonFileActions.some((a) => a.type === "EXECUTE_CMD" || a.type === "WEB_SEARCH");
    if (hasCmdActions && !hasFileActions) {
      showLoading("正在执行操作...");
    }

    let shouldRefreshCurrentPreview = false;
    const changedFiles = new Set<string>();
    const isAbsolutePath = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
    const isProjectRootAlias = (value: string) => {
      const normalized = value.trim().toLowerCase();
      return [
        "项目根目录",
        "项目根",
        "根目录",
        "当前项目",
        "当前项目目录",
        "当前工作区",
        "当前工作目录",
        "工作区根目录",
        "workspace",
        "workspace root",
        "project",
        "project root",
        "root",
      ].includes(normalized);
    };
    const resolveWorkingDir = (rawDir?: string) => {
      const trimmed = rawDir?.trim();
      const workspacePath = activeProject.workspacePath || ".";
      if (!trimmed || trimmed === ".") return workspacePath;
      if (isProjectRootAlias(trimmed)) return workspacePath;
      if (!activeProject.workspacePath || isAbsolutePath(trimmed)) return trimmed;
      const separator = activeProject.workspacePath.includes("\\") ? "\\" : "/";
      const relative = trimmed
        .replace(/^[.][\\/]/, "")
        .replace(/^[\\/]+/, "");
      return `${activeProject.workspacePath.replace(/[\\/]+$/, "")}${separator}${relative}`;
    };
    const resolveCommandAuthMode = (requiresAuth: boolean, authReason: string) => {
      if (!requiresAuth) return "auto" as const;
      return /管理员权限/.test(authReason) ? "admin" as const : "restricted" as const;
    };

    if (deliveryAnalysis.hasExecutableMutation) {
      try {
        const raw = await invoke<string>("apply_agent_delivery_changes", {
          projectName: activeProject.name,
          projectPath: activeProject.workspacePath || null,
          taskDescription: `来自专家团输出的直接变更，共 ${deliveryAnalysis.structuredChangeCount} 项`,
          userTaskText,
          sourcesJson: JSON.stringify(sources.map((source) => ({ content: source.content }))),
        });
        const result = JSON.parse(raw) as AgentActionExecutionResult;
        if (frontendE2ERunning) {
          const topErrors = result?.errors?.slice(0, 5).join(" | ") || "";
          void appendFrontendE2ELog(
            `executeAgentActions: direct changes applied=${result?.applied || 0}, failed=${result?.failed || 0}${topErrors ? `, errors=${topErrors}` : ""}`
          );
        }
        executionResult.applied += result?.applied || 0;
        executionResult.failed += result?.failed || 0;
        executionResult.fileMutationsApplied += result?.fileMutationsApplied || 0;
        executionResult.folderOpsApplied += result?.folderOpsApplied || 0;
        executionResult.touchedFiles.push(...(result?.touchedFiles || []));
        executionResult.errors.push(...(result?.errors || []));
        if (result && result.applied > 0) {
          shouldRefreshCurrentPreview = true;
          result.touchedFiles.forEach((path) => changedFiles.add(path));
        }
      } catch (err) {
        log("ERROR", `Agent: 直接应用变更失败: ${err}`);
        if (frontendE2ERunning) {
          void appendFrontendE2ELog(`executeAgentActions: direct changes threw error: ${String(err)}`);
        }
        executionResult.failed += 1;
        executionResult.errors.push(`直接应用变更失败: ${String(err)}`);
      }
    }

    for (const action of nonFileActions) {
      try {
        switch (action.type) {
          case "INDEX_BUILD":
            await checkAndBuildIndex(activeProject.name, true);
            log("INFO", "Agent: 触发感知索引重建");
            break;
          case "INDEX_SEARCH":
            if (perceptualIndexReady) {
              try {
                const result = await invoke<string>("perceptual_index_search", {
                  projectName: activeProject.name,
                  query: action.path,
                });
                log("INFO", `Agent: 索引检索完成 "${action.path}"`);
                // 将检索结果追加为系统消息供下一轮对话使用
                const sessions = getSessions(activeProject.id);
                const session = sessions.find((s) => s.id === currentSessionId);
                if (session && result) {
                  session.messages.push({
                    role: "assistant",
                    content: `[索引检索结果: ${action.path}]\n\n${result}`,
                  });
                }
              } catch (err) {
                log("ERROR", `Agent: 索引检索失败: ${err}`);
              }
            }
            break;

          // ========== 新增 ACTION 执行器 ==========
          case "WEB_SEARCH": {
            const query = action.params?.query;
            if (query) {
              try {
                const results = await invoke<string>("web_search_query", { query, maxResults: 5 });
                log("INFO", `Agent: 网络搜索完成 "${query}"`);
                let parsedResults: Array<{ title: string; url: string; snippet: string }> = [];
                try {
                  parsedResults = JSON.parse(results) as Array<{ title: string; url: string; snippet: string }>;
                } catch {
                  parsedResults = [];
                }
                await appendToolEventToCurrentSession({
                  kind: "web-search",
                  createdAt: Date.now(),
                  initiator: {
                    expertId: action.sourceExpertId,
                    expertName: action.sourceExpertName,
                    expertTitle: action.sourceExpertTitle,
                  },
                  reason: action.requestReason || "需要补充外部资料或验证最新信息",
                  query,
                  status: "success",
                  results: parsedResults,
                });
              } catch (err) {
                log("ERROR", `Agent: 网络搜索失败: ${err}`);
                await appendToolEventToCurrentSession({
                  kind: "web-search",
                  createdAt: Date.now(),
                  initiator: {
                    expertId: action.sourceExpertId,
                    expertName: action.sourceExpertName,
                    expertTitle: action.sourceExpertTitle,
                  },
                  reason: action.requestReason || "需要补充外部资料或验证最新信息",
                  query,
                  status: "error",
                  error: String(err),
                });
              }
            }
            break;
          }

          case "EXECUTE_CMD": {
            const command = action.params?.command;
            const dir = resolveWorkingDir(action.params?.dir);
            if (command) {
              try {
                // 先检查安全性
                const safetyCheck = await invoke<string>("check_command_safety", {
                  command,
                  args: [],
                  workingDir: dir,
                  projectDir: activeProject.workspacePath || dir,
                });
                const safety = JSON.parse(safetyCheck);
                const authMode = resolveCommandAuthMode(!!safety.requires_auth, String(safety.auth_reason || ""));
                if (safety.requires_auth) {
                  const authorized = await showCommandAuthDialog(
                    command,
                    dir,
                    action.requestReason || "需要通过命令验证环境或执行检查",
                    `${action.sourceExpertName}（${action.sourceExpertTitle}）`,
                    authMode,
                    String(safety.auth_reason || "")
                  );
                  if (!authorized) {
                    log("INFO", `Agent: 用户拒绝执行命令 "${command}"`);
                    await appendToolEventToCurrentSession({
                      kind: "command",
                      createdAt: Date.now(),
                      initiator: {
                        expertId: action.sourceExpertId,
                        expertName: action.sourceExpertName,
                        expertTitle: action.sourceExpertTitle,
                      },
                      reason: action.requestReason || "需要通过命令验证环境或执行检查",
                      command,
                      workingDir: dir,
                      authMode,
                      status: "denied",
                      safetyReason: String(safety.auth_reason || ""),
                    });
                    break;
                  }
                }
                const result = await invoke<string>("execute_command", { command, args: [], workingDir: dir });
                log("INFO", `Agent: 执行命令 "${command}"`);
                const parsed = JSON.parse(result) as { stdout?: string; stderr?: string; exit_code?: number };
                await appendToolEventToCurrentSession({
                  kind: "command",
                  createdAt: Date.now(),
                  initiator: {
                    expertId: action.sourceExpertId,
                    expertName: action.sourceExpertName,
                    expertTitle: action.sourceExpertTitle,
                  },
                  reason: action.requestReason || "需要通过命令验证环境或执行检查",
                  command,
                  workingDir: dir,
                  authMode,
                  status: "success",
                  safetyReason: String(safety.auth_reason || ""),
                  output: {
                    stdout: parsed.stdout || "",
                    stderr: parsed.stderr || "",
                    exitCode: typeof parsed.exit_code === "number" ? parsed.exit_code : -1,
                  },
                });
              } catch (err) {
                log("ERROR", `Agent: 命令执行失败: ${err}`);
                await appendToolEventToCurrentSession({
                  kind: "command",
                  createdAt: Date.now(),
                  initiator: {
                    expertId: action.sourceExpertId,
                    expertName: action.sourceExpertName,
                    expertTitle: action.sourceExpertTitle,
                  },
                  reason: action.requestReason || "需要通过命令验证环境或执行检查",
                  command,
                  workingDir: dir,
                  authMode: "auto",
                  status: "error",
                  error: String(err),
                });
              }
            }
            break;
          }

          case "READ_DOCUMENT": {
            const docPath = action.params?.path || action.path;
            if (docPath) {
              try {
                const content = await invoke<string>("read_document", { filePath: docPath });
                log("INFO", `Agent: 读取文档 "${docPath}"`);
                const sessions = getSessions(activeProject.id);
                const session = sessions.find((s) => s.id === currentSessionId);
                if (session && content) {
                  session.messages.push({
                    role: "assistant",
                    content: `[文档内容: ${docPath}]\n\n${content}`,
                  });
                }
              } catch (err) {
                log("ERROR", `Agent: 文档读取失败: ${err}`);
              }
            }
            break;
          }

          case "WRITE_DOCUMENT": {
            const docPath = action.params?.path || action.path;
            const docContent = action.params?.content || action.content || "";
            const format = action.params?.format || "md";
            if (docPath) {
              try {
                await invoke("write_document", { filePath: docPath, content: docContent, format });
                log("INFO", `Agent: 写入文档 "${docPath}"`);
              } catch (err) {
                log("ERROR", `Agent: 文档写入失败: ${err}`);
              }
            }
            break;
          }

          case "GENERATE_IMAGE": {
            const prompt = action.params?.prompt;
            const size = action.params?.size || "1024x1024";
            if (prompt) {
              const card: ImageCard = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                prompt,
                status: "generating",
                createdAt: Date.now(),
              };
              imageCards.unshift(card);
              renderImageCards();
              enterImageMode();
              const imageKeys = findKeysByModality({ output: ["image"] });
              if (imageKeys.length === 0) {
                log("WARN", "Agent: 未配置支持图像生成的密钥");
                card.status = "error";
                card.error = "未配置支持图像生成的密钥";
              } else {
                log("INFO", `Agent: 图像生成请求已发送 prompt="${prompt}" size=${size}`);
                try {
                  const imageResult = await invoke<string>("chat_with_expert", {
                    key_id: imageKeys[0],
                    model: "gpt-4o",
                    system_prompt: "你是图像生成器。请返回 Markdown 图片语法，图片 URL 必须可直接访问。",
                    user_message: `请根据以下提示生成一张图片，仅返回 Markdown 图片链接：${prompt}，尺寸：${size}`,
                  });
                  const urlMatch = imageResult.match(/!\[[^\]]*\]\(([^)]+)\)/) || imageResult.match(/(https?:\/\/\S+)/);
                  if (urlMatch?.[1]) {
                    card.imageUrl = urlMatch[1];
                    card.status = "done";
                  } else if (urlMatch?.[0]) {
                    card.imageUrl = urlMatch[0];
                    card.status = "done";
                  } else {
                    card.status = "error";
                    card.error = "未解析到图像链接";
                  }
                } catch (e) {
                  card.status = "error";
                  card.error = `图像生成失败: ${e}`;
                }
              }
              renderImageCards();
            }
            break;
          }

          case "SWITCH_VIEW": {
            const target = action.params?.target;
            if (target && (window as any).__switchView) {
              (window as any).__switchView(target);
              log("INFO", `Agent: 切换视图到 ${target}`);
            }
            break;
          }

          case "OPEN_BROWSER": {
            const url = action.params?.path || action.path;
            if (url) {
              const iframe = document.querySelector('#data-analysis-view-container iframe') as HTMLIFrameElement;
              if (iframe) {
                iframe.src = url;
                if ((window as any).__switchView) {
                  (window as any).__switchView("data-analysis");
                }
              }
              log("INFO", `Agent: 打开浏览器 ${url}`);
            }
            break;
          }

          case "CANVAS_ADD_NODE": {
            const nodeType = action.params?.type || "file";
            const src = action.params?.src || "";
            const canvasInst = getCanvas();
            if (canvasInst) {
              const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              canvasInst.addNode({
                id: nodeId,
                type: nodeType as CanvasNode["type"],
                name: src || nodeId,
                x: Math.random() * 400 + 50,
                y: Math.random() * 300 + 50,
              });
              log("INFO", `Agent: 画布添加节点 type=${nodeType} src=${src}`);
            }
            break;
          }

          case "CANVAS_CONNECT": {
            const from = action.params?.from;
            const to = action.params?.to;
            const canvasInst = getCanvas();
            if (canvasInst && from && to) {
              canvasInst.addEdge({ from, to });
              log("INFO", `Agent: 画布连线 ${from} -> ${to}`);
            }
            break;
          }

          case "TIMELINE_ADD": {
            const track = action.params?.track;
            const src = action.params?.src;
            const at = action.params?.at || "0";
            const duration = action.params?.duration;
            log("INFO", `Agent: 时间轴添加片段 track=${track} src=${src} at=${at} duration=${duration || "auto"}`);
            // 时间轴功能待视频编辑模块实现后对接
            if ((window as any).__videoTimeline) {
              (window as any).__videoTimeline.addClip(track, src, parseFloat(at), duration ? parseFloat(duration) : undefined);
            }
            break;
          }

          case "TIMELINE_CUT": {
            const track = action.params?.track;
            const at = action.params?.at || "0";
            log("INFO", `Agent: 时间轴剪切 track=${track} at=${at}`);
            if ((window as any).__videoTimeline) {
              (window as any).__videoTimeline.cut(track, parseFloat(at));
            }
            break;
          }
        }
      } catch (e) {
        log("ERROR", `Agent 动作失败 (${action.type}:${action.path}): ${e}`);
      }
    }

    if (shouldRefreshCurrentPreview) {
      await reloadCurrentPreviewFile();
    }

    if (activeProject && changedFiles.size > 0) {
      await loadFileBrowser(activeProject.name, activeProject.workspacePath);
      highlightCurrentFile();
    }

    // 文件操作完成后隐藏加载状态
    if (hasFileActions || hasCmdActions) {
      hideLoading();
    }

    // 文件变更后标记目录为"需要更新"（不自动生成）
    if (activeProject && changedFiles.size > 0) {
      updateDirectoryStatus("updating");
      scheduleProjectIntelligenceSync(activeProject.name, [...changedFiles], "agent-change");
    }

    // Wiki 自迭代：文件变更后触发增量更新
    if (activeProject && changedFiles.size > 0 && wikiIterationMode === "self") {
      runIncrementalUpdate();
    }

    if (options.emitSummaryMessage !== false) {
      emitAgentActionExecutionSummary(executionResult);
    }

    return executionResult;
  }

  // ========== 命令授权卡片 ==========
  async function resolveCommandAuthRequest(requestId: string, approved: boolean): Promise<void> {
    const resolver = pendingCommandAuthResolvers.get(requestId);
    if (!resolver) return;

    if (currentProjectId) {
      const sessions = projectSessions.get(currentProjectId) || [];
      let targetSessionId: number | null = null;
      for (const session of sessions) {
        const messageIndex = session.messages.findIndex((msg) => {
          if (msg.role !== "command-auth") return false;
          try {
            const auth = JSON.parse(msg.content) as CommandAuthMessage;
            return auth.id === requestId;
          } catch {
            return false;
          }
        });
        if (messageIndex >= 0) {
          try {
            const auth = JSON.parse(session.messages[messageIndex].content) as CommandAuthMessage;
            auth.status = approved ? "approved" : "denied";
            session.messages[messageIndex].content = JSON.stringify(auth);
            targetSessionId = session.id;
          } catch {
            // 解析失败不阻断授权结果返回
          }
          break;
        }
      }
      if (targetSessionId !== null) {
        renderMessages();
        await saveSessionToDb(targetSessionId, currentProjectId);
      }
    }

    pendingCommandAuthResolvers.delete(requestId);
    resolver(approved);
  }

  function showCommandAuthDialog(
    command: string,
    dir: string,
    reason: string,
    initiator?: string,
    authMode: "auto" | "restricted" | "admin" = "restricted",
    safetyReason?: string
  ): Promise<boolean> {
    const initiatorMatch = /^(.+?)（(.+?)）$/.exec(initiator || "");
    const expertName = initiatorMatch?.[1] || initiator || "未知专家";
    const expertTitle = initiatorMatch?.[2] || "未知角色";
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "approval-overlay";
      const modeLabel = authMode === "admin" ? "需要更高权限" : "命令超出当前工作区";
      const safetyLine = safetyReason?.trim() || (authMode === "admin"
        ? "该命令可能需要更高系统权限。"
        : "该命令可能作用于当前项目工作区之外。");
      overlay.innerHTML = `
        <div class="approval-dialog compact-command-approval">
          <h3>${escapeHtml(expertName)}（${escapeHtml(expertTitle)}）需要确认</h3>
          <p class="approval-reason">${escapeHtml(reason || "该命令需要确认后执行。")}</p>
          <div class="approval-command-meta">${escapeHtml(modeLabel)} · ${escapeHtml(dir || "当前项目")}</div>
          <div class="approval-command"><code>${escapeHtml(command)}</code></div>
          <div class="approval-command-note">${escapeHtml(safetyLine)}</div>
          <div class="approval-actions">
            <button class="btn-approve" data-action="allow">同意执行</button>
            <button class="btn-deny" data-action="deny">取消</button>
          </div>
        </div>
      `;

      overlay.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const action = (btn as HTMLElement).dataset.action;
          overlay.remove();
          resolve(action === "allow");
        });
      });

      document.body.appendChild(overlay);
    });
  }

  // 显示加载指示器
  function showLoading(text?: string) {
    if (!chatMessages) return;
    hideLoading(); // 确保不会有重复的 loading 元素
    const label = text || "思考中";
    const loadingEl = document.createElement("div");
    loadingEl.id = "chat-loading";
    loadingEl.className = "chat-message assistant loading";
    loadingEl.innerHTML = `
      <div class="message-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
      <div class="message-content"><span class="loading-label">${escapeHtml(label)}</span><span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></div>
    `;
    chatMessages.appendChild(loadingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 隐藏加载指示器
  function hideLoading() {
    const loadingEl = document.getElementById("chat-loading");
    if (loadingEl) loadingEl.remove();
  }

  // 渲染消息
  function renderMessages() {
    if (!chatMessages) return;

    if (!currentProjectId || !currentSessionId) {
      chatMessages.innerHTML = `
        <div class="chat-welcome">
          <svg class="welcome-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="12" y1="8" x2="12" y2="8"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div class="welcome-title">AI 专家团</div>
          <div class="welcome-desc">选择左侧项目开始对话，或点击下方输入框发送消息</div>
        </div>
      `;
      return;
    }

    const sessions = projectSessions.get(currentProjectId);
    const session = sessions?.find((s) => s.id === currentSessionId);

    if (!session || session.messages.length === 0) {
      chatMessages.innerHTML = `
        <div class="chat-welcome">
          <svg class="welcome-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="12" y1="8" x2="12" y2="8"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div class="welcome-title">${session?.name || "新对话"}</div>
          <div class="welcome-desc">开始发送消息吧</div>
        </div>
      `;
      return;
    }

    chatMessages.innerHTML = "";
    session.messages.forEach((msg) => {
      // 专家卡片快照消息：作为对话历史的一部分按顺序渲染
      if (msg.role === "expert-tasks") {
        try {
          const tasks: ExpertTask[] = JSON.parse(msg.content);
          if (tasks.length > 0) {
            const groupEl = buildTasksGroupEl(tasks);
            chatMessages!.appendChild(groupEl);
          }
        } catch (e) {
          log("WARN", `专家卡片消息解析失败: ${e}`);
        }
        return;
      }

      if (msg.role === "tool-event") {
        try {
          const event = JSON.parse(msg.content) as ToolEventMessage;
          const msgEl = document.createElement("div");
          msgEl.className = "chat-message assistant tool-event-message";
          msgEl.innerHTML = renderToolEventCard(event);
          chatMessages!.appendChild(msgEl);
        } catch (e) {
          log("WARN", `工具事件消息解析失败: ${e}`);
        }
        return;
      }

      if (msg.role === "command-auth") {
        try {
          const auth = JSON.parse(msg.content) as CommandAuthMessage;
          const msgEl = document.createElement("div");
          msgEl.className = "chat-message assistant command-auth-message";
          msgEl.innerHTML = renderCommandAuthCard(auth);
          if (auth.status === "pending") {
            msgEl.querySelector<HTMLElement>("[data-command-auth-action='deny']")?.addEventListener("click", () => {
              resolveCommandAuthRequest(auth.id, false).catch(console.error);
            });
            msgEl.querySelector<HTMLElement>("[data-command-auth-action='allow']")?.addEventListener("click", () => {
              resolveCommandAuthRequest(auth.id, true).catch(console.error);
            });
          }
          chatMessages!.appendChild(msgEl);
        } catch (e) {
          log("WARN", `命令授权消息解析失败: ${e}`);
        }
        return;
      }

      const msgEl = document.createElement("div");
      msgEl.className = `chat-message ${msg.role}`;

      if (msg.role === "user") {
        // 用户消息：保持气泡样式
        msgEl.innerHTML = renderUserMessage(msg.content);
      } else {
        // AI 消息：统一为结构化信息卡，避免元数据和内部信号泄露到用户界面。
        msgEl.innerHTML = `<div class="assistant-panel">${renderAiMessage(msg.content)}</div>`;
      }
      chatMessages!.appendChild(msgEl);
    });

    // 绑定 Artifact 卡片点击事件
    bindArtifactClicks();

    // 滚动到底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function appendToolEventToCurrentSession(event: ToolEventMessage): Promise<void> {
    if (!currentProjectId || !currentSessionId) return;
    const sessions = projectSessions.get(currentProjectId);
    const session = sessions?.find((s) => s.id === currentSessionId);
    if (!session) return;
    session.messages.push({
      role: "tool-event",
      content: JSON.stringify(event),
    });
    renderMessages();
    await saveSessionToDb(currentSessionId, currentProjectId);
  }

  function renderCommandAuthCard(message: CommandAuthMessage): string {
    const initiator = `${message.initiator.expertName}（${message.initiator.expertTitle}）`;
    const statusLabel = message.status === "approved"
      ? "已同意"
      : message.status === "denied"
        ? "已拒绝"
        : "等待你的决定";
    const statusClass = message.status === "approved"
      ? "approved"
      : message.status === "denied"
        ? "denied"
        : "pending";
    const actionButtons = message.status === "pending"
      ? `
        <div class="command-auth-actions">
          <button class="command-auth-btn deny" data-command-auth-action="deny">拒绝</button>
          <button class="command-auth-btn allow" data-command-auth-action="allow">同意执行</button>
        </div>
      `
      : `<div class="command-auth-result ${statusClass}">${statusLabel}</div>`;

    return `
      <div class="chat-log-block command-auth-log compact-command-log" data-status="${message.status}">
        <div class="chat-log-line compact-command-line"><strong>${escapeHtml(initiator)}</strong></div>
        <div class="chat-log-line compact-command-line subtle">${escapeHtml(message.reason?.trim() || "未提供说明")}</div>
        ${actionButtons}
      </div>
    `;
  }

  function renderToolEventCard(event: ToolEventMessage): string {
    const statusLabel = event.status === "success"
      ? "执行成功"
      : event.status === "denied"
        ? "用户拒绝"
        : event.status === "blocked"
          ? "受限放行"
          : "执行失败";
    const reason = event.reason?.trim() || "专家未提供明确理由";
    const initiator = `${event.initiator.expertName}（${event.initiator.expertTitle}）`;

    if (event.kind === "web-search") {
      const results = (event.results || []).map((item) => `
        <li class="chat-log-link-item">
          <a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>
          <div class="chat-log-link-snippet">${escapeHtml(item.snippet || item.url)}</div>
        </li>
      `).join("");

      return `
        <div class="chat-log-block tool-event-log" data-kind="web-search" data-status="${event.status}">
          <div class="chat-log-kicker">
            <span>网络搜索</span>
            <span>${escapeHtml(statusLabel)}</span>
          </div>
          <div class="chat-log-line"><strong>${escapeHtml(initiator)}</strong> 发起了资料检索。</div>
          <div class="chat-log-line">原因：${escapeHtml(reason)}</div>
          ${event.error ? `<div class="chat-log-line is-error">结果：${escapeHtml(event.error)}</div>` : ""}
          ${results ? `<ol class="chat-log-links">${results}</ol>` : '<div class="chat-log-line subtle">结果：未返回可展示条目。</div>'}
        </div>
      `;
    }

    return `
      <div class="chat-log-block tool-event-log compact-command-log" data-kind="command" data-status="${event.status}">
        <div class="chat-log-line compact-command-line"><strong>${escapeHtml(initiator)}</strong></div>
        <div class="chat-log-line compact-command-line subtle">${escapeHtml(reason)}</div>
      </div>
    `;
  }

  function renderUserMessage(content: string): string {
    const payload = parseUserMessagePayload(content);
    if (!payload) {
      return `<div class="message-content">${escapeHtml(content)}</div>`;
    }
    const metaBlocks: string[] = [];
    if (payload.mode !== "normal") {
      metaBlocks.push(`<span class="user-meta-badge">${payload.mode === "plan" ? "按计划进行" : "按目标进行"}</span>`);
    }
    payload.attachments.forEach((attachment) => {
      metaBlocks.push(`
        <span class="user-meta-badge file">
          <span>${attachment.kind === "image" ? "图片" : attachment.kind === "video" ? "视频" : attachment.kind === "audio" ? "音频" : attachment.kind === "text" ? "文本" : "文件"}</span>
          <strong>${escapeHtml(attachment.name)}</strong>
          <span>${formatFileSize(attachment.size)}</span>
        </span>
      `);
    });
    return `
      <div class="message-content">
        ${payload.text ? `<div class="user-message-text">${escapeHtml(payload.text)}</div>` : ""}
        ${metaBlocks.length > 0 ? `<div class="user-message-meta">${metaBlocks.join("")}</div>` : ""}
      </div>
    `;
  }

  /** 渲染 AI 消息内容：解析文本和 Artifact 卡片 */
  function renderAiMessage(content: string): string {
    const cleanContent = sanitizeAssistantDisplayContent(content);
    const blocks = parseMessageBlocks(cleanContent);
    return blocks.map((block) => {
      if (block.type === "artifact") {
        return `
          <div class="msg-artifact" data-filename="${escapeAttr(block.filename)}" data-content="${escapeAttr(block.content)}">
            <svg class="artifact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="artifact-name">${escapeHtml(block.filename)}</span>
          </div>
        `;
      } else if (block.type === "folder") {
        return `
          <div class="msg-folder">
            <svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="folder-name">${escapeHtml(block.name)}</span>
          </div>
        `;
      }
      return `<div class="msg-text">${renderTextWithThink(block.content)}</div>`;
    }).join("");
  }

  /** 解析消息内容为块数组（文本块 + Artifact 块） */
  function parseMessageBlocks(content: string): Array<
    | { type: "text"; content: string }
    | { type: "artifact"; filename: string; content: string }
    | { type: "folder"; name: string }
  > {
    const blocks: ReturnType<typeof parseMessageBlocks> = [];
    // 合并正则，同时匹配文件 Artifact 和文件夹
    const combined = /\[ACTION:CREATE_FILE(?::([^\]]+)|(\s+[^\]]+))\]\s*```(?:\w*\n)?([\s\S]*?)```|\[ACTION:CREATE_FOLDER(?::([^\]]+)|(\s+[^\]]+))\]/g;
    let lastIndex = 0;
    let match;

    while ((match = combined.exec(content)) !== null) {
      // 匹配前的文本（过滤掉残留的 [ACTION:...] 标记）
      if (match.index > lastIndex) {
        let text = content.slice(lastIndex, match.index).trim();
        // 清除残留元数据标记
        text = text.replace(/\[ACTION:[^\]]*\]\s*/g, "").trim();
        if (text) blocks.push({ type: "text", content: text });
      }
      if (match[1] || match[2]) {
        // 文件 Artifact
        const filename = match[1]?.trim() || parseActionParams(match[2]).path?.trim();
        if (!filename) {
          lastIndex = combined.lastIndex;
          continue;
        }
        blocks.push({
          type: "artifact",
          filename,
          content: match[3].trimEnd(),
        });
      } else if (match[4] || match[5]) {
        // 文件夹
        const folderName = match[4]?.trim() || parseActionParams(match[5]).path?.trim();
        if (!folderName) {
          lastIndex = combined.lastIndex;
          continue;
        }
        blocks.push({
          type: "folder",
          name: folderName,
        });
      }
      lastIndex = combined.lastIndex;
    }

    // 剩余文本
    if (lastIndex < content.length) {
      let text = content.slice(lastIndex).trim();
      // 清除残留元数据标记
      text = text.replace(/\[ACTION:[^\]]*\]\s*/g, "").trim();
      if (text) blocks.push({ type: "text", content: text });
    }

    // 如果没有匹配到任何 Artifact，整个内容作为文本块（过滤元数据）
    if (blocks.length === 0) {
      let text = content.replace(/\[ACTION:[^\]]*\]\s*/g, "").trim();
      if (text) blocks.push({ type: "text", content: text });
    }

    return blocks;
  }

  /** 行内 Markdown 格式化（粗体、斜体、行内代码、标题、列表等） */
  function formatInlineMarkdown(html: string): string {
    // 标题（# ## ### ####）—— 必须在 \n → <br> 之前，^ 才生效
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    // 列表项 —— 必须在 \n → <br> 之前，否则 ^ 只匹配字符串开头
    html = html.replace(/^-\s+(.+)$/gm, "• $1");
    // 将换行转为 <br>（保留段落结构，但跳过已渲染的标签行）
    html = html.replace(/\n/g, "<br>");
    // **粗体**
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // *斜体*
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // `行内代码`
    html = html.replace(/`([^`]+)`/g, "<code class=\"inline-code\">$1</code>");
    return html;
  }

  /** 将 <think>...</think> 标签转换为可折叠的深度思考 HTML 块 */
  function processThinkTags(content: string): string {
    // 处理 <think>...</think> 标签，转换为折叠块
    return content.replace(/<think>([\s\S]*?)<\/think>/g, (_, thinkContent) => {
      const escaped = thinkContent.trim()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      return `<details class="deep-thinking"><summary><span class="thinking-icon">💭</span> 深度思考</summary><div class="thinking-content">${escaped}</div></details>`;
    });
  }

  /** 渲染含 think 标签的文本块：用占位符保护 think 生成的 HTML 不被 escapeHtml 破坏 */
  function renderTextWithThink(content: string): string {
    const markers: string[] = [];
    const protectedContent = content.replace(/<think>([\s\S]*?)<\/think>/g, (match) => {
      const idx = markers.length;
      markers.push(processThinkTags(match));
      return `__THINK_${idx}__`;
    });
    let result = formatInlineMarkdown(escapeHtml(protectedContent));
    result = result.replace(/__THINK_(\d+)__/g, (_, i) => markers[parseInt(i)]);
    return result;
  }

  /** 转义含 think 标签的内容（无 Markdown 格式化，用于专家输出等场景） */
  function escapeHtmlWithThink(content: string): string {
    const markers: string[] = [];
    const protectedContent = content.replace(/<think>([\s\S]*?)<\/think>/g, (match) => {
      const idx = markers.length;
      markers.push(processThinkTags(match));
      return `__THINK_${idx}__`;
    });
    let result = escapeHtml(protectedContent);
    result = result.replace(/__THINK_(\d+)__/g, (_, i) => markers[parseInt(i)]);
    return result;
  }

  /** 绑定 Artifact 卡片点击事件 */
  function bindArtifactClicks() {
    chatMessages?.querySelectorAll(".msg-artifact").forEach((el) => {
      const artifactEl = el as HTMLElement;
      // 避免重复绑定
      if ((artifactEl as any).__bound) return;
      (artifactEl as any).__bound = true;

      artifactEl.addEventListener("click", async () => {
        const filename = artifactEl.dataset.filename;
        const content = artifactEl.dataset.content;
        if (!filename) return;

        const activeProject = sidebar.getActiveChat();
        if (!activeProject) return;

        // 旧消息中的 Artifact 点击后直接写入源码（Codex 路线），不再走补丁提案合并。
        try {
          const result = await proposeAndMaybeApplyChanges(activeProject.name, `Artifact 文件变更: ${filename}`, [{
            operation: "write_file",
            path: filename,
            content: content || "",
            rationale: "用户点击旧 Artifact 卡片触发的直接写入",
            risk: "medium",
          }], [], "", activeProject.workspacePath);
          if (result && result.applied > 0) {
            checkAndBuildIndex(activeProject.name, true);
          }
        } catch (e) {
          log("ERROR", `Artifact 直接写入失败: ${e}`);
        }

        // 打开文件预览
        (window as any).openFilePreview?.(filename);
      });
    });
  }

  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * 主管最终回复裁剪：
   * - executeAgentActions 基于原始 finalReply 执行结构化文件动作
   * - 对用户展示时彻底剥离 ACTION/ChangeSet 元数据和代码块
   * - 保留 2~4 句面向用户的自然总结，避免把内部协议和源码片段直接暴露出来
   */
  function sanitizeSupervisorReply(reply: string): string {
    if (!reply) return "这轮已经处理完了，相关结果我整理好了，也已经更新到当前项目里。你现在可以直接继续看页面或文件内容。";
  
    // 1. 移除所有 ACTION 块和 markdown 代码块，得到纯文字部分
    const actionRegex = /\[ACTION:(?:CREATE_FILE|WRITE_FILE|EDIT_FILE|CREATE_FOLDER|DELETE|WRITE_DOCUMENT):[^\]]*\](?:\s*```[\s\S]*?```)?/g;
    let textPart = reply.replace(actionRegex, "");
    textPart = textPart.replace(/```[\s\S]*?```/g, ""); // 剥离残余代码块
  
    // 2. 删除元数据段落
    textPart = textPart.replace(/###?\s*工作亮点[\s\S]*?(?=###|$)/g, "");
    textPart = textPart.replace(/###?\s*改进建议[\s\S]*?(?=###|$)/g, "");
    textPart = textPart.replace(/###?\s*(?:修改|变更|代码)(?:总结|摘要|概览)[\s\S]*?(?=###|$)/g, "");
  
    // 3. 逐句过滤含元数据关键词的句子
    const sentences = textPart.split(/[。！\n]+/).filter(s => s.trim());
    const filtered = sentences.filter(s => {
      const metaKeywords = /ACTION|ChangeSet|PatchProposal|专家|审查|汇总|各位|经审查确认|工作亮点|改进建议|调研员|设计师|工程师|已完成.*处理|处理结果|以下是.*代码|代码如下|具体实现|实现如下/;
      return !metaKeywords.test(s);
    });
  
    const normalized = filtered
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (normalized.length === 0) return "这轮已经处理完了，相关文件和结果已经更新到当前项目里。你可以直接继续检查页面效果，或者再告诉我下一步想怎么改。";

    const summaryLines = normalized
      .slice(0, 4)
      .map((s) => s.replace(/[。！]+$/g, "").trim())
      .filter(Boolean);

    if (summaryLines.length === 1) {
      const core = summaryLines[0];
      const blocked = /(未完成|失败|阻塞|请重试|未实际|尚未|未成功)/.test(core);
      if (blocked) {
        return `${core}。我已经把当前卡点保留下来了，你可以直接继续让我接着修，我会沿着这条结果继续往下处理。`;
      }
      return `${core}。相关改动已经写进当前项目里，你现在可以直接看页面或文件里的变化。要是还想继续细调，我可以接着处理。`;
    }

    let deliveryText = summaryLines.join("。");
    if (!deliveryText.endsWith("。")) {
      deliveryText += "。";
    }
    if (deliveryText.length > 240) {
      deliveryText = `${deliveryText.substring(0, 237).trim()}...`;
    }

    return deliveryText;
  }

  function sanitizeAssistantDisplayContent(content: string): string {
    if (!content) return "";
    let text = content;
    // 移除动作标记与代码块，防止把内部协议暴露给用户。
    text = text.replace(/\[ACTION:[^\]]*\]/g, "");
    text = text.replace(/```(?:json)?\s*\{[\s\S]*?"changes"[\s\S]*?\}\s*```/gi, "");
    // 移除常见系统元数据段落。
    text = text.replace(/^\s*\[(?:索引检索结果|搜索结果|命令执行结果|文档内容|系统认知盲区|项目代码参考|索引覆盖报告)[^\n]*\n?/gim, "");
    text = text.replace(/^\s*(?:\[主管中途检查\].*)$/gim, "");
    // 清理重复空行
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
  }

  // ========== 专家任务记录渲染 ==========

  function getExpertPhaseText(task: ExpertTask, phaseLabels: Record<string, string>): string {
    if (task.phase) return phaseLabels[task.phase] || task.phaseDetail || "处理中";
    return task.phaseDetail || "处理中";
  }

  function getExpertStatusText(status: ExpertTask["status"]): string {
    return status === "done"
      ? "已完成"
      : status === "running"
        ? "执行中"
        : status === "error"
          ? "异常"
          : "等待中";
  }

  function extractExpertSummary(output: string): string {
    const match = output.match(/\[SUMMARY:(.*?)\]/);
    if (match) return match[1].trim();
    const clean = sanitizeAssistantDisplayContent(output)
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return "已完成本轮处理。";
    return clean.substring(0, 90) + (clean.length > 90 ? "..." : "");
  }

  /** 构建一组专家协作记录元素（不插入 DOM，返回可复用的容器） */
  function buildTasksGroupEl(tasks: ExpertTask[], isLive = false): HTMLElement {
    const EXPERT_PHASE_LABELS: Record<string, string> = {
      'searching-repo': '仓库检索中',
      'searching-vector': '索引检索中',
      'searching-memory': '记忆检索中',
      'reading-code': '代码读取中',
      'analyzing': '分析处理中',
      'writing-code': '补丁生成中',
      'reviewing': '质量审查中',
      'completed': '已完成'
    };
    const sortedTasks = [...tasks].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    const groupEl = document.createElement("div");
    groupEl.className = `expert-tasks-group${isLive ? " live" : " compact"}`;
    const doneCount = sortedTasks.filter((t) => t.status === "done").length;
    const failedCount = sortedTasks.filter((t) => t.status === "error").length;
    const runningCount = sortedTasks.filter((t) => t.status === "running" || t.status === "pending").length;
    const headerTitle = isLive ? "专家协作中" : "本轮协作记录";
    const compactSummary = failedCount > 0
      ? `${sortedTasks.length} 位专家参与，${failedCount} 个环节有异常`
      : runningCount > 0
        ? `${sortedTasks.length} 位专家处理中`
        : `${sortedTasks.length} 位专家已处理完成`;
    groupEl.insertAdjacentHTML("beforeend", `
      <div class="expert-group-header">
        <div class="expert-group-header-main">
          <div class="expert-group-title">${headerTitle}</div>
          <div class="expert-group-summary">${escapeHtml(compactSummary)}</div>
        </div>
        <div class="expert-group-header-side">
          <div class="expert-group-stats">
            <span>完成 ${doneCount}</span>
            <span>执行中 ${runningCount}</span>
            <span>异常 ${failedCount}</span>
          </div>
          ${isLive ? "" : `<button class="expert-group-toggle" type="button" aria-expanded="false">展开</button>`}
        </div>
      </div>
    `);

    const bodyEl = document.createElement("div");
    bodyEl.className = `expert-group-body${isLive ? " expanded" : ""}`;
    groupEl.appendChild(bodyEl);

    if (isLive) {
      const firstBlockingTask = sortedTasks.find((t) => t.status === "error");
      const leadTask = firstBlockingTask || sortedTasks.find((t) => t.status === "running") || sortedTasks[0];
      const leadPhase = leadTask ? getExpertPhaseText(leadTask, EXPERT_PHASE_LABELS) : "处理中";
      const leadLine = firstBlockingTask
        ? `${leadTask.expertName}（${leadTask.expertTitle}）出现阻塞，我正在重新调整协作。`
        : `${leadTask?.expertName || "专家"}正在${leadPhase || "处理中"}。`;
      const liveItems = sortedTasks.map((task) => {
        const statusLabel = getExpertStatusText(task.status);
        const phaseText = getExpertPhaseText(task, EXPERT_PHASE_LABELS);
        return `
          <li class="expert-log-item" data-status="${task.status}">
            <span class="expert-log-marker"></span>
            <div class="expert-log-content">
              <div class="expert-log-main">${escapeHtml(task.expertName)}（${escapeHtml(task.expertTitle)}）</div>
              <div class="expert-log-sub">${escapeHtml(phaseText)} · ${statusLabel}</div>
            </div>
          </li>
        `;
      }).join("");

      bodyEl.insertAdjacentHTML("beforeend", `
        <div class="expert-log-shell">
          <div class="expert-log-line emphasis">${escapeHtml(leadLine)}</div>
          <ol class="expert-log-list">${liveItems}</ol>
        </div>
      `);
      return groupEl;
    }

    sortedTasks.forEach((task, index) => {
      const statusLabel = getExpertStatusText(task.status);

      const summaryText = task.status === "error"
        ? (task.error || "执行出错")
        : task.status === "done"
        ? (task.output ? extractExpertSummary(task.output) : "已完成")
        : task.input.substring(0, 80) + (task.input.length > 80 ? "..." : "");

      const recordHtml = `
        <div class="expert-log-record" data-expert-id="${escapeAttr(task.expertId)}" data-status="${task.status}">
          <div class="expert-log-record-head">
            <span class="expert-log-record-index">#${index + 1}</span>
            <span class="expert-log-record-name">${escapeHtml(task.expertName)}（${escapeHtml(task.expertTitle)}）</span>
            <span class="expert-log-record-status">${statusLabel}</span>
          </div>
          <div class="expert-log-record-summary">${escapeHtml(summaryText)}</div>
            ${task.status === "done" && task.output ? `
              <div class="expert-log-record-output">
                <button class="expert-log-output-toggle" type="button">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                  查看完整输出
                </button>
                <div class="expert-log-output-content">${escapeHtmlWithThink(sanitizeAssistantDisplayContent(task.output))}</div>
              </div>
            ` : ""}
        </div>
      `;
      bodyEl.insertAdjacentHTML("beforeend", recordHtml);
    });

    groupEl.querySelector(".expert-group-toggle")?.addEventListener("click", () => {
      const toggle = groupEl.querySelector(".expert-group-toggle") as HTMLButtonElement | null;
      const isExpanded = bodyEl.classList.toggle("expanded");
      toggle?.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      if (toggle) {
        toggle.textContent = isExpanded ? "收起" : "展开";
      }
    });

    groupEl.querySelectorAll(".expert-log-output-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const toggle = btn as HTMLElement;
        const content = toggle.nextElementSibling as HTMLElement;
        toggle.classList.toggle("expanded");
        content.classList.toggle("expanded");
      });
    });

    return groupEl;
  }

  /** 渲染运行中的专家任务卡片组（仅替换 data-live 标记的实时占位，不影响历史卡片组） */
  function renderExpertTaskCards(tasks: ExpertTask[]) {
    if (!chatMessages) return;

    // 仅移除实时占位组，保留历史中已持久化的卡片组
    const oldLive = chatMessages.querySelector('.expert-tasks-group[data-live="true"]');
    if (oldLive) oldLive.remove();

    if (tasks.length === 0) return;

    const groupEl = buildTasksGroupEl(tasks, true);
    groupEl.dataset.live = "true";
    chatMessages.appendChild(groupEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 监听专家任务更新事件
  window.addEventListener("expert-tasks-update", ((e: CustomEvent) => {
    const { tasks } = e.detail;
    renderExpertTaskCards(tasks || []);
  }) as EventListener);

  function escapeAttr(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 发送按钮点击
  chatSendBtn?.addEventListener("click", sendMessage);

  // 输入框回车发送 + 斜杠命令触发
  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  chatInput?.addEventListener("input", () => {
    const val = chatInput.value;
    const slashModal = document.getElementById("slash-modal");
    // 检测斜杠命令：行首单独 /
    if (val === "/") {
      if (slashModal) slashModal.classList.add("active");
    } else if (val === "" || !val.startsWith("/")) {
      if (slashModal) slashModal.classList.remove("active");
      // 输入框内容被清空或不再以 / 开头，移除斜杠命令状态
      chatInput.classList.remove("slash-active");
      delete chatInput.dataset.slashCommand;
      delete chatInput.dataset.slashLabel;
    }
  });

  // 斜杠弹窗选项点击
  document.querySelectorAll(".slash-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const target = e.currentTarget as HTMLElement;
      const command = target.dataset.command;
      const label = target.dataset.label || ("/" + command);
      const slashModal = document.getElementById("slash-modal");
      if (slashModal) slashModal.classList.remove("active");

      // 在输入框中插入高亮的斜杠命令（营光笔迹效果）
      const input = chatInput;
      // 替换当前内容为高亮命令
      input.value = label + " ";
      // 标记输入框已含有激活的斜杠命令
      input.dataset.slashCommand = command;
      input.dataset.slashLabel = label;
      input.classList.add("slash-active");
      input.style.height = "auto";
      input.focus();

      if (command === "image") {
        enterImageMode();
      } else if (command === "video") {
        enterVideoMode();
      }
    });
  });

  // 关闭斜杠弹窗
  document.getElementById("slash-modal-close")?.addEventListener("click", () => {
    const slashModal = document.getElementById("slash-modal");
    if (slashModal) slashModal.classList.remove("active");
  });
  document.querySelector(".slash-modal-backdrop")?.addEventListener("click", () => {
    const slashModal = document.getElementById("slash-modal");
    if (slashModal) slashModal.classList.remove("active");
  });

  // 输入框自动高度
  chatInput?.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  // 监听项目切换
  window.addEventListener("chat-changed", ((e: Event) => {
    const { chatId } = (e as CustomEvent).detail;
    currentProjectId = chatId;

    // 项目被删除（chatId 为 null）时清空所有相关 UI
    if (chatId === null) {
      // 清空会话状态
      currentSessionId = null;

      // 清空消息显示
      renderMessages();

      // 清空历史记录显示
      updateHistoryDisplay();

      // 清空画布
      const canvas = getCanvas();
      if (canvas) canvas.clear();

      // 隐藏文件预览相关面板
      if (fileBrowserCard) {
        fileBrowserCard.classList.remove("active");
        fileBrowserCard.style.display = "none";
      }
      if (filePreviewCard) {
        filePreviewCard.classList.remove("active");
        filePreviewCard.style.display = "none";
      }

      // 恢复画布和悬浮按钮可见性
      setElementVisible(canvasContainer as HTMLElement | null, true, "block");
      setFloatingActionsVisible(true);

      // 隐藏画布文件预览卡片
      hideCanvasFileCard();

      // 清空文件浏览器树
      if (fileBrowserTree) fileBrowserTree.innerHTML = "";

      // 清空当前预览文件
      currentPreviewFile = null;

      // 隐藏 Wiki 面板
      if (wikiPanel) {
        wikiPanel.classList.remove("active");
        wikiPanel.style.display = "none";
      }
      if (repoBrowser) {
        repoBrowser.classList.remove("active");
        repoBrowser.style.display = "none";
      }

      // 重置目录状态按钮
      updateDirectoryStatus("up-to-date");

      return;
    }

    // 重置感知索引状态（新项目需要重新检查）
    perceptualIndexReady = false;
    perceptualIndexBuilding = false;
    updateIndexStatus("", "检查中...");

    // 从数据库加载会话数据
    loadSessionsFromDb(chatId).then(async () => {
      // 切换到项目的第一个会话
      const sessions = getSessions(chatId);
      currentSessionId = sessions[0]?.id || null;

      renderMessages();
      updateHistoryDisplay();

      // 确保密钥池和专家团数据已加载
      if (keyPoolItems.length === 0) {
        await loadKeyPool();
      }
      if (experts.length === 0) {
        await loadExpertsData();
      }

      // 加载项目画布
      loadProjectCanvas(chatId);

      // 加载草稿数据（如果当前在草稿模式）
      const project = sidebar.getChats().find((c) => c.id === chatId);
      if (project) {
        if (isDraftMode) {
          draftCanvas.load(project.name);
        } else {
          draftCanvas.setProjectName(project.name);
        }
        // 检查并构建感知索引
        checkAndBuildIndex(project.name);
      }
    });
  }) as EventListener);

  // ========== 目录卡片模式（structure/logic） ==========
  let directoryMode: "structure" | "logic" = "structure";
  let directorySurfaceMode: "directory" | "draft" = "directory";

  /**
   * 把后端返回的 canvasDirectory 数据归一化成 { structure?, logic? } 形式。
   * 同时兼容三种历史格式：
   * 1) 新格式：{ structure: {...}, logic: {...} }
   * 2) 旧扁平格式：{ mode, nodes, edges, ... }
   * 3) 混合格式：新旧字段同时存在（旧版升级时 rust 端只追加未清理）
   * 优先使用新格式子字段，旧扁平字段仅作为兜底。
   */
  function normalizeCachedDirectory(parsed: any): { structure?: any; logic?: any } {
    const result: { structure?: any; logic?: any } = {};
    if (!parsed || typeof parsed !== "object") return result;
    if (parsed.structure && Array.isArray(parsed.structure.nodes) && parsed.structure.nodes.length > 0) {
      result.structure = parsed.structure;
    }
    if (parsed.logic && Array.isArray(parsed.logic.nodes) && parsed.logic.nodes.length > 0) {
      result.logic = parsed.logic;
    }
    // 旧扁平格式兜底
    if (parsed.mode && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
      if (parsed.mode === "logic" && !result.logic) result.logic = parsed;
      else if (parsed.mode === "structure" && !result.structure) result.structure = parsed;
    }
    return result;
  }

  /** 生成仅含项目根节点的最小画布数据（用作任何失败场景的兑底） */
  function makeRootOnlyResult(projectName: string): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    return {
      nodes: [{ id: projectName, type: "folder", name: projectName, x: 0, y: 0 }],
      edges: [],
    };
  }

  /** 根据文件夹结构生成画布节点和连线（纯机械操作，永不允许返回空） */
  async function generateStructureCanvas(projectName: string, projectPath?: string): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
    const fallback = makeRootOnlyResult(projectName);
    try {
      const entriesJson = await invoke<string>("sandbox_list_dir", {
        projectName,
        relativePath: ".",
        projectPath,
      });
      const tree: TreeEntry[] = JSON.parse(entriesJson);

      const nodes: CanvasNode[] = [];
      const edges: CanvasEdge[] = [];
      const V_GAP = 120;        // 父节点到第一排子节点的距离
      const ROW_GAP = 90;       // 排与排之间的垂直间距
      const H_GAP = 55;         // 同行兄弟节点间距（左右）
      const NODES_PER_ROW = 3;  // 每排最大节点数
      const NODE_WIDTH = 140;   // 单个节点水平占位

      // 创建根节点（项目文件夹）
      const rootId = projectName;
      nodes.push({
        id: rootId,
        type: "folder",
        name: projectName,
        x: 0,
        y: 0,
      });

      // 多排交错网格布局
      function layout(items: TreeEntry[], parentX: number, parentY: number, parentId: string): void {
        if (items.length === 0) return;

        // 将子节点分组为多排
        const rows: TreeEntry[][] = [];
        for (let i = 0; i < items.length; i += NODES_PER_ROW) {
          rows.push(items.slice(i, i + NODES_PER_ROW));
        }

        // 计算每排的宽度
        const rowWidths: number[] = [];
        let maxRowWidth = 0;
        for (const row of rows) {
          const w = row.length * NODE_WIDTH + (row.length - 1) * H_GAP;
          rowWidths.push(w);
          if (w > maxRowWidth) maxRowWidth = w;
        }

        // 从父节点下方开始，逐排向下布局
        let currentY = parentY + V_GAP;

        for (let ri = 0; ri < rows.length; ri++) {
          const row = rows[ri];
          const rowWidth = rowWidths[ri];

          // 交错偏移：奇数排右移半个间距，避免连线垂直重叠
          const staggerOffset = (ri % 2 === 1) ? H_GAP / 2 : 0;

          // 整排居中于父节点
          let currentX = parentX - rowWidth / 2 + staggerOffset;

          for (const item of row) {
            const children = item.children?.length ? item.children : [];
            const nodeX = currentX + NODE_WIDTH / 2;
            const nodeY = currentY;

            nodes.push({
              id: item.path,
              type: item.type as "folder" | "file",
              name: item.name,
              x: nodeX,
              y: nodeY,
            });
            edges.push({ from: parentId, to: item.path });

            // 递归布局子节点
            layout(children, nodeX, nodeY, item.path);

            currentX += NODE_WIDTH + H_GAP;
          }

          // 下一排向下移动
          currentY += ROW_GAP;
        }
      }

      // 从根节点开始布局
      layout(tree, 0, 0, rootId);

      // 确保至少有根节点
      if (nodes.length === 0) {
        log("WARN", "结构画布生成结果为空，使用根节点兗底");
        return fallback;
      }
      return { nodes, edges };
    } catch (e) {
      log("ERROR", `结构画布生成失败，使用根节点兗底: ${e}`);
      return fallback;
    }
  }

  async function saveDirectoryModeData(
    projectName: string,
    mode: "structure" | "logic",
    nodes: CanvasNode[],
    edges: CanvasEdge[],
    directorySnapshot: string[],
    updatedAt: string,
  ) {
    await invoke("save_canvas_directory", {
      projectName,
      data: JSON.stringify({
        nodes,
        edges,
        updatedAt,
        mode,
        directorySnapshot,
      }),
    });
  }

  function layoutProjectLogicCanvas(
    payload: ProjectLogicCanvasPayload,
  ): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    const scoreMap = new Map<string, number>();
    payload.nodes.forEach((node) => {
      scoreMap.set(node.id, node.weight || 1);
    });
    payload.edges.forEach((edge) => {
      scoreMap.set(edge.from, (scoreMap.get(edge.from) || 0) + edge.weight);
      scoreMap.set(edge.to, (scoreMap.get(edge.to) || 0) + edge.weight);
    });

    const sortedNodes = [...payload.nodes].sort((a, b) => {
      const scoreA = scoreMap.get(a.id) || a.weight || 1;
      const scoreB = scoreMap.get(b.id) || b.weight || 1;
      return scoreB - scoreA || a.label.localeCompare(b.label);
    });

    const laidOut: CanvasNode[] = [];
    if (sortedNodes.length > 0) {
      const center = sortedNodes[0];
      laidOut.push({
        id: center.file_path || center.id,
        path: center.file_path || center.id,
        type: "file",
        name: center.label,
        x: 0,
        y: 0,
      });
    }

    let cursor = 1;
    let ring = 1;
    while (cursor < sortedNodes.length) {
      const ringCount = Math.min(sortedNodes.length - cursor, 8 + (ring - 1) * 6);
      const radius = 220 + (ring - 1) * 180;
      for (let i = 0; i < ringCount; i += 1) {
        const node = sortedNodes[cursor + i];
        const angle = (Math.PI * 2 * i) / ringCount + ring * 0.32;
        laidOut.push({
          id: node.file_path || node.id,
          path: node.file_path || node.id,
          type: "file",
          name: node.label,
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      }
      cursor += ringCount;
      ring += 1;
    }

    const availableIds = new Set(laidOut.map((node) => node.id));
    const edges: CanvasEdge[] = payload.edges
      .map((edge) => ({
        from: edge.from,
        to: edge.to,
      }))
      .filter((edge) => availableIds.has(edge.from) && availableIds.has(edge.to));

    return { nodes: laidOut, edges };
  }

  async function generateLogicCanvas(
    projectName: string,
  ): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[]; updatedAt: string }> {
    const graphJson = await invoke<string>("perceptual_index_project_logic_graph", {
      projectName,
    });
    const payload = JSON.parse(graphJson) as ProjectLogicCanvasPayload;
    const { nodes, edges } = layoutProjectLogicCanvas(payload);
    return {
      nodes,
      edges,
      updatedAt: payload.updated_at,
    };
  }

  async function refreshProjectCanvasCaches(projectName: string, forceVisibleRefresh: boolean = false, projectPath?: string) {
    const snapshot = await collectDirectorySnapshot(projectName, projectPath);
    const structureResult = await generateStructureCanvas(projectName, projectPath);
    const logicResult = await generateLogicCanvas(projectName);

    await saveDirectoryModeData(
      projectName,
      "structure",
      structureResult.nodes,
      structureResult.edges,
      snapshot,
      new Date().toISOString(),
    );
    await saveDirectoryModeData(
      projectName,
      "logic",
      logicResult.nodes,
      logicResult.edges,
      snapshot,
      logicResult.updatedAt,
    );

    const activeProject = sidebar.getActiveChat();
    const canvas = getCanvas();
    if (!activeProject || activeProject.name !== projectName || !canvas) {
      return;
    }

    if (directoryMode === "structure") {
      canvas.setData(structureResult.nodes, structureResult.edges);
    } else if (directoryMode === "logic" || forceVisibleRefresh) {
      canvas.setData(logicResult.nodes, logicResult.edges);
    }

    updateDirectoryStatus("up-to-date");
  }

  // 加载项目画布数据（仅加载缓存，不自动生成）
  async function loadProjectCanvas(projectId: number) {
    const canvas = getCanvas();
    if (!canvas) return;

    const project = sidebar.getChats().find((c) => c.id === projectId);
    if (!project) return;

    canvas.clear();

    // 1. 尝试从 .xt/config.json 读取缓存的目录数据（新格式: { structure: {...}, logic: {...} }）
    let allCachedData: { structure?: any; logic?: any } | null = null;
    try {
      const cached = await invoke<string>("load_canvas_directory", {
        projectName: project.name,
      });

      if (cached && cached !== "null") {
        const parsed = JSON.parse(cached);
        // 统一归一化为 { structure?, logic? }，优先新格式、兼容旧格式
        allCachedData = normalizeCachedDirectory(parsed);
        // 默认优先 structure；若仅有 logic 才回退到 logic
        if (allCachedData.structure) {
          directoryMode = "structure";
        } else if (allCachedData.logic) {
          directoryMode = "logic";
        } else {
          directoryMode = "structure";
        }
        updateTabActive();
      }
    } catch (e) {
      log("WARN", `读取缓存目录失败: ${e}`);
    }

    // 2. 根据当前模式加载对应缓存
    const modeData = allCachedData?.[directoryMode];
    if (modeData && modeData.nodes && modeData.edges && modeData.nodes.length > 0) {
      canvas.setData(modeData.nodes, modeData.edges);
      log("INFO", `从缓存加载目录数据 (模式: ${directoryMode})`);
      await checkDirectoryChanges(project.name, modeData, project.workspacePath);
      return;
    }

    // 3. 无缓存：结构模式直接自动生成（纯机械操作，不需要任何前提条件）
    //    无论成功失败，画布上必须有内容（至少显示项目根节点）
    if (directoryMode === "structure") {
      updateDirectoryStatus("updating");
      const result = await generateStructureCanvas(project.name, project.workspacePath);
      canvas.setData(result.nodes, result.edges);
      const snapshot = await collectDirectorySnapshot(project.name, project.workspacePath);
      const now = new Date().toISOString();
      try {
        await saveDirectoryModeData(
          project.name,
          "structure",
          result.nodes,
          result.edges,
          snapshot,
          now,
        );
      } catch { /* 保存失败不影响显示 */ }
      updateDirectoryStatus("up-to-date");
      log("INFO", "无缓存，结构模式自动生成完成");
    } else {
      updateDirectoryStatus("updating");
      try {
        await checkAndBuildIndex(project.name);
        const logicResult = await generateLogicCanvas(project.name);
        canvas.setData(logicResult.nodes, logicResult.edges);
        const snapshot = await collectDirectorySnapshot(project.name, project.workspacePath);
        await saveDirectoryModeData(
          project.name,
          "logic",
          logicResult.nodes,
          logicResult.edges,
          snapshot,
          logicResult.updatedAt,
        );
        updateDirectoryStatus("up-to-date");
      } catch (e) {
        log("ERROR", `逻辑模式自动生成失败: ${e}`);
        const rootResult = makeRootOnlyResult(project.name);
        canvas.setData(rootResult.nodes, rootResult.edges);
        updateDirectoryStatus("needs-update");
      }
    }
  }

  // 基于感知索引生成逻辑画布并持久化
  async function aiGenerateCanvas(
    project: { id: number; name: string; workspacePath?: string },
    canvas: ReturnType<typeof getCanvas>,
  ) {
    if (!canvas) return;
    try {
      await checkAndBuildIndex(project.name);
      const logicResult = await generateLogicCanvas(project.name);
      canvas.setData(logicResult.nodes, logicResult.edges);

      const snapshot = await collectDirectorySnapshot(project.name, project.workspacePath);
      await saveDirectoryModeData(
        project.name,
        "logic",
        logicResult.nodes,
        logicResult.edges,
        snapshot,
        logicResult.updatedAt,
      );

      try {
        const allCached = await invoke<string>("load_canvas_directory", {
          projectName: project.name,
        });
        const parsedAll = allCached && allCached !== "null" ? JSON.parse(allCached) : {};
        const hasStructure = parsedAll.structure && parsedAll.structure.nodes && parsedAll.structure.nodes.length > 0;
        if (!hasStructure) {
          const structureResult = await generateStructureCanvas(project.name, project.workspacePath);
          await saveDirectoryModeData(
            project.name,
            "structure",
            structureResult.nodes,
            structureResult.edges,
            snapshot,
            new Date().toISOString(),
          );
          log("INFO", "逻辑模式生成时自动补全结构模式缓存");
        }
      } catch { /* 补全结构缓存失败不影响主流程 */ }

      updateDirectoryStatus("up-to-date");
      log("INFO", "基于感知索引生成逻辑目录数据并持久化");
      return;
    } catch (e) {
      log("ERROR", `加载项目画布失败: ${e}`);
      // 失败时显示根节点，禁止画布为空
      const rootResult = makeRootOnlyResult(project.name);
      canvas.setData(rootResult.nodes, rootResult.edges);
      updateDirectoryStatus("needs-update");
    }
  }
  void aiGenerateCanvas;

  /** 收集当前目录快照（所有文件/文件夹路径的排序列表） */
  async function collectDirectorySnapshot(projectName: string, projectPath?: string): Promise<string[]> {
    try {
      const entriesJson = await invoke<string>("sandbox_list_dir", {
        projectName,
        relativePath: ".",
        projectPath,
      });
      const tree: TreeEntry[] = JSON.parse(entriesJson);
      const paths: string[] = [];
      function collect(items: TreeEntry[]) {
        for (const item of items) {
          const modified = item.modifiedAtMs ?? 0;
          const size = item.size ?? 0;
          paths.push(`${item.path}|${item.type}|${modified}|${size}`);
          if (item.children) collect(item.children);
        }
      }
      collect(tree);
      return paths.sort();
    } catch {
      return [];
    }
  }

  /** 比较当前目录与缓存的快照，更新状态按钮 */
  async function checkDirectoryChanges(projectName: string, cachedData: any, projectPath?: string) {
    const currentSnapshot = await collectDirectorySnapshot(projectName, projectPath);
    const cachedSnapshot: string[] = cachedData.directorySnapshot || [];

    if (cachedSnapshot.length === 0) {
      // 旧缓存没有快照数据，标记为需要更新
      updateDirectoryStatus("needs-update");
      return;
    }

    // 比较两个快照
    if (currentSnapshot.length !== cachedSnapshot.length) {
      updateDirectoryStatus("needs-update");
      return;
    }
    for (let i = 0; i < currentSnapshot.length; i++) {
      if (currentSnapshot[i] !== cachedSnapshot[i]) {
        updateDirectoryStatus("needs-update");
        return;
      }
    }
    updateDirectoryStatus("up-to-date");
  }

  /** 更新状态按钮（“未生成”状态已废除，画布永不允许为空） */
  function updateDirectoryStatus(status: "up-to-date" | "needs-update" | "updating") {
    const btn = document.getElementById("canvas-directory-status-btn") as HTMLButtonElement;
    const textEl = document.getElementById("canvas-directory-status-text");
    if (!btn || !textEl) return;

    btn.classList.remove("needs-update", "spinning");

    switch (status) {
      case "up-to-date":
        textEl.textContent = "已同步";
        btn.disabled = true;
        break;
      case "needs-update":
        textEl.textContent = "待同步";
        btn.classList.add("needs-update");
        btn.disabled = false;
        break;
      case "updating":
        textEl.textContent = "同步中...";
        btn.classList.add("spinning");
        btn.disabled = true;
        break;
    }
  }

  function updateDirectorySurfaceUI() {
    const card = document.getElementById("canvas-directory-card");
    const title = document.getElementById("canvas-directory-title");
    const subtitle = document.getElementById("canvas-directory-subtitle");
    const directoryBtn = document.getElementById("dir-view-directory");
    const draftBtn = document.getElementById("dir-view-draft");
    const modeLabel = directoryMode === "structure" ? "结构" : "逻辑";

    if (card) card.classList.toggle("draft-active", directorySurfaceMode === "draft");
    if (directoryBtn) directoryBtn.classList.toggle("active", directorySurfaceMode === "directory");
    if (draftBtn) draftBtn.classList.toggle("active", directorySurfaceMode === "draft");

    if (title) {
      title.textContent = directorySurfaceMode === "draft"
        ? "可视化目录 · 草稿"
        : "可视化目录";
    }

    if (subtitle) {
      subtitle.textContent = directorySurfaceMode === "draft"
        ? `当前以${modeLabel}目录为底图，可直接叠加批注与连线`
        : `当前为${modeLabel}目录视图`;
    }
  }

  // 同步页签 UI 状态
  function updateTabActive() {
    const tabStructure = document.getElementById("dir-tab-structure");
    const tabLogic = document.getElementById("dir-tab-logic");
    if (tabStructure) tabStructure.classList.toggle("active", directoryMode === "structure");
    if (tabLogic) tabLogic.classList.toggle("active", directoryMode === "logic");
    updateDirectorySurfaceUI();
  }

  // 绑定状态按钮点击（触发增量更新）
  const dirStatusBtn = document.getElementById("canvas-directory-status-btn");
  dirStatusBtn?.addEventListener("click", async () => {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject || !getCanvas()) return;

    updateDirectoryStatus("updating");

    try {
      await checkAndBuildIndex(activeProject.name, true);
      await refreshProjectCanvasCaches(activeProject.name, true, activeProject.workspacePath);
    } finally {
      // 状态由具体更新函数设置
    }
  });

  /** 结构模式增量更新：只增加/移除变更的节点 */
  async function incrementalStructureUpdate(projectName: string, canvas: ReturnType<typeof getCanvas>, projectPath?: string) {
    if (!canvas) return;
    try {
      const result = await generateStructureCanvas(projectName, projectPath);
      canvas.setData(result.nodes, result.edges);

      // 收集并保存快照
      const snapshot = await collectDirectorySnapshot(projectName, projectPath);
      const now = new Date().toISOString();
      await saveDirectoryModeData(projectName, "structure", result.nodes, result.edges, snapshot, now);
      updateDirectoryStatus("up-to-date");
      log("INFO", "结构模式增量更新完成");
    } catch (e) {
      log("ERROR", `结构模式更新失败: ${e}`);
      updateDirectoryStatus("needs-update");
    }
  }
  void incrementalStructureUpdate;

  async function switchDirectoryMode(nextMode: "structure" | "logic") {
    if (directoryMode === nextMode) {
      updateTabActive();
      return;
    }

    directoryMode = nextMode;
    updateTabActive();

    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;
    const canvas = getCanvas();
    if (!canvas) return;
    canvas.clear();

    try {
      const cached = await invoke<string>("load_canvas_directory", {
        projectName: activeProject.name,
      });
      if (cached && cached !== "null") {
        const parsed = JSON.parse(cached);
        const modeData = normalizeCachedDirectory(parsed)[nextMode];
        if (modeData && modeData.nodes && modeData.edges && modeData.nodes.length > 0) {
          canvas.setData(modeData.nodes, modeData.edges);
          await checkDirectoryChanges(activeProject.name, modeData, activeProject.workspacePath);
          return;
        }
      }
    } catch { /* ignore */ }

    updateDirectoryStatus("updating");

    if (nextMode === "structure") {
      const result = await generateStructureCanvas(activeProject.name, activeProject.workspacePath);
      canvas.setData(result.nodes, result.edges);
      const snapshot = await collectDirectorySnapshot(activeProject.name, activeProject.workspacePath);
      const now = new Date().toISOString();
      try {
        await saveDirectoryModeData(
          activeProject.name,
          "structure",
          result.nodes,
          result.edges,
          snapshot,
          now,
        );
      } catch { /* 保存失败不影响显示 */ }
      updateDirectoryStatus("up-to-date");
      return;
    }

    try {
      await checkAndBuildIndex(activeProject.name);
      const logicResult = await generateLogicCanvas(activeProject.name);
      canvas.setData(logicResult.nodes, logicResult.edges);
      const snapshot = await collectDirectorySnapshot(activeProject.name, activeProject.workspacePath);
      await saveDirectoryModeData(
        activeProject.name,
        "logic",
        logicResult.nodes,
        logicResult.edges,
        snapshot,
        logicResult.updatedAt,
      );
      updateDirectoryStatus("up-to-date");
    } catch (e) {
      log("ERROR", `逻辑模式切换生成失败: ${e}`);
      const rootResult = makeRootOnlyResult(activeProject.name);
      canvas.setData(rootResult.nodes, rootResult.edges);
      updateDirectoryStatus("needs-update");
    }
  }

  function switchDirectorySurface(nextMode: "directory" | "draft") {
    if (directorySurfaceMode === nextMode) {
      updateDirectorySurfaceUI();
      return;
    }

    directorySurfaceMode = nextMode;
    if (nextMode === "draft") {
      if (!isDraftMode) enterDraftMode();
      else updateDirectorySurfaceUI();
      return;
    }

    if (isDraftMode) {
      exitDraftMode();
    } else {
      showDirectoryWorkspace();
      clearViewTabs("btn-directory");
      updateDirectorySurfaceUI();
    }
  }

  document.querySelector(".canvas-directory-tabs")?.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>(".canvas-directory-tab");
    if (!tab) return;
    const nextMode = tab.dataset.mode as "structure" | "logic" | undefined;
    if (!nextMode) return;
    void switchDirectoryMode(nextMode);
  });

  document.querySelector(".canvas-view-switch")?.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>(".canvas-view-switch-btn");
    if (!button) return;
    if (button.id === "dir-view-draft") {
      switchDirectorySurface("draft");
      return;
    }
    switchDirectorySurface("directory");
  });

  updateDirectorySurfaceUI();

  type PrimaryWorkspaceView = "directory" | "file" | "repo" | "git" | "token" | "workspace-settings";

  function switchPrimaryWorkspaceView(view: PrimaryWorkspaceView) {
    switch (view) {
      case "directory":
        enterDirectoryMode();
        return;
      case "file":
        enterFileMode();
        return;
      case "repo":
        void enterWikiMode();
        return;
      case "git":
        void enterGitMode();
        return;
      case "token":
        enterTokenMode();
        return;
      case "workspace-settings":
        void enterWorkspaceSettingsMode();
        return;
    }
  }

  function bindPrimaryWorkspaceViewTabs() {
    const floatingActionsHost = document.getElementById("floating-actions");
    if (!floatingActionsHost || floatingActionsHost.dataset.bound === "true") {
      return;
    }

    floatingActionsHost.dataset.bound = "true";
    floatingActionsHost.addEventListener("click", (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>(".view-tab");
      if (!button) return;
      const view = button.dataset.view as PrimaryWorkspaceView | undefined;
      if (!view) return;
      e.preventDefault();
      switchPrimaryWorkspaceView(view);
    });
  }

  bindPrimaryWorkspaceViewTabs();

  // 保留全局API（兼容 ACTION 系统），并提前绑定避免后续初始化异常影响页签切换。
  (window as any).__switchView = (view: string) => {
    if (
      view === "file" ||
      view === "directory" ||
      view === "repo" ||
      view === "git" ||
      view === "token" ||
      view === "workspace-settings"
    ) {
      switchPrimaryWorkspaceView(view as PrimaryWorkspaceView);
      return;
    }
    if (view === "image") {
      enterImageMode();
      return;
    }
    if (view === "video") {
      enterVideoMode();
      return;
    }
    if (view === "data-analysis") {
      enterDataMode();
      return;
    }
    enterDirectoryMode();
  };

  // 初始化显示
  renderMessages();
  updateHistoryDisplay();

  // ========== 画布文件预览卡片 ==========
  const canvasFileCard = document.getElementById("canvas-file-card");
  const canvasFileTitle = document.getElementById("canvas-file-title");
  const canvasFileTime = document.getElementById("canvas-file-time");
  const canvasFileUpdate = document.getElementById("canvas-file-update");

  /** 显示画布文件预览卡片 */
  function showCanvasFileCard(filename: string, updatedAt?: string) {
    if (!canvasFileCard) return;
    if (canvasFileTitle) canvasFileTitle.textContent = filename;
    if (canvasFileTime) canvasFileTime.textContent = updatedAt || "刚刚生成";
    canvasFileCard.style.display = "flex";
  }

  /** 隐藏画布文件预览卡片 */
  function hideCanvasFileCard() {
    if (!canvasFileCard) return;
    canvasFileCard.style.display = "none";
  }

  // 文件预览卡片更新按钮
  canvasFileUpdate?.addEventListener("click", async () => {
    if (!currentPreviewFile) return;
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    canvasFileUpdate.classList.add("spinning");
    (canvasFileUpdate as HTMLButtonElement).disabled = true;

    try {
      // 重新读取文件内容
      const content = await invoke<string>("sandbox_read_file", {
        projectName: activeProject.name,
        relativePath: currentPreviewFile,
        projectPath: activeProject.workspacePath,
      });
      if (filePreviewEditor) filePreviewEditor.value = content;
      if (isMarkdownFile(currentPreviewFile)) updateMdPreview();

      // 更新时间
      const now = new Date().toLocaleString("zh-CN");
      if (canvasFileTime) canvasFileTime.textContent = now;
    } catch (e) {
      log("ERROR", `刷新文件失败: ${e}`);
    }

    canvasFileUpdate.classList.remove("spinning");
    (canvasFileUpdate as HTMLButtonElement).disabled = false;
  });

  // ========== Wiki 知识库模式 ==========

  // Wiki 状态变量
  let wikiIterationMode: "manual" | "self" | "auto" = "manual";
  let wikiAutoTimer: ReturnType<typeof setInterval> | null = null;
  let wikiApiKey: string = "";

  // Wiki DOM 元素
  const wikiPanel = document.getElementById("wiki-panel");
  const repoBrowser = document.getElementById("repo-browser");
  const wikiArticle = document.getElementById("wiki-article");
  const wikiTitle = document.getElementById("wiki-title");
  const wikiBack = document.getElementById("wiki-back");
  const wikiIterationBtn = document.getElementById("wiki-iteration-btn") as HTMLButtonElement;
  const wikiIterationModeEl = document.getElementById("wiki-iteration-mode") as HTMLSelectElement;
  const wikiIterationStatus = document.getElementById("wiki-iteration-status");
  const repoBrowserList = document.getElementById("repo-browser-list");

  function wikiMarkdownRender(md: string): string {
    let html = md;
    html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, _lang: string, code: string) => `<pre><code>${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    html = html.replace(/^---+$/gm, "<hr>");
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
    html = html.replace(/^(\s*)\d+\. (.+)$/gm, "$1<li>$2</li>");
    html = html.replace(/^\|(.+)\|$/gm, (_match: string, cells: string) => {
      const tds = cells.split("|").map((c: string) => `<td>${c.trim()}</td>`).join("");
      return `<tr>${tds}</tr>`;
    });
    html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, "<p>$1</p>");
    html = html.replace(/<p><\/p>/g, "");
    html = html.replace(/\n/g, "");
    html = html.replace(/((?:<li>.*?<\/li>)+)/g, "<ul>$1</ul>");
    return html;
  }

  /** 获取当前项目的 API Key（复用全局密钥池） */
  async function getWikiApiKey(): Promise<string> {
    if (wikiApiKey) return wikiApiKey;
    // 优先使用已有的全局密钥
    const active = getActiveApiKey();
    if (active) {
      wikiApiKey = active;
      return wikiApiKey;
    }
    // fallback: 确保密钥池已加载后再尝试
    try {
      await loadKeyPool();
      const fallback = getActiveApiKey();
      if (fallback) {
        wikiApiKey = fallback;
      }
    } catch {
      // 忽略
    }
    return wikiApiKey;
  }

  /** 进入 Wiki 模式 */
  async function enterWikiMode() {
    const activeProject = await resolveActiveProjectForView("仓库");
    if (!activeProject) {
      return;
    }
    exitDraftMode();
    exitTokenMode();
    exitGitMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();

    // 显示 Wiki 面板和仓库管理器
    if (wikiPanel) {
      wikiPanel.style.display = "flex";
      wikiPanel.classList.add("active");
    }
    if (repoBrowser) {
      repoBrowser.style.display = "flex";
      repoBrowser.classList.add("active");
    }
    clearViewTabs("btn-repo");
    setFloatingActionsVisible(true);

    // 加载仓库导航
    await loadRepoBrowser(activeProject.name);

    // 默认加载 Wiki 文章
    await loadWikiArticle(activeProject.name);

    log("INFO", "进入 Wiki 模式");
  }

  /** 退出 Wiki 模式 */
  function exitWikiMode() {
    // 停止自动迭代
    stopAutoIteration();

    // 隐藏 Wiki 面板和仓库管理器
    if (wikiPanel) {
      wikiPanel.classList.remove("active");
      wikiPanel.style.display = "none";
    }
    if (repoBrowser) {
      repoBrowser.classList.remove("active");
      repoBrowser.style.display = "none";
    }

    showDirectoryWorkspace();
    clearViewTabs("btn-directory");

    log("INFO", "退出 Wiki 模式");
  }

  /** 加载仓库管理器导航 */
  async function loadRepoBrowser(projectName: string) {
    if (!repoBrowserList) return;
    repoBrowserList.innerHTML = "";

    try {
      const itemsStr = await invoke<string>("repo_list_items", { projectName });
      const items = JSON.parse(itemsStr);

      // 默认 Wiki 入口
      const wikiItem = document.createElement("div");
      wikiItem.className = "repo-nav-item active";
      wikiItem.dataset.repoId = "wiki";
      wikiItem.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
        <span>Wiki 文章</span>
      `;
      wikiItem.addEventListener("click", () => selectRepoItem("wiki", projectName));
      repoBrowserList.appendChild(wikiItem);

      // 动态仓库项（Wiki 文章入口固定保留一个，避免出现「文章名 + index」重复）
      if (Array.isArray(items)) {
        for (const item of items) {
          if (typeof item?.id === "string" && item.id.startsWith("wiki:")) continue;
          const navItem = document.createElement("div");
          navItem.className = "repo-nav-item";
          navItem.dataset.repoId = item.id;
          navItem.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            </svg>
            <span>${item.name}</span>
          `;
          navItem.addEventListener("click", () => selectRepoItem(item.id, projectName));
          repoBrowserList.appendChild(navItem);
        }
      }
    } catch (e) {
      repoBrowserList.innerHTML = `<div style="padding:8px;color:rgba(255,255,255,0.4);font-size:12px;">无法加载仓库</div>`;
      log("ERROR", `加载仓库失败: ${e}`);
    }
  }

  /** 选择仓库导航项 */
  async function selectRepoItem(id: string, projectName: string) {
    // 更新激活状态
    repoBrowserList?.querySelectorAll(".repo-nav-item").forEach((el) => {
      const itemEl = el as HTMLElement;
      if (itemEl.dataset.repoId === id) {
        itemEl.classList.add("active");
      } else {
        itemEl.classList.remove("active");
      }
    });

    // 加载对应内容（所有项都是 Wiki 文章）
    if (id === "wiki") {
      await loadWikiArticle(projectName);
    } else if (id.startsWith("wiki:")) {
      const wikiName = id.substring(5);
      await loadWikiArticle(projectName, wikiName);
    }
  }

  /** 加载 Wiki 文章 */
  async function loadWikiArticle(projectName: string, name: string = "index") {
    if (!wikiArticle) return;

    try {
      const content = await invoke<string>("repo_read_wiki", { projectName, name });
      wikiArticle.innerHTML = wikiMarkdownRender(content);
      if (wikiTitle) wikiTitle.textContent = `Wiki - ${name}`;
    } catch {
      // 没有 Wiki 文章，显示提示
      wikiArticle.innerHTML = `
        <div style="text-align:center;padding:40px;color:#999;">
          <p>暂无 Wiki 文章</p>
          <p style="font-size:12px;margin-top:8px;">点击左下角"执行迭代"按钮生成知识卡片和 Wiki 文章</p>
        </div>
      `;
      if (wikiTitle) wikiTitle.textContent = "Wiki";
    }
  }

  /** 设置迭代状态 */
  function setIterationStatus(text: string, className: string = "") {
    if (!wikiIterationStatus) return;
    wikiIterationStatus.textContent = text;
    wikiIterationStatus.className = "wiki-iteration-status " + className;
  }

  /** 执行知识迭代 */
  async function executeIteration() {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    const apiKey = await getWikiApiKey();
    if (!apiKey) {
      setIterationStatus("缺少 API 密钥", "");
      return;
    }

    if (wikiIterationBtn) {
      wikiIterationBtn.disabled = true;
      wikiIterationBtn.textContent = "迭代中...";
    }
    setIterationStatus("正在执行迭代（生成卡片 + 合成 Wiki）...", "running");

    try {
      // 合成 Wiki（内部会自动生成卡片若不存在）
      await invoke("repo_synthesize_wiki", {
        projectName: activeProject.name,
        apiKey,
        model: getActiveKeyModel(),
        name: "index",
      });

      setIterationStatus("迭代完成", "done");

      // 刷新当前视图
      await loadWikiArticle(activeProject.name);
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      const shortErr = errMsg.length > 60 ? errMsg.substring(0, 60) + "..." : errMsg;
      setIterationStatus(`迭代失败: ${shortErr}`, "");
      log("ERROR", `Wiki 迭代失败: ${e}`);
    } finally {
      if (wikiIterationBtn) {
        wikiIterationBtn.disabled = false;
        wikiIterationBtn.textContent = "执行迭代";
      }
      setTimeout(() => {
        if (wikiIterationStatus && wikiIterationStatus.classList.contains("done")) {
          setIterationStatus("就绪", "");
        }
      }, 3000);
    }
  }

  /** 增量更新（自迭代触发） */
  async function runIncrementalUpdate() {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    const apiKey = await getWikiApiKey();
    if (!apiKey) return;

    setIterationStatus("自迭代中...", "running");

    try {
      const result = await invoke<string>("repo_incremental_update", {
        projectName: activeProject.name,
        apiKey,
        model: getActiveKeyModel(),
      });
      log("INFO", `Wiki 增量更新: ${result}`);
      setIterationStatus("自迭代完成", "done");

      // 刷新当前视图
      await loadWikiArticle(activeProject.name);
    } catch (e) {
      log("ERROR", `Wiki 增量更新失败: ${e}`);
      setIterationStatus("就绪", "");
    }

    setTimeout(() => {
      if (wikiIterationStatus && wikiIterationStatus.classList.contains("done")) {
        setIterationStatus("就绪", "");
      }
    }, 3000);
  }

  /** 启动自动迭代 */
  function startAutoIteration() {
    stopAutoIteration();
    wikiAutoTimer = setInterval(() => {
      runIncrementalUpdate();
    }, 10 * 60 * 1000); // 每 10 分钟
    log("INFO", "Wiki 自动迭代已启动 (10分钟间隔)");
  }

  /** 停止自动迭代 */
  function stopAutoIteration() {
    if (wikiAutoTimer) {
      clearInterval(wikiAutoTimer);
      wikiAutoTimer = null;
      log("INFO", "Wiki 自动迭代已停止");
    }
  }

  // Wiki 事件绑定

  // ========== 仓库管理器 Tab 切换 ==========

  function initRepoTabs() {
    const tabs = document.querySelectorAll('.repo-tab-btn');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-tab');
        document.querySelector('.repo-tab-content-wiki')?.classList.toggle('hidden', target !== 'wiki');
        document.querySelector('.repo-tab-content-memory')?.classList.toggle('hidden', target !== 'memory');
        if (target === 'memory') loadMemoryPanel();
      });
    });
  }

  /** 相对时间格式化 */
  function relativeTime(ts: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}天前`;
    return new Date(ts * 1000).toLocaleDateString();
  }

  async function loadMemoryPanel() {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject || !currentProjectId) return;
    const projectName = activeProject.name;

    try {
      const stats = await getMemoryStats(projectName);

      // 渲染统计栏 —— 只显示长期记忆
      const statsEl = document.querySelector('.memory-stats');
      if (statsEl) {
        statsEl.innerHTML = `
          <span class="memory-stat-item total">全部 ${stats.total}</span>
          <span class="memory-stat-item ephemeral">瞬时记忆 ${stats.ephemeral}</span>
          <span class="memory-stat-item working">工作记忆 ${stats.working}</span>
          <span class="memory-stat-item longterm">长期记忆 ${stats.longterm}</span>
        `;
      }

      const filterEl = document.querySelector('.memory-filter') as HTMLElement | null;
      if (filterEl) {
        const filters: Array<{ key: typeof currentMemoryFilter; label: string }> = [
          { key: 'all', label: '全部' },
          { key: 'ephemeral', label: '瞬时' },
          { key: 'working', label: '工作' },
          { key: 'longterm', label: '长期' },
        ];
        filterEl.style.display = 'flex';
        filterEl.innerHTML = filters.map(({ key, label }) => `
          <button class="memory-filter-btn${currentMemoryFilter === key ? ' active' : ''}" data-filter="${key}">
            ${label}
          </button>
        `).join('');
        filterEl.querySelectorAll('.memory-filter-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const filter = (btn as HTMLElement).dataset.filter as typeof currentMemoryFilter | undefined;
            if (!filter || filter === currentMemoryFilter) return;
            currentMemoryFilter = filter;
            loadMemoryPanel();
          });
        });
      }

      const results = await searchMemory(projectName, {
        project_id: currentProjectId,
        query_text: '',
        memory_type: currentMemoryFilter === 'all' ? undefined : currentMemoryFilter,
        limit: 1000,
      });
      const filtered = [...results].sort((a, b) => b.entry.created_at - a.entry.created_at);

      // 渲染列表
      const listEl = document.querySelector('.memory-list');
      if (listEl) {
        if (filtered.length === 0) {
          listEl.innerHTML = `<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.3);font-size:12px;">暂无记忆</div>`;
        } else {
          listEl.innerHTML = filtered.map(r => {
            const m = r.entry;
            const kw = m.keywords?.length
              ? m.keywords.slice(0, 5).join(', ')
              : m.content?.substring(0, 40) || '';
            const preview = escapeHtml(m.content?.replace(/\n+/g, ' ').slice(0, 120) || '');
            return `
              <div class="memory-item" data-id="${m.id}" data-type="${m.memory_type}">
                <span class="memory-type-badge ${m.memory_type}">${m.memory_type}</span>
                <span class="memory-keywords">${escapeHtml(kw)}</span>
                <span class="memory-time">${relativeTime(m.created_at)}</span>
                <button class="memory-delete-btn" title="删除">×</button>
                <div style="width:100%;margin-top:8px;color:rgba(255,255,255,0.72);font-size:12px;line-height:1.5;">${preview}</div>
              </div>`;
          }).join('');

          // 绑定删除事件
          listEl.querySelectorAll('.memory-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const item = (e.target as HTMLElement).closest('.memory-item');
              const id = item?.getAttribute('data-id');
              const type = item?.getAttribute('data-type');
              if (id && type && projectName) {
                try {
                  await deleteMemory(projectName, type, id);
                  loadMemoryPanel();
                } catch (err) {
                  log('ERROR', `删除记忆失败: ${err}`);
                }
              }
            });
          });
        }
      }
    } catch (e) {
      log('ERROR', `加载记忆面板失败: ${e}`);
      const listEl = document.querySelector('.memory-list');
      if (listEl) {
        listEl.innerHTML = `<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.3);font-size:12px;">加载失败</div>`;
      }
    }
  }

  // 初始化 Tab 切换
  initRepoTabs();

  // ========== 草稿模式 ==========
  const draftCanvas = new DraftCanvas();
  const draftToolbox = new DraftToolbox();
  const draftSidebar = new DraftSidebar();
  let isDraftMode = false;

  // 关联侧边栏与画布
  draftSidebar.setCanvas(draftCanvas);

  // 草稿模式下右键平移 / 滚轮缩放转发给主画布
  draftCanvas.setOnPanRequest((dx, dy) => {
    const c = getCanvas();
    (c as any)?.panBy?.(dx, dy);
  });
  draftCanvas.setOnZoomRequest((cx, cy, factor) => {
    const c = getCanvas();
    (c as any)?.zoomAt?.(cx, cy, factor);
  });

  // 同步无限画布的视口到草稿画布
  function syncDraftViewport() {
    const canvas = getCanvas();
    if (canvas) {
      const view = (canvas as any).view || { x: 0, y: 0, scale: 1 };
      draftCanvas.setViewport(view);
    }
  }

  // 进入草稿模式
  function enterDraftMode() {
    if (isDraftMode) return;
    exitTokenMode();
    exitGitMode();
    exitWikiMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();
    isDraftMode = true;
    directorySurfaceMode = "draft";

    // 恢复目录画布可见（草稿模式下仍需要底层目录画布作为背景）
    const cc = document.getElementById("canvas-container");
    const dirStack = document.getElementById("canvas-directory-stack");
    setElementVisible(cc as HTMLElement | null, true, "block");
    setElementVisible(dirStack as HTMLElement | null, true, "flex");
    document.body.classList.add("workspace-draft-mode");

    clearViewTabs("btn-directory");
    updateDirectorySurfaceUI();

    // 激活草稿画布和工具栏
    draftCanvas.activate();
    draftToolbox.show();
    draftSidebar.show();
    syncDraftViewport();

    // 加载当前项目的草稿数据
    const activeProject = sidebar.getActiveChat();
    if (activeProject) {
      draftCanvas.load(activeProject.name);
    }

    log("INFO", "进入草稿模式");
  }

  // 退出草稿模式
  function exitDraftMode() {
    if (!isDraftMode) return;
    isDraftMode = false;
    directorySurfaceMode = "directory";
    document.body.classList.remove("workspace-draft-mode");

    draftCanvas.deactivate();
    draftToolbox.hide();
    draftSidebar.hide();

    showDirectoryWorkspace();
    clearViewTabs("btn-directory");
    updateDirectorySurfaceUI();

    log("INFO", "退出草稿模式");
  }

  // 工具箱回调
  draftToolbox.setOnToolChange((tool) => {
    draftCanvas.setTool(tool);
  });
  draftToolbox.setOnColorChange((color) => {
    draftCanvas.setColor(color);
  });
  draftToolbox.setOnEraserModeChange((mode) => {
    draftCanvas.setEraserMode(mode);
  });
  draftToolbox.setOnClearCanvas(() => {
    draftCanvas.clearCanvas();
  });

  // 监听工具变化事件（快捷键触发）
  window.addEventListener("draft-tool-changed", ((e: CustomEvent) => {
    const tool = e.detail.tool as DraftTool;
    draftToolbox.selectTool(tool);
    draftCanvas.setTool(tool);
  }) as EventListener);

  // 监听无限画布视口变化，同步到草稿画布
  window.addEventListener("canvas-viewport-changed", ((e: CustomEvent) => {
    const { x, y, scale } = e.detail;
    draftCanvas.setViewport({ x, y, scale });
  }) as EventListener);

  // 词元模式状态
  let isTokenMode = false;

  // 格式化词元数量（加千分位或缩写）
  function formatTokenCount(count: number): string {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
    if (count >= 1000) return (count / 1000).toFixed(1) + "K";
    return count.toString();
  }

  // 获取时间范围起始时间戳
  // 相对时间格式化
  function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天前`;
    return new Date(timestamp).toLocaleDateString();
  }

  // Canvas 趋势图绘制
  function drawTrendChart(labels: string[], buckets: number[]): void {
    const canvas = document.getElementById("trend-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 设置Canvas实际像素
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2; // 高DPI
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    const w = rect.width;
    const h = rect.height;

    // 绘制
    const maxVal = Math.max(...buckets, 1);
    const padding = { top: 20, right: 20, bottom: 30, left: 50 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // 清空
    ctx.clearRect(0, 0, w, h);

    // 网格线
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    // Y轴标签
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const val = maxVal - (maxVal / 4) * i;
      const y = padding.top + (chartH / 4) * i;
      ctx.fillText(formatTokenCount(val), padding.left - 8, y + 3);
    }

    // 折线
    if (buckets.length > 1) {
      const step = chartW / (buckets.length - 1);
      ctx.beginPath();
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      buckets.forEach((val, i) => {
        const x = padding.left + i * step;
        const y = padding.top + chartH - (val / maxVal) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 填充渐变
      ctx.lineTo(padding.left + (buckets.length - 1) * step, padding.top + chartH);
      ctx.lineTo(padding.left, padding.top + chartH);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
      gradient.addColorStop(0, "rgba(99, 102, 241, 0.3)");
      gradient.addColorStop(1, "rgba(99, 102, 241, 0)");
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // X轴标签（间隔显示，避免重叠）
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    const labelInterval = Math.ceil(labels.length / 10);
    labels.forEach((label, i) => {
      if (i % labelInterval === 0) {
        const x = padding.left + (chartW / (buckets.length - 1 || 1)) * i;
        ctx.fillText(label, x, h - 8);
      }
    });
  }

  // 当前词元数据源
  let currentTokenSource: "project" | "user" = "project";

  // 渲染词元仪表盘
  async function renderTokenDashboard(activeRange: TimeRange = "today", dataSource: "project" | "user" = currentTokenSource): Promise<void> {
    const panel = document.getElementById("token-panel-content");
    if (!panel) return;

    const snapshot = await buildTokenDashboardSnapshot(activeRange, dataSource, experts);
    const maxExpertTokens = snapshot.expertDistribution.length > 0 ? snapshot.expertDistribution[0].total : 1;

    panel.innerHTML = `
      <div class="token-dashboard">
        <!-- 顶部概览卡片 -->
        <div class="dashboard-overview">
          <div class="overview-card">
            <span class="overview-label">今日消耗</span>
            <span class="overview-value">${formatTokenCount(snapshot.todayUsage.total)}</span>
            <span class="overview-sub">输入 ${formatTokenCount(snapshot.todayUsage.prompt)} / 输出 ${formatTokenCount(snapshot.todayUsage.completion)}</span>
          </div>
          <div class="overview-card">
            <span class="overview-label">本月消耗</span>
            <span class="overview-value">${formatTokenCount(snapshot.monthUsage.total)}</span>
            <span class="overview-sub">输入 ${formatTokenCount(snapshot.monthUsage.prompt)} / 输出 ${formatTokenCount(snapshot.monthUsage.completion)}</span>
          </div>
          <div class="overview-card">
            <span class="overview-label">总计消耗</span>
            <span class="overview-value">${formatTokenCount(snapshot.totalUsage.total)}</span>
          </div>
          <div class="overview-card">
            <span class="overview-label">活跃专家</span>
            <span class="overview-value">${snapshot.activeExpertCount}</span>
            <span class="overview-sub">/ ${experts.length} 位</span>
          </div>
        </div>

        <!-- 消耗趋势图 -->
        <div class="dashboard-section">
          <h3 class="dashboard-section-title">消耗趋势</h3>
          <div class="dashboard-chart-container">
            <canvas id="trend-canvas" width="800" height="200"></canvas>
          </div>
        </div>

        <!-- 专家词元分布 -->
        <div class="dashboard-section">
          <h3 class="dashboard-section-title">专家词元分布</h3>
          <div class="expert-distribution-bars">
            ${snapshot.expertDistribution.length > 0
              ? snapshot.expertDistribution
                  .map(
                    (e) => `
              <div class="distribution-bar-item">
                <div class="distribution-bar-label">
                  <span class="distribution-name">${e.name}（${e.title}）</span>
                  <span class="distribution-value">${formatTokenCount(e.total)}</span>
                </div>
                <div class="distribution-bar-track">
                  <div class="distribution-bar-fill" style="width: ${(e.total / maxExpertTokens * 100).toFixed(1)}%"></div>
                </div>
              </div>
            `
                  )
                  .join("")
              : '<div class="dashboard-empty">暂无数据</div>'}
          </div>
        </div>

        <!-- 模型使用统计 -->
        <div class="dashboard-section">
          <h3 class="dashboard-section-title">模型使用统计</h3>
          <div class="model-stats-table">
            ${snapshot.modelStats.length > 0
              ? `
              <div class="model-table-header">
                <span>模型</span>
                <span>调用次数</span>
                <span>词元消耗</span>
              </div>
              ${snapshot.modelStats
                .map(
                  (stats) => `
                <div class="model-table-row">
                  <span class="model-name">${stats.model}</span>
                  <span class="model-calls">${stats.calls}</span>
                  <span class="model-tokens">${formatTokenCount(stats.tokens)}</span>
                </div>
              `
                )
                .join("")}
            `
              : '<div class="dashboard-empty">暂无数据</div>'}
          </div>
        </div>

        <!-- 配额状态 -->
        <div class="dashboard-section">
          <h3 class="dashboard-section-title">配额状态</h3>
          <div class="quota-status-grid">
            ${snapshot.quotaStatus.length > 0
              ? snapshot.quotaStatus
                  .map((item) => {
                    return `
                      <div class="quota-card">
                        <div class="quota-card-header">
                          <span class="quota-card-name">${item.name}</span>
                          <span class="quota-card-title">${item.title}</span>
                        </div>
                        ${item.dailyLimit !== null
                          ? `
                          <div class="quota-card-row">
                            <span class="quota-period">日</span>
                            <div class="quota-progress-bar"><div class="quota-progress-fill ${item.dayUsed >= item.dailyLimit ? "quota-exceeded" : ""}" style="width:${Math.min(100, (item.dayUsed / item.dailyLimit) * 100)}%"></div></div>
                            <span class="quota-fraction">${formatTokenCount(item.dayUsed)}/${formatTokenCount(item.dailyLimit)}</span>
                          </div>
                        `
                          : ""}
                        ${item.monthlyLimit !== null
                          ? `
                          <div class="quota-card-row">
                            <span class="quota-period">月</span>
                            <div class="quota-progress-bar"><div class="quota-progress-fill ${item.monthUsed >= item.monthlyLimit ? "quota-exceeded" : ""}" style="width:${Math.min(100, (item.monthUsed / item.monthlyLimit) * 100)}%"></div></div>
                            <span class="quota-fraction">${formatTokenCount(item.monthUsed)}/${formatTokenCount(item.monthlyLimit)}</span>
                          </div>
                        `
                          : ""}
                        ${item.yearlyLimit !== null
                          ? `
                          <div class="quota-card-row">
                            <span class="quota-period">年</span>
                            <div class="quota-progress-bar"><div class="quota-progress-fill ${item.yearUsed >= item.yearlyLimit ? "quota-exceeded" : ""}" style="width:${Math.min(100, (item.yearUsed / item.yearlyLimit) * 100)}%"></div></div>
                            <span class="quota-fraction">${formatTokenCount(item.yearUsed)}/${formatTokenCount(item.yearlyLimit)}</span>
                          </div>
                        `
                          : ""}
                      </div>
                    `;
                  })
                  .join("")
              : '<div class="dashboard-empty">暂无配额配置</div>'}
          </div>
        </div>

        <!-- 最近活动 -->
        <div class="dashboard-section">
          <h3 class="dashboard-section-title">最近活动</h3>
          <div class="recent-activity-list">
            ${snapshot.recentRecords.length > 0
              ? snapshot.recentRecords
                  .map(
                    (r) => `
              <div class="activity-item">
                <div class="activity-dot"></div>
                <div class="activity-content">
                  <span class="activity-expert">${r.expertName}（${r.expertTitle || "未知"}）</span>
                  <span class="activity-model">${r.model}</span>
                  <span class="activity-tokens">${formatTokenCount(r.totalTokens)}</span>
                </div>
                <span class="activity-time">${formatRelativeTime(r.timestamp)}</span>
              </div>
            `
                  )
                  .join("")
              : '<div class="dashboard-empty">暂无活动记录</div>'}
          </div>
        </div>
      </div>
    `;

    // 绘制趋势图
    drawTrendChart(snapshot.trend.labels, snapshot.trend.buckets);
  }

  // 将仪表盘渲染函数挂载到window，供时间管理器联动调用
  (window as unknown as Record<string, unknown>).renderTokenDashboard = renderTokenDashboard;

  // 渲染时间管理器（到右侧token-browser卡片）
  async function renderTimeManager(activeRange: TimeRange = "today", dataSource: "project" | "user" = currentTokenSource): Promise<void> {
    const container = document.getElementById("token-browser-body");
    if (!container) return;

    const snapshot = await buildTokenDashboardSnapshot(activeRange, dataSource, experts);

    container.innerHTML = `
      <div class="token-browser-nav">
        <div class="tb-nav-item ${activeRange === "today" ? "active" : ""}" data-range="today">今日</div>
        <div class="tb-nav-item ${activeRange === "week" ? "active" : ""}" data-range="week">本周</div>
        <div class="tb-nav-item ${activeRange === "month" ? "active" : ""}" data-range="month">本月</div>
        <div class="tb-nav-item ${activeRange === "year" ? "active" : ""}" data-range="year">本年</div>
        <div class="tb-nav-item ${activeRange === "all" ? "active" : ""}" data-range="all">全部</div>
      </div>
      <div class="tb-summary">
        <div class="tb-summary-total">
          <span class="tb-summary-label">总消耗</span>
          <span class="tb-summary-value">${formatTokenCount(snapshot.totalUsage.total)}</span>
        </div>
        <div class="tb-summary-breakdown">
          <span class="tb-summary-item">输入: ${formatTokenCount(snapshot.totalUsage.prompt)}</span>
          <span class="tb-summary-item">输出: ${formatTokenCount(snapshot.totalUsage.completion)}</span>
        </div>
      </div>
      <div class="tb-expert-list">
        ${snapshot.expertRangeStats.length > 0
          ? snapshot.expertRangeStats
              .map(
                (s) => `
          <div class="tb-expert-item">
            <div class="tb-expert-info">
              <span class="tb-expert-name">${s.name}</span>
              <span class="tb-expert-title">${s.title}</span>
            </div>
            <div class="tb-expert-usage">
              <span class="tb-expert-tokens">${formatTokenCount(s.total)}</span>
              ${s.quota !== null
                ? `
                <div class="tb-expert-quota-bar">
                  <div class="tb-quota-fill" style="width: ${Math.min(100, (s.total / s.quota) * 100)}%"></div>
                </div>
                <span class="tb-expert-quota-text">${Math.round((s.total / s.quota) * 100)}%</span>
              `
                : ""}
            </div>
          </div>
        `
              )
              .join("")
          : '<div class="tb-expert-empty">暂无数据</div>'}
      </div>
    `;

    // 绑定时间导航点击事件
    container.querySelectorAll(".tb-nav-item").forEach((item) => {
      item.addEventListener("click", () => {
        const range = (item as HTMLElement).dataset.range as TimeRange;
        void renderTimeManager(range, currentTokenSource);
        if (typeof (window as unknown as Record<string, unknown>).renderTokenDashboard === "function") {
          void ((window as unknown as Record<string, unknown>).renderTokenDashboard as (range: TimeRange, source: "project" | "user") => Promise<void>)(range, currentTokenSource);
        }
      });
    });
  }

  function enterTokenMode() {
    if (isTokenMode) return;
    exitDraftMode();
    exitWikiMode();
    exitGitMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();

    isTokenMode = true;

    // 显示中央仪表盘卡片
    const tokenPanel = document.getElementById("token-panel");
    if (tokenPanel) {
      tokenPanel.style.display = "flex";
      tokenPanel.classList.add("active");
      // 默认重置为项目级页签
      currentTokenSource = "project";
      tokenPanel.querySelectorAll(".token-tab").forEach((tab) => tab.classList.remove("active"));
      tokenPanel.querySelector('.token-tab[data-tab="project"]')?.classList.add("active");
      void renderTokenDashboard("today", "project");
    }
    // 显示右侧时间导航卡片
    const tokenBrowser = document.getElementById("token-browser");
    if (tokenBrowser) {
      tokenBrowser.style.display = "flex";
      tokenBrowser.classList.add("active");
      void renderTimeManager("today", "project");
    }

    // 更新按钮active状态
    clearViewTabs("btn-token");
    setFloatingActionsVisible(true);

    log("INFO", "进入词元模式");
  }

  function exitTokenMode() {
    if (!isTokenMode) return;
    isTokenMode = false;

    // 隐藏仪表盘和时间导航
    const tokenPanel = document.getElementById("token-panel");
    const tokenBrowser = document.getElementById("token-browser");
    if (tokenPanel) tokenPanel.style.display = "none";
    if (tokenBrowser) tokenBrowser.style.display = "none";

    showDirectoryWorkspace();
    clearViewTabs("btn-directory");

    log("INFO", "退出词元模式");
  }

  // ========== Git 模式状态 ==========
  let isGitMode = false;
  interface GitConfig {
    repoUrl: string;
    token: string;
    commitMsg: string;
    autoPush: boolean;
  }
  let gitConfig: GitConfig = { repoUrl: "", token: "", commitMsg: "更新项目文件", autoPush: false };
  let gitSelectedFiles: Set<string> = new Set();
  let gitAllFiles: string[] = [];

  async function loadGitConfig(projectName: string) {
    try {
      const data = await invoke<string>("load_git_config", { projectName });
      if (data && data !== "null") {
        const parsed = JSON.parse(data);
        gitConfig = {
          repoUrl: parsed.repoUrl || "",
          token: parsed.token || "",
          commitMsg: parsed.commitMsg || "更新项目文件",
          autoPush: parsed.autoPush || false,
        };
        gitSelectedFiles = new Set(parsed.selectedFiles || []);
        return;
      }
    } catch (e) {
      log("WARN", `加载Git配置失败: ${e}`);
    }
    gitConfig = { repoUrl: "", token: "", commitMsg: "更新项目文件", autoPush: false };
    gitSelectedFiles = new Set();
  }

  async function saveGitConfig(projectName: string) {
    try {
      await invoke("save_git_config", {
        projectName,
        data: JSON.stringify({
          repoUrl: gitConfig.repoUrl,
          token: gitConfig.token,
          commitMsg: gitConfig.commitMsg,
          autoPush: gitConfig.autoPush,
          selectedFiles: Array.from(gitSelectedFiles),
        }),
      });
    } catch (e) {
      log("ERROR", `保存Git配置失败: ${e}`);
    }
  }

  async function refreshGitFileList(projectName: string) {
    try {
      const filesJson = await invoke<string>("list_project_files_all", { projectName });
      gitAllFiles = JSON.parse(filesJson);
      // 移除已不在项目中的文件
      const validFiles = new Set(gitAllFiles);
      gitSelectedFiles = new Set([...gitSelectedFiles].filter((f) => validFiles.has(f)));
      renderGitFileList();
    } catch (e) {
      log("ERROR", `刷新Git文件列表失败: ${e}`);
      gitAllFiles = [];
      renderGitFileList();
    }
  }

  function renderGitFileList() {
    const list = document.getElementById("git-browser-list");
    if (!list) return;

    list.innerHTML = "";
    if (gitAllFiles.length === 0) {
      list.innerHTML = '<div style="padding:16px;color:rgba(255,255,255,0.3);font-size:11px;text-align:center;">暂无文件</div>';
      return;
    }

    for (const file of gitAllFiles) {
      const item = document.createElement("label");
      item.className = "git-file-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = gitSelectedFiles.has(file);
      cb.addEventListener("change", () => {
        if (cb.checked) {
          gitSelectedFiles.add(file);
        } else {
          gitSelectedFiles.delete(file);
        }
        const activeProject = sidebar.getActiveChat();
        if (activeProject) saveGitConfig(activeProject.name);
      });

      const name = document.createElement("span");
      name.className = "git-file-name";
      name.textContent = file;
      name.title = file;

      item.appendChild(cb);
      item.appendChild(name);
      list.appendChild(item);
    }
  }

  function setGitStatus(msg: string, cls: string) {
    const el = document.getElementById("git-status");
    if (!el) return;
    el.textContent = msg;
    el.className = "git-status " + cls;
  }

  function syncGitFormToConfig() {
    const repoUrlEl = document.getElementById("git-repo-url") as HTMLInputElement;
    const tokenEl = document.getElementById("git-token") as HTMLInputElement;
    const commitMsgEl = document.getElementById("git-commit-msg") as HTMLInputElement;
    const autoPushEl = document.getElementById("git-auto-push") as HTMLInputElement;
    if (repoUrlEl) gitConfig.repoUrl = repoUrlEl.value.trim();
    if (tokenEl) gitConfig.token = tokenEl.value;
    if (commitMsgEl) gitConfig.commitMsg = commitMsgEl.value.trim() || "更新项目文件";
    if (autoPushEl) gitConfig.autoPush = autoPushEl.checked;
  }

  function syncGitConfigToForm() {
    const repoUrlEl = document.getElementById("git-repo-url") as HTMLInputElement;
    const tokenEl = document.getElementById("git-token") as HTMLInputElement;
    const commitMsgEl = document.getElementById("git-commit-msg") as HTMLInputElement;
    const autoPushEl = document.getElementById("git-auto-push") as HTMLInputElement;
    if (repoUrlEl) repoUrlEl.value = gitConfig.repoUrl;
    if (tokenEl) tokenEl.value = gitConfig.token;
    if (commitMsgEl) commitMsgEl.value = gitConfig.commitMsg;
    if (autoPushEl) autoPushEl.checked = gitConfig.autoPush;
  }

  async function enterGitMode() {
    if (isGitMode) return;
    const activeProject = await resolveActiveProjectForView("Git");
    if (!activeProject) {
      return;
    }
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();

    isGitMode = true;

    // 更新浮动按钮状态
    clearViewTabs("btn-git");
    setFloatingActionsVisible(true);

    // 显示 Git 面板
    const gitPanel = document.getElementById("git-panel");
    if (gitPanel) {
      gitPanel.style.display = "flex";
      gitPanel.classList.add("active");
    }
    const gitBrowser = document.getElementById("git-browser");
    if (gitBrowser) {
      gitBrowser.style.display = "flex";
      gitBrowser.classList.add("active");
    }

    // 加载 Git 配置
    await loadGitConfig(activeProject.name);
    syncGitConfigToForm();

    // 加载文件列表
    await refreshGitFileList(activeProject.name);

    setGitStatus("", "");

    log("INFO", "进入 Git 模式");
  }

  function exitGitMode() {
    if (!isGitMode) return;
    isGitMode = false;

    // 保存当前配置
    syncGitFormToConfig();
    const activeProject = sidebar.getActiveChat();
    if (activeProject) saveGitConfig(activeProject.name);

    // 隐藏 Git 面板和文件列表
    const gitPanel = document.getElementById("git-panel");
    const gitBrowser = document.getElementById("git-browser");
    if (gitPanel) { gitPanel.classList.remove("active"); gitPanel.style.display = "none"; }
    if (gitBrowser) { gitBrowser.classList.remove("active"); gitBrowser.style.display = "none"; }

    showDirectoryWorkspace();
    clearViewTabs("btn-directory");

    log("INFO", "退出 Git 模式");
  }

  async function doGitPush() {
    syncGitFormToConfig();
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) {
      setGitStatus("没有活跃项目", "error");
      return;
    }

    if (!gitConfig.repoUrl) {
      setGitStatus("请填写仓库地址", "error");
      return;
    }
    if (!gitConfig.token) {
      setGitStatus("请填写访问令牌", "error");
      return;
    }

    const selectedFiles = Array.from(gitSelectedFiles);
    if (selectedFiles.length === 0) {
      setGitStatus("请选择要上传的文件", "error");
      return;
    }

    const commitMsgEl = document.getElementById("git-commit-msg") as HTMLInputElement;
    const commitMsg = commitMsgEl?.value?.trim() || "更新项目文件";

    // 保存配置
    await saveGitConfig(activeProject.name);

    setGitStatus("推送中...", "running");
    const pushBtn = document.getElementById("git-push-btn") as HTMLButtonElement;
    if (pushBtn) pushBtn.disabled = true;

    try {
      const result = await invoke<string>("git_push", {
        projectName: activeProject.name,
        repoUrl: gitConfig.repoUrl,
        token: gitConfig.token,
        commitMessage: commitMsg,
        files: selectedFiles,
      });
      setGitStatus(result, "success");
    } catch (e) {
      setGitStatus(`推送失败: ${e}`, "error");
    } finally {
      if (pushBtn) pushBtn.disabled = false;
    }
  }

  // 词元面板页签切换
  document.querySelectorAll(".token-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = (tab as HTMLElement).dataset.tab as "project" | "user";
      if (!target || target === currentTokenSource) return;
      currentTokenSource = target;
      document.querySelectorAll(".token-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      void renderTokenDashboard("today", target);
      void renderTimeManager("today", target);
    });
  });

  // 词元面板返回按钮
  document.getElementById("token-panel-back")?.addEventListener("click", () => {
    exitTokenMode();
  });

  type ImageCard = {
    id: string;
    prompt: string;
    status: "pending" | "generating" | "done" | "error";
    imageUrl?: string;
    error?: string;
    createdAt: number;
  };
  const imageCards: ImageCard[] = [];

  function renderImageCards() {
    const grid = document.getElementById("image-card-grid");
    if (!grid) return;

    if (imageCards.length === 0) {
      grid.innerHTML = `
        <div class="video-empty-state">
          <p>在下方输入框中使用 <code>/image</code> 命令开始图像创作</p>
          <p class="video-empty-hint">专家团将为你完成提示词设计和图像生成</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = "";
    for (const card of imageCards) {
      const el = document.createElement("div");
      el.className = `image-gen-card${card.status === "generating" || card.status === "pending" ? " generating" : ""}`;
      const thumb = card.imageUrl
        ? `<img src="${escapeAttr(card.imageUrl)}" alt="${escapeAttr(card.prompt)}" />`
        : `<div class="image-gen-placeholder"><span class="image-gen-spinner"></span></div>`;
      const actions = card.imageUrl
        ? `<div class="image-gen-actions"><button class="image-action-btn download-btn" data-id="${escapeAttr(card.id)}" type="button">下载</button></div>`
        : "";
      el.innerHTML = `
        <div class="image-gen-thumb">${thumb}</div>
        <div class="image-gen-body">
          <p class="image-gen-prompt">${escapeHtml(card.prompt)}</p>
          ${actions}
          ${card.error ? `<div class="video-segment-error">${escapeHtml(card.error)}</div>` : ""}
        </div>
      `;
      el.querySelector(".download-btn")?.addEventListener("click", () => {
        if (!card.imageUrl) return;
        const a = document.createElement("a");
        a.href = card.imageUrl;
        a.download = `image_${card.id}.png`;
        a.click();
      });
      grid.appendChild(el);
    }
  }

  // ============ 图像模式（视频式卡片网格） ============
  function enterImageMode(): void {
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
    exitGitMode();
    exitVideoMode();
    exitDataMode();
    const imgPanel = document.getElementById("image-panel");
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();
    if (imgPanel) {
      imgPanel.style.display = "flex";
      imgPanel.classList.add("active");
    }
    renderImageCards();
    document.querySelectorAll(".view-tab").forEach(b => b.classList.remove("active"));
    document.getElementById("btn-image")?.classList.add("active");
    window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: "image" } }));
  }

  function exitImageMode(): void {
    const imgPanel = document.getElementById("image-panel");
    if (imgPanel) {
      imgPanel.classList.remove("active");
      imgPanel.style.display = "none";
    }
  }

  // ============ 视频模式 ============
  function enterVideoMode(): void {
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
    exitGitMode();
    exitImageMode();
    exitDataMode();
    const vidCard = document.getElementById("canvas-video-card");
    const vidBrowser = document.getElementById("video-browser");
    const vidPanel = document.getElementById("video-panel");
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();
    if (vidCard) vidCard.style.display = "flex";
    if (vidBrowser) vidBrowser.style.display = "flex";
    if (vidPanel) {
      vidPanel.style.display = "flex";
      vidPanel.classList.add("active");
    }
    document.querySelectorAll(".view-tab").forEach(b => b.classList.remove("active"));
    document.getElementById("btn-video")?.classList.add("active");
    window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: "video" } }));
  }

  function exitVideoMode(): void {
    const vidCard = document.getElementById("canvas-video-card");
    const vidBrowser = document.getElementById("video-browser");
    const vidPanel = document.getElementById("video-panel");
    if (vidCard) vidCard.style.display = "none";
    if (vidBrowser) vidBrowser.style.display = "none";
    if (vidPanel) {
      vidPanel.classList.remove("active");
      vidPanel.style.display = "none";
    }
  }

  // ============ 数据分析模式（隐藏画布，显示面板 - 类似wiki模式） ============
  function enterDataMode(): void {
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
    exitGitMode();
    exitImageMode();
    exitVideoMode();
    const dataPanel = document.getElementById("data-panel");
    const dataBrowser = document.getElementById("data-browser");
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();
    if (dataPanel) dataPanel.style.display = "flex";
    if (dataBrowser) dataBrowser.style.display = "flex";
    document.querySelectorAll(".view-tab").forEach(b => b.classList.remove("active"));
    document.getElementById("btn-data")?.classList.add("active");
    window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: "data-analysis" } }));
  }

  function exitDataMode(): void {
    const dataPanel = document.getElementById("data-panel");
    const dataBrowser = document.getElementById("data-browser");
    if (dataPanel) dataPanel.style.display = "none";
    if (dataBrowser) dataBrowser.style.display = "none";
  }

  // ============ 新按钮事件绑定 ============
  document.getElementById("btn-image")?.addEventListener("click", () => {
    enterImageMode();
  });
  document.getElementById("image-download-all")?.addEventListener("click", () => {
    imageCards.filter((c) => !!c.imageUrl).forEach((c) => {
      const a = document.createElement("a");
      a.href = c.imageUrl!;
      a.download = `image_${c.id}.png`;
      a.click();
    });
  });
  document.getElementById("btn-video")?.addEventListener("click", () => {
    enterVideoMode();
  });
  document.getElementById("video-back")?.addEventListener("click", () => {
    exitVideoMode();
    document.getElementById("canvas-directory-stack")!.style.display = "";
    document.querySelectorAll(".view-tab").forEach(b => b.classList.remove("active"));
    document.getElementById("btn-directory")?.classList.add("active");
  });
  document.getElementById("btn-data")?.addEventListener("click", () => {
    enterDataMode();
  });
  document.getElementById("data-back")?.addEventListener("click", () => {
    exitDataMode();
    document.getElementById("canvas-directory-stack")!.style.display = "";
    document.querySelectorAll(".view-tab").forEach(b => b.classList.remove("active"));
    document.getElementById("btn-directory")?.classList.add("active");
  });

  wikiBack?.addEventListener("click", () => exitWikiMode());

  // 迭代按钮
  wikiIterationBtn?.addEventListener("click", () => executeIteration());

  // 迭代模式切换
  wikiIterationModeEl?.addEventListener("change", () => {
    wikiIterationMode = wikiIterationModeEl.value as "manual" | "self" | "auto";
    if (wikiIterationMode === "auto") {
      startAutoIteration();
      setIterationStatus("自动迭代中", "running");
    } else {
      stopAutoIteration();
      setIterationStatus("就绪", "");
    }
  });

  // ========== Git 面板事件 ==========
  // 返回按钮
  document.getElementById("git-panel-back")?.addEventListener("click", () => exitGitMode());

  // 刷新文件列表
  document.getElementById("git-refresh-files")?.addEventListener("click", async () => {
    const activeProject = sidebar.getActiveChat();
    if (activeProject) {
      await refreshGitFileList(activeProject.name);
    }
  });

  // 手动上传
  document.getElementById("git-push-btn")?.addEventListener("click", () => doGitPush());

  // 全选
  document.getElementById("git-select-all")?.addEventListener("click", () => {
    gitSelectedFiles = new Set(gitAllFiles);
    renderGitFileList();
    const activeProject = sidebar.getActiveChat();
    if (activeProject) saveGitConfig(activeProject.name);
  });

  // 取消全选
  document.getElementById("git-deselect-all")?.addEventListener("click", () => {
    gitSelectedFiles = new Set();
    renderGitFileList();
    const activeProject = sidebar.getActiveChat();
    if (activeProject) saveGitConfig(activeProject.name);
  });

  // 配置输入变更时自动保存
  const gitRepoUrlEl = document.getElementById("git-repo-url");
  const gitTokenEl = document.getElementById("git-token");
  const gitCommitMsgEl = document.getElementById("git-commit-msg");
  const gitAutoPushEl = document.getElementById("git-auto-push");
  function gitConfigAutoSave() {
    syncGitFormToConfig();
    const activeProject = sidebar.getActiveChat();
    if (activeProject) saveGitConfig(activeProject.name);
  }
  let gitSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function gitDebouncedSave() {
    if (gitSaveTimer) clearTimeout(gitSaveTimer);
    gitSaveTimer = setTimeout(gitConfigAutoSave, 800);
  }
  gitRepoUrlEl?.addEventListener("input", gitDebouncedSave);
  gitTokenEl?.addEventListener("input", gitDebouncedSave);
  gitCommitMsgEl?.addEventListener("input", gitDebouncedSave);
  gitAutoPushEl?.addEventListener("change", gitConfigAutoSave);

  // 页面卸载前清理计时器并强制保存
  window.addEventListener("beforeunload", () => {
    if (gitSaveTimer) clearTimeout(gitSaveTimer);
    gitConfigAutoSave();
  });

  // ========== 文件预览模式 ==========
  const fileBrowserCard = document.getElementById("file-browser-card");
  const filePreviewCard = document.getElementById("file-preview-card");
  const canvasContainer = document.getElementById("canvas-container");
  const floatingActions = document.getElementById("floating-actions");
  const filePreviewTitle = document.getElementById("file-preview-title");
  const filePreviewEditor = document.getElementById("file-preview-editor") as HTMLTextAreaElement;
  const filePreviewMd = document.getElementById("file-preview-md");
  const filePreviewTabs = document.getElementById("file-preview-tabs");
  const filePreviewSaveStatus = document.getElementById("file-preview-save-status");
  const fileCanvasSvg = document.getElementById("file-canvas-svg");
  const filePreviewImage = document.getElementById("file-preview-image");
  const filePreviewVideo = document.getElementById("file-preview-video") as HTMLVideoElement | null;
  const filePreviewWeb = document.getElementById("file-preview-web") as HTMLIFrameElement | null;
  const fileBrowserTree = document.getElementById("file-browser-tree");
  const filePreviewBack = document.getElementById("file-preview-back");
  const filePreviewHighlight = document.getElementById("file-preview-highlight");
  const highlightCode = document.getElementById("highlight-code");
  const filePreviewLang = document.getElementById("file-preview-lang");
  const langLabel = document.getElementById("lang-label");
  const filePreviewThemeToggle = document.getElementById("file-preview-theme-toggle");
  const fileCanvasToolbar = document.getElementById("file-canvas-toolbar");
  const fileCanvasStatusText = document.getElementById("file-canvas-status-text");
  const fileCanvasStatusTime = document.getElementById("file-canvas-status-time");
  const fileCanvasRefresh = document.getElementById("file-canvas-refresh") as HTMLButtonElement | null;

  // 子画布实例（延迟初始化）
  let fileCanvas: FileCanvas | null = null;
  let fileCanvasRequestSeq = 0;

  // 当前预览的文件路径（用于侧边栏高亮）
  let currentPreviewFile: string | null = null;
  // 当前预览模式：source | preview | canvas | image | highlight
  let currentPreviewMode: "source" | "preview" | "canvas" | "image" | "video" | "web" | "highlight" = "source";

  // 高亮主题：dark | light
  let highlightTheme: "dark" | "light" = "dark";

  function clearViewTabs(activeId: string | null = null) {
    document.querySelectorAll(".view-tab").forEach((btn) => btn.classList.remove("active"));
    if (activeId) {
      document.getElementById(activeId)?.classList.add("active");
    }
  }

  function setElementVisible(el: HTMLElement | null, visible: boolean, display = "flex") {
    if (!el) return;
    el.style.display = visible ? display : "none";
  }

  function setFloatingActionsVisible(visible: boolean) {
    setElementVisible(floatingActions as HTMLElement | null, visible, "flex");
  }

  function resetFilePreviewSurfaces() {
    if (filePreviewEditor) filePreviewEditor.style.display = "none";
    if (filePreviewMd) filePreviewMd.classList.remove("active");
    if (filePreviewHighlight) filePreviewHighlight.classList.remove("active");
    if (filePreviewImage) {
      filePreviewImage.classList.remove("active");
      filePreviewImage.innerHTML = "";
    }
    if (filePreviewVideo) {
      filePreviewVideo.classList.remove("active");
      filePreviewVideo.removeAttribute("src");
      filePreviewVideo.load?.();
    }
    if (filePreviewWeb) {
      filePreviewWeb.classList.remove("active");
      filePreviewWeb.src = "about:blank";
    }
    if (fileCanvasSvg) fileCanvasSvg.classList.remove("active");
    if (fileCanvasToolbar) fileCanvasToolbar.classList.remove("active");
    if (filePreviewTabs) filePreviewTabs.style.display = "none";
    if (filePreviewLang) filePreviewLang.style.display = "none";
    if (filePreviewThemeToggle) filePreviewThemeToggle.style.display = "none";
    currentPreviewMode = "source";
  }

  function hideAllWorkspacePanels() {
    setElementVisible(fileBrowserCard as HTMLElement | null, false);
    setElementVisible(filePreviewCard as HTMLElement | null, false);
    setElementVisible(document.getElementById("wiki-panel"), false);
    setElementVisible(document.getElementById("repo-browser"), false);
    setElementVisible(document.getElementById("git-panel"), false);
    setElementVisible(document.getElementById("git-browser"), false);
    setElementVisible(document.getElementById("token-panel"), false);
    setElementVisible(document.getElementById("token-browser"), false);
    setElementVisible(document.getElementById("image-panel"), false);
    setElementVisible(document.getElementById("video-panel"), false);
    setElementVisible(document.getElementById("data-panel"), false);
    setElementVisible(document.getElementById("data-browser"), false);
    setElementVisible(workspaceSettingsPanel as HTMLElement | null, false);
    workspaceSettingsPanel.classList.remove("active");
    setElementVisible(document.getElementById("preview-chat-card"), false);
    hideCanvasFileCard();
    resetFilePreviewSurfaces();
  }

  function showDirectoryWorkspace() {
    setElementVisible(canvasContainer as HTMLElement | null, true, "block");
    setFloatingActionsVisible(true);
    const dirStack = document.getElementById("canvas-directory-stack");
    setElementVisible(dirStack as HTMLElement | null, true, "flex");
  }

  function hideDirectoryWorkspace() {
    setElementVisible(canvasContainer as HTMLElement | null, false, "block");
    const dirStack = document.getElementById("canvas-directory-stack");
    setElementVisible(dirStack as HTMLElement | null, false, "flex");
  }

  async function enterWorkspaceSettingsMode() {
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
    exitGitMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();
    setElementVisible(workspaceSettingsPanel as HTMLElement | null, true);
    workspaceSettingsPanel.classList.add("active");
    setFloatingActionsVisible(true);
    clearViewTabs("btn-workspace-settings");
    activateWorkspaceSettingsSection("experts");

    try {
      await loadKeyPool();
    } catch (e) {
      log("ERROR", `项目设置加载密钥池失败: ${e}`);
    }

    try {
      await loadExperts();
    } catch (e) {
      log("ERROR", `项目设置加载专家团失败: ${e}`);
    }

    window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: "workspace-settings" } }));
  }

  function enterFileMode() {
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
    exitGitMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    hideDirectoryWorkspace();
    setElementVisible(fileBrowserCard as HTMLElement | null, true);
    setElementVisible(filePreviewCard as HTMLElement | null, true);
    setFloatingActionsVisible(true);
    clearViewTabs("btn-file");
    window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: "file" } }));
  }

  function enterDirectoryMode() {
    exitDraftMode();
    document.body.classList.remove("workspace-draft-mode");
    exitWikiMode();
    exitTokenMode();
    exitGitMode();
    exitImageMode();
    exitVideoMode();
    exitDataMode();
    hideAllWorkspacePanels();
    showDirectoryWorkspace();
    clearViewTabs("btn-directory");
    window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: "directory" } }));
  }

  workspaceSettingsBackBtn.addEventListener("click", () => {
    enterDirectoryMode();
  });

  function setFileCanvasSyncState(
    state: "idle" | "building" | "ready" | "error",
    text: string,
    timeText: string,
  ) {
    if (fileCanvasStatusText) {
      fileCanvasStatusText.textContent = text;
      fileCanvasStatusText.style.color = state === "error"
        ? "#dc2626"
        : state === "building"
          ? "#d97706"
          : "#2563eb";
    }
    if (fileCanvasStatusTime) {
      fileCanvasStatusTime.textContent = timeText;
    }
    if (fileCanvasRefresh) {
      fileCanvasRefresh.classList.toggle("spinning", state === "building");
      fileCanvasRefresh.disabled = state === "building";
    }
  }

  function mapFileLogicCanvasToBlocks(payload: FileLogicCanvasPayload): {
    blocks: DocBlock[];
    edges: { from: string; to: string }[];
  } {
    const blocks: DocBlock[] = payload.nodes.map((node, index) => {
      let column = 1;
      let accent = "symbol";
      let staticHeight = 132;
      let collapsed = true;

      if (node.kind === "file-root") {
        column = 1;
        accent = "file-root";
        staticHeight = 124;
        collapsed = false;
      } else if (node.kind === "group-upstream") {
        column = 0;
        accent = "group-upstream";
        staticHeight = 92;
        collapsed = false;
      } else if (node.kind === "group-downstream") {
        column = 2;
        accent = "group-downstream";
        staticHeight = 92;
        collapsed = false;
      } else if (node.kind === "group-symbols") {
        column = 1;
        accent = "group-symbols";
        staticHeight = 92;
        collapsed = false;
      } else if (node.kind === "inbound-file") {
        column = 0;
        accent = "inbound-file";
      } else if (node.kind === "outbound-file") {
        column = 2;
        accent = "outbound-file";
      }

      const lineMeta = node.line_start
        ? node.line_end && node.line_end !== node.line_start
          ? `L${node.line_start}-L${node.line_end}`
          : `L${node.line_start}`
        : "";
      const pathMeta = node.file_path && node.file_path !== payload.file_path ? node.file_path : "";
      const meta = [lineMeta, pathMeta].filter(Boolean).join(" · ");

      return {
        id: node.id,
        title: node.label,
        level: column + 1,
        content: node.detail,
        meta,
        children: [],
        x: 0,
        y: 0,
        w: 280,
        h: 100,
        collapsed,
        accent,
        column,
        order: node.line_start || index,
        openPath: node.file_path || undefined,
        staticHeight,
      };
    });

    return {
      blocks,
      edges: payload.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    };
  }

  // ========== Markdown 渲染器 ==========
  function renderMarkdown(md: string): string {
    let html = md;
    // 转义 HTML
    html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // 代码块 (```...```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, _lang: string, code: string) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // 行内代码 (`...`)
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // 标题
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // 粗体 + 斜体
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // 图片 ![alt](url)
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%;">');

    // 链接 [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // 水平线
    html = html.replace(/^---+$/gm, "<hr>");

    // 引用块
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // 无序列表
    html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
    // 有序列表
    html = html.replace(/^(\s*)\d+\. (.+)$/gm, "$1<li>$2</li>");

    // 表格 (简化)
    html = html.replace(/^\|(.+)\|$/gm, (_match: string, cells: string) => {
      const tds = cells.split("|").map((c: string) => `<td>${c.trim()}</td>`).join("");
      return `<tr>${tds}</tr>`;
    });

    // 段落：连续非空行
    html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, "<p>$1</p>");

    // 清理多余空行
    html = html.replace(/<p><\/p>/g, "");
    html = html.replace(/\n/g, "");

    // 用 <ul>/<ol> 包裹连续的 <li>
    html = html.replace(/((?:<li>.*?<\/li>)+)/g, "<ul>$1</ul>");

    return html;
  }

  // 更新 MD 预览
  function updateMdPreview() {
    if (!filePreviewMd || !filePreviewEditor) return;
    filePreviewMd.innerHTML = renderMarkdown(filePreviewEditor.value);
  }

  // ========== 保存文件 ==========
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function showSaveStatus(text: string) {
    if (!filePreviewSaveStatus) return;
    filePreviewSaveStatus.textContent = text;
    filePreviewSaveStatus.classList.add("visible");
    setTimeout(() => filePreviewSaveStatus?.classList.remove("visible"), 1500);
  }

  async function saveCurrentFile(): Promise<void> {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject || !currentPreviewFile || !filePreviewEditor) return;
    if (isImageFile(currentPreviewFile) || isVideoFile(currentPreviewFile) || isWebPreviewFile(currentPreviewFile)) return;
    try {
      await invoke("sandbox_write_file", {
        projectName: activeProject.name,
        relativePath: currentPreviewFile,
        content: filePreviewEditor.value,
        projectPath: activeProject.workspacePath,
      });
      // 同步更新 MD 预览
      if (currentPreviewMode === "preview") updateMdPreview();
      showSaveStatus("已保存");
      scheduleProjectIntelligenceSync(activeProject.name, [currentPreviewFile], "editor-save");
    } catch (e) {
      showSaveStatus("保存失败");
      console.error("保存文件失败:", e);
    }
  }

  async function reloadCurrentPreviewFile(): Promise<void> {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject || !currentPreviewFile || !filePreviewEditor) return;
    if (isImageFile(currentPreviewFile) || isVideoFile(currentPreviewFile) || isWebPreviewFile(currentPreviewFile)) return;

    try {
      const content = await invoke<string>("sandbox_read_file", {
        projectName: activeProject.name,
        relativePath: currentPreviewFile,
        projectPath: activeProject.workspacePath,
      });
      filePreviewEditor.value = content;
      if (isMarkdownFile(currentPreviewFile)) {
        updateMdPreview();
      } else {
        updateHighlight();
        if (currentPreviewMode === "canvas") {
          triggerCanvasRefresh();
        }
      }
    } catch (e) {
      console.error("刷新当前预览文件失败:", e);
    }
  }

  // 自动保存（防抖 2 秒）
  function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => saveCurrentFile(), 2000);
  }

  // Ctrl+S 快捷键保存
  filePreviewEditor?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
      void saveCurrentFile();
    }
  });

  // ========== MD → 方块解析器 ==========
  function parseMdToBlocks(mdText: string): { blocks: DocBlock[]; edges: { from: string; to: string }[] } {
    const blocks: DocBlock[] = [];
    const edges: { from: string; to: string }[] = [];
    const lines = mdText.split("\n");

    interface RawSection {
      level: number;
      title: string;
      content: string;
      children: RawSection[];
    }

    // 解析顶层 sections
    const sections: RawSection[] = [];
    let currentSection: RawSection | null = null;
    let currentSubs: RawSection[] = [];
    let currentSubSection: RawSection | null = null;

    for (const line of lines) {
      const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const title = hMatch[2].trim();
        const newSection: RawSection = { level, title, content: "", children: [] };

        if (level === 1) {
          sections.push(newSection);
          currentSection = newSection;
          currentSubs = newSection.children;
          currentSubSection = null;
        } else if (currentSection) {
          currentSubs.push(newSection);
          currentSubSection = newSection;
          currentSubs = newSection.children;
        } else {
          sections.push(newSection);
          currentSection = newSection;
          currentSubs = newSection.children;
        }
        continue;
      }

      if (currentSubSection) {
        currentSubSection.content += line + "\n";
      } else if (currentSection) {
        // 内容挂到最近的 H1 section
        const lastH1 = sections[sections.length - 1];
        if (lastH1) {
          // 如果 H1 有子标题，内容属于最后一个子标题；否则属于 H1 本身
          if (lastH1.children.length > 0) {
            const lastChild = lastH1.children[lastH1.children.length - 1];
            lastChild.content += line + "\n";
          } else {
            lastH1.content += line + "\n";
          }
        }
      }
    }

    // 将 sections 转为 blocks
    let idCounter = 0;
    function addBlock(sec: RawSection, parentId?: string): string {
      const id = `b${++idCounter}`;
      blocks.push({
        id,
        title: sec.title,
        level: sec.level,
        content: sec.content.trim(),
        children: [],
        x: 0, y: 0, w: 280, h: 100,
        collapsed: sec.content.trim().length > 80,
      });
      if (parentId) {
        edges.push({ from: parentId, to: id });
        const parent = blocks.find((b) => b.id === parentId);
        if (parent) parent.children.push(id);
      }
      sec.children.forEach((child) => addBlock(child, id));
      return id;
    }

    sections.forEach((sec) => addBlock(sec));
    return { blocks, edges };
  }

  async function refreshFileCanvas(forceRebuild: boolean = false) {
    if (!fileCanvasSvg || !filePreviewEditor || !currentPreviewFile) return;
    if (!fileCanvas) fileCanvas = new FileCanvas();

    if (isMarkdownFile(currentPreviewFile)) {
      const { blocks, edges } = parseMdToBlocks(filePreviewEditor.value);
      fileCanvas.setData(blocks, edges);
      setFileCanvasSyncState("ready", "文档结构图已更新", "Markdown 实时解析");
      return;
    }

    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    const requestSeq = ++fileCanvasRequestSeq;
    setFileCanvasSyncState(
      "building",
      forceRebuild ? "正在重建逻辑图谱..." : "正在同步逻辑图谱...",
      "自动联动代码检索与目录图谱",
    );

    try {
      await checkAndBuildIndex(activeProject.name, forceRebuild);
      const graphJson = await invoke<string>("perceptual_index_file_logic_graph", {
        projectName: activeProject.name,
        relativePath: currentPreviewFile,
      });
      if (requestSeq !== fileCanvasRequestSeq) return;

      const payload = JSON.parse(graphJson) as FileLogicCanvasPayload;
      const { blocks, edges } = mapFileLogicCanvasToBlocks(payload);
      fileCanvas.setData(blocks, edges, { layout: "columns" });
      setFileCanvasSyncState(
        "ready",
        `已联动 ${payload.nodes.length} 个节点 / ${payload.edges.length} 条链路`,
        `最近同步：${formatGraphTimestamp(payload.updated_at)}`,
      );
    } catch (e) {
      if (requestSeq !== fileCanvasRequestSeq) return;
      console.error("生成文件逻辑图谱失败:", e);
      setFileCanvasSyncState("error", "逻辑图谱生成失败", String(e));
    }
  }

  let canvasRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function triggerCanvasRefresh() {
    if (currentPreviewMode !== "canvas") return;
    if (canvasRefreshTimer) clearTimeout(canvasRefreshTimer);
    canvasRefreshTimer = setTimeout(() => {
      void refreshFileCanvas();
    }, 700);
  }

  fileCanvasRefresh?.addEventListener("click", () => {
    const activeProject = sidebar.getActiveChat();
    if (activeProject && currentPreviewFile && !isMarkdownFile(currentPreviewFile) && !isImageFile(currentPreviewFile)) {
      scheduleProjectIntelligenceSync(activeProject.name, [currentPreviewFile], "manual-refresh");
    } else {
      void refreshFileCanvas(true);
    }
  });

  // ========== 语法高亮 ==========
  function getHighlightLang(filename: string): string | undefined {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      ts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript",
      py: "python", rs: "rust", go: "go",
      java: "java", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", h: "cpp", c: "c",
      html: "xml", htm: "xml", xml: "xml",
      css: "css", scss: "scss", sass: "scss", less: "less",
      json: "json", yaml: "yaml", yml: "yaml",
      sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
      md: "markdown", vue: "xml", svelte: "xml",
    };
    return map[ext];
  }

  function getLangLabel(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const labels: Record<string, string> = {
      ts: "TS", js: "JS", mjs: "JS", cjs: "JS", py: "PY", rs: "RS", go: "GO",
      java: "JAVA", cpp: "C++", cc: "C++", cxx: "C++", hpp: "H++", h: "H", c: "C",
      html: "HTML", htm: "HTML", xml: "XML", css: "CSS", scss: "SCSS", sass: "SASS", less: "LESS",
      json: "JSON", yaml: "YAML", yml: "YML", sql: "SQL", sh: "SH", bash: "BASH", zsh: "ZSH",
      md: "MD", vue: "VUE", svelte: "SVELTE",
    };
    return labels[ext] || ext.toUpperCase() || "TEXT";
  }

  function updateHighlight() {
    if (!highlightCode || !filePreviewEditor || !currentPreviewFile) return;
    const lang = getHighlightLang(currentPreviewFile);
    const code = filePreviewEditor.value;
    if (!code) { highlightCode.innerHTML = ""; return; }

    let result: string;
    if (lang && hljs.getLanguage(lang)) {
      result = hljs.highlight(code, { language: lang }).value;
    } else {
      result = hljs.highlightAuto(code).value;
    }
    highlightCode.innerHTML = result;
  }

  function toggleHighlightTheme() {
    if (!filePreviewHighlight) return;
    highlightTheme = highlightTheme === "dark" ? "light" : "dark";
    if (highlightTheme === "light") {
      filePreviewHighlight.classList.add("light");
    } else {
      filePreviewHighlight.classList.remove("light");
    }
  }

  // 主题切换按钮
  filePreviewThemeToggle?.addEventListener("click", toggleHighlightTheme);

  // ========== 三模式切换 ==========
  function switchMode(mode: "source" | "preview" | "canvas" | "image" | "video" | "web" | "highlight") {
    currentPreviewMode = mode;

    // 更新标签激活态
    filePreviewTabs?.querySelectorAll(".preview-tab").forEach((t) => t.classList.remove("active"));
    const targetTab = filePreviewTabs?.querySelector(`[data-tab="${mode}"]`);
    targetTab?.classList.add("active");

    // 切换可见区域
    if (filePreviewEditor) filePreviewEditor.style.display = "none";
    if (filePreviewMd) filePreviewMd.classList.remove("active");
    if (fileCanvasSvg) fileCanvasSvg.classList.remove("active");
    if (filePreviewImage) filePreviewImage.classList.remove("active");
    if (filePreviewVideo) filePreviewVideo.classList.remove("active");
    if (filePreviewWeb) filePreviewWeb.classList.remove("active");
    if (filePreviewHighlight) filePreviewHighlight.classList.remove("active");
    if (fileCanvasToolbar) fileCanvasToolbar.classList.remove("active");

    switch (mode) {
      case "source":
        if (currentPreviewFile && !isMarkdownFile(currentPreviewFile) && !isImageFile(currentPreviewFile)) {
          updateHighlight();
          if (filePreviewHighlight) filePreviewHighlight.classList.add("active");
        } else if (filePreviewEditor) {
          filePreviewEditor.style.display = "";
          filePreviewEditor.focus();
        }
        break;
      case "preview":
        updateMdPreview();
        if (filePreviewMd) filePreviewMd.classList.add("active");
        break;
      case "canvas":
        if (fileCanvasSvg) fileCanvasSvg.classList.add("active");
        if (fileCanvasToolbar) fileCanvasToolbar.classList.add("active");
        if (currentPreviewFile && isImageFile(currentPreviewFile)) {
          setFileCanvasSyncState("idle", "当前文件不支持逻辑图谱", "请切换到源码或预览模式");
        } else {
          void refreshFileCanvas();
        }
        break;
      case "image":
        if (filePreviewImage) filePreviewImage.classList.add("active");
        break;
      case "video":
        if (filePreviewVideo) filePreviewVideo.classList.add("active");
        break;
      case "web":
        if (filePreviewWeb) filePreviewWeb.classList.add("active");
        break;
      case "highlight":
        updateHighlight();
        if (filePreviewHighlight) filePreviewHighlight.classList.add("active");
        break;
    }
  }

  // 标签栏点击事件
  filePreviewTabs?.addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest(".preview-tab") as HTMLElement;
    if (!tab) return;
    const mode = tab.dataset.tab as "source" | "preview" | "canvas" | "image" | "video" | "web" | "highlight";
    if (!mode) return;
    switchMode(mode);
  });

  // 编辑器输入 → 自动保存 + 画布实时刷新
  filePreviewEditor?.addEventListener("input", () => {
    triggerAutoSave();
    triggerCanvasRefresh();
    if (currentPreviewFile && currentPreviewMode === "canvas" && !isMarkdownFile(currentPreviewFile) && !isImageFile(currentPreviewFile)) {
      setFileCanvasSyncState("building", "检测到修改，保存后自动刷新图谱", "无需手动逐个更新");
    }
    if (currentPreviewMode === "source" || currentPreviewMode === "highlight") updateHighlight();
  });

  // 判断是否为 MD 文件
  function isMarkdownFile(filename: string): boolean {
    return /\.(md|markdown)$/i.test(filename);
  }

  // 判断是否为图片文件
  function isImageFile(filename: string): boolean {
    return /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(filename);
  }

  // 判断是否为视频文件
  function isVideoFile(filename: string): boolean {
    return /\.(mp4|webm|ogg|mov|m4v)$/i.test(filename);
  }

  // 判断是否为网页预览文件
  function isWebPreviewFile(filename: string): boolean {
    return /\.(html?|xhtml)$/i.test(filename);
  }

  // 获取图片 MIME 类型
  function getImageMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'bmp': return 'image/bmp';
      case 'webp': return 'image/webp';
      case 'svg': return 'image/svg+xml';
      default: return 'image/png';
    }
  }

  function getVideoMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case "mp4": return "video/mp4";
      case "webm": return "video/webm";
      case "ogg": return "video/ogg";
      case "mov": return "video/quicktime";
      case "m4v": return "video/x-m4v";
      default: return "video/mp4";
    }
  }

  // 打开文件预览
  (window as any).openFilePreview = async function(filename: string) {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    enterFileMode();
    currentPreviewFile = filename;

    // 显示画布文件预览卡片
    showCanvasFileCard(filename);

    // 加载目录树
    await loadFileBrowser(activeProject.name, activeProject.workspacePath);

    // 高亮当前文件
    highlightCurrentFile();

    // 判断文件类型
    const isMd = isMarkdownFile(filename);
    const isImg = isImageFile(filename);
    const isVideo = isVideoFile(filename);
    const isWeb = isWebPreviewFile(filename);

    // 显示标签：MD/代码保留标签，媒体文件隐藏标签栏
    if (filePreviewTabs) {
      if (isImg || isVideo || isWeb) {
        filePreviewTabs.style.display = "none";
      } else {
        filePreviewTabs.style.display = "flex";
        filePreviewTabs.classList.remove("code-only");
      }
    }

    // 显示/隐藏语言标签和主题切换
    if (filePreviewLang) {
      if (isImg || isMd || isVideo || isWeb) {
        filePreviewLang.style.display = "none";
      } else {
        filePreviewLang.style.display = "flex";
        if (langLabel) langLabel.textContent = getLangLabel(filename);
      }
    }
    if (filePreviewThemeToggle) {
      filePreviewThemeToggle.style.display = (isImg || isMd || isVideo || isWeb) ? "none" : "flex";
    }
    if (!isImg && !isMd && !isVideo && !isWeb) {
      setFileCanvasSyncState("idle", "逻辑图谱待联动", "切到画布页后会自动生成");
      void checkAndBuildIndex(activeProject.name);
    }

    // 加载文件内容
    if (filePreviewTitle) filePreviewTitle.textContent = filename;
    if (filePreviewEditor && (isImg || isVideo || isWeb)) {
      filePreviewEditor.value = "";
    }

    if (isImg) {
      // 图片文件：通过 Base64 读取并显示
      try {
        const base64 = await invoke<string>("sandbox_read_file_base64", {
          projectName: activeProject.name,
          relativePath: filename,
          projectPath: activeProject.workspacePath,
        });
        const mime = getImageMimeType(filename);
        if (filePreviewImage) {
          filePreviewImage.innerHTML = `<img src="data:${mime};base64,${base64}" alt="${filename}" />`;
        }
        switchMode("image");
      } catch (e) {
        if (filePreviewImage) filePreviewImage.innerHTML = `<div style="color:#fff;text-align:center;">无法读取图片: ${e}</div>`;
        switchMode("image");
      }
      return;
    }

    if (isVideo) {
      try {
        const base64 = await invoke<string>("sandbox_read_file_base64", {
          projectName: activeProject.name,
          relativePath: filename,
          projectPath: activeProject.workspacePath,
        });
        if (filePreviewVideo) {
          filePreviewVideo.src = `data:${getVideoMimeType(filename)};base64,${base64}`;
          filePreviewVideo.load();
        }
        switchMode("video");
      } catch (e) {
        if (filePreviewVideo) filePreviewVideo.removeAttribute("src");
        showSaveStatus(`无法读取视频: ${e}`);
        switchMode("video");
      }
      return;
    }

    if (isWeb) {
      try {
        const content = await invoke<string>("sandbox_read_file", {
          projectName: activeProject.name,
          relativePath: filename,
          projectPath: activeProject.workspacePath,
        });
        if (filePreviewWeb) {
          filePreviewWeb.srcdoc = content;
        }
        switchMode("web");
      } catch (e) {
        if (filePreviewWeb) filePreviewWeb.srcdoc = `<pre style="padding:16px;color:#b91c1c;">无法读取网页文件: ${String(e)}</pre>`;
        switchMode("web");
      }
      return;
    }

    // 文本文件
    try {
      const content = await invoke<string>("sandbox_read_file", {
        projectName: activeProject.name,
        relativePath: filename,
        projectPath: activeProject.workspacePath,
      });
      if (filePreviewEditor) filePreviewEditor.value = content;
      if (isMd) updateMdPreview();
    } catch (e) {
      if (filePreviewEditor) filePreviewEditor.value = `无法读取文件: ${e}`;
    }

    // MD 默认预览模式，代码默认源码模式
    switchMode(isMd ? "preview" : "source");
  };

  // 高亮侧边栏中当前预览的文件
  function highlightCurrentFile() {
    if (!fileBrowserTree || !currentPreviewFile) return;
    fileBrowserTree.querySelectorAll(".file-tree-item").forEach((el) => {
      const itemPath = (el as HTMLElement).dataset.path;
      if (itemPath === currentPreviewFile) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    });
  }

  // 刷新资源管理器
  const fileBrowserRefresh = document.getElementById("file-browser-refresh");
  fileBrowserRefresh?.addEventListener("click", async () => {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;
    await loadFileBrowser(activeProject.name, activeProject.workspacePath);
    highlightCurrentFile();
  });

  // 返回画布
  filePreviewBack?.addEventListener("click", () => {
    currentPreviewFile = null;
    enterDirectoryMode();
  });

  // 加载目录树
  async function loadFileBrowser(projectName: string, projectPath?: string) {
    if (!fileBrowserTree) return;
    fileBrowserTree.innerHTML = "";

    try {
      const entries = await invoke<string>("sandbox_list_dir", {
        projectName,
        relativePath: ".",
        projectPath,
      });
      const items = JSON.parse(entries);
      renderTreeItems(items, 0);
    } catch (e) {
      fileBrowserTree.innerHTML = `<div style="padding:8px;color:#999;font-size:12px;">无法加载目录</div>`;
    }
  }

  function renderTreeItems(items: any[], depth: number, parentEl?: HTMLElement) {
    const container = parentEl || fileBrowserTree;
    if (!container) return;
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "file-tree-item";
      div.style.paddingLeft = `${8 + depth * 16}px`;
      div.dataset.path = item.path || item.name;

      const isFolder = item.type === "folder";
      const hasChildren = isFolder && item.children && item.children.length > 0;

      // 文件夹折叠箭头
      const chevronSvg = hasChildren
        ? '<svg class="tree-chevron expanded" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
        : '<span class="tree-chevron-placeholder"></span>';

      const iconSvg = isFolder
        ? '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        : '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

      div.innerHTML = `${chevronSvg}${iconSvg}<span>${item.name}</span>`;

      // 子容器（仅文件夹有）
      let childrenContainer: HTMLElement | null = null;
      if (hasChildren) {
        childrenContainer = document.createElement("div");
        childrenContainer.className = "file-tree-children expanded";
      }

      div.addEventListener("click", async () => {
        if (isFolder && hasChildren && childrenContainer) {
          // 折叠/展开
          const isExpanded = childrenContainer.classList.contains("expanded");
          if (isExpanded) {
            childrenContainer.classList.remove("expanded");
            div.querySelector(".tree-chevron")?.classList.remove("expanded");
          } else {
            childrenContainer.classList.add("expanded");
            div.querySelector(".tree-chevron")?.classList.add("expanded");
          }
          return;
        }

        if (!isFolder) {
          void (window as any).openFilePreview?.(item.path || item.name);
          return;
        }
      });

      container.appendChild(div);

      // 递归渲染子目录
      if (hasChildren && childrenContainer) {
        container.appendChild(childrenContainer);
        renderTreeItems(item.children, depth + 1, childrenContainer);
      }
    });
  }

  type FrontendE2EControl = {
    id?: string;
    action?: "run-chat-scenario";
    projectName?: string;
    projectPath?: string;
    prompt: string;
    sessionName?: string;
  };

  let frontendE2ERunning = false;
  let frontendE2EPollTimer: ReturnType<typeof setInterval> | null = null;

  async function appendFrontendE2ELog(message: string): Promise<void> {
    const line = `[${new Date().toISOString()}] ${message}`;
    log("INFO", `[frontend-e2e] ${message}`);
    try {
      await invoke("append_frontend_e2e_log", { line });
    } catch (e) {
      console.error("[frontend-e2e] 写日志失败:", e);
      try {
        const rawState = await invoke<string>("load_app_state");
        const parsed = rawState && rawState !== "null" ? JSON.parse(rawState) : {};
        const logs = Array.isArray(parsed.frontendE2ELogs) ? parsed.frontendE2ELogs.slice(-19) : [];
        logs.push(line);
        await invoke("save_app_state", {
          state: JSON.stringify({
            ...parsed,
            frontendE2ELogs: logs,
          }),
        });
      } catch (fallbackError) {
        console.error("[frontend-e2e] fallback 写日志失败:", fallbackError);
      }
    }
  }

  async function saveFrontendE2EStatus(payload: Record<string, unknown>): Promise<void> {
    try {
      const fullPayload = {
        updatedAt: new Date().toISOString(),
        ...payload,
      };
      await invoke("save_frontend_e2e_status", {
        data: JSON.stringify(fullPayload, null, 2),
      });
      try {
        const rawState = await invoke<string>("load_app_state");
        const parsed = rawState && rawState !== "null" ? JSON.parse(rawState) : {};
        await invoke("save_app_state", {
          state: JSON.stringify({
            ...parsed,
            frontendE2EStatus: fullPayload,
          }),
        });
      } catch (fallbackError) {
        console.error("[frontend-e2e] fallback 状态写入失败:", fallbackError);
      }
    } catch (e) {
      console.error("[frontend-e2e] 写状态失败:", e);
      try {
        const rawState = await invoke<string>("load_app_state");
        const parsed = rawState && rawState !== "null" ? JSON.parse(rawState) : {};
        await invoke("save_app_state", {
          state: JSON.stringify({
            ...parsed,
            frontendE2EStatus: {
              updatedAt: new Date().toISOString(),
              ...payload,
            },
          }),
        });
      } catch (fallbackError) {
        console.error("[frontend-e2e] fallback 状态写入失败:", fallbackError);
      }
    }
  }

  async function reportFrontendE2ECheckpoint(
    stage: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    if (!frontendE2ERunning) return;
    await appendFrontendE2ELog(`checkpoint: ${stage}`);
    await saveFrontendE2EStatus({
      stage,
      status: "sending",
      ...extra,
    });
  }

  function getSessionSnapshot(session: ChatSession) {
    const toolEventCount = session.messages.filter((msg) => msg.role === "tool-event").length;
    const commandAuthCount = session.messages.filter((msg) => msg.role === "command-auth").length;
    const assistantMessages = session.messages.filter((msg) => msg.role === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1]?.content || "";
    return {
      messageCount: session.messages.length,
      toolEventCount,
      commandAuthCount,
      lastAssistant,
      recentMessages: session.messages.slice(-8).map((msg) => ({
        role: msg.role,
        content: msg.content.slice(0, 500),
      })),
    };
  }

  async function runFrontendE2EScenario(control: FrontendE2EControl): Promise<void> {
    frontendE2ERunning = true;
    const scenarioId = control.id || `frontend-e2e-${Date.now()}`;
    try {
      await appendFrontendE2ELog(`开始执行场景 ${scenarioId}`);
      await saveFrontendE2EStatus({
        id: scenarioId,
        status: "running",
        prompt: control.prompt,
      });

      let project = sidebar.getChats().find((item) =>
        (control.projectPath && item.workspacePath === control.projectPath)
        || (control.projectName && item.name === control.projectName)
      ) || null;

      if (!project && control.projectPath) {
        await appendFrontendE2ELog(`当前前端未打开目标项目，尝试从路径打开：${control.projectPath}`);
        project = await sidebar.openProjectFromPath(control.projectPath);
      }

      if (!project) {
        throw new Error(`前端无法定位目标项目: ${control.projectName || control.projectPath || "未提供项目标识"}`);
      }

      sidebar.setActiveChat(project.id);
      currentProjectId = project.id;
      await loadSessionsFromDb(project.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      renderMessages();
      updateHistoryDisplay();

      const session = await createSession(project.id, control.sessionName || "前端 E2E 对话");
      currentSessionId = session.id;
      renderMessages();
      updateHistoryDisplay();
      await appendFrontendE2ELog(`已切换到项目「${project.name}」，并新建空对话「${session.name}」`);

      chatInput.value = control.prompt;
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
      await appendFrontendE2ELog(`已注入测试提示词：${control.prompt}`);

      await saveFrontendE2EStatus({
        id: scenarioId,
        status: "sending",
        projectName: project.name,
        projectPath: project.workspacePath,
        sessionName: session.name,
        sessionId: session.id,
        prompt: control.prompt,
      });

      await sendMessage();

      const updatedSession = getSessions(project.id).find((item) => item.id === session.id) || session;
      const snapshot = getSessionSnapshot(updatedSession);
      await appendFrontendE2ELog(
        `场景执行完成：messages=${snapshot.messageCount}, toolEvents=${snapshot.toolEventCount}, commandAuth=${snapshot.commandAuthCount}`
      );
      await saveFrontendE2EStatus({
        id: scenarioId,
        status: "completed",
        projectName: project.name,
        projectPath: project.workspacePath,
        sessionName: updatedSession.name,
        sessionId: updatedSession.id,
        prompt: control.prompt,
        ...snapshot,
      });
    } catch (e) {
      const error = String(e);
      await appendFrontendE2ELog(`场景执行失败：${error}`);
      await saveFrontendE2EStatus({
        id: scenarioId,
        status: "error",
        prompt: control.prompt,
        error,
      });
    } finally {
      frontendE2ERunning = false;
    }
  }

  async function pollFrontendE2EControl(): Promise<void> {
    if (frontendE2ERunning) return;
    try {
      const raw = await invoke<string | null>("read_frontend_e2e_control");
      if (!raw || raw === "null") return;
      await invoke("clear_frontend_e2e_control");
      const normalized = raw.replace(/^\uFEFF/, "").trim();
      const control = JSON.parse(normalized) as FrontendE2EControl;
      if (!control?.prompt) {
        await appendFrontendE2ELog("收到无效的前端 E2E 控制文件，缺少 prompt");
        await saveFrontendE2EStatus({
          status: "error",
          error: "前端 E2E 控制文件缺少 prompt",
        });
        return;
      }
      await runFrontendE2EScenario(control);
    } catch (e) {
      console.error("[frontend-e2e] 轮询失败:", e);
    }
  }

  function startFrontendE2ERunner(): void {
    if (frontendE2EPollTimer) return;
    frontendE2EPollTimer = setInterval(() => {
      void pollFrontendE2EControl();
    }, 1200);
    void pollFrontendE2EControl();
  }

  startFrontendE2ERunner();
});
