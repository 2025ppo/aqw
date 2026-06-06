// ========== 草稿功能核心模块（高性能重构版） ==========

import { invoke } from "@tauri-apps/api/core";

// ========== 数据类型定义 ==========

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  tool: "ballpen" | "fountain" | "marker";
  color: string;
  width: number;
  points: Point[];
  // 缓存包围盒，用于视口裁剪和脏矩形
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface Shape {
  id: string;
  type: "rect" | "circle" | "line" | "arrow";
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  x2?: number;
  y2?: number;
  color: string;
  fill: boolean;
  strokeWidth: number;
}

export interface Note {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  width: number;
  height: number;
}

export interface Screenshot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
}

export interface MiniCanvas {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  background: string;
  // 内嵌绘制内容（在小画布本地坐标系中）
  strokes: Stroke[];
}

export interface DraftLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  strokes: Stroke[];
  shapes: Shape[];
  notes: Note[];
  screenshots: Screenshot[];
  miniCanvases?: MiniCanvas[];
}

export interface DraftData {
  version: number;
  layers: DraftLayer[];
  // 兼容旧格式
  strokes?: Stroke[];
  shapes?: Shape[];
  notes?: Note[];
  screenshots?: Screenshot[];
}

export interface HistoryState {
  id: string;
  timestamp: number;
  action: string;
  data: DraftData;
}

export interface Selection {
  ids: string[];
  type: "stroke" | "shape" | "note" | "screenshot" | "mixed";
}

export type DraftTool =
  | "select"
  | "cursor"
  | "ballpen"
  | "fountain"
  | "marker"
  | "eraser"
  | "rect"
  | "circle"
  | "line"
  | "arrow"
  | "note"
  | "mini-canvas"
  | "screenshot";

// ========== 工具配置 ==========

interface ToolConfig {
  width: number;
  opacity: number;
  smoothing: boolean;
}

const DEFAULT_TOOL_CONFIGS: Record<string, ToolConfig> = {
  ballpen: { width: 2, opacity: 1, smoothing: false },
  fountain: { width: 2, opacity: 1, smoothing: true },
  marker: { width: 12, opacity: 0.4, smoothing: false },
};

// ========== 视口类型 ==========

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

// ========== 工具箱管理 ==========

export class DraftToolbox {
  private el: HTMLElement;
  private tabs: HTMLElement[] = [];
  private panels: HTMLElement[] = [];
  private tools: HTMLElement[] = [];
  private colors: HTMLElement[] = [];
  private colorBar: HTMLElement | null = null;
  private currentTab = "basic";
  public getCurrentTab() { return this.currentTab; }
  private currentTool: DraftTool = "ballpen";
  private currentColor = "#FF5252";
  private onToolChange?: (tool: DraftTool) => void;
  private onColorChange?: (color: string) => void;
  private onEraserModeChange?: (mode: "partial" | "stroke") => void;
  private onClearCanvas?: () => void;
  private eraserMode: "partial" | "stroke" = "partial";
  private eraserMenuEl: HTMLElement | null = null;

  constructor() {
    this.el = document.getElementById("draft-toolbox")!;
    this.colorBar = document.getElementById("draft-color-bar");
    this.bindTabs();
    this.bindTools();
    this.bindColors();
    this.bindEraserMenu();
    this.bindClearCanvas();
  }

  private bindTabs() {
    this.tabs = Array.from(this.el.querySelectorAll(".draft-toolbox-tab"));
    this.panels = Array.from(this.el.querySelectorAll(".draft-toolbox-panel"));

    this.tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = (tab as HTMLElement).dataset.tab!;
        this.switchTab(target);
      });
    });
  }

  private switchTab(tabName: string) {
    this.currentTab = tabName;
    this.tabs.forEach((t) => t.classList.toggle("active", (t as HTMLElement).dataset.tab === tabName));
    this.panels.forEach((p) =>
      p.classList.toggle("active", (p as HTMLElement).dataset.panel === tabName)
    );
    if (tabName !== "brush" && this.colorBar) {
      this.colorBar.classList.remove("visible");
    }
  }

  private bindTools() {
    this.tools = Array.from(this.el.querySelectorAll(".draft-tool"));
    this.tools.forEach((tool) => {
      tool.addEventListener("click", () => {
        const toolName = (tool as HTMLElement).dataset.tool as DraftTool;
        if (!toolName) return;
        this.selectTool(toolName);
      });
    });
  }

  selectTool(tool: DraftTool) {
    this.currentTool = tool;
    this.tools.forEach((t) =>
      t.classList.toggle("active", (t as HTMLElement).dataset.tool === tool)
    );
    if (this.colorBar) {
      if (tool === "marker") {
        this.colorBar.classList.toggle("visible");
      } else {
        this.colorBar.classList.remove("visible");
      }
    }
    this.onToolChange?.(tool);
  }

  private bindColors() {
    this.colors = Array.from(this.el.querySelectorAll(".draft-color"));
    this.colors.forEach((color) => {
      color.addEventListener("click", () => {
        const c = (color as HTMLElement).dataset.color!;
        this.selectColor(c);
      });
    });
  }

  selectColor(color: string) {
    this.currentColor = color;
    this.colors.forEach((c) =>
      c.classList.toggle("active", (c as HTMLElement).dataset.color === color)
    );
    this.onColorChange?.(color);
  }

  getCurrentTool(): DraftTool {
    return this.currentTool;
  }

  getCurrentColor(): string {
    return this.currentColor;
  }

  setOnToolChange(cb: (tool: DraftTool) => void) {
    this.onToolChange = cb;
  }

  setOnColorChange(cb: (color: string) => void) {
    this.onColorChange = cb;
  }

  setOnEraserModeChange(cb: (mode: "partial" | "stroke") => void) {
    this.onEraserModeChange = cb;
  }

  setOnClearCanvas(cb: () => void) {
    this.onClearCanvas = cb;
  }

  getEraserMode(): "partial" | "stroke" {
    return this.eraserMode;
  }

  // 橡皮擦上拉菜单：选择 partial / stroke 模式
  private bindEraserMenu() {
    const caret = document.getElementById("draft-eraser-caret");
    if (!caret) return;
    caret.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleEraserMenu();
    });
  }

  private toggleEraserMenu() {
    if (this.eraserMenuEl) {
      this.hideEraserMenu();
      return;
    }
    const caret = document.getElementById("draft-eraser-caret");
    if (!caret) return;
    const rect = caret.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "draft-eraser-menu";
    menu.style.left = rect.left + "px";
    // 上拉：底部对齐按钮顶部
    menu.style.bottom = (window.innerHeight - rect.top + 6) + "px";
    const items: { mode: "partial" | "stroke"; label: string; desc: string }[] = [
      { mode: "partial", label: "部分擦除", desc: "仅擦除路径穿过的部分" },
      { mode: "stroke", label: "整条擦除", desc: "碰一下删除整条笔画" },
    ];
    items.forEach((it) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "draft-eraser-menu-item";
      if (this.eraserMode === it.mode) item.classList.add("active");
      item.innerHTML = `<span class="draft-eraser-menu-label">${it.label}</span><span class="draft-eraser-menu-desc">${it.desc}</span>`;
      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.setEraserMode(it.mode);
        this.hideEraserMenu();
      });
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    this.eraserMenuEl = menu;
    const onDocClick = () => {
      this.hideEraserMenu();
      window.removeEventListener("mousedown", onDocClick, true);
    };
    setTimeout(() => window.addEventListener("mousedown", onDocClick, true), 0);
  }

  private hideEraserMenu() {
    if (this.eraserMenuEl) {
      this.eraserMenuEl.remove();
      this.eraserMenuEl = null;
    }
  }

  private setEraserMode(mode: "partial" | "stroke") {
    this.eraserMode = mode;
    this.onEraserModeChange?.(mode);
    // 选中橡皮擦同时切换为 eraser 工具
    this.selectTool("eraser");
    this.onToolChange?.("eraser");
  }

  // 清空画布按钮（与确认对话框）
  private bindClearCanvas() {
    const btn = document.getElementById("draft-clear-canvas");
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.confirm("确认清空当前画布上的所有内容吗？此操作可通过 Ctrl+Z 撤销。")) {
        this.onClearCanvas?.();
      }
    });
  }

  show() {
    this.el.classList.add("active");
  }

  hide() {
    this.el.classList.remove("active");
  }
}

// ========== 高性能草稿画布 ==========

