// video-canvas.ts
// 视频编辑视图 - 卡片布局 + 底部时间轴 overlay

interface VideoNode {
  id: string;
  type: "source" | "effect" | "output";
  label: string;
  src: string;        // 视频缩略图或封面路径
  properties: Record<string, any>;
}

interface VideoConnection {
  id: string;
  fromId: string;
  toId: string;
}

interface TimelineClip {
  id: string;
  track: "image" | "audio";
  startTime: number;
  duration: number;
  label: string;
  color: string;
}

class VideoCanvasController {
  private nodes: VideoNode[] = [];
  private connections: VideoConnection[] = [];
  private clips: TimelineClip[] = [];
  // timeline 渲染到 #video-timeline-wrap，无需独立元素引用
  private active: boolean = false;
  private playheadTime: number = 0;
  private totalDuration: number = 60;

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

    document.getElementById("canvas-video-add-btn")?.addEventListener("click", () => {
      // 等待AI操作或用户输入
    });
  }

  private activate(): void {
    this.active = true;
    this.renderCardGrid();
    this.showTimeline();
    this.updateClipList();
  }

  private deactivate(): void {
    this.active = false;
    this.clearCardGrid();
    this.hideTimeline();
  }

  // 在 #video-card-grid 中渲染卡片网格
  private renderCardGrid(): void {
    this.clearCardGrid();
    const grid = document.getElementById("video-card-grid");
    if (!grid) return;

    const colorMap: Record<string, string> = {
      source: "#4CAF50",
      effect: "#9C27B0",
      output: "#FF9800",
    };

    for (const node of this.nodes) {
      const card = document.createElement("div");
      card.className = "video-card-item";
      card.dataset.id = node.id;

      const thumb = node.src
        ? `<img src="${node.src}" class="video-card-thumb" alt="" />`
        : `<div class="video-card-placeholder" style="background:${colorMap[node.type] || "#555"}">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:32px;height:32px;opacity:0.5;">
               <polygon points="23 7 16 12 23 17 23 7"/>
               <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
             </svg>
           </div>`;

      card.innerHTML = `
        <div class="video-card-thumb-wrap">${thumb}</div>
        <div class="video-card-info">
          <div class="video-card-dot" style="background:${colorMap[node.type] || "#555"}"></div>
          <span class="video-card-label">${node.label}</span>
        </div>
      `;
      grid.appendChild(card);
    }
  }

  private clearCardGrid(): void {
    const grid = document.getElementById("video-card-grid");
    if (grid) grid.innerHTML = "";
  }

  // 时间轴（渲染到 #video-timeline-wrap 容器内）
  private showTimeline(): void {
    const wrap = document.getElementById("video-timeline-wrap");
    if (!wrap) return;
    wrap.style.display = "flex";
    this.renderTimeline();
  }

  private hideTimeline(): void {
    const wrap = document.getElementById("video-timeline-wrap");
    if (wrap) wrap.style.display = "none";
  }

  private renderTimeline(): void {
    const wrap = document.getElementById("video-timeline-wrap");
    if (!wrap) return;

    const pixelsPerSecond = 20;
    const totalWidth = this.totalDuration * pixelsPerSecond;

    wrap.innerHTML = `
      <div style="height:20px;background:#222;border-bottom:1px solid #333;position:relative;overflow:hidden;">
        <div style="position:relative;height:100%;width:${totalWidth}px;">
          ${Array.from({ length: Math.ceil(this.totalDuration / 5) + 1 }, (_, i) =>
            `<span style="position:absolute;left:${i * 5 * pixelsPerSecond}px;top:2px;font-size:9px;color:#888;">${i * 5}s</span>`
          ).join("")}
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;overflow-x:auto;overflow-y:hidden;">
        <div style="display:flex;align-items:center;height:50%;border-bottom:1px solid #333;">
          <span style="width:60px;font-size:10px;color:#888;padding-left:4px;">图像</span>
          <div style="position:relative;flex:1;height:100%;width:${totalWidth}px;">
            ${this.clips.filter(c => c.track === "image").map(c => `
              <div style="position:absolute;left:${c.startTime * pixelsPerSecond}px;width:${c.duration * pixelsPerSecond}px;top:6px;bottom:6px;background:${c.color};border-radius:4px;font-size:10px;color:#fff;padding:2px 4px;overflow:hidden;">${c.label}</div>
            `).join("")}
          </div>
        </div>
        <div style="display:flex;align-items:center;height:50%;">
          <span style="width:60px;font-size:10px;color:#888;padding-left:4px;">音频</span>
          <div style="position:relative;flex:1;height:100%;width:${totalWidth}px;">
            ${this.clips.filter(c => c.track === "audio").map(c => `
              <div style="position:absolute;left:${c.startTime * pixelsPerSecond}px;width:${c.duration * pixelsPerSecond}px;top:6px;bottom:6px;background:${c.color};border-radius:4px;font-size:10px;color:#fff;padding:2px 4px;overflow:hidden;">${c.label}</div>
            `).join("")}
          </div>
        </div>
      </div>
      <div style="position:absolute;top:0;left:${this.playheadTime * pixelsPerSecond + 60}px;width:2px;height:100%;background:red;pointer-events:none;z-index:2;"></div>
    `;
  }

  private updateClipList(): void {
    const list = document.getElementById("video-clip-list");
    if (!list) return;
    const allItems = [...this.nodes, ...this.clips];
    list.innerHTML = allItems.map(item => `
      <div class="repo-nav-item" data-id="${item.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
          <polygon points="23 7 16 12 23 17 23 7"/>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </svg>
        <span>${item.label}</span>
      </div>
    `).join("");
  }

  // === 公共 API ===

  public addNode(type: "source" | "effect" | "output", label: string, src?: string): string {
    const id = "vn-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    this.nodes.push({
      id, type, label,
      src: src || "",
      properties: {},
    });
    if (this.active) { this.renderCardGrid(); this.updateClipList(); }
    return id;
  }

  public connect(fromId: string, toId: string): void {
    const id = "vc-" + Date.now();
    this.connections.push({ id, fromId, toId });
    // 卡片布局不渲染连线，仅记录关系
  }

  public addToTimeline(track: "image" | "audio", label: string, startTime: number, duration?: number): string {
    const id = "clip-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const color = track === "image" ? "#2196F3" : "#FF9800";
    this.clips.push({ id, track, startTime, duration: duration ?? 5, label, color });
    if (startTime + (duration ?? 5) > this.totalDuration) {
      this.totalDuration = startTime + (duration ?? 5) + 10;
    }
    if (this.active) { this.renderTimeline(); this.updateClipList(); }
    return id;
  }

  public cutAt(track: string, atTime: number): void {
    const clip = this.clips.find(c => c.track === track && c.startTime <= atTime && c.startTime + c.duration > atTime);
    if (!clip) return;
    const newDuration = atTime - clip.startTime;
    const remainDuration = clip.duration - newDuration;
    clip.duration = newDuration;
    const newId = "clip-" + Date.now();
    this.clips.push({ id: newId, track: clip.track, startTime: atTime, duration: remainDuration, label: clip.label + "(2)", color: clip.color });
    if (this.active) { this.renderTimeline(); this.updateClipList(); }
  }

  public removeNode(id: string): void {
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.connections = this.connections.filter(c => c.fromId !== id && c.toId !== id);
    if (this.active) {
      this.renderCardGrid();
      this.updateClipList();
    }
  }

  public getState() {
    return { nodes: [...this.nodes], connections: [...this.connections], clips: [...this.clips], playheadTime: this.playheadTime, totalDuration: this.totalDuration };
  }
}

// 初始化
const videoController = new VideoCanvasController();

// 暴露全局API
(window as any).__videoCanvas = {
  addNode: (type: string, label: string) => videoController.addNode(type as any, label),
  connect: (from: string, to: string) => videoController.connect(from, to),
  addToTimeline: (track: "image" | "audio", label: string, at: number, duration?: number) => videoController.addToTimeline(track, label, at, duration),
  cut: (track: string, at: number) => videoController.cutAt(track, at),
  getState: () => videoController.getState(),
};
