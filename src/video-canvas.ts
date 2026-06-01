// video-canvas.ts
// 视频创作视图 - 轻量卡片网格：播放器 + 导出按钮
// 由专家团流水线驱动的镜头分段 → 生成 → 拼接工作流

interface VideoSegment {
  id: string;
  label: string;         // 镜头名称，如 "镜头1: 开场"
  description: string;   // 镜头描述
  videoUrl: string;      // 视频路径或 blob URL
  duration: number;      // 秒
  thumbnail: string;     // 缩略图（可选）
  status: "pending" | "generating" | "done" | "error";
  error?: string;
}

class VideoCanvasController {
  private segments: VideoSegment[] = [];
  private active: boolean = false;
  private currentPlayingId: string | null = null;

  constructor() {
    this.bindEvents();
  }

  private bindEvents(): void {
    window.addEventListener("view-changed", (e: any) => {
      if (e.detail?.view === "video") {
        this.activate();
      } else {
        this.deactivate();
      }
    });
  }

  private activate(): void {
    this.active = true;
    this.renderCardGrid();
  }

  private deactivate(): void {
    this.active = false;
    this.stopAllPlayers();
    this.clearCardGrid();
  }

  private stopAllPlayers(): void {
    this.currentPlayingId = null;
    const grid = document.getElementById("video-card-grid");
    if (!grid) return;
    grid.querySelectorAll("video").forEach((v) => {
      (v as HTMLVideoElement).pause();
    });
  }

  // === 卡片网格渲染 ===

  private renderCardGrid(): void {
    this.clearCardGrid();
    const grid = document.getElementById("video-card-grid");
    if (!grid) return;

    if (this.segments.length === 0) {
      grid.innerHTML = `
        <div class="video-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;opacity:0.3;">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
          <p>在下方输入框中使用 <code>/</code> 命令开始视频创作</p>
          <p class="video-empty-hint">专家团将为你完成调研、镜头分段和视频生成</p>
        </div>
      `;
      return;
    }

    for (const seg of this.segments) {
      const card = this.buildSegmentCard(seg);
      grid.appendChild(card);
    }
  }

  private buildSegmentCard(seg: VideoSegment): HTMLElement {
    const card = document.createElement("div");
    card.className = `video-segment-card${seg.status === "generating" ? " generating" : ""}`;
    card.dataset.id = seg.id;

    const statusBadge = this.statusBadge(seg.status);
    const playerHtml = seg.videoUrl && seg.status === "done"
      ? `<video class="video-segment-player"
               src="${seg.videoUrl}"
               preload="metadata"
               controls
               controlslist="nodownload"
               data-seg-id="${seg.id}">
         </video>`
      : `<div class="video-segment-placeholder">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <polygon points="23 7 16 12 23 17 23 7"/>
             <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
           </svg>
           ${seg.status === "generating" ? '<span class="video-generating-spinner"></span>' : ''}
         </div>`;

    card.innerHTML = `
      <div class="video-segment-thumb">${playerHtml}</div>
      <div class="video-segment-body">
        <div class="video-segment-header">
          <span class="video-segment-label">${this.escapeHtml(seg.label)}</span>
          ${statusBadge}
        </div>
        <p class="video-segment-desc">${this.escapeHtml(seg.description || "")}</p>
        <div class="video-segment-meta">
          <span class="video-segment-duration">${seg.duration > 0 ? seg.duration + "s" : "—"}</span>
        </div>
        ${seg.status === "done" && seg.videoUrl
          ? `<div class="video-segment-actions">
               <button class="video-action-btn export-btn" data-action="export" data-id="${seg.id}" title="导出此片段">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                   <polyline points="7 10 12 15 17 10"/>
                   <line x1="12" y1="15" x2="12" y2="3"/>
                 </svg>
                 <span>导出</span>
               </button>
             </div>`
          : ""}
        ${seg.status === "generating" ? `<div class="video-progress-bar"><div class="video-progress-fill"></div></div>` : ""}
        ${seg.error ? `<div class="video-segment-error">${this.escapeHtml(seg.error)}</div>` : ""}
      </div>
    `;

    // 绑定导出按钮
    card.querySelector(".export-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.exportSegment(seg.id);
    });