export class DraftCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // 双缓冲：离屏Canvas缓存已完成的绘制内容
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;
  private offscreenDirty = true;

  // 数据模型
  private layers: DraftLayer[] = [];
  private activeLayerId = "layer_1";

  // 兼容旧数据的扁平存储
  // @ts-ignore 保留以兼容旧数据序列化
  private data: DraftData = { version: 2, layers: [] };

  private currentTool: DraftTool = "ballpen";
  private currentColor = "#FF5252";
  private toolConfigs: Record<string, ToolConfig> = { ...DEFAULT_TOOL_CONFIGS };

  // 绘制状态
  private isDrawing = false;
  private currentStroke: Stroke | null = null;
  private currentShape: Shape | null = null;
  private shapeStart = { x: 0, y: 0 };

  // 选区
  private selection: Selection = { ids: [], type: "mixed" };
  private isSelecting = false;
  private selectStart = { x: 0, y: 0 };
  private selectRect: { x: number; y: number; w: number; h: number } | null = null;

  // 视口
  private viewport: Viewport = { x: 0, y: 0, scale: 1 };
  private canvasSize = { width: 0, height: 0 };

  // DOM
  private notesContainer: HTMLElement;
  private selectionOverlay: HTMLElement | null = null;

  // 性能优化
  // @ts-ignore 预留字段
  private renderRafId: number | null = null;
  private pendingRender = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // 历史记录
  private history: HistoryState[] = [];
  private historyIndex = -1;
  private maxHistory = 50;
  private isUndoing = false;

  // 项目
  private projectName: string = "";
  private isActive = false;

  // 拖拽优化
  private dragRafId: number | null = null;
  private dragPending = false;
  // @ts-ignore 预留字段
  private dragTarget: { el: HTMLElement; data: Note | Screenshot; offsetX: number; offsetY: number } | null = null;

  // 右键平移与滚轮缩放回调（由 main.ts 注入调用主画布）
  private panRequest?: (dx: number, dy: number) => void;
  private zoomRequest?: (clientX: number, clientY: number, factor: number) => void;
  private isPanning = false;
  private panLast = { x: 0, y: 0 };

  // 橡皮擦模式：partial=部分擦除；stroke=整条擦除
  private eraserMode: "partial" | "stroke" = "partial";

  // 钢笔锥点
  private penAnchors: Point[] = [];
  private penPreview: Point | null = null;

  constructor() {
    this.canvas = document.getElementById("draft-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d", { alpha: true })!;
    this.notesContainer = document.getElementById("canvas-container")!;

    // 初始化离屏Canvas
    this.offscreenCanvas = document.createElement("canvas");
    this.offscreenCtx = this.offscreenCanvas.getContext("2d", { alpha: true })!;

    // 初始化默认图层
    this.layers = [{
      id: "layer_1",
      name: "图层 1",
      visible: true,
      locked: false,
      strokes: [],
      shapes: [],
      notes: [],
      screenshots: [],
      miniCanvases: [],
    }];

    this.resize();
    this.bindEvents();
    this.bindKeyboard();
    this.createSelectionOverlay();
  }

  // ========== 初始化 ==========

  private createSelectionOverlay() {
    this.selectionOverlay = document.createElement("div");
    this.selectionOverlay.className = "draft-selection-overlay";
    this.selectionOverlay.style.display = "none";
    this.notesContainer.appendChild(this.selectionOverlay);
  }

  // ========== 尺寸与视口 ==========

  private resize() {
    const rect = this.notesContainer.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;

    this.canvasSize.width = width;
    this.canvasSize.height = height;

    // 重置变换后再按 DPR 缩放，避免多次 resize 后缩放叠加
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.offscreenCtx.setTransform(1, 0, 0, 1, 0, 0);

    // 设置主 Canvas 尺寸（考虑 DPR）
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + "px";
    this.canvas.style.height = height + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 同步离屏Canvas
    this.offscreenCanvas.width = width * dpr;
    this.offscreenCanvas.height = height * dpr;
    this.offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.offscreenDirty = true;
    this.scheduleRender();
  }

  setViewport(viewport: Viewport) {
    this.viewport = viewport;
    this.offscreenDirty = true;
    this.scheduleRender();
    // 同步所有 DOM 元素位置，跟随主画布缩放/平移
    this.updateAllElementTransforms();
  }

  /**
   * 同步所有草稿 DOM 元素（便签/截图/小画布）位置与尺寸到当前 viewport
   */
  private updateAllElementTransforms() {
    for (const layer of this.layers) {
      for (const note of layer.notes) {
        const el = document.getElementById(note.id);
        if (el) this.updateNoteTransform(el, note.x, note.y);
      }
      for (const sc of layer.screenshots) {
        const el = document.getElementById(sc.id);
        if (el) {
          this.updateScreenshotTransform(el, sc.x, sc.y);
          el.style.width = sc.w * this.viewport.scale + "px";
          el.style.height = sc.h * this.viewport.scale + "px";
        }
      }
      const minis = layer.miniCanvases || [];
      for (const mc of minis) {
        const el = document.getElementById(mc.id);
        if (el) {
          this.updateMiniCanvasTransform(el, mc);
        }
      }
    }
    if (this.selectionOverlay) this.updateSelectionOverlay();
  }

  // ========== 事件绑定 ==========

  private bindEvents() {
    // 使用 passive: false 防止滚动默认行为
    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e), { passive: false });
    this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e), { passive: false });
    window.addEventListener("mouseup", (e) => this.onMouseUp(e));

    // 双击结束钢笔路径
    this.canvas.addEventListener("dblclick", (e) => this.onDblClick(e));

    // 拦截右键菜单（右键用于平移画布）
    this.canvas.addEventListener("contextmenu", (e) => {
      if (this.isActive) e.preventDefault();
    });

    // 滚轮缩放：转发给主画布同步变换
    this.canvas.addEventListener("wheel", (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoomRequest?.(e.clientX, e.clientY, factor);
    }, { passive: false });

    // Resize防抖
    let resizeTimer: ReturnType<typeof setTimeout>;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.resize(), 100);
    });
  }

  private bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (!this.isActive) return;

      // 忽略输入框内的快捷键
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      // 工具快捷键
      const toolMap: Record<string, DraftTool> = {
        v: "select",
        b: "ballpen",
        p: "fountain",
        m: "marker",
        e: "eraser",
        r: "rect",
        o: "circle",
        l: "line",
        a: "arrow",
        n: "note",
      };

      if (toolMap[e.key.toLowerCase()]) {
        e.preventDefault();
        this.setTool(toolMap[e.key.toLowerCase()]);
        // 同步更新工具箱UI
        window.dispatchEvent(new CustomEvent("draft-tool-changed", {
          detail: { tool: toolMap[e.key.toLowerCase()] },
        }));
        return;
      }

      // 撤销/重做
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) {
            this.redo();
          } else {
            this.undo();
          }
          return;
        }
        if (e.key.toLowerCase() === "a") {
          e.preventDefault();
          this.selectAll();
          return;
        }
      }

      // 删除选中
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.selection.ids.length > 0) {
          e.preventDefault();
          this.deleteSelection();
        }
        return;
      }

      // ESC：取消钢笔未提交路径
      if (e.key === "Escape") {
        if (this.currentTool === "fountain" && this.penAnchors.length > 0) {
          e.preventDefault();
          this.cancelPenStroke();
          return;
        }
      }

      // Enter：提交钢笔路径
      if (e.key === "Enter") {
        if (this.currentTool === "fountain" && this.penAnchors.length >= 2) {
          e.preventDefault();
          this.commitPenStroke();
          return;
        }
      }

      // 笔刷大小调整
      if (e.key === "[") {
        e.preventDefault();
        this.adjustBrushSize(-1);
        return;
      }
      if (e.key === "]") {
        e.preventDefault();
        this.adjustBrushSize(1);
        return;
      }
    });
  }

  // ========== 鼠标事件处理 ==========

  private onMouseDown(e: MouseEvent) {
    if (!this.isActive) return;

    // 右键中键：平移画布
    if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      this.isPanning = true;
      this.panLast = { x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button !== 0) return;
    e.preventDefault();

    const pos = this.getCanvasPos(e);
    const worldPos = this.screenToWorld(pos.x, pos.y);

    switch (this.currentTool) {
      case "select":
        this.startSelection(worldPos.x, worldPos.y);
        break;
      case "ballpen":
      case "marker":
        this.saveHistory("绘制笔画");
        this.startStroke(worldPos.x, worldPos.y);
        break;
      case "fountain":
        // 钢笔：点击放锥点，双击结束
        this.handlePenAnchor(worldPos.x, worldPos.y);
        break;
      case "eraser":
        this.saveHistory("橡皮擦");
        this.startErase(worldPos.x, worldPos.y);
        break;
      case "rect":
      case "circle":
      case "line":
      case "arrow":
        this.saveHistory("绘制形状");
        this.startShape(worldPos.x, worldPos.y);
        break;
      case "note":
        this.saveHistory("添加便签");
        this.createNote(worldPos.x, worldPos.y);
        // 创建后自动切回选择工具，避免连续创建
        this.setTool("select");
        window.dispatchEvent(new CustomEvent("draft-tool-changed", { detail: { tool: "select" } }));
        break;
      case "mini-canvas":
        this.saveHistory("添加画布");
        this.createMiniCanvas(worldPos.x, worldPos.y);
        this.setTool("select");
        window.dispatchEvent(new CustomEvent("draft-tool-changed", { detail: { tool: "select" } }));
        break;
      case "screenshot":
        this.saveHistory("截图");
        this.startScreenshot(worldPos.x, worldPos.y);
        break;
    }
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isActive) return;

    // 右键平移中
    if (this.isPanning) {
      const dx = e.clientX - this.panLast.x;
      const dy = e.clientY - this.panLast.y;
      this.panLast = { x: e.clientX, y: e.clientY };
      this.panRequest?.(dx, dy);
      return;
    }

    const pos = this.getCanvasPos(e);
    const worldPos = this.screenToWorld(pos.x, pos.y);

    // 钢笔预览
    if (this.currentTool === "fountain" && this.penAnchors.length > 0) {
      this.penPreview = { x: worldPos.x, y: worldPos.y };
      this.scheduleRender();
      return;
    }

    if (this.isSelecting && this.selectRect) {
      this.updateSelection(worldPos.x, worldPos.y);
      return;
    }

    if (this.isDrawing && this.currentStroke) {
      const last = this.currentStroke.points[this.currentStroke.points.length - 1];
      const dx = worldPos.x - last.x;
      const dy = worldPos.y - last.y;
      // 距离阈值节流：避免快速移动时点数爆炸（世界坐标 0.5px，随缩放适配）
      const minDist = 0.5 / this.viewport.scale;
      if (dx * dx + dy * dy < minDist * minDist) return;
      this.currentStroke.points.push({ x: worldPos.x, y: worldPos.y });
      this.updateStrokeBBox(this.currentStroke);
      this.scheduleRender();
      return;
    }

    if (this.isDrawing && this.currentShape) {
      this.updateShape(worldPos.x, worldPos.y);
      this.scheduleRender();
      return;
    }

    if (this.isDrawing && this.currentTool === "eraser") {
      this.eraseAt(worldPos.x, worldPos.y);
      return;
    }

    if (this.isDrawing && this.currentTool === "screenshot" && this.screenshotRect) {
      this.updateScreenshot(worldPos.x, worldPos.y);
      return;
    }
  }

  private onMouseUp(e?: MouseEvent) {
    // 结束右键平移
    if (this.isPanning) {
      this.isPanning = false;
      this.updateCursor();
      // 右键上司其他动作不发生
      if (e && e.button === 2) return;
    }

    if (this.isSelecting) {
      this.finishSelection();
      return;
    }

    if (this.isDrawing) {
      this.finishDrawing();
    }
  }

  // ========== 钢笔工具锥点逻辑 ==========

  private onDblClick(e: MouseEvent) {
    if (!this.isActive) return;
    if (this.currentTool === "fountain" && this.penAnchors.length >= 2) {
      e.preventDefault();
      this.commitPenStroke();
    }
  }

  private handlePenAnchor(x: number, y: number) {
    if (this.penAnchors.length === 0) {
      this.saveHistory("钢笔路径");
    }
    this.penAnchors.push({ x, y });
    this.penPreview = { x, y };
    this.scheduleRender();
  }

  private commitPenStroke() {
    // 去除尾部“双击重复点”：双击事件会在同位置多调一次 mousedown
    while (this.penAnchors.length >= 2) {
      const a = this.penAnchors[this.penAnchors.length - 1];
      const b = this.penAnchors[this.penAnchors.length - 2];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1) {
        this.penAnchors.pop();
      } else break;
    }
    if (this.penAnchors.length < 2) {
      this.penAnchors = [];
      this.penPreview = null;
      this.scheduleRender();
      return;
    }
    const config = this.toolConfigs.fountain || DEFAULT_TOOL_CONFIGS.fountain;
    const pts = [...this.penAnchors];
    const stroke: Stroke = {
      id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tool: "fountain",
      color: this.currentColor,
      width: config.width,
      points: pts,
      bbox: this.bboxFromPoints(pts),
    };
    this.getActiveLayer().strokes.push(stroke);
    this.penAnchors = [];
    this.penPreview = null;
    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }

  private cancelPenStroke() {
    if (this.penAnchors.length > 0) {
      this.penAnchors = [];
      this.penPreview = null;
      this.scheduleRender();
    }
  }

  private bboxFromPoints(pts: Point[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  // ========== 坐标转换 ==========

  private getCanvasPos(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private screenToWorld(sx: number, sy: number): Point {
    return {
      x: (sx - this.viewport.x) / this.viewport.scale,
      y: (sy - this.viewport.y) / this.viewport.scale,
    };
  }

  private worldToScreen(wx: number, wy: number): Point {
    return {
      x: wx * this.viewport.scale + this.viewport.x,
      y: wy * this.viewport.scale + this.viewport.y,
    };
  }

  public convertWorldToScreen(wx: number, wy: number) { return this.worldToScreen(wx, wy); }

  // ========== 选区工具 ==========

  private startSelection(x: number, y: number) {
    this.isSelecting = true;
    this.selectStart = { x, y };
    this.selectRect = { x, y, w: 0, h: 0 };
    this.selection = { ids: [], type: "mixed" };
    this.updateSelectionOverlay();
  }

  private updateSelection(x: number, y: number) {
    if (!this.selectRect) return;
    this.selectRect.x = Math.min(this.selectStart.x, x);
    this.selectRect.y = Math.min(this.selectStart.y, y);
    this.selectRect.w = Math.abs(x - this.selectStart.x);
    this.selectRect.h = Math.abs(y - this.selectStart.y);
    this.updateSelectionOverlay();
    this.scheduleRender();
  }

  private finishSelection() {
    this.isSelecting = false;
    if (!this.selectRect || this.selectRect.w < 5 || this.selectRect.h < 5) {
      this.selectRect = null;
      this.updateSelectionOverlay();
      this.scheduleRender();
      return;
    }

    // 检测框选范围内的元素
    const selectedIds: string[] = [];
    const rect = this.selectRect;

    for (const layer of this.layers) {
      if (!layer.visible) continue;

      for (const stroke of layer.strokes) {
        if (this.strokeIntersectsRect(stroke, rect)) {
          selectedIds.push(stroke.id);
        }
      }
      for (const shape of layer.shapes) {
        if (this.shapeIntersectsRect(shape, rect)) {
          selectedIds.push(shape.id);
        }
      }
      for (const note of layer.notes) {
        if (this.noteIntersectsRect(note, rect)) {
          selectedIds.push(note.id);
        }
      }
      for (const sc of layer.screenshots) {
        if (this.screenshotIntersectsRect(sc, rect)) {
          selectedIds.push(sc.id);
        }
      }
    }

    this.selection = { ids: selectedIds, type: "mixed" };
    this.selectRect = null;
    this.updateSelectionOverlay();
    this.scheduleRender();

    // 通知选区变化
    window.dispatchEvent(new CustomEvent("draft-selection-changed", {
      detail: { selection: this.selection },
    }));
  }

  private selectAll() {
    const ids: string[] = [];
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      layer.strokes.forEach((s) => ids.push(s.id));
      layer.shapes.forEach((s) => ids.push(s.id));
      layer.notes.forEach((n) => ids.push(n.id));
      layer.screenshots.forEach((s) => ids.push(s.id));
    }
    this.selection = { ids, type: "mixed" };
    this.scheduleRender();
    window.dispatchEvent(new CustomEvent("draft-selection-changed", {
      detail: { selection: this.selection },
    }));
  }

  private deleteSelection() {
    if (this.selection.ids.length === 0) return;
    this.saveHistory("删除选中");

    const idSet = new Set(this.selection.ids);

    for (const layer of this.layers) {
      layer.strokes = layer.strokes.filter((s) => !idSet.has(s.id));
      layer.shapes = layer.shapes.filter((s) => !idSet.has(s.id));
      layer.notes = layer.notes.filter((n) => !idSet.has(n.id));
      layer.screenshots = layer.screenshots.filter((s) => !idSet.has(s.id));
    }

    // 移除DOM元素
    for (const id of this.selection.ids) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }

    this.selection = { ids: [], type: "mixed" };
    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }

  // 碰撞检测
  private strokeIntersectsRect(stroke: Stroke, rect: { x: number; y: number; w: number; h: number }): boolean {
    for (const p of stroke.points) {
      if (p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
        return true;
      }
    }
    return false;
  }

  private shapeIntersectsRect(shape: Shape, rect: { x: number; y: number; w: number; h: number }): boolean {
    if (shape.type === "rect" && shape.w !== undefined && shape.h !== undefined) {
      return !(shape.x + shape.w < rect.x || shape.x > rect.x + rect.w ||
               shape.y + shape.h < rect.y || shape.y > rect.y + rect.h);
    }
    if (shape.type === "circle" && shape.r !== undefined) {
      const closestX = Math.max(rect.x, Math.min(shape.x, rect.x + rect.w));
      const closestY = Math.max(rect.y, Math.min(shape.y, rect.y + rect.h));
      const dx = shape.x - closestX;
      const dy = shape.y - closestY;
      return dx * dx + dy * dy <= shape.r * shape.r;
    }
    if ((shape.type === "line" || shape.type === "arrow") && shape.x2 !== undefined && shape.y2 !== undefined) {
      // 简化为端点检测
      return (shape.x >= rect.x && shape.x <= rect.x + rect.w && shape.y >= rect.y && shape.y <= rect.y + rect.h) ||
             (shape.x2 >= rect.x && shape.x2 <= rect.x + rect.w && shape.y2 >= rect.y && shape.y2 <= rect.y + rect.h);
    }
    return false;
  }

  private noteIntersectsRect(note: Note, rect: { x: number; y: number; w: number; h: number }): boolean {
    return !(note.x + note.width < rect.x || note.x > rect.x + rect.w ||
             note.y + note.height < rect.y || note.y > rect.y + rect.h);
  }

  private screenshotIntersectsRect(sc: Screenshot, rect: { x: number; y: number; w: number; h: number }): boolean {
    return !(sc.x + sc.w < rect.x || sc.x > rect.x + rect.w ||
             sc.y + sc.h < rect.y || sc.y > rect.y + rect.h);
  }

  private updateSelectionOverlay() {
    if (!this.selectionOverlay) return;

    if (this.selectRect && this.selectRect.w > 0 && this.selectRect.h > 0) {
      const s1 = this.worldToScreen(this.selectRect.x, this.selectRect.y);
      const s2 = this.worldToScreen(this.selectRect.x + this.selectRect.w, this.selectRect.y + this.selectRect.h);
      this.selectionOverlay.style.display = "block";
      this.selectionOverlay.style.left = Math.min(s1.x, s2.x) + "px";
      this.selectionOverlay.style.top = Math.min(s1.y, s2.y) + "px";
      this.selectionOverlay.style.width = Math.abs(s2.x - s1.x) + "px";
      this.selectionOverlay.style.height = Math.abs(s2.y - s1.y) + "px";
    } else {
      this.selectionOverlay.style.display = "none";
    }
  }

  // ========== 画笔工具 ==========

  private startStroke(x: number, y: number) {
    this.isDrawing = true;
    const config = this.toolConfigs[this.currentTool] || DEFAULT_TOOL_CONFIGS.ballpen;
    this.currentStroke = {
      id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tool: this.currentTool as "ballpen" | "fountain" | "marker",
      color: this.currentColor,
      width: config.width,
      points: [{ x, y }],
      bbox: { minX: x, minY: y, maxX: x, maxY: y },
    };
  }

  private updateStrokeBBox(stroke: Stroke) {
    if (!stroke.bbox || stroke.points.length === 0) return;
    const last = stroke.points[stroke.points.length - 1];
    stroke.bbox.minX = Math.min(stroke.bbox.minX, last.x);
    stroke.bbox.minY = Math.min(stroke.bbox.minY, last.y);
    stroke.bbox.maxX = Math.max(stroke.bbox.maxX, last.x);
    stroke.bbox.maxY = Math.max(stroke.bbox.maxY, last.y);
  }

  // ========== 橡皮擦 ==========

  private startErase(x: number, y: number) {
    this.isDrawing = true;
    this.eraseAt(x, y);
  }

  private eraseAt(x: number, y: number) {
    if (this.eraserMode === "stroke") {
      this.eraseWholeStrokeAt(x, y);
    } else {
      this.erasePartialAt(x, y);
    }
  }

  // 整条擦除：只要某点在半径内，整条 stroke 删除
  private eraseWholeStrokeAt(x: number, y: number) {
    const eraseRadius = 12 / this.viewport.scale;
    const r2 = eraseRadius * eraseRadius;
    const toRemove: { layerIndex: number; strokeIndex: number }[] = [];

    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      if (!layer.visible || layer.locked) continue;

      layer.strokes.forEach((stroke, si) => {
        for (const p of stroke.points) {
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy < r2) {
            toRemove.push({ layerIndex: li, strokeIndex: si });
            break;
          }
        }
      });
    }

    if (toRemove.length > 0) {
      const grouped = new Map<number, number[]>();
      for (const item of toRemove) {
        if (!grouped.has(item.layerIndex)) grouped.set(item.layerIndex, []);
        grouped.get(item.layerIndex)!.push(item.strokeIndex);
      }
      for (const [li, indices] of grouped) {
        const unique = [...new Set(indices)].sort((a, b) => b - a);
        for (const idx of unique) {
          this.layers[li].strokes.splice(idx, 1);
        }
      }
      this.offscreenDirty = true;
      this.scheduleRender();
      this.debouncedSave();
    }
  }

  // 部分擦除：在交叉处切断 stroke，保留两侧未动部分
  private erasePartialAt(x: number, y: number) {
    const eraseRadius = 12 / this.viewport.scale;
    const r2 = eraseRadius * eraseRadius;
    let changed = false;

    for (let li = 0; li < this.layers.length; li++) {
      const layer = this.layers[li];
      if (!layer.visible || layer.locked) continue;

      const newStrokes: Stroke[] = [];
      for (const stroke of layer.strokes) {
        // 快跳：包围盒不相交，原样保留
        if (stroke.bbox) {
          const b = stroke.bbox;
          if (
            x + eraseRadius < b.minX ||
            x - eraseRadius > b.maxX ||
            y + eraseRadius < b.minY ||
            y - eraseRadius > b.maxY
          ) {
            newStrokes.push(stroke);
            continue;
          }
        }
        const segs: Point[][] = [];
        let cur: Point[] = [];
        let hit = false;
        for (const p of stroke.points) {
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy < r2) {
            hit = true;
            if (cur.length >= 2) segs.push(cur);
            cur = [];
          } else {
            cur.push(p);
          }
        }
        if (cur.length >= 2) segs.push(cur);
        if (!hit) {
          newStrokes.push(stroke);
          continue;
        }
        changed = true;
        // 生成子 stroke
        segs.forEach((pts, i) => {
          newStrokes.push({
            id: `${stroke.id}_${i}_${Date.now().toString(36)}`,
            tool: stroke.tool,
            color: stroke.color,
            width: stroke.width,
            points: pts,
            bbox: this.bboxFromPoints(pts),
          });
        });
      }
      layer.strokes = newStrokes;
    }

    if (changed) {
      this.offscreenDirty = true;
      this.scheduleRender();
      this.debouncedSave();
    }
  }

  // ========== 形状工具 ==========

  private startShape(x: number, y: number) {
    this.isDrawing = true;
    this.shapeStart = { x, y };
    this.currentShape = {
      id: `shape_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: this.currentTool as "rect" | "circle" | "line" | "arrow",
      x,
      y,
      color: this.currentColor,
      fill: false,
      strokeWidth: 2,
    };
  }

  private updateShape(x: number, y: number) {
    if (!this.currentShape) return;
    const s = this.currentShape;
    if (s.type === "rect") {
      s.x = Math.min(this.shapeStart.x, x);
      s.y = Math.min(this.shapeStart.y, y);
      s.w = Math.abs(x - this.shapeStart.x);
      s.h = Math.abs(y - this.shapeStart.y);
    } else if (s.type === "circle") {
      s.x = this.shapeStart.x;
      s.y = this.shapeStart.y;
      s.r = Math.sqrt(
        Math.pow(x - this.shapeStart.x, 2) + Math.pow(y - this.shapeStart.y, 2)
      );
    } else if (s.type === "line" || s.type === "arrow") {
      s.x = this.shapeStart.x;
      s.y = this.shapeStart.y;
      s.x2 = x;
      s.y2 = y;
    }
  }

  // ========== 便签（高性能拖拽版）==========

  private createNote(x: number, y: number) {
    const note: Note = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      x,
      y,
      text: "",
      color: "#fff9c4",
      width: 160,
      height: 100,
    };

    const layer = this.getActiveLayer();
    layer.notes.push(note);
    this.renderNoteElement(note);
    this.debouncedSave();
  }

  private renderNoteElement(note: Note) {
    const el = document.createElement("div");
    el.className = "draft-note";
    el.id = note.id;
    // 默认不可编辑，点击进入编辑态，按住拖动为移动
    el.contentEditable = "false";
    el.textContent = note.text || "点击编辑...";
    if (!note.text) el.classList.add("placeholder");

    this.updateNoteTransform(el, note.x, note.y);
    el.style.width = note.width + "px";
    el.style.height = note.height + "px";
    el.style.background = note.color;

    // 失焦退出编辑态
    el.addEventListener("blur", () => {
      if (el.classList.contains("editing")) {
        el.contentEditable = "false";
        el.classList.remove("editing");
        note.text = el.textContent || "";
        if (!note.text) {
          el.textContent = "点击编辑...";
          el.classList.add("placeholder");
        }
        this.debouncedSave();
      }
    });

    // 实时保存输入
    el.addEventListener("input", () => {
      if (el.classList.contains("editing")) {
        note.text = el.textContent || "";
        this.debouncedSave();
      }
    });

    // 拖拽 + 右键菜单（拖拽逻辑内部处理“点击=编辑”）
    this.bindDraggable(el, note);
    this.bindContextMenu(el, note.id);

    this.notesContainer.appendChild(el);
  }

  private updateNoteTransform(el: HTMLElement, x: number, y: number) {
    const screenPos = this.worldToScreen(x, y);
    el.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px)`;
  }

  private bindDraggable(el: HTMLElement, data: Note | Screenshot | MiniCanvas) {
    let isMouseDown = false;
    let downAt = { x: 0, y: 0 };
    let startDataX = 0;
    let startDataY = 0;
    let dragStarted = false;
    const DRAG_THRESHOLD = 4; // 需位移超过 4px 才视为拖动，避免误触发

    const onDown = (e: MouseEvent) => {
      // 只的左键进入拖动/点击逻辑
      if (e.button !== 0) return;
      // 正在编辑态的便签：不进入拖动，也不拦截事件，由便签自己处理输入
      if (el.classList.contains("editing")) return;
      isMouseDown = true;
      dragStarted = false;
      downAt = { x: e.clientX, y: e.clientY };
      startDataX = data.x;
      startDataY = data.y;
      e.stopPropagation();
      // 不调 preventDefault，避免阻止后续 focus
    };

    el.addEventListener("mousedown", onDown);

    const onMouseMove = (e: MouseEvent) => {
      if (!isMouseDown) return;
      const dx = e.clientX - downAt.x;
      const dy = e.clientY - downAt.y;
      if (!dragStarted) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        dragStarted = true;
        el.classList.add("dragging");
      }
      data.x = startDataX + dx / this.viewport.scale;
      data.y = startDataY + dy / this.viewport.scale;

      if (!this.dragPending) {
        this.dragPending = true;
        this.dragRafId = requestAnimationFrame(() => {
          if (el.classList.contains("draft-note")) {
            this.updateNoteTransform(el, data.x, data.y);
          } else if (el.classList.contains("draft-screenshot")) {
            this.updateScreenshotTransform(el, data.x, data.y);
          } else if (el.classList.contains("draft-mini-canvas")) {
            this.updateMiniCanvasTransform(el, data as MiniCanvas);
          }
          this.dragPending = false;
        });
      }
    };

    const onMouseUp = () => {
      if (!isMouseDown) return;
      isMouseDown = false;
      if (dragStarted) {
        // 拖动结束
        el.classList.remove("dragging");
        if (this.dragRafId) {
          cancelAnimationFrame(this.dragRafId);
          this.dragRafId = null;
        }
        this.dragPending = false;
        this.debouncedSave();
      } else {
        // 未拖动：视为点击
        if (el.classList.contains("draft-note")) {
          this.enterNoteEdit(el, data as Note);
        }
      }
      dragStarted = false;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  // 便签进入编辑态
  private enterNoteEdit(el: HTMLElement, note: Note) {
    if (el.classList.contains("editing")) return;
    el.contentEditable = "true";
    el.classList.add("editing");
    el.classList.remove("placeholder");
    if (!note.text) el.textContent = "";
    // 延迟一个 tick 调用 focus，避免被同一 mouseup 序列中的 blur 抢占
    setTimeout(() => {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, 0);
  }

  // ========== 截图 ==========

  private screenshotStart = { x: 0, y: 0 };
  private screenshotRect: HTMLElement | null = null;

  private startScreenshot(x: number, y: number) {
    this.isDrawing = true;
    this.screenshotStart = { x, y };
    this.screenshotRect = document.createElement("div");
    this.screenshotRect.className = "draft-screenshot-selector";
    this.notesContainer.appendChild(this.screenshotRect);
  }

  private updateScreenshot(x: number, y: number) {
    if (!this.screenshotRect) return;
    const left = Math.min(this.screenshotStart.x, x);
    const top = Math.min(this.screenshotStart.y, y);
    const w = Math.abs(x - this.screenshotStart.x);
    const h = Math.abs(y - this.screenshotStart.y);

    const s1 = this.worldToScreen(left, top);
    const s2 = this.worldToScreen(left + w, top + h);

    this.screenshotRect.style.left = Math.min(s1.x, s2.x) + "px";
    this.screenshotRect.style.top = Math.min(s1.y, s2.y) + "px";
    this.screenshotRect.style.width = Math.abs(s2.x - s1.x) + "px";
    this.screenshotRect.style.height = Math.abs(s2.y - s1.y) + "px";
  }

  public refreshScreenshot(x: number, y: number) { this.updateScreenshot(x, y); }

  private finishScreenshot() {
    if (!this.screenshotRect) return;
    const rect = this.screenshotRect.getBoundingClientRect();
    const containerRect = this.notesContainer.getBoundingClientRect();
    const x = rect.left - containerRect.left;
    const y = rect.top - containerRect.top;
    const w = rect.width;
    const h = rect.height;

    this.screenshotRect.remove();
    this.screenshotRect = null;

    if (w < 10 || h < 10) return;

    // 截取canvas区域
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tctx = tempCanvas.getContext("2d")!;
    tctx.drawImage(this.canvas, x, y, w, h, 0, 0, w, h);

    const dataUrl = tempCanvas.toDataURL("image/png");
    const screenshot: Screenshot = {
      id: `screenshot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      x: (x - this.viewport.x) / this.viewport.scale,
      y: (y - this.viewport.y) / this.viewport.scale,
      w: w / this.viewport.scale,
      h: h / this.viewport.scale,
      dataUrl,
    };

    const layer = this.getActiveLayer();
    layer.screenshots.push(screenshot);
    this.renderScreenshotElement(screenshot);
    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }

  private renderScreenshotElement(sc: Screenshot) {
    const el = document.createElement("div");
    el.className = "draft-screenshot";
    el.id = sc.id;
    this.updateScreenshotTransform(el, sc.x, sc.y);
    el.style.width = sc.w * this.viewport.scale + "px";
    el.style.height = sc.h * this.viewport.scale + "px";

    const img = document.createElement("img");
    img.src = sc.dataUrl;
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    el.appendChild(img);

    this.bindDraggable(el, sc);
    this.bindContextMenu(el, sc.id);
    this.notesContainer.appendChild(el);
  }

  private updateScreenshotTransform(el: HTMLElement, x: number, y: number) {
    const screenPos = this.worldToScreen(x, y);
    el.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px)`;
  }

  // ========== 小画布（mini-canvas）==========

  private createMiniCanvas(x: number, y: number) {
    const mc: MiniCanvas = {
      id: `mini_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      x,
      y,
      w: 280,
      h: 200,
      background: "#ffffff",
      strokes: [],
    };
    const layer = this.getActiveLayer();
    if (!layer.miniCanvases) layer.miniCanvases = [];
    layer.miniCanvases.push(mc);
    this.renderMiniCanvasElement(mc);
    this.debouncedSave();
  }

  private renderMiniCanvasElement(mc: MiniCanvas) {
    const el = document.createElement("div");
    el.className = "draft-mini-canvas";
    el.id = mc.id;
    el.style.background = mc.background;

    // 内部 canvas【预留：后续可扩展为在小画布内作画】
    const inner = document.createElement("canvas");
    inner.width = mc.w;
    inner.height = mc.h;
    inner.style.width = "100%";
    inner.style.height = "100%";
    inner.style.display = "block";
    inner.style.borderRadius = "10px";
    el.appendChild(inner);

    this.updateMiniCanvasTransform(el, mc);

    // 拖动 + 右键菜单
    this.bindDraggable(el, mc);
    this.bindContextMenu(el, mc.id);

    this.notesContainer.appendChild(el);
  }

  private updateMiniCanvasTransform(el: HTMLElement, mc: MiniCanvas) {
    const screenPos = this.worldToScreen(mc.x, mc.y);
    el.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px)`;
    el.style.width = mc.w * this.viewport.scale + "px";
    el.style.height = mc.h * this.viewport.scale + "px";
  }

  private renderMiniCanvases() {
    this.notesContainer.querySelectorAll(".draft-mini-canvas").forEach((el) => el.remove());
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      const list = layer.miniCanvases || [];
      for (const mc of list) {
        this.renderMiniCanvasElement(mc);
      }
    }
  }

  // ========== 右键菜单与元素销毁 ==========

  private contextMenuEl: HTMLElement | null = null;

  private bindContextMenu(el: HTMLElement, id: string) {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showContextMenu(e.clientX, e.clientY, id);
    });
  }

  private showContextMenu(clientX: number, clientY: number, id: string) {
    this.hideContextMenu();
    const menu = document.createElement("div");
    menu.className = "draft-context-menu";
    menu.style.left = clientX + "px";
    menu.style.top = clientY + "px";

    const items: Array<{ label: string; action: () => void; danger?: boolean }> = [
      { label: "复制", action: () => this.duplicateElement(id) },
      { label: "置顶", action: () => this.bringToFront(id) },
      { label: "删除", action: () => this.deleteElementById(id), danger: true },
    ];
    for (const it of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "draft-context-item" + (it.danger ? " danger" : "");
      btn.textContent = it.label;
      btn.addEventListener("click", () => {
        it.action();
        this.hideContextMenu();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    this.contextMenuEl = menu;

    const onDocClick = () => {
      this.hideContextMenu();
      window.removeEventListener("mousedown", onDocClick, true);
    };
    setTimeout(() => window.addEventListener("mousedown", onDocClick, true), 0);
  }

  private hideContextMenu() {
    if (this.contextMenuEl) {
      this.contextMenuEl.remove();
      this.contextMenuEl = null;
    }
  }

  /** 删除任意元素（笔画/形状/便签/截图/小画布） */
  private deleteElementById(id: string) {
    this.saveHistory("删除元素");
    let dirty = false;
    for (const layer of this.layers) {
      const beforeS = layer.strokes.length;
      layer.strokes = layer.strokes.filter((s) => s.id !== id);
      const beforeSh = layer.shapes.length;
      layer.shapes = layer.shapes.filter((s) => s.id !== id);
      const beforeN = layer.notes.length;
      layer.notes = layer.notes.filter((n) => n.id !== id);
      const beforeSc = layer.screenshots.length;
      layer.screenshots = layer.screenshots.filter((s) => s.id !== id);
      const minis = layer.miniCanvases || [];
      const beforeM = minis.length;
      layer.miniCanvases = minis.filter((m) => m.id !== id);
      if (layer.strokes.length !== beforeS || layer.shapes.length !== beforeSh ||
          layer.notes.length !== beforeN || layer.screenshots.length !== beforeSc ||
          (layer.miniCanvases?.length ?? 0) !== beforeM) {
        dirty = true;
      }
    }
    const el = document.getElementById(id);
    if (el) el.remove();
    if (dirty) {
      this.offscreenDirty = true;
      this.scheduleRender();
      this.debouncedSave();
    }
  }

  private duplicateElement(id: string) {
    this.saveHistory("复制元素");
    const offset = 24 / this.viewport.scale;
    for (const layer of this.layers) {
      const note = layer.notes.find((n) => n.id === id);
      if (note) {
        const copy: Note = { ...note, id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: note.x + offset, y: note.y + offset };
        layer.notes.push(copy);
        this.renderNoteElement(copy);
        this.debouncedSave();
        return;
      }
      const sc = layer.screenshots.find((s) => s.id === id);
      if (sc) {
        const copy: Screenshot = { ...sc, id: `screenshot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: sc.x + offset, y: sc.y + offset };
        layer.screenshots.push(copy);
        this.renderScreenshotElement(copy);
        this.debouncedSave();
        return;
      }
      const minis = layer.miniCanvases || [];
      const mc = minis.find((m) => m.id === id);
      if (mc) {
        const copy: MiniCanvas = { ...mc, id: `mini_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: mc.x + offset, y: mc.y + offset, strokes: JSON.parse(JSON.stringify(mc.strokes)) };
        minis.push(copy);
        this.renderMiniCanvasElement(copy);
        this.debouncedSave();
        return;
      }
    }
  }

  private bringToFront(id: string) {
    const el = document.getElementById(id);
    if (el && el.parentElement) {
      el.parentElement.appendChild(el);
    }
    // 将元素在数据中也移到末尾（后续绘制在上层）
    for (const layer of this.layers) {
      const idxN = layer.notes.findIndex((n) => n.id === id);
      if (idxN >= 0) { const [it] = layer.notes.splice(idxN, 1); layer.notes.push(it); this.debouncedSave(); return; }
      const idxS = layer.screenshots.findIndex((s) => s.id === id);
      if (idxS >= 0) { const [it] = layer.screenshots.splice(idxS, 1); layer.screenshots.push(it); this.debouncedSave(); return; }
      const minis = layer.miniCanvases || [];
      const idxM = minis.findIndex((m) => m.id === id);
      if (idxM >= 0) { const [it] = minis.splice(idxM, 1); minis.push(it); this.debouncedSave(); return; }
    }
  }

  // ========== 绘制完成 ==========

  private finishDrawing() {
    this.isDrawing = false;
    const layer = this.getActiveLayer();

    if (this.currentStroke) {
      layer.strokes.push(this.currentStroke);
      this.currentStroke = null;
      this.offscreenDirty = true;
      this.scheduleRender();
      this.debouncedSave();
    }

    if (this.currentShape) {
      layer.shapes.push(this.currentShape);
      this.currentShape = null;
      this.offscreenDirty = true;
      this.scheduleRender();
      this.debouncedSave();
    }

    if (this.currentTool === "screenshot" && this.screenshotRect) {
      this.finishScreenshot();
    }
  }

  // ========== 高性能渲染引擎 ==========

  /**
   * 使用 requestAnimationFrame 调度渲染，避免每帧重复绘制
   */
  private scheduleRender() {
    if (this.pendingRender) return;
    this.pendingRender = true;
    this.renderRafId = requestAnimationFrame(() => {
      this.pendingRender = false;
      this.render();
    });
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvasSize.width;
    const h = this.canvasSize.height;

    // 清空主 Canvas（逻辑像素坐标系，resize 中已 ctx.scale(dpr,dpr)）
    ctx.clearRect(0, 0, w, h);

    // 重绘离屏缓存：离屏 canvas 中直接以主画布同样的坐标系、同样的 viewport 变换进行绘制
    if (this.offscreenDirty) {
      this.renderToOffscreen();
      this.offscreenDirty = false;
    }

    // 1:1 复制离屏 canvas 到主 canvas（同为逻辑像素 w×h）
    ctx.drawImage(this.offscreenCanvas, 0, 0, w, h);

    // 临时元素（正在绘制中的笔画/形状/选区）需要应用 viewport 变换
    ctx.save();
    ctx.translate(this.viewport.x, this.viewport.y);
    ctx.scale(this.viewport.scale, this.viewport.scale);

    if (this.currentStroke) {
      this.drawStroke(this.currentStroke, ctx);
    }
    if (this.currentShape) {
      this.drawShape(this.currentShape, ctx);
    }

    if (this.selectRect && this.isSelecting) {
      ctx.strokeStyle = "#5B8DEF";
      ctx.lineWidth = 1 / this.viewport.scale;
      ctx.setLineDash([5 / this.viewport.scale, 5 / this.viewport.scale]);
      ctx.strokeRect(this.selectRect.x, this.selectRect.y, this.selectRect.w, this.selectRect.h);
      ctx.fillStyle = "rgba(91, 141, 239, 0.1)";
      ctx.fillRect(this.selectRect.x, this.selectRect.y, this.selectRect.w, this.selectRect.h);
      ctx.setLineDash([]);
    }

    // 钢笔预览：已放锥点连纯线 + 临时到鼠标的虚线
    if (this.currentTool === "fountain" && this.penAnchors.length > 0) {
      const cfg = this.toolConfigs.fountain || DEFAULT_TOOL_CONFIGS.fountain;
      ctx.strokeStyle = this.currentColor;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = cfg.width;
      ctx.beginPath();
      ctx.moveTo(this.penAnchors[0].x, this.penAnchors[0].y);
      for (let i = 1; i < this.penAnchors.length; i++) {
        ctx.lineTo(this.penAnchors[i].x, this.penAnchors[i].y);
      }
      ctx.stroke();
      // 虚线预览下一段
      if (this.penPreview) {
        ctx.save();
        ctx.setLineDash([6 / this.viewport.scale, 4 / this.viewport.scale]);
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        const last = this.penAnchors[this.penAnchors.length - 1];
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(this.penPreview.x, this.penPreview.y);
        ctx.stroke();
        ctx.restore();
      }
      // 锥点圆点
      const r = 3 / this.viewport.scale;
      for (const a of this.penAnchors) {
        ctx.fillStyle = "#5B8DEF";
        ctx.beginPath();
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1 / this.viewport.scale;
        ctx.stroke();
      }
    }

    this.drawSelectionHighlights(ctx);

    ctx.restore();
  }

  /**
   * 重绘离屏 canvas：坐标系与主 canvas 完全一致（逻辑像素 + viewport 变换）
   * 不多乘 dpr，避免双重缩放造成的坐标错位
   */
  private renderToOffscreen() {
    const ctx = this.offscreenCtx;
    const w = this.canvasSize.width;
    const h = this.canvasSize.height;

    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.viewport.x, this.viewport.y);
    ctx.scale(this.viewport.scale, this.viewport.scale);

    // 计算视口世界坐标边界（用于裁剪）
    const viewLeft = -this.viewport.x / this.viewport.scale;
    const viewTop = -this.viewport.y / this.viewport.scale;
    const viewRight = viewLeft + w / this.viewport.scale;
    const viewBottom = viewTop + h / this.viewport.scale;
    const padding = 50;
    const minX = viewLeft - padding;
    const minY = viewTop - padding;
    const maxX = viewRight + padding;
    const maxY = viewBottom + padding;

    for (const layer of this.layers) {
      if (!layer.visible) continue;
      for (const stroke of layer.strokes) {
        if (this.isStrokeInViewport(stroke, minX, minY, maxX, maxY)) {
          this.drawStroke(stroke, ctx);
        }
      }
      for (const shape of layer.shapes) {
        if (this.isShapeInViewport(shape, minX, minY, maxX, maxY)) {
          this.drawShape(shape, ctx);
        }
      }
    }

    ctx.restore();
  }

  // 视口裁剪检测
  private isStrokeInViewport(stroke: Stroke, minX: number, minY: number, maxX: number, maxY: number): boolean {
    if (stroke.bbox) {
      return !(stroke.bbox.maxX < minX || stroke.bbox.minX > maxX ||
               stroke.bbox.maxY < minY || stroke.bbox.minY > maxY);
    }
    // 无bbox时回退到点检测
    for (const p of stroke.points) {
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) return true;
    }
    return false;
  }

  private isShapeInViewport(shape: Shape, minX: number, minY: number, maxX: number, maxY: number): boolean {
    // 简化为包围盒检测
    let sMinX = shape.x, sMinY = shape.y, sMaxX = shape.x, sMaxY = shape.y;
    if (shape.type === "rect" && shape.w !== undefined && shape.h !== undefined) {
      sMaxX = shape.x + shape.w;
      sMaxY = shape.y + shape.h;
    } else if (shape.type === "circle" && shape.r !== undefined) {
      sMinX = shape.x - shape.r;
      sMinY = shape.y - shape.r;
      sMaxX = shape.x + shape.r;
      sMaxY = shape.y + shape.r;
    } else if (shape.x2 !== undefined && shape.y2 !== undefined) {
      sMinX = Math.min(shape.x, shape.x2);
      sMaxX = Math.max(shape.x, shape.x2);
      sMinY = Math.min(shape.y, shape.y2);
      sMaxY = Math.max(shape.y, shape.y2);
    }
    return !(sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY);
  }

  private drawStroke(stroke: Stroke, ctx: CanvasRenderingContext2D) {
    if (stroke.points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    // 使用简化的线条绘制（减少曲线计算开销）
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width / this.viewport.scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (stroke.tool === "marker") {
      ctx.globalAlpha = 0.4;
    } else {
      ctx.globalAlpha = 1;
    }

    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawShape(shape: Shape, ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineWidth = shape.strokeWidth / this.viewport.scale;
    ctx.globalAlpha = 1;

    if (shape.type === "rect" && shape.w !== undefined && shape.h !== undefined) {
      if (shape.fill) {
        ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
      } else {
        ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      }
    } else if (shape.type === "circle" && shape.r !== undefined) {
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
      if (shape.fill) {
        ctx.fill();
      } else {
        ctx.stroke();
      }
    } else if (
      (shape.type === "line" || shape.type === "arrow") &&
      shape.x2 !== undefined && shape.y2 !== undefined
    ) {
      ctx.beginPath();
      ctx.moveTo(shape.x, shape.y);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();

      if (shape.type === "arrow") {
        this.drawArrowHead(shape.x, shape.y, shape.x2, shape.y2, ctx);
      }
    }
  }

  private drawArrowHead(x1: number, y1: number, x2: number, y2: number, ctx: CanvasRenderingContext2D) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = 10 / this.viewport.scale;

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
  }

  private drawSelectionHighlights(ctx: CanvasRenderingContext2D) {
    if (this.selection.ids.length === 0) return;

    const idSet = new Set(this.selection.ids);
    ctx.strokeStyle = "#5B8DEF";
    ctx.lineWidth = 1 / this.viewport.scale;
    ctx.setLineDash([3 / this.viewport.scale, 3 / this.viewport.scale]);

    for (const layer of this.layers) {
      for (const stroke of layer.strokes) {
        if (idSet.has(stroke.id) && stroke.bbox) {
          const padding = 4 / this.viewport.scale;
          ctx.strokeRect(
            stroke.bbox.minX - padding,
            stroke.bbox.minY - padding,
            stroke.bbox.maxX - stroke.bbox.minX + padding * 2,
            stroke.bbox.maxY - stroke.bbox.minY + padding * 2
          );
        }
      }
      for (const shape of layer.shapes) {
        if (idSet.has(shape.id)) {
          let x = shape.x, y = shape.y, w = 0, h = 0;
          if (shape.type === "rect" && shape.w !== undefined && shape.h !== undefined) {
            w = shape.w; h = shape.h;
          } else if (shape.type === "circle" && shape.r !== undefined) {
            x -= shape.r; y -= shape.r; w = shape.r * 2; h = shape.r * 2;
          } else if (shape.x2 !== undefined && shape.y2 !== undefined) {
            x = Math.min(shape.x, shape.x2);
            y = Math.min(shape.y, shape.y2);
            w = Math.abs(shape.x2 - shape.x);
            h = Math.abs(shape.y2 - shape.y);
          }
          const padding = 4 / this.viewport.scale;
          ctx.strokeRect(x - padding, y - padding, w + padding * 2, h + padding * 2);
        }
      }
    }

    ctx.setLineDash([]);
  }

  // ========== 历史记录系统 ==========

  private saveHistory(action: string) {
    if (this.isUndoing) return;

    // 移除当前索引之后的历史
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    const state: HistoryState = {
      id: `hist_${Date.now()}`,
      timestamp: Date.now(),
      action,
      data: this.getData(),
    };

    this.history.push(state);

    // 限制历史记录数量
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.historyIndex++;
    }

    // 通知历史更新
    window.dispatchEvent(new CustomEvent("draft-history-changed", {
      detail: { history: this.history, index: this.historyIndex },
    }));
  }

  undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.isUndoing = true;
    this.setData(this.history[this.historyIndex].data);
    this.isUndoing = false;

    window.dispatchEvent(new CustomEvent("draft-history-changed", {
      detail: { history: this.history, index: this.historyIndex },
    }));
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.isUndoing = true;
    this.setData(this.history[this.historyIndex].data);
    this.isUndoing = false;

    window.dispatchEvent(new CustomEvent("draft-history-changed", {
      detail: { history: this.history, index: this.historyIndex },
    }));
  }

  getHistory(): HistoryState[] {
    return this.history;
  }

  getHistoryIndex(): number {
    return this.historyIndex;
  }

  // ========== 图层管理 ==========

  private getActiveLayer(): DraftLayer {
    const layer = this.layers.find((l) => l.id === this.activeLayerId);
    if (layer) return layer;
    // 回退到第一个可见图层
    const visible = this.layers.find((l) => l.visible);
    if (visible) {
      this.activeLayerId = visible.id;
      return visible;
    }
    // 创建默认图层
    const newLayer: DraftLayer = {
      id: `layer_${Date.now()}`,
      name: `图层 ${this.layers.length + 1}`,
      visible: true,
      locked: false,
      strokes: [], shapes: [], notes: [], screenshots: [],
    };
    this.layers.push(newLayer);
    this.activeLayerId = newLayer.id;
    return newLayer;
  }

  getLayers(): DraftLayer[] {
    return this.layers;
  }

  getActiveLayerId(): string {
    return this.activeLayerId;
  }

  setActiveLayer(id: string) {
    const layer = this.layers.find((l) => l.id === id);
    if (layer) {
      this.activeLayerId = id;
    }
  }

  addLayer(name?: string): DraftLayer {
    const layer: DraftLayer = {
      id: `layer_${Date.now()}`,
      name: name || `图层 ${this.layers.length + 1}`,
      visible: true,
      locked: false,
      strokes: [], shapes: [], notes: [], screenshots: [],
    };
    this.layers.push(layer);
    this.activeLayerId = layer.id;
    this.offscreenDirty = true;
    this.scheduleRender();
    return layer;
  }

  removeLayer(id: string) {
    if (this.layers.length <= 1) return; // 至少保留一个图层
    const index = this.layers.findIndex((l) => l.id === id);
    if (index === -1) return;

    // 移除该图层的所有DOM元素
    const layer = this.layers[index];
    for (const note of layer.notes) {
      const el = document.getElementById(note.id);
      if (el) el.remove();
    }
    for (const sc of layer.screenshots) {
      const el = document.getElementById(sc.id);
      if (el) el.remove();
    }

    this.layers.splice(index, 1);
    if (this.activeLayerId === id) {
      this.activeLayerId = this.layers[0]?.id || "";
    }

    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }

  setLayerVisibility(id: string, visible: boolean) {
    const layer = this.layers.find((l) => l.id === id);
    if (layer) {
      layer.visible = visible;
      this.offscreenDirty = true;
      this.scheduleRender();
    }
  }

  setLayerLock(id: string, locked: boolean) {
    const layer = this.layers.find((l) => l.id === id);
    if (layer) {
      layer.locked = locked;
    }
  }

  renameLayer(id: string, name: string) {
    const layer = this.layers.find((l) => l.id === id);
    if (layer) {
      layer.name = name;
    }
  }

  // ========== 工具与颜色 ==========

  setTool(tool: DraftTool) {
    // 切换工具时处理未提交的钢笔锥点
    if (this.currentTool === "fountain" && tool !== "fountain") {
      if (this.penAnchors.length >= 2) {
        this.commitPenStroke();
      } else {
        this.cancelPenStroke();
      }
    }
    this.currentTool = tool;
    this.updateCursor();
    this.applyToolBodyClass(tool);
  }

  // 画笔/形状/橡皮擦类工具下，便签/截图/小画布 的 pointer-events 该被穿透
  private applyToolBodyClass(tool: DraftTool) {
    const paintTools = new Set<DraftTool>([
      "ballpen", "fountain", "marker", "eraser",
      "rect", "circle", "line", "arrow",
    ]);
    document.body.classList.toggle("draft-paint-mode", paintTools.has(tool));
  }

  setOnPanRequest(cb: (dx: number, dy: number) => void) {
    this.panRequest = cb;
  }

  setOnZoomRequest(cb: (clientX: number, clientY: number, factor: number) => void) {
    this.zoomRequest = cb;
  }

  setEraserMode(mode: "partial" | "stroke") {
    this.eraserMode = mode;
  }

  getEraserMode(): "partial" | "stroke" {
    return this.eraserMode;
  }

  // 清空画布：清除所有图层中的元素
  clearCanvas() {
    this.saveHistory("清空画布");
    for (const layer of this.layers) {
      layer.strokes = [];
      layer.shapes = [];
      layer.notes = [];
      layer.screenshots = [];
      layer.miniCanvases = [];
    }
    // 清除所有 DOM 元素
    this.notesContainer
      .querySelectorAll<HTMLElement>(".draft-note, .draft-screenshot, .draft-mini-canvas")
      .forEach((el) => el.remove());
    this.selection = { ids: [], type: "mixed" };
    if (this.selectionOverlay) this.selectionOverlay.style.display = "none";
    this.penAnchors = [];
    this.penPreview = null;
    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }

  setColor(color: string) {
    this.currentColor = color;
  }

  getCurrentTool(): DraftTool {
    return this.currentTool;
  }

  getCurrentColor(): string {
    return this.currentColor;
  }

  setToolConfig(tool: string, config: Partial<ToolConfig>) {
    if (!this.toolConfigs[tool]) {
      this.toolConfigs[tool] = { ...DEFAULT_TOOL_CONFIGS[tool] || DEFAULT_TOOL_CONFIGS.ballpen };
    }
    Object.assign(this.toolConfigs[tool], config);
  }

  getToolConfig(tool: string): ToolConfig {
    return this.toolConfigs[tool] || DEFAULT_TOOL_CONFIGS[tool] || DEFAULT_TOOL_CONFIGS.ballpen;
  }

  private adjustBrushSize(delta: number) {
    const tool = this.currentTool;
    if (tool !== "ballpen" && tool !== "fountain" && tool !== "marker") return;
    const config = this.toolConfigs[tool];
    if (!config) return;
    config.width = Math.max(1, Math.min(50, config.width + delta));
  }

  private updateCursor() {
    const cursors: Record<DraftTool, string> = {
      select: "default",
      cursor: "default",
      ballpen: "crosshair",
      fountain: "crosshair",
      marker: "crosshair",
      eraser: "cell",
      rect: "crosshair",
      circle: "crosshair",
      line: "crosshair",
      arrow: "crosshair",
      note: "pointer",
      "mini-canvas": "pointer",
      screenshot: "crosshair",
    };
    this.canvas.style.cursor = cursors[this.currentTool] || "default";
  }

  // ========== 数据管理 ==========

  setData(data: DraftData) {
    this.clear();

    // 兼容旧格式
    if (data.version === 2 && data.layers) {
      this.layers = data.layers.map((l) => ({
        ...l,
        visible: l.visible !== false,
        locked: l.locked || false,
        miniCanvases: l.miniCanvases || [],
      }));
    } else if (data.strokes || data.shapes || data.notes || data.screenshots) {
      // 旧格式转换
      this.layers = [{
        id: "layer_1",
        name: "图层 1",
        visible: true,
        locked: false,
        strokes: data.strokes || [],
        shapes: data.shapes || [],
        notes: data.notes || [],
        screenshots: data.screenshots || [],
        miniCanvases: [],
      }];
    }

    if (this.layers.length === 0) {
      this.layers = [{
        id: "layer_1",
        name: "图层 1",
        visible: true,
        locked: false,
        strokes: [], shapes: [], notes: [], screenshots: [], miniCanvases: [],
      }];
    }

    this.activeLayerId = this.layers[0].id;
    this.offscreenDirty = true;
    this.scheduleRender();
    this.renderNotes();
    this.renderScreenshots();
    this.renderMiniCanvases();
  }

  getData(): DraftData {
    return {
      version: 2,
      layers: JSON.parse(JSON.stringify(this.layers)),
    };
  }

  clear() {
    this.layers = [{
      id: "layer_1",
      name: "图层 1",
      visible: true,
      locked: false,
      strokes: [], shapes: [], notes: [], screenshots: [], miniCanvases: [],
    }];
    this.activeLayerId = "layer_1";
    this.currentStroke = null;
    this.currentShape = null;
    this.isDrawing = false;
    this.selection = { ids: [], type: "mixed" };
    this.history = [];
    this.historyIndex = -1;

    // 清除DOM元素
    this.notesContainer.querySelectorAll(".draft-note, .draft-screenshot, .draft-mini-canvas").forEach((el) => el.remove());

    this.offscreenDirty = true;
    this.scheduleRender();
  }

  private renderNotes() {
    this.notesContainer.querySelectorAll(".draft-note").forEach((el) => el.remove());
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      for (const note of layer.notes) {
        this.renderNoteElement(note);
      }
    }
  }

  private renderScreenshots() {
    this.notesContainer.querySelectorAll(".draft-screenshot").forEach((el) => el.remove());
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      for (const sc of layer.screenshots) {
        this.renderScreenshotElement(sc);
      }
    }
  }

  // ========== 持久化 ==========

  setProjectName(name: string) {
    this.projectName = name;
  }

  async save() {
    if (!this.projectName) return;
    try {
      await invoke("save_draft", {
        projectName: this.projectName,
        data: JSON.stringify(this.getData()),
      });
    } catch (e) {
      console.error("[DraftCanvas] 保存草稿失败:", e);
    }
  }

  async load(projectName: string) {
    this.projectName = projectName;
    try {
      const result = await invoke<string>("load_draft", { projectName });
      if (result && result !== "null") {
        const data: DraftData = JSON.parse(result);
        this.setData(data);
      } else {
        this.clear();
      }
    } catch (e) {
      console.error("[DraftCanvas] 加载草稿失败:", e);
      this.clear();
    }
  }

  private debouncedSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  // ========== 激活状态 ==========

  activate() {
    this.isActive = true;
    this.canvas.classList.add("active");
    this.resize();
    // 显示所有草稿 DOM 元素
    this.notesContainer.querySelectorAll<HTMLElement>(".draft-note, .draft-screenshot, .draft-mini-canvas")
      .forEach((el) => { el.style.display = ""; });
    this.offscreenDirty = true;
    this.scheduleRender();
    this.updateAllElementTransforms();
    // 应用当前工具的 paint 模式类
    this.applyToolBodyClass(this.currentTool);
  }

  deactivate() {
    this.isActive = false;
    this.canvas.classList.remove("active");
    // 隐藏所有草稿 DOM 元素，避免在非草稿模式中残留
    this.notesContainer.querySelectorAll<HTMLElement>(".draft-note, .draft-screenshot, .draft-mini-canvas")
      .forEach((el) => { el.style.display = "none"; });
    // 隐藏选区覆盖层
    if (this.selectionOverlay) this.selectionOverlay.style.display = "none";
    // 关闭右键菜单
    this.hideContextMenu();
    // 移除 paint 模式类
    document.body.classList.remove("draft-paint-mode");
    // 取消未提交的钢笔锥点
    this.cancelPenStroke();
    // 重置平移状态
    this.isPanning = false;
  }

  isActivated(): boolean {
    return this.isActive;
  }

  // ========== 对齐工具 ==========

  alignSelection(align: "left" | "center" | "right" | "top" | "bottom" | "hcenter" | "vcenter") {
    if (this.selection.ids.length < 2) return;
    this.saveHistory("对齐元素");

    const idSet = new Set(this.selection.ids);
    const items: Array<{ x: number; y: number; w: number; h: number; setter: (x: number, y: number) => void }> = [];

    for (const layer of this.layers) {
      for (const shape of layer.shapes) {
        if (idSet.has(shape.id)) {
          const w = shape.w || 0;
          const h = shape.h || (shape.r ? shape.r * 2 : 0);
          items.push({
            x: shape.x, y: shape.y, w, h,
            setter: (nx, ny) => { shape.x = nx; shape.y = ny; },
          });
        }
      }
      for (const note of layer.notes) {
        if (idSet.has(note.id)) {
          items.push({
            x: note.x, y: note.y, w: note.width, h: note.height,
            setter: (nx, ny) => { note.x = nx; note.y = ny; },
          });
        }
      }
      for (const sc of layer.screenshots) {
        if (idSet.has(sc.id)) {
          items.push({
            x: sc.x, y: sc.y, w: sc.w, h: sc.h,
            setter: (nx, ny) => { sc.x = nx; sc.y = ny; },
          });
        }
      }
    }

    if (items.length < 2) return;

    let targetValue: number;

    switch (align) {
      case "left":
        targetValue = Math.min(...items.map((i) => i.x));
        items.forEach((i) => i.setter(targetValue, i.y));
        break;
      case "right":
        targetValue = Math.max(...items.map((i) => i.x + i.w));
        items.forEach((i) => i.setter(targetValue - i.w, i.y));
        break;
      case "center":
      case "hcenter":
        targetValue = items.reduce((s, i) => s + i.x + i.w / 2, 0) / items.length;
        items.forEach((i) => i.setter(targetValue - i.w / 2, i.y));
        break;
      case "top":
        targetValue = Math.min(...items.map((i) => i.y));
        items.forEach((i) => i.setter(i.x, targetValue));
        break;
      case "bottom":
        targetValue = Math.max(...items.map((i) => i.y + i.h));
        items.forEach((i) => i.setter(i.x, targetValue - i.h));
        break;
      case "vcenter":
        targetValue = items.reduce((s, i) => s + i.y + i.h / 2, 0) / items.length;
        items.forEach((i) => i.setter(i.x, targetValue - i.h / 2));
        break;
    }

    // 更新DOM位置
    for (const id of this.selection.ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      for (const layer of this.layers) {
        const note = layer.notes.find((n) => n.id === id);
        if (note) this.updateNoteTransform(el, note.x, note.y);
        const sc = layer.screenshots.find((s) => s.id === id);
        if (sc) this.updateScreenshotTransform(el, sc.x, sc.y);
      }
    }

    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }

  distributeSelection(direction: "horizontal" | "vertical") {
    if (this.selection.ids.length < 3) return;
    this.saveHistory("等间距分布");

    const idSet = new Set(this.selection.ids);
    const items: Array<{ x: number; y: number; w: number; h: number; setter: (x: number, y: number) => void; el?: HTMLElement }> = [];

    for (const layer of this.layers) {
      for (const shape of layer.shapes) {
        if (idSet.has(shape.id)) {
          const w = shape.w || 0;
          const h = shape.h || (shape.r ? shape.r * 2 : 0);
          items.push({
            x: shape.x, y: shape.y, w, h,
            setter: (nx, ny) => { shape.x = nx; shape.y = ny; },
          });
        }
      }
      for (const note of layer.notes) {
        if (idSet.has(note.id)) {
          items.push({
            x: note.x, y: note.y, w: note.width, h: note.height,
            setter: (nx, ny) => { note.x = nx; note.y = ny; },
            el: document.getElementById(note.id) || undefined,
          });
        }
      }
      for (const sc of layer.screenshots) {
        if (idSet.has(sc.id)) {
          items.push({
            x: sc.x, y: sc.y, w: sc.w, h: sc.h,
            setter: (nx, ny) => { sc.x = nx; sc.y = ny; },
            el: document.getElementById(sc.id) || undefined,
          });
        }
      }
    }

    if (items.length < 3) return;

    if (direction === "horizontal") {
      items.sort((a, b) => a.x - b.x);
      const minX = items[0].x;
      const maxX = items[items.length - 1].x;
      const totalSpace = maxX - minX;
      const step = totalSpace / (items.length - 1);
      items.forEach((item, i) => {
        item.setter(minX + step * i, item.y);
        if (item.el) {
          if (item.el.classList.contains("draft-note")) {
            this.updateNoteTransform(item.el, minX + step * i, item.y);
          } else if (item.el.classList.contains("draft-screenshot")) {
            this.updateScreenshotTransform(item.el, minX + step * i, item.y);
          }
        }
      });
    } else {
      items.sort((a, b) => a.y - b.y);
      const minY = items[0].y;
      const maxY = items[items.length - 1].y;
      const totalSpace = maxY - minY;
      const step = totalSpace / (items.length - 1);
      items.forEach((item, i) => {
        item.setter(item.x, minY + step * i);
        if (item.el) {
          if (item.el.classList.contains("draft-note")) {
            this.updateNoteTransform(item.el, item.x, minY + step * i);
          } else if (item.el.classList.contains("draft-screenshot")) {
            this.updateScreenshotTransform(item.el, item.x, minY + step * i);
          }
        }
      });
    }

    this.offscreenDirty = true;
    this.scheduleRender();
    this.debouncedSave();
  }
}

