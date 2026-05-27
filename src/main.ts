import { getCurrentWindow } from "@tauri-apps/api/window";
import { sidebar } from "./sidebar";

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

  // 文件菜单 - 新建项目
  const menuNewProject = document.getElementById("menu-new-project");
  log("INFO", `menu-new-project found: ${!!menuNewProject}`);
  menuNewProject?.addEventListener("click", (e) => {
    log("INFO", "menu-new-project CLICKED!");
    e.stopPropagation();
    sidebar.createChatWithDialog();
  });

  // 侧边栏初始化：默认创建一个项目
  log("INFO", "creating initial project...");
  sidebar.createChat();
});

// ========== 主题切换 ==========
let isDarkMode = false;
document.getElementById("header-theme")?.addEventListener("click", () => {
  isDarkMode = !isDarkMode;
  log("INFO", `theme toggled: isDarkMode=${isDarkMode}`);

  const root = document.documentElement;
  if (isDarkMode) {
    // 暗色模式
    root.style.setProperty("--bg-near-white", "#1e1e1e");
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
    // 亮色模式（恢复默认）
    root.style.setProperty("--bg-near-white", "#fafafa");
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
});

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

document.addEventListener("DOMContentLoaded", () => {
  const historyDropdownBtn = document.getElementById("chat-history-dropdown");
  const historyPanel = document.getElementById("history-dropdown-panel");
  const historyList = document.getElementById("chat-history-list");
  const historyDropdownList = document.getElementById("history-dropdown-list");
  const chatNewBtn = document.getElementById("chat-new-btn");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
  const chatSendBtn = document.getElementById("chat-send-btn");

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

  // 获取下一个会话名称
  function getNextSessionName(projectId: number): string {
    const sessions = getSessions(projectId);
    let index = sessions.length + 1;
    return `对话 ${index}`;
  }

  // 创建新会话
  function createSession(projectId: number, name?: string): ChatSession {
    const sessions = getSessions(projectId);
    const session: ChatSession = {
      id: nextSessionId++,
      name: name || getNextSessionName(projectId),
      messages: [],
    };
    sessions.push(session);
    return session;
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
        chip.textContent = session.name;
        if (currentSessionId === session.id) {
          chip.classList.add("active");
        }
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
  chatNewBtn?.addEventListener("click", () => {
    const activeProject = sidebar.getActiveChat();
    if (!activeProject) {
      const newProject = sidebar.createChat();
      if (!newProject) return;
      currentProjectId = newProject.id;
    } else {
      currentProjectId = activeProject.id;
    }

    const session = createSession(currentProjectId);
    currentSessionId = session.id;
    renderMessages();
    updateHistoryDisplay();
  });

  // 发送消息
  function sendMessage() {
    const text = chatInput?.value.trim();
    if (!text) return;

    const activeProject = sidebar.getActiveChat();
    if (!activeProject) {
      // 没有活跃项目，自动创建一个
      const newProject = sidebar.createChat();
      if (!newProject) return;
      currentProjectId = newProject.id;
    } else {
      currentProjectId = activeProject.id;
    }

    // 确保有会话
    const sessions = getSessions(currentProjectId);
    if (!currentSessionId || !sessions.find((s) => s.id === currentSessionId)) {
      const session = createSession(currentProjectId);
      currentSessionId = session.id;
    }

    const session = sessions.find((s) => s.id === currentSessionId)!;
    session.messages.push({ role: "user", content: text });

    // 清空输入框
    chatInput.value = "";
    chatInput.style.height = "auto";

    // 显示用户消息
    renderMessages();
    updateHistoryDisplay();

    // 模拟 AI 回复
    setTimeout(() => {
      session.messages.push({
        role: "assistant",
        content: `收到：${text}`,
      });
      renderMessages();
    }, 500);
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
      msgEl.innerHTML = `
        <div class="message-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px">${msg.role === "user" ? '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' : '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}</svg></div>
        <div class="message-content">${escapeHtml(msg.content)}</div>
      `;
      chatMessages.appendChild(msgEl);
    });

    // 滚动到底部
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
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
  window.addEventListener("chat-changed", ((e: CustomEvent) => {
    const { chatId } = e.detail;
    currentProjectId = chatId;

    // 切换到项目的第一个会话
    const sessions = getSessions(chatId);
    currentSessionId = sessions[0]?.id || null;

    renderMessages();
    updateHistoryDisplay();
  }) as EventListener);

  // 初始化显示
  renderMessages();
  updateHistoryDisplay();
});
