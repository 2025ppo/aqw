import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface ChatItem {
  id: number;
  name: string;
  hasContent: boolean;
  iconColor: string;
  workspacePath?: string; // 工作区文件夹路径
}

/** 图标色彩色板（柔和不刺眼） */
const ICON_COLORS = [
  "#5B8DEF", // 柔和蓝
  "#6BCB77", // 柔和绿
  "#E8A87C", // 柔和橙
  "#C38D9E", // 柔和粉
  "#85CDCA", // 柔和青
  "#E27D60", // 柔和珊瑚
  "#41B3A3", // 柔和 teal
  "#D4A5A5", // 柔和玫瑰
  "#9B59B6", // 柔和紫
  "#F7DC6F", // 柔和黄
];

class Sidebar {
  private sidebarEl: HTMLElement;
  private chatListEl: HTMLElement;
  private createBtn: HTMLElement;
  private toggleBtn: HTMLElement;
  private chats: ChatItem[] = [];
  private activeChatId: number | null = null;
  private nextId: number = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.sidebarEl = document.getElementById("sidebar")!;
    this.chatListEl = this.sidebarEl.querySelector(".sidebar-chat-list")!;
    this.createBtn = this.sidebarEl.querySelector(".sidebar-create-btn")!;
    this.toggleBtn = this.sidebarEl.querySelector(".sidebar-toggle-btn")!;

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.createBtn.addEventListener("click", () => this.showProjectDialog());