// ========== 右侧专业工具栏 ==========

const SIDEBAR_PALETTE: string[] = [
  "#FF5252", "#FF4081", "#E040FB", "#7C4DFF",
  "#536DFE", "#448AFF", "#40C4FF", "#18FFFF",
  "#64FFDA", "#69F0AE", "#B2FF59", "#EEFF41",
  "#FFD740", "#FFAB40", "#FF6E40", "#8D6E63",
];

export class DraftSidebar {
  private el: HTMLElement;
  private tabs: HTMLElement[] = [];
  private panels: HTMLElement[] = [];
  private canvas: DraftCanvas | null = null;

  constructor() {
    this.el = document.getElementById("draft-sidebar")!;
    this.bindTabs();
    this.bindPaletteEvents();
    this.bindPropEvents();
    this.renderPalette();
  }

  setCanvas(canvas: DraftCanvas) {
    this.canvas = canvas;
    this.syncPropsFromCanvas();
  }

  // ========== 页签切换 ==========

  private bindTabs() {
    this.tabs = Array.from(this.el.querySelectorAll(".draft-sidebar-tab"));
    this.panels = Array.from(this.el.querySelectorAll(".draft-sidebar-panel"));

    this.tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = (tab as HTMLElement).dataset.tab!;
        this.switchTab(target);
      });
    });
  }

  private switchTab(tabName: string) {
    this.tabs.forEach((t) => t.classList.toggle("active", (t as HTMLElement).dataset.tab === tabName));
    this.panels.forEach((p) => p.classList.toggle("active", (p as HTMLElement).dataset.panel === tabName));
    if (tabName === "props") this.syncPropsFromCanvas();
  }

  // ========== 调色盘 ==========

  private renderPalette() {
    const grid = this.el.querySelector("#draft-palette-grid");
    if (!grid) return;
    grid.innerHTML = SIDEBAR_PALETTE.map((color) =>
      `<button class="draft-palette-color" data-color="${color}" style="background:${color}" title="${color}"></button>`
    ).join("");
  }

  private bindPaletteEvents() {
    // 预设色块点击
    const grid = this.el.querySelector("#draft-palette-grid");
    grid?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".draft-palette-color") as HTMLElement;
      if (!btn?.dataset.color) return;
      const color = btn.dataset.color;
      this.canvas?.setColor(color);
      this.syncColorInputs(color);
    });

    // 取色器
    this.el.querySelector("#draft-palette-picker")?.addEventListener("input", (e) => {
      const color = (e.target as HTMLInputElement).value;
      this.canvas?.setColor(color);
      const hex = this.el.querySelector("#draft-palette-hex") as HTMLInputElement;
      if (hex) hex.value = color;
    });

    // HEX输入
    this.el.querySelector("#draft-palette-hex")?.addEventListener("change", () => {
      const hex = this.el.querySelector("#draft-palette-hex") as HTMLInputElement;
      let color = hex.value.trim();
      if (!color.startsWith("#")) color = "#" + color;
      if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
        this.canvas?.setColor(color);
        const picker = this.el.querySelector("#draft-palette-picker") as HTMLInputElement;
        if (picker) picker.value = color;
      }
    });

    // 调色盘不透明度滑块
    this.el.querySelector("#draft-prop-opacity")?.addEventListener("input", (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      const valEl = this.el.querySelector("#draft-prop-opacity-val");
      if (valEl) valEl.textContent = val + "%";
      this.applyToolConfig({ opacity: val / 100 });
    });
  }

  private syncColorInputs(color: string) {
    const picker = this.el.querySelector("#draft-palette-picker") as HTMLInputElement;
    const hex = this.el.querySelector("#draft-palette-hex") as HTMLInputElement;
    if (picker) picker.value = color;
    if (hex) hex.value = color;
  }

  // ========== 属性面板 ==========

  private bindPropEvents() {
    // 笔刷大小
    this.el.querySelector("#draft-prop-size")?.addEventListener("input", (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      const valEl = this.el.querySelector("#draft-prop-size-val");
      if (valEl) valEl.textContent = val + "px";
      this.applyToolConfig({ width: val });
    });

    // 属性面板不透明度
    this.el.querySelector("#draft-prop-opacity2")?.addEventListener("input", (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      const valEl = this.el.querySelector("#draft-prop-opacity2-val");
      if (valEl) valEl.textContent = val + "%";
      this.applyToolConfig({ opacity: val / 100 });
    });

    // 填充开关 - 暂存状态，绘制形状时由 DraftCanvas 读取
    this.el.querySelector("#draft-prop-fill")?.addEventListener("change", () => {
      // fill 状态由 DraftCanvas 的 currentFill 属性控制
    });
  }

  private applyToolConfig(config: Partial<ToolConfig>) {
    if (!this.canvas) return;
    const tool = this.canvas.getCurrentTool();
    this.canvas.setToolConfig(tool, config);
  }

  private syncPropsFromCanvas() {
    if (!this.canvas) return;
    const tool = this.canvas.getCurrentTool();
    const config = this.canvas.getToolConfig(tool);

    const sizeSlider = this.el.querySelector("#draft-prop-size") as HTMLInputElement;
    const sizeVal = this.el.querySelector("#draft-prop-size-val");
    if (sizeSlider) sizeSlider.value = String(config.width);
    if (sizeVal) sizeVal.textContent = config.width + "px";

    const opacity2 = this.el.querySelector("#draft-prop-opacity2") as HTMLInputElement;
    const opacity2Val = this.el.querySelector("#draft-prop-opacity2-val");
    const pct = Math.round(config.opacity * 100);
    if (opacity2) opacity2.value = String(pct);
    if (opacity2Val) opacity2Val.textContent = pct + "%";

    const opacity1 = this.el.querySelector("#draft-prop-opacity") as HTMLInputElement;
    const opacity1Val = this.el.querySelector("#draft-prop-opacity-val");
    if (opacity1) opacity1.value = String(pct);
    if (opacity1Val) opacity1Val.textContent = pct + "%";

    const picker = this.el.querySelector("#draft-palette-picker") as HTMLInputElement;
    const hex = this.el.querySelector("#draft-palette-hex") as HTMLInputElement;
    const color = this.canvas.getCurrentColor();
    if (picker) picker.value = color;
    if (hex) hex.value = color;
  }

  // ========== 显隐 ==========

  show() {
    this.el.classList.add("active");
    this.syncPropsFromCanvas();
  }

  hide() {
    this.el.classList.remove("active");
  }
}
