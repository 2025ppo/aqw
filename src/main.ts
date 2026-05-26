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
  // 下拉菜单交互：点击触发按钮切换显隐
  document.querySelectorAll(".menu-dropdown").forEach((dropdown) => {
    const trigger = dropdown.querySelector(".menu-trigger");
    trigger?.addEventListener("click", (e) => {
      e.stopPropagation();
      // 先关闭其他菜单
      document.querySelectorAll(".menu-dropdown.active").forEach((d) => {
        if (d !== dropdown) d.classList.remove("active");
      });
      dropdown.classList.toggle("active");
    });
  });

  // 点击页面其他地方关闭菜单
  document.addEventListener("click", () => {
    document.querySelectorAll(".menu-dropdown.active").forEach((d) => {
      d.classList.remove("active");
    });
  });

  // 文件菜单 - 新建对话
  document
    .getElementById("menu-new-chat")
    ?.addEventListener("click", (e) => {
      e.stopPropagation();
      sidebar.createChatWithDialog();
    });

  // 侧边栏初始化：默认创建一个项目
  sidebar.createChat();
});

// ========== 监听对话切换 ==========
window.addEventListener("chat-changed", ((e: CustomEvent) => {
  const { chatId } = e.detail;
  console.log(`[app] 切换到项目 ${chatId}`);
  // 后续在此处理对话内容加载
}) as EventListener);
