import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { sidebar } from "./sidebar";
import { initCanvas, getCanvas, FileCanvas, DocBlock, CanvasNode, CanvasEdge } from "./canvas";
import { DraftCanvas, DraftToolbox, DraftSidebar, DraftTool } from "./draft";
import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import {
  supervisorAnalyze,
  executePipeline,
  supervisorReview,
  resolveExpertApiKey,
  buildProgressReport,
  analyzeFollowupIntent,
  getAvailableExpertInfos,
  recordTokenUsage,
  loadTokenData,
  loadUserTokenData,
  userTokenData,
  getTokenUsageByExpert,
  setExpertsRef,
  getTotalUsage,
  getExpertPerformance,
  type DispatchPlan,
  type ExpertTask,
  type TimeRange,
  type ExpertPerformance,
} from "./expert-router";
import { saveUserIntentMemory } from "./memory-store";

// 引用以避免 TS6133 未使用警告（专家表现面板后续将使用）
void getExpertPerformance;
void 0 as unknown as ExpertPerformance;

// ========== 树节点类型（对应 Rust TreeEntry） ==========
interface TreeEntry {
  name: string;
  path: string;
  type: "folder" | "file";
  children: TreeEntry[] | null;
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
const appWindow = getCurrentWindow();
log("INFO", "appWindow acquired");

document
  .getElementById("header-minimize")
  ?.addEventListener("click", () => {
    log("INFO", "minimize clicked");
    appWindow.minimize();
  });

document
  .getElementById("header-maximize")
  ?.addEventListener("click", () => {
    log("INFO", "maximize clicked");
    appWindow.toggleMaximize();
  });

document
  .getElementById("header-close")
  ?.addEventListener("click", () => {
    log("INFO", "close clicked");
    appWindow.close();
  });

// ========== 手动实现拖拽（替代 data-tauri-drag-region） ==========
document.addEventListener("DOMContentLoaded", () => {
  const dragRegion = document.getElementById("header-drag-region");
  if (dragRegion) {
    dragRegion.addEventListener("mousedown", async (e) => {
      if (e.button === 0) {
        log("INFO", "drag started");
        await appWindow.startDragging();
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
  appWindow.onDragDropEvent(async (event) => {
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

  // 悬浮按钮切换激活状态
  document.querySelectorAll(".floating-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".floating-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
});

// ========== 主题切换 ==========
let isDarkMode = false;

function applyTheme(dark: boolean) {
  isDarkMode = dark;
  log("INFO", `theme toggled: isDarkMode=${isDarkMode}`);

  const root = document.documentElement;
  if (isDarkMode) {
    root.style.setProperty("--bg-near-white", "#1e1e1e");
    root.style.setProperty("--bg-primary", "#1a1a2e");
    root.style.setProperty("--bg-secondary", "#252525");
    root.style.setProperty("--bg-tertiary", "rgba(255,255,255,0.03)");
    root.style.setProperty("--text-primary", "#e0e0e0");
    root.style.setProperty("--text-secondary", "#a0a0b0");
    root.style.setProperty("--text-muted", "#888888");
    root.style.setProperty("--border-color", "#2a2a4a");
    document.body.style.backgroundColor = "#1e1e1e";
    document.body.style.color = "#e0e0e0";

    const header = document.querySelector(".app-header") as HTMLElement;
    if (header) {
      header.style.backgroundColor = "#2d2d2d";
      header.style.borderBottomColor = "#3d3d3d";
    }

    const sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar.style.backgroundColor = "#252525";
      sidebar.style.borderRightColor = "#3d3d3d";
    }

    const mainContent = document.getElementById("main-content");
    if (mainContent) {
      mainContent.style.backgroundColor = "#1e1e1e";
    }

    document.querySelectorAll(".menu-trigger").forEach((el) => {
      (el as HTMLElement).style.color = "#ccc";
    });

    document.querySelectorAll(".header-btn").forEach((el) => {
      (el as HTMLElement).style.color = "#aaa";
    });
  } else {
    root.style.setProperty("--bg-near-white", "#fafafa");
    root.style.setProperty("--bg-primary", "#ffffff");
    root.style.setProperty("--bg-secondary", "#f5f5f5");
    root.style.setProperty("--bg-tertiary", "#fafafa");
    root.style.setProperty("--text-primary", "#333333");
    root.style.setProperty("--text-secondary", "#666666");
    root.style.setProperty("--text-muted", "#999999");
    root.style.setProperty("--border-color", "#e0e0e0");
    document.body.style.backgroundColor = "#fafafa";
    document.body.style.color = "#333";

    const header = document.querySelector(".app-header") as HTMLElement;
    if (header) {
      header.style.backgroundColor = "#f5f5f5";
      header.style.borderBottomColor = "#e8e8e8";
    }

    const sidebar = document.getElementById("sidebar");
    if (sidebar) {
      sidebar.style.backgroundColor = "#f2f2f2";
      sidebar.style.borderRightColor = "#e8e8e8";
    }

    const mainContent = document.getElementById("main-content");
    if (mainContent) {
      mainContent.style.backgroundColor = "#fafafa";
    }

    document.querySelectorAll(".menu-trigger").forEach((el) => {
      (el as HTMLElement).style.color = "#555";
    });

    document.querySelectorAll(".header-btn").forEach((el) => {
      (el as HTMLElement).style.color = "#888";
    });
  }

  // 同步设置页面开关状态
  const themeToggle = document.getElementById("settings-theme-toggle") as HTMLInputElement;
  if (themeToggle && themeToggle.checked !== dark) {
    themeToggle.checked = dark;
  }
}

document.getElementById("header-theme")?.addEventListener("click", () => {
  applyTheme(!isDarkMode);
});

// ========== 设置页面 ==========
const settingsPage = document.getElementById("settings-page")!;
const settingsBackBtn = document.getElementById("settings-back-btn")!;

// 需要在设置页面打开时隐藏的 UI 元素
const normalUIElements = [
  "canvas-container",
  "floating-actions",
  "chat-card",
  "preview-chat-card",
  "file-preview-card",
  "file-browser-card",
  "wiki-panel",
  "repo-browser",
  "token-panel",
  "time-manager",
];

// 保存打开设置前的 display 状态，以便关闭时正确恢复
const savedDisplayStates = new Map<string, string>();

async function openSettings() {
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

  // 加载密钥池和专家团数据（先密钥池后专家团，避免竞态）
  await loadKeyPool();
  await loadExperts();

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

// ========== 密钥池配置 ==========
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
}

interface RelayKey {
  id: string;
  name: string;
  model: string;
  endpoint: string;
  apiKey: string;
  label: string;
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
    keyPoolItems = Array.isArray(raw) ? raw.filter((i: any) => i && i.type && i.data) : [];
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
  }

  /** 构建单个密钥项的 HTML（预设/中转/自定义共用） */
  const keypoolItemHtml = (id: string, label: string, metaHtml: string) => `
    <div class="keypool-item" data-id="${id}">
      <div class="keypool-item-info">
        <span class="keypool-item-name">${label}</span>
        <span class="keypool-item-meta">${metaHtml}</span>
      </div>
      <div class="keypool-item-actions">
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
    ))
    .join("");

  // 渲染自定义代码列表
  const customs = keyPoolItems.filter((i): i is { type: "custom"; data: CustomCodeKey } => i.type === "custom");
  customList.innerHTML = customs
    .map((item) => keypoolItemHtml(
      item.data.id,
      item.data.label,
      `${item.data.name} &middot; 自定义代码接口`,
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

  setButtonLoading(btn, true);
  try {
    await invoke("test_api_key", {
      config: { type: provider, api_key: key, model },
    });

    keyPoolItems.push({
      type: "preset",
      data: {
        id: crypto.randomUUID(),
        providerId: provider,
        model,
        apiKey: key,
        label: generateLabel(model),
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

  setButtonLoading(btn, true);
  try {
    await invoke("test_api_key", {
      config: { type: "relay", api_key: key, endpoint, model },
    });

    keyPoolItems.push({
      type: "relay",
      data: {
        id: crypto.randomUUID(),
        name,
        model,
        endpoint,
        apiKey: key,
        label: generateLabel(model),
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
  keyId: string | null;
  tokenAllocation?: {
    dailyLimit: number | null;
    monthlyLimit: number | null;
    yearlyLimit: number | null;
  };
}

// 核心角色 ID：江星图(主管)、江星河(助手)、江青澜(通用工程师)、江若溪(调研员)、江映秋(审查员)
// 五者未配置密钥时软件核心功能不可用
const CORE_EXPERT_IDS = ["jiang-xingtu", "jiang-xinghe", "jiang-qinglan", "jiang-ruoxi", "jiang-yingqiu"];

const DEFAULT_EXPERTS: Expert[] = [
  // === 核心角色（顶部三个，必须配置密钥） ===
  {
    id: "jiang-xingtu",
    name: "江星图",
    title: "主管",
    description: "AI 对话区域的实际对话对象，负责整体调度与决策",
    keyId: null,
  },
  {
    id: "jiang-xinghe",
    name: "江星河",
    title: "助手",
    description: "软件本体 AI 助手，负责画布目录关系生成、知识库与仓库生成、对话压缩/总结/优化",
    keyId: null,
  },
  {
    id: "jiang-qinglan",
    name: "江青澜",
    title: "通用工程师",
    description: "负责通用技术方案、架构设计与技术调研",
    keyId: null,
  },
  // === 普通专家 ===
  {
    id: "jiang-dingchu",
    name: "江定初",
    title: "设计师",
    description: "负责 UI/UX 设计、视觉方案与交互规范",
    keyId: null,
  },
  {
    id: "jiang-niannian",
    name: "江念念",
    title: "文员",
    description: "负责文档整理、会议纪要、资料归档",
    keyId: null,
  },
  {
    id: "jiang-yumo",
    name: "江予墨",
    title: "前端工程师",
    description: "负责前端开发、界面实现与交互逻辑",
    keyId: null,
  },
  {
    id: "jiang-subai",
    name: "江素白",
    title: "后端工程师",
    description: "负责后端服务、数据库设计与 API 开发",
    keyId: null,
  },
  {
    id: "jiang-ruoxi",
    name: "江若溪",
    title: "调研员",
    description: "负责代码环境调研、需求分析、技术可行性评估与上下文收集",
    keyId: null,
  },
  {
    id: "jiang-yingqiu",
    name: "江映秋",
    title: "审查员",
    description: "负责代码质量审查、方案合规校验、风险评估与验收确认",
    keyId: null,
  },
];

export let experts: Expert[] = [];

async function loadExperts() {
  await loadExpertsData();
  renderExperts();
}

/** 仅加载专家数据，不渲染 UI（供启动时使用） */
async function loadExpertsData() {
  try {
    const json = await invoke<string>("load_experts");
    const saved = JSON.parse(json || "[]") as Expert[];
    const defaultIds = DEFAULT_EXPERTS.map((e) => e.id);
    const savedIds = saved.map((e) => e.id);
    const missingIds = defaultIds.filter((id) => !savedIds.includes(id));
    if (missingIds.length > 0) {
      // 补齐缺失的新角色（如旧数据缺少江星河）
      const merged = defaultIds.map((id) => {
        const existing = saved.find((e) => e.id === id);
        if (existing) return existing;
        return JSON.parse(JSON.stringify(DEFAULT_EXPERTS.find((e) => e.id === id)!));
      });
      experts = merged;
      await saveExperts();
    } else {
      experts = saved;
    }
  } catch {
    experts = JSON.parse(JSON.stringify(DEFAULT_EXPERTS));
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
  const gridSpecial = document.getElementById("expert-grid-special")!;
  const gridRegular = document.getElementById("expert-grid-regular")!;

  // 构建密钥选项
  const keyOptions = keyPoolItems
    .map((item) => {
      return `<option value="${item.data.id}">${item.data.label}</option>`;
    })
    .join("");

  // 填充全局模型配置下拉框
  const globalKeySelect = document.getElementById("expert-global-key") as HTMLSelectElement;
  if (globalKeySelect) {
    globalKeySelect.innerHTML = `<option value="">选择密钥...</option>${keyOptions}`;
  }

  const EXEMPT_EXPERT_IDS = ["jiang-xingtu", "jiang-xinghe", "jiang-qinglan"];

  const cardHtml = (expert: Expert) => {
    const selectHtml = `<select class="expert-key-select" data-expert-id="${expert.id}">
      <option value="">未配置</option>
      ${keyOptions}
    </select>`;
    const quotaHtml = EXEMPT_EXPERT_IDS.includes(expert.id) ? "" : `
      <div class="expert-quota-config">
        <span class="quota-label">词元配额</span>
        <div class="quota-inputs">
          <div class="quota-input-group">
            <input type="number" placeholder="不限制" class="quota-input quota-daily" data-expert-id="${expert.id}" value="${expert.tokenAllocation?.dailyLimit ?? ""}" min="0" />
            <span class="quota-unit">日</span>
          </div>
          <div class="quota-input-group">
            <input type="number" placeholder="不限制" class="quota-input quota-monthly" data-expert-id="${expert.id}" value="${expert.tokenAllocation?.monthlyLimit ?? ""}" min="0" />
            <span class="quota-unit">月</span>
          </div>
          <div class="quota-input-group">
            <input type="number" placeholder="不限制" class="quota-input quota-yearly" data-expert-id="${expert.id}" value="${expert.tokenAllocation?.yearlyLimit ?? ""}" min="0" />
            <span class="quota-unit">年</span>
          </div>
        </div>
        <span class="quota-hint">留空表示不限制</span>
      </div>`;
    return `<div class="expert-card${CORE_EXPERT_IDS.includes(expert.id) ? " expert-card-core" : ""}">
      <div class="expert-body">
        <div class="expert-header">
          <div class="expert-name">${expert.name}</div>
          <div class="expert-title">${expert.title}</div>
          <div class="expert-desc">${expert.description}</div>
        </div>
        <div class="expert-footer">
          ${selectHtml}
          ${quotaHtml}
        </div>
      </div>
    </div>`;
  };

  // 顶部核心角色（前3个）
  const specialExperts = experts.slice(0, 3);
  gridSpecial.innerHTML = specialExperts.map(cardHtml).join("");

  // 下方普通专家（后4个）
  const regularExperts = experts.slice(3);
  gridRegular.innerHTML = regularExperts.map(cardHtml).join("");

  // 设置当前选中值（涵盖两个 grid）
  const allGrids = [gridSpecial, gridRegular];
  experts.forEach((expert) => {
    allGrids.forEach((grid) => {
      const select = grid.querySelector(`select[data-expert-id="${expert.id}"]`) as HTMLSelectElement;
      if (select && expert.keyId) {
        select.value = expert.keyId;
      }
    });
  });

  // 绑定 change 事件（涵盖两个 grid）
  allGrids.forEach((grid) => {
    grid.querySelectorAll(".expert-key-select").forEach((select) => {
      select.addEventListener("change", async (e) => {
        const expertId = (e.target as HTMLElement).dataset.expertId;
        const keyId = (e.target as HTMLSelectElement).value;
        const expert = experts.find((ex) => ex.id === expertId);
        if (expert) {
          expert.keyId = keyId || null;
          await saveExperts();
        }
      });
    });
  });

  // 绑定配额输入框 change 事件
  allGrids.forEach((grid) => {
    grid.querySelectorAll(".quota-input").forEach((input) => {
      input.addEventListener("change", async (e) => {
        const el = e.target as HTMLInputElement;
        const expertId = el.dataset.expertId!;
        const expert = experts.find((ex) => ex.id === expertId);
        if (!expert) return;
        if (!expert.tokenAllocation) {
          expert.tokenAllocation = { dailyLimit: null, monthlyLimit: null, yearlyLimit: null };
        }
        const value = el.value ? parseInt(el.value, 10) : null;
        if (el.classList.contains("quota-daily")) expert.tokenAllocation.dailyLimit = value;
        if (el.classList.contains("quota-monthly")) expert.tokenAllocation.monthlyLimit = value;
        if (el.classList.contains("quota-yearly")) expert.tokenAllocation.yearlyLimit = value;
        await saveExperts();
      });
    });
  });

  // 绑定全局模型配置应用按钮
  const applyModelBtn = document.getElementById("apply-model-btn");
  if (applyModelBtn) {
    applyModelBtn.addEventListener("click", async () => {
      const globalSelect = document.getElementById("expert-global-key") as HTMLSelectElement;
      const applyAllCheckbox = document.getElementById("apply-key-to-all") as HTMLInputElement;
      const selectedKeyId = globalSelect?.value;
      if (!applyAllCheckbox?.checked) {
        showError("请先勾选\"为所有专家配置该模型\"确认选项");
        return;
      }
      if (!selectedKeyId) {
        showError("请先选择一个密钥");
        return;
      }
      experts.forEach((ex) => { ex.keyId = selectedKeyId; });
      await saveExperts();
      renderExperts();
    });
  }
}

// ========== 监听对话切换 ==========
window.addEventListener("chat-changed", ((e: CustomEvent) => {
  const { chatId } = e.detail;
  log("INFO", `切换到项目 ${chatId}`);
}) as EventListener);

// ========== 聊天区域逻辑 ==========
// 每个项目下可以有多个对话历史（对话一、对话二...）
interface ChatSession {
  id: number;
  name: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

const projectSessions = new Map<number, ChatSession[]>();
let currentProjectId: number | null = null;
let currentSessionId: number | null = null;
let nextSessionId = 1;

// ========== 感知索引状态 ==========
let perceptualIndexReady = false;
let perceptualIndexBuilding = false;

// ========== 专家团流水线状态 ==========
let pipelineRunning = false;
let currentDispatchPlan: DispatchPlan | null = null;
let pendingFollowups: string[] = [];

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

  // 从数据库加载项目的会话数据
  async function loadSessionsFromDb(projectId: number): Promise<void> {
    const project = sidebar.getChats().find((c) => c.id === projectId);
    if (!project) return;

    try {
      // 优先从项目文件 .xt/chat_sessions.json 加载（项目级持久化）
      const fileData = await invoke<string>("load_chat_sessions", {
        projectName: project.name,
      });
      if (fileData && fileData !== "null") {
        const sessions: ChatSession[] = JSON.parse(fileData);
        if (sessions.length > 0) {
          projectSessions.set(projectId, sessions);
          const maxId = Math.max(...sessions.map((s) => s.id), 0);
          if (maxId >= nextSessionId) nextSessionId = maxId + 1;
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
      const sessions: ChatSession[] = JSON.parse(data);
      if (sessions.length > 0) {
        projectSessions.set(projectId, sessions);
        const maxId = Math.max(...sessions.map((s) => s.id), 0);
        if (maxId >= nextSessionId) nextSessionId = maxId + 1;
        log("INFO", `从数据库加载了 ${sessions.length} 个会话`);
        // 迁移到项目文件
        await invoke("save_chat_sessions", {
          projectName: project.name,
          data: JSON.stringify(sessions),
        });
      }
    } catch (e) {
      log("ERROR", `加载会话数据失败: ${e}`);
    }
  }

  // 保存会话消息到数据库
  async function saveSessionToDb(sessionId: number, projectId: number): Promise<void> {
    const sessions = projectSessions.get(projectId);
    if (!sessions) return;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;

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

      // 持久化到项目文件
      await persistSessionsToFile(projectId);
    } catch (e) {
      log("ERROR", `保存会话消息失败: ${e}`);
    }
  }

  // 获取当前项目的所有会话
  function getSessions(projectId: number): ChatSession[] {
    if (!projectSessions.has(projectId)) {
      // 默认创建一个会话
      const session: ChatSession = {
        id: nextSessionId++,
        name: "对话 1",
        messages: [],
      };
      projectSessions.set(projectId, [session]);
    }
    return projectSessions.get(projectId)!;
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
      session.id = dbSessionId; // 使用数据库返回的ID
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
      sessions.splice(idx, 1);
      // 如果删除的是当前会话，切换到第一个
      if (currentSessionId === sessionId) {
        currentSessionId = sessions[0]?.id || null;
      }
      // 持久化到项目文件
      await persistSessionsToFile(currentProjectId);
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
    if (perceptualIndexBuilding) return;

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

  // 发送消息
  async function sendMessage() {
    const text = chatInput?.value.trim();
    if (!text) return;

    // 核心角色密钥校验：江星图/江星河/江青澜/江若溪/江映秋 必须全部配置密钥
    if (!isCoreKeyConfigured()) {
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
    session.messages.push({ role: "user", content: text });

    // 保存用户消息到数据库
    await saveSessionToDb(currentSessionId, currentProjectId);

    // 保存用户意图到 Ephemeral 记忆
    const projectForMemory = sidebar.getActiveChat();
    if (projectForMemory) {
      saveUserIntentMemory(projectForMemory.name, currentProjectId, text).catch(console.error);
    }

    // 清空输入框
    chatInput.value = "";
    chatInput.style.height = "auto";

    // 显示用户消息
    renderMessages();
    updateHistoryDisplay();

    // 获取主管（江星图）的 API 密钥
    const supervisorKey = getExpertApiKey("jiang-xingtu");
    if (!supervisorKey) {
      showError("主管「江星图」未配置密钥，请在设置中绑定");
      session.messages.push({ role: "assistant", content: "请先为「江星图」配置 API 密钥。" });
      renderMessages();
      return;
    }

    // 如果流水线正在执行：将新消息作为增量提交
    if (pipelineRunning) {
      showLoading();
      pendingFollowups.push(text);
      try {
        await analyzeFollowupIntent(text, currentDispatchPlan!, supervisorKey, "supervisor");
        const reportMsg = `已收到新消息。当前专家团执行中，我已将您的补充要求转达给相关专家。\n\n${buildProgressReport()}`;
        session.messages.push({ role: "assistant", content: reportMsg });
        await saveSessionToDb(currentSessionId, currentProjectId);
      } catch (e) {
        log("WARN", `增量意图分析失败: ${e}`);
        session.messages.push({ role: "assistant", content: "已记录您的补充要求，专家团执行完毕后将一并处理。" });
      } finally {
        hideLoading();
        renderMessages();
      }
      return;
    }

    // === 主管意图分析 ===
    showLoading();
    let dispatchPlan: DispatchPlan;
    try {
      // 感知索引上下文
      let searchContext = "";
      if (perceptualIndexReady) {
        const searchProject = sidebar.getActiveChat();
        if (searchProject) {
          try {
            searchContext = await invoke<string>("perceptual_index_search", {
              projectName: searchProject.name,
              query: text,
            });
          } catch (e) { log("WARN", `感知索引检索失败: ${e}`); }
        }
      }

      // 构建对话历史上下文（排除当前用户消息，避免重复）
      const historyForSupervisor = session.messages.slice(0, -1).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // 可用专家列表（不含主管和助手）
      const availableExperts = getAvailableExpertInfos();

      // 用户消息 + 感知索引上下文
      const userMessageWithContext = searchContext
        ? `[项目相关代码]\n${searchContext}\n\n[用户需求]\n${text}`
        : text;

      dispatchPlan = await supervisorAnalyze(
        userMessageWithContext,
        historyForSupervisor,
        availableExperts,
        supervisorKey,
        "supervisor"
      );
      log("INFO", `主管决策：scene=${dispatchPlan.scene}, experts=[${dispatchPlan.expertIds.join(",")}]`);
    } catch (e) {
      log("ERROR", `主管意图分析失败: ${e}`);
      dispatchPlan = { scene: "quick-answer", taskDescription: text, expertIds: [] };
    }

    // === 根据场景执行 ===
    let finalReply: string;

    if (dispatchPlan.scene === "quick-answer" || dispatchPlan.expertIds.length === 0) {
      // 简单问题：主管直接回答
      try {
        const apiMessages = session.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const rawReply = await invoke<string>("chat_with_expert", {
          messages: apiMessages,
          apiKey: supervisorKey,
          systemPrompt: "你是「江星图」，项目主管。现在用户有一个简单问题，请直接回答。回答要简洁明了。",
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
          recordTokenUsage("supervisor", "江星图", "deepseek-v4-flash", "supervisor", usage, "主管").catch(console.error);
        }

        finalReply = reply;
      } catch (e) {
        finalReply = `抱歉，请求出错：${e}`;
      }
    } else {
      // 流水线执行：专家团依次/并行工作
      pipelineRunning = true;
      currentDispatchPlan = dispatchPlan;
      pendingFollowups = [];
      hideLoading();

      // 插入一条“主管调度”消息（显示分派计划）
      const dispatchDesc = dispatchPlan.expertIds
        .map((id) => {
          const info = getAvailableExpertInfos().find((e) => e.id === id);
          return info ? `${info.name}（${info.title}）` : id;
        })
        .join(" → ");
      session.messages.push({
        role: "assistant",
        content: `派遣专家处理：${dispatchDesc}`,
      });
      renderMessages();

      try {
        // 执行流水线（onProgress 回调实时更新 UI）
        const activeProjectForPipeline = sidebar.getActiveChat();
        const pipelineResult = await executePipeline(
          dispatchPlan,
          getExpertApiKey,
          (tasks: ExpertTask[]) => {
            // 实时渲染专家任务卡片（通过全局事件）
            window.dispatchEvent(new CustomEvent("expert-tasks-update", { detail: { tasks } }));
          },
          activeProjectForPipeline?.name,
          activeProjectForPipeline?.id
        );
        const expertResults = pipelineResult.tasks;
        const pipelineId = pipelineResult.pipelineId;

        // 检查是否有补充消息需传递给审核阶段
        const followupContext = pendingFollowups.length > 0
          ? `\n\n用户补充要求：${pendingFollowups.join("；")}`
          : "";

        // 主管审核所有专家结果
        showLoading();
        finalReply = await supervisorReview(
          dispatchPlan.taskDescription + followupContext,
          expertResults,
          supervisorKey,
          "supervisor"
        );

        // 生成交付清单（fire-and-forget）
        if (activeProjectForPipeline?.name && pipelineId) {
          import("./task-tracker").then(({ generateDeliverable }) => {
            generateDeliverable(
              activeProjectForPipeline.name,
              pipelineId,
              dispatchPlan.taskDescription,
              expertResults
            ).catch(console.error);
          });
        }

        // 流水线结束后保留专家任务卡片（不主动清除），由新对话或页面切换时自然清理
      } catch (e) {
        log("ERROR", `流水线执行失败: ${e}`);
        finalReply = `专家团执行出错：${e}`;
      } finally {
        pipelineRunning = false;
        currentDispatchPlan = null;
      }
    }

    // 将最终回复推入会话
    session.messages.push({ role: "assistant", content: finalReply });

    // 保存到数据库
    await saveSessionToDb(currentSessionId, currentProjectId);

    // 解析并执行 Agent 动作
    await executeAgentActions(finalReply);

    hideLoading();
    renderMessages();
  }

  // ========== Agent 动作解析与执行 ==========
  interface AgentAction {
    type: "CREATE_FOLDER" | "CREATE_FILE" | "WRITE_FILE" | "DELETE" | "INDEX_BUILD" | "INDEX_SEARCH";
    path: string;
    content?: string;
  }

  /** 解析 AI 返回中的动作标记 */
  function parseAgentActions(content: string): AgentAction[] {
    const actions: AgentAction[] = [];

    // 匹配 [ACTION:CREATE_FOLDER:相对路径]
    const folderRegex = /\[ACTION:CREATE_FOLDER:([^\]]+)\]/g;
    let match;
    while ((match = folderRegex.exec(content)) !== null) {
      actions.push({ type: "CREATE_FOLDER", path: match[1].trim() });
    }

    // 匹配 [ACTION:CREATE_FILE:相对路径]\n```\n内容\n```
    const fileRegex = /\[ACTION:CREATE_FILE:([^\]]+)\]\s*```(?:\w*\n)?([\s\S]*?)```/g;
    while ((match = fileRegex.exec(content)) !== null) {
      actions.push({
        type: "CREATE_FILE",
        path: match[1].trim(),
        content: match[2].trimEnd(),
      });
    }

    // 匹配 [ACTION:WRITE_FILE:相对路径]\n```\n内容\n```
    const writeRegex = /\[ACTION:WRITE_FILE:([^\]]+)\]\s*```(?:\w*\n)?([\s\S]*?)```/g;
    while ((match = writeRegex.exec(content)) !== null) {
      actions.push({
        type: "WRITE_FILE",
        path: match[1].trim(),
        content: match[2].trimEnd(),
      });
    }

    // 匹配 [ACTION:DELETE:相对路径]
    const deleteRegex = /\[ACTION:DELETE:([^\]]+)\]/g;
    while ((match = deleteRegex.exec(content)) !== null) {
      actions.push({ type: "DELETE", path: match[1].trim() });
    }

    // 匹配 [INDEX_BUILD]
    const indexBuildRegex = /\[INDEX_BUILD\]/g;
    while ((match = indexBuildRegex.exec(content)) !== null) {
      actions.push({ type: "INDEX_BUILD", path: "" });
    }

    // 匹配 [INDEX_SEARCH:查询文本]
    const indexSearchRegex = /\[INDEX_SEARCH:([^\]]+)\]/g;
    while ((match = indexSearchRegex.exec(content)) !== null) {
      actions.push({ type: "INDEX_SEARCH", path: match[1].trim() });
    }

    return actions;
  }

  /** 执行 Agent 动作 */
  async function executeAgentActions(content: string): Promise<void> {
    const actions = parseAgentActions(content);
    if (actions.length === 0) return;

    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    for (const action of actions) {
      try {
        switch (action.type) {
          case "CREATE_FOLDER":
            await invoke("sandbox_create_folder", {
              projectName: activeProject.name,
              relativePath: action.path,
            });
            log("INFO", `Agent: 创建文件夹 ${action.path}`);
            break;
          case "CREATE_FILE":
            await invoke("sandbox_create_file", {
              projectName: activeProject.name,
              relativePath: action.path,
              content: action.content || "",
            });
            log("INFO", `Agent: 创建文件 ${action.path}`);
            break;
          case "WRITE_FILE":
            await invoke("sandbox_write_file", {
              projectName: activeProject.name,
              relativePath: action.path,
              content: action.content || "",
            });
            log("INFO", `Agent: 写入文件 ${action.path}`);
            break;
          case "DELETE":
            await invoke("sandbox_delete", {
              projectName: activeProject.name,
              relativePath: action.path,
            });
            log("INFO", `Agent: 删除 ${action.path}`);
            break;
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
        }
      } catch (e) {
        log("ERROR", `Agent 动作失败 (${action.type}:${action.path}): ${e}`);
      }
    }

    // 文件变更后标记目录为"需要更新"（不自动生成）
    if (activeProject) {
      updateDirectoryStatus("needs-update");
    }

    // 文件变更后自动重建感知索引（后台执行，不阻塞）
    if (activeProject) {
      checkAndBuildIndex(activeProject.name, true);
    }

    // Wiki 自迭代：文件变更后触发增量更新
    if (activeProject && wikiIterationMode === "self") {
      runIncrementalUpdate();
    }
  }

  // 显示加载指示器
  function showLoading() {
    if (!chatMessages) return;
    const loadingEl = document.createElement("div");
    loadingEl.id = "chat-loading";
    loadingEl.className = "chat-message assistant loading";
    loadingEl.innerHTML = `
      <div class="message-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
      <div class="message-content"><span class="loading-dots">思考中<span>.</span><span>.</span><span>.</span></span></div>
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
      const msgEl = document.createElement("div");
      msgEl.className = `chat-message ${msg.role}`;

      if (msg.role === "user") {
        // 用户消息：保持气泡样式
        msgEl.innerHTML = `
          <div class="message-content">${escapeHtml(msg.content)}</div>
        `;
      } else {
        // AI 消息：无头像、无背景、流式布局，解析 Artifact 卡片
        msgEl.innerHTML = renderAiMessage(msg.content);
      }
      chatMessages.appendChild(msgEl);
    });

    // 绑定 Artifact 卡片点击事件
    bindArtifactClicks();

    // 滚动到底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  /** 渲染 AI 消息内容：解析文本和 Artifact 卡片 */
  function renderAiMessage(content: string): string {
    const blocks = parseMessageBlocks(content);
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
      return `<div class="msg-text">${formatInlineMarkdown(escapeHtml(block.content))}</div>`;
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
    const combined = /\[ACTION:CREATE_FILE:([^\]]+)\]\s*```(?:\w*\n)?([\s\S]*?)```|\[ACTION:CREATE_FOLDER:([^\]]+)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = combined.exec(content)) !== null) {
      // 匹配前的文本（过滤掉残留的 [ACTION:...] 标记）
      if (match.index > lastIndex) {
        let text = content.slice(lastIndex, match.index).trim();
        // 清除残留的 [ACTION:...] 元数据标记
        text = text.replace(/\[ACTION:[^\]]*\]\s*/g, "").trim();
        if (text) blocks.push({ type: "text", content: text });
      }
      if (match[1]) {
        // 文件 Artifact
        blocks.push({
          type: "artifact",
          filename: match[1].trim(),
          content: match[2].trimEnd(),
        });
      } else if (match[3]) {
        // 文件夹
        blocks.push({
          type: "folder",
          name: match[3].trim(),
        });
      }
      lastIndex = combined.lastIndex;
    }

    // 剩余文本
    if (lastIndex < content.length) {
      let text = content.slice(lastIndex).trim();
      // 清除残留的 [ACTION:...] 元数据标记
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

  /** 行内 Markdown 格式化（粗体、斜体、行内代码、标题等） */
  function formatInlineMarkdown(html: string): string {
    // 标题（# ## ### ####）
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    // 将换行转为 <br>（保留段落结构，但跳过已渲染的标题行）
    html = html.replace(/\n/g, "<br>");
    // **粗体**
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // *斜体*
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // `行内代码`
    html = html.replace(/`([^`]+)`/g, "<code class=\"inline-code\">$1</code>");
    // - 列表项
    html = html.replace(/^-\s+(.+)$/gm, "• $1");
    return html;
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

        // 将内容写入沙箱文件
        try {
          await invoke("sandbox_write_file", {
            projectName: activeProject.name,
            relativePath: filename,
            content: content || "",
          });
          log("INFO", `Artifact 写入文件: ${filename}`);
          // 文件变更后重建感知索引
          checkAndBuildIndex(activeProject.name, true);
        } catch (e) {
          log("ERROR", `Artifact 写入失败: ${e}`);
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

  // ========== 专家任务卡片渲染 ==========

  /** 渲染专家任务卡片组（实时插入到 chatMessages 尾部） */
  function renderExpertTaskCards(tasks: ExpertTask[]) {
    if (!chatMessages) return;

    // 移除旧的卡片容器
    const oldGroup = chatMessages.querySelector(".expert-tasks-group");
    if (oldGroup) oldGroup.remove();

    if (tasks.length === 0) return;

    const groupEl = document.createElement("div");
    groupEl.className = "expert-tasks-group";

    tasks.forEach((task) => {
      const statusLabel = task.status === "done" ? "已完成"
        : task.status === "running" ? "执行中"
        : task.status === "error" ? "失败" : "等待中";

      const descText = task.status === "error"
        ? (task.error || "执行出错")
        : task.status === "done"
        ? (task.output ? task.output.substring(0, 80) + (task.output.length > 80 ? "..." : "") : "已完成")
        : task.input.substring(0, 80) + (task.input.length > 80 ? "..." : "");

      const cardHtml = `
        <div class="expert-call-card" data-expert-id="${escapeAttr(task.expertId)}" data-status="${task.status}">
          <div class="expert-call-accent"></div>
          <div class="expert-call-body">
            <div class="expert-call-header">
              <span class="expert-call-name">${escapeHtml(task.expertName)}</span>
              <span class="expert-call-title">${escapeHtml(task.expertTitle)}</span>
              <span class="expert-call-status ${task.status}">${statusLabel}</span>
            </div>
            <div class="expert-call-desc">${escapeHtml(descText)}</div>
            ${task.status === "done" && task.output ? `
              <div class="expert-call-output">
                <button class="expert-call-output-toggle" type="button">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                  查看完整输出
                </button>
                <div class="expert-call-output-content">${escapeHtml(task.output)}</div>
              </div>
            ` : ""}
          </div>
        </div>
      `;
      groupEl.insertAdjacentHTML("beforeend", cardHtml);
    });

    chatMessages.appendChild(groupEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // 绑定折叠按钮
    groupEl.querySelectorAll(".expert-call-output-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const toggle = btn as HTMLElement;
        const content = toggle.nextElementSibling as HTMLElement;
        toggle.classList.toggle("expanded");
        content.classList.toggle("expanded");
      });
    });
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

  // 输入框回车发送
  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
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
      if (canvasContainer) canvasContainer.style.visibility = "visible";
      if (floatingActions) floatingActions.style.visibility = "visible";

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

  /** 生成仅含项目根节点的最小画布数据（用作任何失败场景的兑底） */
  function makeRootOnlyResult(projectName: string): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    return {
      nodes: [{ id: projectName, type: "folder", name: projectName, x: 0, y: 0 }],
      edges: [],
    };
  }

  /** 根据文件夹结构生成画布节点和连线（纯机械操作，永不允许返回空） */
  async function generateStructureCanvas(projectName: string): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
    const fallback = makeRootOnlyResult(projectName);
    try {
      const entriesJson = await invoke<string>("sandbox_list_dir", {
        projectName,
        relativePath: ".",
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
        // 兼容旧格式（直接是单模式数据对象）
        if (parsed.mode) {
          allCachedData = {};
          if (parsed.mode === "logic") {
            allCachedData.logic = parsed;
            directoryMode = "logic";
          } else {
            allCachedData.structure = parsed;
            directoryMode = "structure";
          }
        } else {
          // 新格式：包含 structure/logic 子字段
          allCachedData = parsed;
          // 默认优先 structure 模式
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
      await checkDirectoryChanges(project.name, modeData);
      return;
    }

    // 3. 无缓存：结构模式直接自动生成（纯机械操作，不需要任何前提条件）
    //    无论成功失败，画布上必须有内容（至少显示项目根节点）
    if (directoryMode === "structure") {
      updateDirectoryStatus("updating");
      const result = await generateStructureCanvas(project.name);
      canvas.setData(result.nodes, result.edges);
      const snapshot = await collectDirectorySnapshot(project.name);
      const now = new Date().toISOString();
      try {
        await invoke("save_canvas_directory", {
          projectName: project.name,
          data: JSON.stringify({
            nodes: result.nodes,
            edges: result.edges,
            updatedAt: now,
            mode: "structure",
            directorySnapshot: snapshot,
          }),
        });
      } catch { /* 保存失败不影响显示 */ }
      updateDirectoryStatus("up-to-date");
      log("INFO", "无缓存，结构模式自动生成完成");
    } else {
      // 逻辑模式无缓存：先显示根节点，等用户点更新时调用 AI
      const rootResult = makeRootOnlyResult(project.name);
      canvas.setData(rootResult.nodes, rootResult.edges);
      updateDirectoryStatus("needs-update");
    }
  }

  // AI 生成画布数据并持久化
  async function aiGenerateCanvas(
    project: { id: number; name: string },
    canvas: ReturnType<typeof getCanvas>,
  ) {
    if (!canvas) return;
    try {
      const apiKey = getActiveApiKey();
      if (!apiKey) {
        log("WARN", "没有配置 API 密钥，跳过画布分析");
        // 即使无密钥也显示根节点，禁止画布为空
        const rootResult = makeRootOnlyResult(project.name);
        canvas.setData(rootResult.nodes, rootResult.edges);
        updateDirectoryStatus("needs-update");
        return;
      }
      const result = await invoke<string>("analyze_project_dependencies", {
        projectName: project.name,
        apiKey: apiKey,
      });

      // 解析 DeepSeek 返回的 JSON
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data.nodes && data.edges) {
          canvas.setData(data.nodes, data.edges);

          // 收集目录快照
          const snapshot = await collectDirectorySnapshot(project.name);

          // 持久化逻辑模式数据到 .xt/config.json
          const now = new Date().toISOString();
          await invoke("save_canvas_directory", {
            projectName: project.name,
            data: JSON.stringify({
              nodes: data.nodes,
              edges: data.edges,
              updatedAt: now,
              mode: "logic",
              directorySnapshot: snapshot,
            }),
          });

          // 同时确保结构模式也有缓存（如果还没有的话）
          try {
            const allCached = await invoke<string>("load_canvas_directory", {
              projectName: project.name,
            });
            const parsedAll = allCached && allCached !== "null" ? JSON.parse(allCached) : {};
            const hasStructure = parsedAll.structure && parsedAll.structure.nodes && parsedAll.structure.nodes.length > 0;
            if (!hasStructure) {
              const structureResult = await generateStructureCanvas(project.name);
              const structureSnapshot = await collectDirectorySnapshot(project.name);
              await invoke("save_canvas_directory", {
                projectName: project.name,
                data: JSON.stringify({
                  nodes: structureResult.nodes,
                  edges: structureResult.edges,
                  updatedAt: now,
                  mode: "structure",
                  directorySnapshot: structureSnapshot,
                }),
              });
              log("INFO", "逻辑模式生成时自动补全结构模式缓存");
            }
          } catch { /* 补全结构缓存失败不影响主流程 */ }

          updateDirectoryStatus("up-to-date");
          log("INFO", "AI 生成目录数据并持久化");
          return;
        }
      }
    } catch (e) {
      log("ERROR", `加载项目画布失败: ${e}`);
      // 失败时显示根节点，禁止画布为空
      const rootResult = makeRootOnlyResult(project.name);
      canvas.setData(rootResult.nodes, rootResult.edges);
      updateDirectoryStatus("needs-update");
    }
  }

  /** 收集当前目录快照（所有文件/文件夹路径的排序列表） */
  async function collectDirectorySnapshot(projectName: string): Promise<string[]> {
    try {
      const entriesJson = await invoke<string>("sandbox_list_dir", {
        projectName,
        relativePath: ".",
      });
      const tree: TreeEntry[] = JSON.parse(entriesJson);
      const paths: string[] = [];
      function collect(items: TreeEntry[]) {
        for (const item of items) {
          paths.push(item.path);
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
  async function checkDirectoryChanges(projectName: string, cachedData: any) {
    const currentSnapshot = await collectDirectorySnapshot(projectName);
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
        textEl.textContent = "无需更新";
        btn.disabled = true;
        break;
      case "needs-update":
        textEl.textContent = "更新";
        btn.classList.add("needs-update");
        btn.disabled = false;
        break;
      case "updating":
        textEl.textContent = "更新中...";
        btn.classList.add("spinning");
        btn.disabled = true;
        break;
    }
  }

  // 同步页签 UI 状态
  function updateTabActive() {
    const tabStructure = document.getElementById("dir-tab-structure");
    const tabLogic = document.getElementById("dir-tab-logic");
    if (tabStructure) tabStructure.classList.toggle("active", directoryMode === "structure");
    if (tabLogic) tabLogic.classList.toggle("active", directoryMode === "logic");
  }

  // 绑定状态按钮点击（触发增量更新）
  const dirStatusBtn = document.getElementById("canvas-directory-status-btn");
  dirStatusBtn?.addEventListener("click", async () => {
    const activeProject = sidebar.getActiveChat();
    const canvas = getCanvas();
    if (!activeProject || !canvas) return;

    updateDirectoryStatus("updating");

    try {
      if (directoryMode === "structure") {
        await incrementalStructureUpdate(activeProject.name, canvas);
      } else {
        await aiGenerateCanvas(activeProject, canvas);
      }
    } finally {
      // 状态由具体更新函数设置
    }
  });

  /** 结构模式增量更新：只增加/移除变更的节点 */
  async function incrementalStructureUpdate(projectName: string, canvas: ReturnType<typeof getCanvas>) {
    if (!canvas) return;
    try {
      const result = await generateStructureCanvas(projectName);
      canvas.setData(result.nodes, result.edges);

      // 收集并保存快照
      const snapshot = await collectDirectorySnapshot(projectName);
      const now = new Date().toISOString();
      await invoke("save_canvas_directory", {
        projectName,
        data: JSON.stringify({
          nodes: result.nodes,
          edges: result.edges,
          updatedAt: now,
          mode: "structure",
          directorySnapshot: snapshot,
        }),
      });
      updateDirectoryStatus("up-to-date");
      log("INFO", "结构模式增量更新完成");
    } catch (e) {
      log("ERROR", `结构模式更新失败: ${e}`);
      updateDirectoryStatus("needs-update");
    }
  }

  // 绑定目录卡片页签切换
  const tabStructure = document.getElementById("dir-tab-structure");
  const tabLogic = document.getElementById("dir-tab-logic");
  tabStructure?.addEventListener("click", async () => {
    if (directoryMode === "structure") return;
    directoryMode = "structure";
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
        // 兼容旧格式
        const modeData = parsed.mode ? parsed : parsed.structure;
        if (modeData && modeData.nodes && modeData.edges && modeData.nodes.length > 0) {
          canvas.setData(modeData.nodes, modeData.edges);
          await checkDirectoryChanges(activeProject.name, modeData);
          return;
        }
      }
    } catch { /* ignore */ }
    // 无缓存：结构模式直接自动生成（纯机械操作，画布永不允许为空）
    updateDirectoryStatus("updating");
    const result = await generateStructureCanvas(activeProject.name);
    canvas.setData(result.nodes, result.edges);
    const snapshot = await collectDirectorySnapshot(activeProject.name);
    const now = new Date().toISOString();
    try {
      await invoke("save_canvas_directory", {
        projectName: activeProject.name,
        data: JSON.stringify({
          nodes: result.nodes, edges: result.edges,
          updatedAt: now, mode: "structure", directorySnapshot: snapshot,
        }),
      });
    } catch { /* 保存失败不影响显示 */ }
    updateDirectoryStatus("up-to-date");
  });
  tabLogic?.addEventListener("click", async () => {
    if (directoryMode === "logic") return;
    directoryMode = "logic";
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
        // 新格式: parsed.logic; 旧格式: parsed.mode === "logic"
        const modeData = parsed.logic || (parsed.mode === "logic" ? parsed : null);
        if (modeData && modeData.nodes && modeData.edges && modeData.nodes.length > 0) {
          canvas.setData(modeData.nodes, modeData.edges);
          await checkDirectoryChanges(activeProject.name, modeData);
          return;
        }
      }
    } catch { /* ignore */ }
    // 无缓存或模式不匹配：先显示根节点，等用户点更新时调用 AI
    const rootResult = makeRootOnlyResult(activeProject.name);
    canvas.setData(rootResult.nodes, rootResult.edges);
    updateDirectoryStatus("needs-update");
  });

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
    exitTokenMode();
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) {
      log("WARN", "Wiki: 没有活跃项目");
      return;
    }

    // 更新浮动按钮激活状态
    document.querySelectorAll(".floating-btn").forEach((b) => b.classList.remove("active"));
    const repoBtn = document.getElementById("btn-repo");
    if (repoBtn) repoBtn.classList.add("active");

    // 隐藏画布
    if (canvasContainer) canvasContainer.style.visibility = "hidden";
    if (floatingActions) floatingActions.style.visibility = "visible";

    // 显示 Wiki 面板和仓库管理器
    if (wikiPanel) {
      wikiPanel.style.display = "flex";
      wikiPanel.classList.add("active");
    }
    if (repoBrowser) {
      repoBrowser.style.display = "flex";
      repoBrowser.classList.add("active");
    }

    // 隐藏文件预览面板
    const fileBrowserCard = document.getElementById("file-browser-card");
    const filePreviewCard = document.getElementById("file-preview-card");
    if (fileBrowserCard) {
      fileBrowserCard.classList.remove("active");
      fileBrowserCard.style.display = "none";
    }
    if (filePreviewCard) {
      filePreviewCard.classList.remove("active");
      filePreviewCard.style.display = "none";
    }

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

    // 恢复画布
    if (canvasContainer) canvasContainer.style.visibility = "visible";
    if (floatingActions) floatingActions.style.visibility = "visible";

    // 更新浮动按钮激活状态
    document.querySelectorAll(".floating-btn").forEach((b) => b.classList.remove("active"));
    const dirBtn = document.getElementById("btn-directory");
    if (dirBtn) dirBtn.classList.add("active");

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

      // 动态仓库项
      if (Array.isArray(items)) {
        for (const item of items) {
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
      repoBrowserList.innerHTML = `<div style="padding:8px;color:#999;font-size:12px;">无法加载仓库</div>`;
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
    isDraftMode = true;

    // 更新浮动按钮状态
    document.querySelectorAll(".floating-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById("btn-draft")?.classList.add("active");

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

    draftCanvas.deactivate();
    draftToolbox.hide();
    draftSidebar.hide();

    // 恢复目录按钮激活状态
    document.querySelectorAll(".floating-btn").forEach((b) => b.classList.remove("active"));
    document.getElementById("btn-directory")?.classList.add("active");

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
  function drawTrendChart(range: TimeRange, dataSource: "project" | "user" = currentTokenSource): void {
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

    // 根据时间范围确定数据点数和间隔
    let buckets: number[];
    let labels: string[];
    const now = new Date();
    const data = dataSource === "user" ? userTokenData : tokenData;

    if (range === "today") {
      // 按小时分组（24个点）
      buckets = new Array(24).fill(0);
      labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      data.records.filter((r) => r.timestamp >= dayStart).forEach((r) => {
        const hour = new Date(r.timestamp).getHours();
        buckets[hour] += r.totalTokens;
      });
    } else if (range === "week") {
      // 按天分组（7天）
      buckets = new Array(7).fill(0);
      labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      const day = now.getDay() || 7;
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1).getTime();
      data.records.filter((r) => r.timestamp >= weekStart).forEach((r) => {
        const d = new Date(r.timestamp).getDay() || 7;
        buckets[d - 1] += r.totalTokens;
      });
    } else if (range === "month") {
      // 按天分组（当月天数）
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      buckets = new Array(daysInMonth).fill(0);
      labels = Array.from({ length: daysInMonth }, (_, i) => `${i + 1}`);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      data.records.filter((r) => r.timestamp >= monthStart).forEach((r) => {
        const day = new Date(r.timestamp).getDate() - 1;
        buckets[day] += r.totalTokens;
      });
    } else if (range === "year") {
      // 按月分组（12个月）
      buckets = new Array(12).fill(0);
      labels = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
      const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
      data.records.filter((r) => r.timestamp >= yearStart).forEach((r) => {
        const month = new Date(r.timestamp).getMonth();
        buckets[month] += r.totalTokens;
      });
    } else {
      // all - 按月分组（最近12个月）
      buckets = new Array(12).fill(0);
      labels = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
        return `${d.getMonth() + 1}月`;
      });
      data.records.forEach((r) => {
        const rDate = new Date(r.timestamp);
        const monthsDiff = (now.getFullYear() - rDate.getFullYear()) * 12 + (now.getMonth() - rDate.getMonth());
        if (monthsDiff >= 0 && monthsDiff < 12) {
          buckets[11 - monthsDiff] += r.totalTokens;
        }
      });
    }

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
  function renderTokenDashboard(activeRange: TimeRange = "today", dataSource: "project" | "user" = currentTokenSource): void {
    const panel = document.getElementById("token-panel-content");
    if (!panel) return;

    const todayUsage = getTotalUsage("today", dataSource);
    const monthUsage = getTotalUsage("month", dataSource);

    // 计算活跃专家数（在当前时段有消耗的专家）
    const activeExpertIds = new Set(
      (dataSource === "user" ? userTokenData : tokenData).records
        .filter((r) => r.timestamp >= getTimeRangeStart(activeRange))
        .map((r) => r.expertId)
    );

    // 专家分布统计
    const expertDistribution = experts
      .map((expert) => {
        const records = getTokenUsageByExpert(expert.id, activeRange, dataSource);
        const total = records.reduce((sum, r) => sum + r.totalTokens, 0);
        return { name: expert.name, title: expert.title, id: expert.id, total };
      })
      .filter((e) => e.total > 0)
      .sort((a, b) => b.total - a.total);

    const maxExpertTokens = expertDistribution.length > 0 ? expertDistribution[0].total : 1;

    // 模型统计
    const modelStats: Record<string, { calls: number; tokens: number }> = {};
    const rangeStart = getTimeRangeStart(activeRange);
    (dataSource === "user" ? userTokenData : tokenData).records
      .filter((r) => r.timestamp >= rangeStart)
      .forEach((r) => {
        if (!modelStats[r.model]) modelStats[r.model] = { calls: 0, tokens: 0 };
        modelStats[r.model].calls++;
        modelStats[r.model].tokens += r.totalTokens;
      });
    const modelList = Object.entries(modelStats).sort((a, b) => b[1].tokens - a[1].tokens);

    // 配额状态（非豁免专家）—— 始终使用项目级数据
    const QUOTA_EXEMPT = ["jiang-xingtu", "jiang-xinghe", "jiang-qinglan"];
    const quotaExperts = experts.filter((e) => !QUOTA_EXEMPT.includes(e.id) && e.tokenAllocation);

    // 最近活动（最近20条）
    const recentRecords = [...(dataSource === "user" ? userTokenData : tokenData).records]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);

    panel.innerHTML = `
      <div class="token-dashboard">
        <!-- 顶部概览卡片 -->
        <div class="dashboard-overview">
          <div class="overview-card">
            <span class="overview-label">今日消耗</span>
            <span class="overview-value">${formatTokenCount(todayUsage.total)}</span>
            <span class="overview-sub">输入 ${formatTokenCount(todayUsage.prompt)} / 输出 ${formatTokenCount(todayUsage.completion)}</span>
          </div>
          <div class="overview-card">
            <span class="overview-label">本月消耗</span>
            <span class="overview-value">${formatTokenCount(monthUsage.total)}</span>
            <span class="overview-sub">输入 ${formatTokenCount(monthUsage.prompt)} / 输出 ${formatTokenCount(monthUsage.completion)}</span>
          </div>
          <div class="overview-card">
            <span class="overview-label">总计消耗</span>
            <span class="overview-value">${formatTokenCount(getTotalUsage("all").total)}</span>
          </div>
          <div class="overview-card">
            <span class="overview-label">活跃专家</span>
            <span class="overview-value">${activeExpertIds.size}</span>
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
            ${expertDistribution.length > 0
              ? expertDistribution
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
            ${modelList.length > 0
              ? `
              <div class="model-table-header">
                <span>模型</span>
                <span>调用次数</span>
                <span>词元消耗</span>
              </div>
              ${modelList
                .map(
                  ([model, stats]) => `
                <div class="model-table-row">
                  <span class="model-name">${model}</span>
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
            ${quotaExperts.length > 0
              ? quotaExperts
                  .map((expert) => {
                    const alloc = expert.tokenAllocation!;
                    const now = new Date();
                    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
                    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
                    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
                    const dayUsed = tokenData.records
                      .filter((r) => r.expertId === expert.id && r.timestamp >= dayStart)
                      .reduce((s, r) => s + r.totalTokens, 0);
                    const monthUsed = tokenData.records
                      .filter((r) => r.expertId === expert.id && r.timestamp >= monthStart)
                      .reduce((s, r) => s + r.totalTokens, 0);
                    const yearUsed = tokenData.records
                      .filter((r) => r.expertId === expert.id && r.timestamp >= yearStart)
                      .reduce((s, r) => s + r.totalTokens, 0);
                    return `
                      <div class="quota-card">
                        <div class="quota-card-header">
                          <span class="quota-card-name">${expert.name}</span>
                          <span class="quota-card-title">${expert.title}</span>
                        </div>
                        ${alloc.dailyLimit !== null
                          ? `
                          <div class="quota-card-row">
                            <span class="quota-period">日</span>
                            <div class="quota-progress-bar"><div class="quota-progress-fill ${dayUsed >= alloc.dailyLimit ? "quota-exceeded" : ""}" style="width:${Math.min(100, (dayUsed / alloc.dailyLimit) * 100)}%"></div></div>
                            <span class="quota-fraction">${formatTokenCount(dayUsed)}/${formatTokenCount(alloc.dailyLimit)}</span>
                          </div>
                        `
                          : ""}
                        ${alloc.monthlyLimit !== null
                          ? `
                          <div class="quota-card-row">
                            <span class="quota-period">月</span>
                            <div class="quota-progress-bar"><div class="quota-progress-fill ${monthUsed >= alloc.monthlyLimit ? "quota-exceeded" : ""}" style="width:${Math.min(100, (monthUsed / alloc.monthlyLimit) * 100)}%"></div></div>
                            <span class="quota-fraction">${formatTokenCount(monthUsed)}/${formatTokenCount(alloc.monthlyLimit)}</span>
                          </div>
                        `
                          : ""}
                        ${alloc.yearlyLimit !== null
                          ? `
                          <div class="quota-card-row">
                            <span class="quota-period">年</span>
                            <div class="quota-progress-bar"><div class="quota-progress-fill ${yearUsed >= alloc.yearlyLimit ? "quota-exceeded" : ""}" style="width:${Math.min(100, (yearUsed / alloc.yearlyLimit) * 100)}%"></div></div>
                            <span class="quota-fraction">${formatTokenCount(yearUsed)}/${formatTokenCount(alloc.yearlyLimit)}</span>
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
            ${recentRecords.length > 0
              ? recentRecords
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
    drawTrendChart(activeRange, dataSource);
  }

  // 将仪表盘渲染函数挂载到window，供时间管理器联动调用
  (window as unknown as Record<string, unknown>).renderTokenDashboard = renderTokenDashboard;

  // 渲染时间管理器（到右侧token-browser卡片）
  function renderTimeManager(activeRange: TimeRange = "today", dataSource: "project" | "user" = currentTokenSource): void {
    const container = document.getElementById("token-browser-body");
    if (!container) return;

    // 获取总统计
    const totalUsage = getTotalUsage(activeRange, dataSource);

    // 获取各专家统计
    const expertStats = experts
      .map((expert) => {
        const records = getTokenUsageByExpert(expert.id, activeRange, dataSource);
        const total = records.reduce((sum, r) => sum + r.totalTokens, 0);
        const allocation = expert.tokenAllocation;
        let quota: number | null = null;
        if (activeRange === "today" && allocation?.dailyLimit) quota = allocation.dailyLimit;
        else if (activeRange === "month" && allocation?.monthlyLimit) quota = allocation.monthlyLimit;
        else if (activeRange === "year" && allocation?.yearlyLimit) quota = allocation.yearlyLimit;
        return { expert, total, quota };
      })
      .filter((s) => s.total > 0 || s.quota !== null)
      .sort((a, b) => b.total - a.total);

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
          <span class="tb-summary-value">${formatTokenCount(totalUsage.total)}</span>
        </div>
        <div class="tb-summary-breakdown">
          <span class="tb-summary-item">输入: ${formatTokenCount(totalUsage.prompt)}</span>
          <span class="tb-summary-item">输出: ${formatTokenCount(totalUsage.completion)}</span>
        </div>
      </div>
      <div class="tb-expert-list">
        ${expertStats.length > 0
          ? expertStats
              .map(
                (s) => `
          <div class="tb-expert-item">
            <div class="tb-expert-info">
              <span class="tb-expert-name">${s.expert.name}</span>
              <span class="tb-expert-title">${s.expert.title}</span>
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
        renderTimeManager(range, currentTokenSource);
        if (typeof (window as unknown as Record<string, unknown>).renderTokenDashboard === "function") {
          ((window as unknown as Record<string, unknown>).renderTokenDashboard as (range: TimeRange, source: "project" | "user") => void)(range, currentTokenSource);
        }
      });
    });
  }

  function enterTokenMode() {
    if (isTokenMode) return;
    // 退出其他互斥模式
    exitDraftMode();
    exitWikiMode();

    isTokenMode = true;

    // 隐藏主界面元素
    if (canvasContainer) canvasContainer.style.visibility = "hidden";
    if (floatingActions) floatingActions.style.visibility = "visible";

    // 显示中央仪表盘卡片
    const tokenPanel = document.getElementById("token-panel");
    if (tokenPanel) {
      tokenPanel.style.display = "flex";
      tokenPanel.classList.add("active");
      // 默认重置为项目级页签
      currentTokenSource = "project";
      tokenPanel.querySelectorAll(".token-tab").forEach((tab) => tab.classList.remove("active"));
      tokenPanel.querySelector('.token-tab[data-tab="project"]')?.classList.add("active");
      renderTokenDashboard("today", "project");
    }
    // 显示右侧时间导航卡片
    const tokenBrowser = document.getElementById("token-browser");
    if (tokenBrowser) {
      tokenBrowser.style.display = "flex";
      tokenBrowser.classList.add("active");
      renderTimeManager("today", "project");
    }

    // 隐藏文件预览面板
    const fileBrowserCard = document.getElementById("file-browser-card");
    const filePreviewCard = document.getElementById("file-preview-card");
    if (fileBrowserCard) { fileBrowserCard.classList.remove("active"); fileBrowserCard.style.display = "none"; }
    if (filePreviewCard) { filePreviewCard.classList.remove("active"); filePreviewCard.style.display = "none"; }

    // 更新按钮active状态
    document.querySelectorAll("#floating-actions .floating-btn").forEach((btn) => btn.classList.remove("active"));
    document.getElementById("btn-token")?.classList.add("active");

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

    // 恢复主界面元素
    if (canvasContainer) canvasContainer.style.visibility = "visible";
    if (floatingActions) floatingActions.style.visibility = "visible";

    // 恢复默认按钮active（目录按钮）
    document.getElementById("btn-token")?.classList.remove("active");
    document.getElementById("btn-directory")?.classList.add("active");

    log("INFO", "退出词元模式");
  }

  // 词元面板页签切换
  document.querySelectorAll(".token-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = (tab as HTMLElement).dataset.tab as "project" | "user";
      if (!target || target === currentTokenSource) return;
      currentTokenSource = target;
      document.querySelectorAll(".token-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      renderTokenDashboard("today", target);
      renderTimeManager("today", target);
    });
  });

  // btn-token 进入/退出词元模式
  document.getElementById("btn-token")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isTokenMode) {
      exitTokenMode();
    } else {
      enterTokenMode();
    }
  });

  // 词元面板返回按钮
  document.getElementById("token-panel-back")?.addEventListener("click", () => {
    exitTokenMode();
  });

  // btn-draft 进入草稿模式
  document.getElementById("btn-draft")?.addEventListener("click", (e) => {
    e.stopPropagation();
    exitTokenMode();
    enterDraftMode();
  });

  // btn-repo 进入 Wiki 模式（覆盖悬浮按钮的通用点击行为）
  document.getElementById("btn-repo")?.addEventListener("click", (e) => {
    e.stopPropagation();
    exitTokenMode();
    exitDraftMode();
    enterWikiMode();
  });

  // btn-directory 退出 Wiki/草稿/词元模式
  document.getElementById("btn-directory")?.addEventListener("click", () => {
    exitDraftMode();
    exitWikiMode();
    exitTokenMode();
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
  const fileBrowserTree = document.getElementById("file-browser-tree");
  const filePreviewBack = document.getElementById("file-preview-back");
  const filePreviewHighlight = document.getElementById("file-preview-highlight");
  const highlightCode = document.getElementById("highlight-code");
  const filePreviewLang = document.getElementById("file-preview-lang");
  const langLabel = document.getElementById("lang-label");
  const filePreviewThemeToggle = document.getElementById("file-preview-theme-toggle");

  // 子画布实例（延迟初始化）
  let fileCanvas: FileCanvas | null = null;

  // 当前预览的文件路径（用于侧边栏高亮）
  let currentPreviewFile: string | null = null;
  // 当前预览模式：source | preview | canvas | image | highlight
  let currentPreviewMode: "source" | "preview" | "canvas" | "image" | "highlight" = "source";

  // 高亮主题：dark | light
  let highlightTheme: "dark" | "light" = "dark";

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
    try {
      await invoke("sandbox_write_file", {
        projectName: activeProject.name,
        relativePath: currentPreviewFile,
        content: filePreviewEditor.value,
      });
      // 同步更新 MD 预览
      if (currentPreviewMode === "preview") updateMdPreview();
      showSaveStatus("已保存");
      // 文件变更后重建感知索引（防抖：仅 Ctrl+S 手动保存触发）
    } catch (e) {
      showSaveStatus("保存失败");
      console.error("保存文件失败:", e);
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
      saveCurrentFile().then(() => {
        const activeProject = sidebar.getActiveChat();
        if (activeProject) checkAndBuildIndex(activeProject.name, true);
      });
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

  // 刷新画布（从编辑器内容重新解析）
  function refreshFileCanvas() {
    if (!fileCanvasSvg || !filePreviewEditor) return;
    if (!fileCanvas) fileCanvas = new FileCanvas();
    const { blocks, edges } = parseMdToBlocks(filePreviewEditor.value);
    fileCanvas.setData(blocks, edges);
  }

  // 画布防抖
  let canvasRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function triggerCanvasRefresh() {
    if (currentPreviewMode !== "canvas") return;
    if (canvasRefreshTimer) clearTimeout(canvasRefreshTimer);
    canvasRefreshTimer = setTimeout(() => refreshFileCanvas(), 1000);
  }

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
  function switchMode(mode: "source" | "preview" | "canvas" | "image" | "highlight") {
    if (mode === currentPreviewMode) return;
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
    if (filePreviewHighlight) filePreviewHighlight.classList.remove("active");

    switch (mode) {
      case "source":
        if (filePreviewEditor) { filePreviewEditor.style.display = ""; filePreviewEditor.focus(); }
        break;
      case "preview":
        updateMdPreview();
        if (filePreviewMd) filePreviewMd.classList.add("active");
        break;
      case "canvas":
        if (fileCanvasSvg) fileCanvasSvg.classList.add("active");
        refreshFileCanvas();
        break;
      case "image":
        if (filePreviewImage) filePreviewImage.classList.add("active");
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
    const mode = tab.dataset.tab as "source" | "preview" | "canvas" | "image" | "highlight";
    if (!mode) return;
    switchMode(mode);
  });

  // 编辑器输入 → 自动保存 + 画布实时刷新
  filePreviewEditor?.addEventListener("input", () => {
    triggerAutoSave();
    triggerCanvasRefresh();
  });

  // 判断是否为 MD 文件
  function isMarkdownFile(filename: string): boolean {
    return /\.(md|markdown)$/i.test(filename);
  }

  // 判断是否为图片文件
  function isImageFile(filename: string): boolean {
    return /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(filename);
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

  // 打开文件预览
  (window as any).openFilePreview = async function(filename: string) {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) return;

    currentPreviewFile = filename;

    // 显示画布文件预览卡片
    showCanvasFileCard(filename);

    // 隐藏画布和悬浮按钮（AI对话卡片保持可见）
    if (canvasContainer) canvasContainer.style.visibility = "hidden";
    if (floatingActions) floatingActions.style.visibility = "hidden";

    // 显示文件预览面板
    if (fileBrowserCard) {
      fileBrowserCard.style.display = "flex";
      fileBrowserCard.classList.add("active");
    }
    if (filePreviewCard) {
      filePreviewCard.style.display = "flex";
      filePreviewCard.classList.add("active");
    }

    // 加载目录树
    await loadFileBrowser(activeProject.name);

    // 高亮当前文件
    highlightCurrentFile();

    // 判断文件类型
    const isMd = isMarkdownFile(filename);
    const isImg = isImageFile(filename);

    // 显示标签：MD → 三段，代码 → 三段（源码/高亮/画布），图片 → 隐藏标签栏
    if (filePreviewTabs) {
      if (isImg) {
        filePreviewTabs.style.display = "none";
      } else {
        filePreviewTabs.style.display = "flex";
        filePreviewTabs.classList.remove("code-only");
      }
    }

    // 显示/隐藏语言标签和主题切换
    if (filePreviewLang) {
      if (isImg || isMd) {
        filePreviewLang.style.display = "none";
      } else {
        filePreviewLang.style.display = "flex";
        if (langLabel) langLabel.textContent = getLangLabel(filename);
      }
    }
    if (filePreviewThemeToggle) {
      filePreviewThemeToggle.style.display = (isImg || isMd) ? "none" : "flex";
    }

    // 加载文件内容
    if (filePreviewTitle) filePreviewTitle.textContent = filename;

    if (isImg) {
      // 图片文件：通过 Base64 读取并显示
      try {
        const base64 = await invoke<string>("sandbox_read_file_base64", {
          projectName: activeProject.name,
          relativePath: filename,
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

    // 文本文件
    try {
      const content = await invoke<string>("sandbox_read_file", {
        projectName: activeProject.name,
        relativePath: filename,
      });
      if (filePreviewEditor) filePreviewEditor.value = content;
      if (isMd) updateMdPreview();
    } catch (e) {
      if (filePreviewEditor) filePreviewEditor.value = `无法读取文件: ${e}`;
    }

    // MD 默认预览模式，代码默认高亮模式
    switchMode(isMd ? "preview" : "highlight");
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
    await loadFileBrowser(activeProject.name);
    highlightCurrentFile();
  });

  // 返回画布
  filePreviewBack?.addEventListener("click", () => {
    if (fileBrowserCard) {
      fileBrowserCard.classList.remove("active");
      fileBrowserCard.style.display = "none";
    }
    if (filePreviewCard) {
      filePreviewCard.classList.remove("active");
      filePreviewCard.style.display = "none";
    }

    // 恢复画布和悬浮按钮
    if (canvasContainer) canvasContainer.style.visibility = "visible";
    if (floatingActions) floatingActions.style.visibility = "visible";

    // 隐藏文件预览卡片
    hideCanvasFileCard();
  });

  // 加载目录树
  async function loadFileBrowser(projectName: string) {
    if (!fileBrowserTree) return;
    fileBrowserTree.innerHTML = "";

    try {
      const entries = await invoke<string>("sandbox_list_dir", {
        projectName,
        relativePath: ".",
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
          // 点击文件，加载预览
          const activeProject = sidebar.getActiveChat();
          if (!activeProject) return;
          currentPreviewFile = item.path || item.name;
          if (filePreviewTitle) filePreviewTitle.textContent = item.name;

          const isMd = isMarkdownFile(item.name);
          const isImg = isImageFile(item.name);

          // 显示标签
          if (filePreviewTabs) {
            if (isImg) {
              filePreviewTabs.style.display = "none";
            } else {
              filePreviewTabs.style.display = "flex";
              if (isMd) {
                filePreviewTabs.classList.remove("code-only");
              } else {
                filePreviewTabs.classList.add("code-only");
              }
            }
          }

          if (isImg) {
            // 图片文件
            try {
              const base64 = await invoke<string>("sandbox_read_file_base64", {
                projectName: activeProject.name,
                relativePath: currentPreviewFile,
              });
              const mime = getImageMimeType(item.name);
              if (filePreviewImage) {
                filePreviewImage.innerHTML = `<img src="data:${mime};base64,${base64}" alt="${item.name}" />`;
              }
            } catch (err) {
              if (filePreviewImage) filePreviewImage.innerHTML = `<div style="color:#fff;text-align:center;">无法读取图片: ${err}</div>`;
            }
            // 高亮当前选中
            fileBrowserTree?.querySelectorAll(".file-tree-item").forEach((el) => el.classList.remove("active"));
            div.classList.add("active");
            switchMode("image");
            return;
          }

          // 文本文件
          try {
            const content = await invoke<string>("sandbox_read_file", {
              projectName: activeProject.name,
              relativePath: currentPreviewFile,
            });
            if (filePreviewEditor) filePreviewEditor.value = content;
            if (isMd) updateMdPreview();
          } catch (err) {
            if (filePreviewEditor) filePreviewEditor.value = `无法读取文件: ${err}`;
          }
          // 更新语言标签
          if (filePreviewLang && !isMd) {
            filePreviewLang.style.display = "flex";
            if (langLabel) langLabel.textContent = getLangLabel(item.name);
          } else if (filePreviewLang) {
            filePreviewLang.style.display = "none";
          }
          if (filePreviewThemeToggle) {
            filePreviewThemeToggle.style.display = isMd ? "none" : "flex";
          }
          // 高亮当前选中
          fileBrowserTree?.querySelectorAll(".file-tree-item").forEach((el) => el.classList.remove("active"));
          div.classList.add("active");
          // MD 默认预览，代码默认高亮
          switchMode(isMd ? "preview" : "highlight");
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
});