    // 绑定播放器事件（防止多视频同时播放）
    card.querySelector("video")?.addEventListener("play", () => {
      if (this.currentPlayingId && this.currentPlayingId !== seg.id) {
        const prevVideo = document.querySelector(`video[data-seg-id="${this.currentPlayingId}"]`) as HTMLVideoElement;
        if (prevVideo) prevVideo.pause();
      }
      this.currentPlayingId = seg.id;
    });

    return card;
  }

  private statusBadge(status: VideoSegment["status"]): string {
    switch (status) {
      case "pending": return '<span class="video-status-badge pending">等待中</span>';
      case "generating": return '<span class="video-status-badge generating">生成中</span>';
      case "done": return '<span class="video-status-badge done">已完成</span>';
      case "error": return '<span class="video-status-badge error">失败</span>';
    }
  }

  private clearCardGrid(): void {
    const grid = document.getElementById("video-card-grid");
    if (grid) grid.innerHTML = "";
  }

  // === 导出 ===

  private exportSegment(id: string): void {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg || !seg.videoUrl) return;

    // 如果是 blob URL，通过创建 a 标签下载
    const a = document.createElement("a");
    a.href = seg.videoUrl;
    a.download = `${seg.label.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_")}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** 导出完整拼接视频（如果有的话） */
  public exportFinal(): void {
    // 触发全局导出事件，由 main.ts 处理
    window.dispatchEvent(new CustomEvent("video-export-final"));
  }

  // === 公共 API ===

  /** 添加镜头分段 */
  public addSegment(label: string, description?: string): string {
    const id = "vseg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    this.segments.push({
      id,
      label,
      description: description || "",
      videoUrl: "",
      duration: 0,
      thumbnail: "",
      status: "pending",
    });
    if (this.active) this.renderCardGrid();
    return id;
  }

  /** 批量设置镜头分段（替换现有） */
  public setSegments(segments: { label: string; description?: string }[]): string[] {
    this.segments = segments.map((s) => ({
      id: "vseg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      label: s.label,
      description: s.description || "",
      videoUrl: "",
      duration: 0,
      thumbnail: "",
      status: "pending" as const,
    }));
    if (this.active) this.renderCardGrid();
    return this.segments.map((s) => s.id);
  }

  /** 更新镜头状态 */
  public updateSegment(id: string, update: Partial<Pick<VideoSegment, "status" | "videoUrl" | "duration" | "thumbnail" | "error" | "label" | "description">>): void {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return;
    Object.assign(seg, update);
    if (this.active) this.renderCardGrid();
  }

  /** 移除镜头 */
  public removeSegment(id: string): void {
    this.segments = this.segments.filter((s) => s.id !== id);
    if (this.active) this.renderCardGrid();
  }

  /** 清空所有镜头 */
  public clearSegments(): void {
    this.segments = [];
    if (this.active) this.renderCardGrid();
  }

  public getState(): { segments: VideoSegment[] } {
    return { segments: [...this.segments] };
  }

  public getSegments(): VideoSegment[] {
    return [...this.segments];
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /** 静默设置数据（不重新渲染，用于初始化加载） */
  public loadState(segments: VideoSegment[]): void {
    this.segments = segments;
  }
}

// 初始化
const videoController = new VideoCanvasController();

// 暴露全局 API
(window as any).__videoCanvas = {
  addSegment: (label: string, description?: string) => videoController.addSegment(label, description),
  setSegments: (segments: { label: string; description?: string }[]) => videoController.setSegments(segments),
  updateSegment: (id: string, update: any) => videoController.updateSegment(id, update),
  removeSegment: (id: string) => videoController.removeSegment(id),
  clearSegments: () => videoController.clearSegments(),
  getState: () => videoController.getState(),
  getSegments: () => videoController.getSegments(),
  loadState: (segments: any[]) => videoController.loadState(segments),
  exportFinal: () => videoController.exportFinal(),
};
