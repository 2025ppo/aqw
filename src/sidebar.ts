export interface ChatItem {
  id: number;
  name: string;
  hasContent: boolean;
  iconColor: string;
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

  constructor() {
    this.sidebarEl = document.getElementById("sidebar")!;
    this.chatListEl = this.sidebarEl.querySelector(".sidebar-chat-list")!;
    this.createBtn = this.sidebarEl.querySelector(".sidebar-create-btn")!;
    this.toggleBtn = this.sidebarEl.querySelector(".sidebar-toggle-btn")!;

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.createBtn.addEventListener("click", () => this.createChat());
  }

  /** 创建新对话 */
  createChat(): ChatItem | null {
    // 如果上一个对话没有任何操作，不新建
    if (this.chats.length > 0) {
      const lastChat = this.chats[this.chats.length - 1];
      if (!lastChat.hasContent) {
        return null;
      }
    }

    const chat: ChatItem = {
      id: this.nextId++,
      name: `对话 ${this.nextId - 1}`,
      hasContent: false,
      iconColor: ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)],
    };

    this.chats.push(chat);
    this.renderChatList();
    this.setActiveChat(chat.id);
    return chat;
  }

  /** 设置当前活跃对话 */
  setActiveChat(id: number): void {
    this.activeChatId = id;
    this.renderChatList();

    // 触发自定义事件，通知外部
    window.dispatchEvent(
      new CustomEvent("chat-changed", { detail: { chatId: id } })
    );
  }

  /** 重命名对话 */
  renameChat(id: number, newName: string): void {
    const chat = this.chats.find((c) => c.id === id);
    if (chat) {
      chat.name = newName.trim() || `对话 ${id}`;
      this.renderChatList();
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