    // 加载持久化的项目列表
    this.loadProjects();
  }

  /** 从数据库加载项目列表 */
  private async loadProjects(): Promise<void> {
    try {
      const data = await invoke<string>("db_load_projects");
      const projects: ChatItem[] = JSON.parse(data);
      if (projects.length > 0) {
        this.chats = projects;
        // 恢复 nextId
        const maxId = Math.max(...projects.map((p) => p.id), 0);
        this.nextId = maxId + 1;
        this.renderChatList();

        // 加载上次打开的项目
        const lastProjectId = await invoke<string>("db_load_state", { key: "lastProjectId" });
        if (lastProjectId) {
          const lastId = parseInt(lastProjectId, 10);
          const exists = this.chats.find((c) => c.id === lastId);
          if (exists) {
            this.setActiveChat(lastId);
          }
        }
      }
    } catch (e) {
      console.error("[Sidebar] 加载项目失败:", e);
    }
  }

  /** 保存项目列表到数据库 + projects.json（供 Rust 同步读取外部路径） */
  private async saveProjects(): Promise<void> {
    try {
      for (const chat of this.chats) {
        await invoke("db_save_project", {
          id: chat.id,
          name: chat.name,
          iconColor: chat.iconColor,
          workspacePath: chat.workspacePath,
        });
      }
      // 同步写入 projects.json，供 Rust get_project_dir 同步读取
      await invoke("save_projects", {
        projects: JSON.stringify(
          this.chats.map((c) => ({
            id: c.id,
            name: c.name,
            iconColor: c.iconColor,
            workspacePath: c.workspacePath || null,
          }))
        ),
      });
    } catch (e) {
      console.error("[Sidebar] 保存项目失败:", e);
    }
  }

  /** 延迟保存（防抖） */
  private debouncedSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveProjects(), 500);
  }

  /** 获取下一个可用的项目名称（确保不重复） */
  private getNextProjectName(): string {
    let index = 1;
    const existingNames = new Set(this.chats.map((c) => c.name));
    while (existingNames.has(`项目 ${index}`)) {
      index++;
    }
    return `项目 ${index}`;
  }

  /** 创建新项目（可指定名称，自动创建工作区文件夹和 .xt 配置文件） */
  async createChat(customName?: string): Promise<ChatItem | null> {
    const name = customName?.trim() || this.getNextProjectName();

    // 调用 Rust 后端创建工作区文件夹（包含 .xt 配置文件）
    let workspacePath: string | undefined;
    try {
      workspacePath = await invoke<string>("create_workspace", { projectName: name });
      console.log("[Sidebar] 工作区创建成功:", workspacePath);
    } catch (e) {
      console.error("[Sidebar] 创建工作区失败:", e);
      // 即使创建失败也继续创建项目记录
    }

    const chat: ChatItem = {
      id: this.nextId++,
      name,
      hasContent: false,
      iconColor: ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)],
      workspacePath,
    };

    this.chats.push(chat);
    this.renderChatList();
    this.setActiveChat(chat.id);
    this.debouncedSave();
    return chat;
  }

  /** 检查并补全 .xt 配置文件 */
  async ensureXtConfig(projectName: string): Promise<void> {
    try {
      await invoke("ensure_xt_config", { projectName });
      console.log("[Sidebar] .xt 配置文件已确保存在:", projectName);
    } catch (e) {
      console.error("[Sidebar] 补全 .xt 配置文件失败:", e);
    }
  }

  /** 统一项目弹窗：打开项目 / 新建项目 */
  showProjectDialog(): void {
    const defaultName = this.getNextProjectName();

    const dialog = document.createElement("div");
    dialog.className = "new-chat-dialog";
    dialog.innerHTML = `
      <div class="dialog-overlay"></div>
      <div class="dialog-box dialog-box-lg">
        <div class="dialog-title">项目</div>
        <div class="dialog-tabs" id="dialog-project-tabs">
          <button class="dialog-tab active" data-tab="open" type="button">打开项目</button>
          <button class="dialog-tab" data-tab="create" type="button">新建项目</button>
        </div>
        <!-- 打开项目页面 -->
        <div class="dialog-tab-content" id="dialog-tab-open">
          <p class="dialog-hint">选择本地已有的文件夹作为项目打开</p>
          <div class="dialog-actions">
            <button class="dialog-btn dialog-btn-cancel" type="button">取消</button>
            <button class="dialog-btn dialog-btn-confirm" id="dialog-open-btn" type="button">选择文件夹</button>
          </div>
        </div>
        <!-- 新建项目页面 -->
        <div class="dialog-tab-content" id="dialog-tab-create" style="display:none;">
          <div class="dialog-field">
            <label class="dialog-label">项目名称</label>
            <input type="text" class="dialog-input" id="dialog-project-name" placeholder="${defaultName}" value="" spellcheck="false" />
          </div>
          <div class="dialog-field">
            <label class="dialog-label">项目目录</label>
            <input type="text" class="dialog-input" id="dialog-project-dir" value="" spellcheck="false" readonly style="background:#f5f5f5;color:#888;" />
            <div class="dialog-hint">工作区将自动创建在应用数据目录下</div>
          </div>
          <div class="dialog-actions">
            <button class="dialog-btn dialog-btn-cancel" type="button">取消</button>
            <button class="dialog-btn dialog-btn-confirm" type="button">创建</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);

    const closeDialog = () => dialog.remove();
    const nameInput = dialog.querySelector("#dialog-project-name") as HTMLInputElement;
    const dirInput = dialog.querySelector("#dialog-project-dir") as HTMLInputElement;

    // 显示默认工作区路径
    invoke<string>("get_app_data_dir")
      .then((dir) => {
        dirInput.value = `${dir}\\workspaces\\${defaultName}`;
      })
      .catch(() => {
        dirInput.value = "自动分配";
      });

    // 页签切换
    const tabs = dialog.querySelectorAll("#dialog-project-tabs .dialog-tab");
    const tabOpen = dialog.querySelector("#dialog-tab-open") as HTMLElement;
    const tabCreate = dialog.querySelector("#dialog-tab-create") as HTMLElement;

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = (tab as HTMLElement).dataset.tab;
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        if (target === "open") {
          tabOpen.style.display = "block";
          tabCreate.style.display = "none";
        } else {
          tabOpen.style.display = "none";
          tabCreate.style.display = "block";
          nameInput.focus();
        }
      });
    });

    // 打开项目 - 选择文件夹
    dialog.querySelector("#dialog-open-btn")?.addEventListener("click", async () => {
      closeDialog();
      await this.openProject();
    });

    // 新建项目 - 创建
    const confirmCreate = async () => {
      const name = nameInput.value.trim() || defaultName;
      closeDialog();
      await this.createChat(name);
    };

    dialog.querySelectorAll(".dialog-btn-cancel").forEach((btn) => {
      btn.addEventListener("click", closeDialog);
    });
    dialog.querySelector(".dialog-overlay")?.addEventListener("click", closeDialog);

    // 新建页签中的确认按钮
    const createTabConfirm = dialog.querySelector("#dialog-tab-create .dialog-btn-confirm");
    createTabConfirm?.addEventListener("click", confirmCreate);

    nameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") confirmCreate();
      if (ev.key === "Escape") closeDialog();
    });
  }

  /** 通过文件夹选择器打开现有项目 */
  async openProject(): Promise<void> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择项目文件夹",
      });

      if (!selected) return;
      await this.openProjectFromPath(selected as string);
    } catch (e) {
      console.error("[Sidebar] 打开项目失败:", e);
      window.dispatchEvent(
        new CustomEvent("show-error", {
          detail: { message: `打开项目失败: ${e}` },
        })
      );
    }
  }

  /** 从指定文件夹路径打开项目（供拖拽使用） */
  async openProjectFromPath(folderPath: string): Promise<ChatItem | null> {
    try {
      console.log("[Sidebar] 打开项目:", folderPath);

      // 调用 Rust 后端验证并准备项目
      const result = await invoke<string>("open_project_from_path", {
        folderPath,
      });
      const info = JSON.parse(result);
      const projectName: string = info.name;
      const projectPath: string = info.path;

      // 检查是否已经存在相同路径的项目
      const existing = this.chats.find(
        (c) => c.workspacePath === projectPath
      );
      if (existing) {
        this.setActiveChat(existing.id);
        console.log("[Sidebar] 项目已存在，切换至:", existing.name);
        return existing;
      }

      // 创建新的项目记录
      const chat: ChatItem = {
        id: this.nextId++,
        name: projectName,
        hasContent: false,
        iconColor: ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)],
        workspacePath: projectPath,
      };

      this.chats.push(chat);
      this.renderChatList();
      // 必须先保存 projects.json（含 workspacePath），再触发 chat-changed
      // 否则 loadProjectCanvas 读取 get_project_dir 时找不到外部路径
      await this.saveProjects();
      this.setActiveChat(chat.id);

      console.log("[Sidebar] 项目已打开:", projectName);
      return chat;
    } catch (e) {
      console.error("[Sidebar] 打开项目失败:", e);
      window.dispatchEvent(
        new CustomEvent("show-error", {
          detail: { message: `打开项目失败: ${e}` },
        })
      );
      return null;
    }
  }

  /** 设置当前活跃对话 */
  setActiveChat(id: number): void {
    this.activeChatId = id;
    this.renderChatList();

    // 保存最后打开的项目
    this.saveAppState({ lastProjectId: id });

    // 触发自定义事件，通知外部
    window.dispatchEvent(
      new CustomEvent("chat-changed", { detail: { chatId: id } })
    );
  }

  /** 保存应用状态 */
  private async saveAppState(state: Record<string, unknown>): Promise<void> {
    try {
      for (const [key, value] of Object.entries(state)) {
        await invoke("db_save_state", { key, value: String(value) });
      }
    } catch (e) {
      console.error("[Sidebar] 保存状态失败:", e);
    }
  }

  /** 删除项目（仅从列表和数据库移除映射，不删除实际文件夹） */
  async deleteChat(id: number): Promise<void> {
    const index = this.chats.findIndex((c) => c.id === id);
    if (index === -1) return;

    // 从内存列表移除
    this.chats.splice(index, 1);

    // 如果删除的是当前活跃项目，清空活跃状态
    if (this.activeChatId === id) {
      this.activeChatId = null;
      // 通知外部项目已切换为空
      window.dispatchEvent(
        new CustomEvent("chat-changed", { detail: { chatId: null } })
      );
    }

    this.renderChatList();

    // 从数据库删除项目记录（级联删除会话和消息）
    try {
      await invoke("db_delete_project", { id });
    } catch (e) {
      console.error("[Sidebar] 删除项目数据库记录失败:", e);
    }

    // 重新保存 projects.json
    this.debouncedSave();
  }

  /** 重命名对话 */
  renameChat(id: number, newName: string): void {
    const chat = this.chats.find((c) => c.id === id);
    if (chat) {
      chat.name = newName.trim() || `项目 ${id}`;
      this.renderChatList();
      this.debouncedSave();
    }
  }

  /** 标记对话有内容 */
  markHasContent(id: number): void {
    const chat = this.chats.find((c) => c.id === id);
    if (chat) {
      chat.hasContent = true;
    }
  }

  /** 获取当前活跃对话 */
  getActiveChat(): ChatItem | null {
    return this.chats.find((c) => c.id === this.activeChatId) ?? null;
  }

  /** 获取所有对话 */
  getChats(): ChatItem[] {
    return this.chats;
  }

  /** 展开/收起侧边栏 */
  toggle(): void {
    this.sidebarEl.classList.toggle("expanded");
  }

  /** 展开侧边栏 */
  expand(): void {
    this.sidebarEl.classList.add("expanded");
  }

  /** 收起侧边栏 */
  collapse(): void {
    this.sidebarEl.classList.remove("expanded");
  }

  /** 渲染对话列表 */
  private renderChatList(): void {
    // 清空并重建列表
    this.chatListEl.innerHTML = "";

    for (const chat of this.chats) {
      const item = document.createElement("div");
      item.className = `chat-item${
        chat.id === this.activeChatId ? " active" : ""
      }`;

      // 对话图标 (SVG，带独立颜色)
      const icon = document.createElement("span");
      icon.className = "chat-icon";
      icon.style.color = chat.iconColor;
      icon.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      item.appendChild(icon);

      // 对话名称（仅展开时可见）
      const nameEl = document.createElement("span");
      nameEl.className = "chat-name";
      nameEl.textContent = chat.name;
      item.appendChild(nameEl);

      // 点击切换对话
      item.addEventListener("click", (e) => {
        // 如果正在编辑名称，不切换
        if ((e.target as HTMLElement).classList.contains("chat-rename-input")) {
          return;
        }
        this.setActiveChat(chat.id);
        // 自动收起侧边栏
        this.collapse();
      });

      // 删除按钮（展开时显示）
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "chat-delete-btn";
      deleteBtn.title = "删除项目";
      deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const confirmed = confirm(`确定要删除项目「${chat.name}」吗？\n\n注意：仅移除软件中的项目记录，不会删除本地文件夹。`);
        if (confirmed) {
          this.deleteChat(chat.id);
        }
      });
      item.appendChild(deleteBtn);

      // 双击重命名
      item.addEventListener("dblclick", () => {
        const nameEl = item.querySelector(".chat-name") as HTMLElement;
        if (!nameEl) return;

        const currentName = chat.name;
        const input = document.createElement("input");
        input.className = "chat-rename-input";
        input.value = currentName;
        input.spellcheck = false;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        const finishRename = () => {
          this.renameChat(chat.id, input.value);
        };

        input.addEventListener("blur", finishRename);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            input.blur();
          }
          if (ev.key === "Escape") {
            input.value = currentName;
            input.blur();
          }
        });
      });

      this.chatListEl.appendChild(item);
    }
  }
}

// 单例
export const sidebar = new Sidebar();
