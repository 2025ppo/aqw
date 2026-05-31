// data-analysis.ts
// 数据分析视图 - 嵌入式网页 + AI面板

interface AnalysisRecord {
  id: string;
  timestamp: number;
  query: string;
  htmlContent: string;
  dataSource?: string;
}

class DataAnalysisController {
  private iframe: HTMLIFrameElement | null = null;
  private records: AnalysisRecord[] = [];
  private currentTab: "source" | "history" = "source";
  private active: boolean = false;

  constructor() {
    this.bindEvents();
  }

  private bindEvents(): void {
    window.addEventListener("view-changed", (e: any) => {
      if (e.detail?.view === "data-analysis") {
        this.activate();
      } else {
        this.deactivate();
      }
    });

    // 右侧面板 tab 切换
    const browser = document.getElementById("data-browser");
    if (browser) {
      browser.querySelectorAll(".repo-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const tab = (btn as HTMLElement).dataset.tab as "source" | "history";
          if (tab) this.switchTab(tab);
        });
      });
    }
  }

  private activate(): void {
    this.active = true;
    this.iframe = document.getElementById("data-iframe") as HTMLIFrameElement;
    this.updateList();
  }

  private deactivate(): void {
    this.active = false;
  }

  private switchTab(tab: "source" | "history"): void {
    this.currentTab = tab;
    const browser = document.getElementById("data-browser");
    if (!browser) return;
    browser.querySelectorAll(".repo-tab-btn").forEach(btn => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab);
    });
    this.updateList();
  }

  private updateList(): void {
    const list = document.getElementById("data-source-list");
    if (!list) return;

    if (this.currentTab === "history") {
      list.innerHTML = this.records.map(r => `
        <div class="repo-nav-item" data-id="${r.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <span>${r.query}</span>
        </div>
      `).join("");

      // 点击历史记录重新加载
      list.querySelectorAll(".repo-nav-item").forEach(item => {
        item.addEventListener("click", () => {
          const id = (item as HTMLElement).dataset.id;
          const record = this.records.find(r => r.id === id);
          if (record) this.loadHTML(record.htmlContent);
        });
      });
    } else {
      // 数据源 tab - 空状态，等待AI操作
      list.innerHTML = `<div style="padding:12px;color:#888;font-size:12px;">通过对话指令进行数据分析</div>`;
    }
  }

  // === 公共 API ===

  public loadHTML(htmlContent: string): void {
    if (!this.iframe) this.iframe = document.getElementById("data-iframe") as HTMLIFrameElement;
    if (!this.iframe) return;

    const blob = new Blob([htmlContent], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    this.iframe.src = url;
    this.iframe.style.display = "";
  }

  public addRecord(query: string, htmlContent: string, dataSource?: string): void {
    const record: AnalysisRecord = {
      id: "da-" + Date.now(),
      timestamp: Date.now(),
      query,
      htmlContent,
      dataSource,
    };
    this.records.unshift(record);
    if (this.active && this.currentTab === "history") {
      this.updateList();
    }
  }

  public loadFromPath(_filePath: string): void {
    // 预留：通过 Tauri 读取文件后调用 loadHTML
  }

  public getRecords(): AnalysisRecord[] {
    return [...this.records];
  }
}

// 初始化
const dataController = new DataAnalysisController();

// 暴露全局API
(window as any).__dataAnalysis = {
  loadHTML: (html: string) => dataController.loadHTML(html),
  addRecord: (query: string, html: string, source?: string) => dataController.addRecord(query, html, source),
  loadFromPath: (path: string) => dataController.loadFromPath(path),
  getRecords: () => dataController.getRecords(),
};
