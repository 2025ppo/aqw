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

// ========== 侧边栏初始化：默认创建一个对话 ==========
window.addEventListener("DOMContentLoaded", () => {
  sidebar.createChat();
});

// ========== 监听对话切换 ==========
window.addEventListener("chat-changed", ((e: CustomEvent) => {
  const { chatId } = e.detail;
  console.log(`[app] 切换到对话 ${chatId}`);
  // 后续在此处理对话内容加载
}) as EventListener);
