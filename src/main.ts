import { getCurrentWindow } from "@tauri-apps/api/window";
import { sidebar } from "./sidebar";

// ========== 窗口控制按钮 ==========
const appWindow = getCurrentWindow();

document
  .getElementById("header-minimize")
  ?.addEventListener("click", () => appWindow.minimize());

document
  .getElementById("header-maximize")
  ?.addEventListener("click", () => appWindow.toggleMaximize());

document
  .getElementById("header-close")
  ?.addEventListener("click", () => appWindow.close());

// ========== 菜单绑定 ==========
window.addEventListener("DOMContentLoaded", () => {
  // 文件菜单 - 新建对话
  document
    .getElementById("menu-new-chat")
    ?.addEventListener("click", () => sidebar.createChatWithDialog());

  // 侧边栏初始化：默认创建一个项目
  sidebar.createChat();
});

// ========== 监听对话切换 ==========
window.addEventListener("chat-changed", ((e: CustomEvent) => {
  const { chatId } = e.detail;
  console.log(`[app] 切换到项目 ${chatId}`);
  // 后续在此处理对话内容加载
}) as EventListener);
