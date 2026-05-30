// ========== 草稿功能核心模块 ==========

import { invoke } from "@tauri-apps/api/core";

// ========== 数据类型定义 ==========

export interface DraftData {
  strokes: Stroke[];
  shapes: Shape[];
  notes: Note[];
  screenshots: Screenshot[];
}

export interface Stroke {
  id: string;
  tool: "ballpen" | "fountain" | "marker";
  color: string;
  width: number;
  points: { x: number; y: number }[];
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

export type DraftTool =
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

// ========== 工具箱管理 ==========

export class DraftToolbox {
  private el: HTMLElement;
  private tabs: HTMLElement[] = [];
  private panels: HTMLElement[] = [];
  private tools: HTMLElement[] = [];
  private colors: HTMLElement[] = [];
  private currentTab = "basic";
  public getCurrentTab() { return this.currentTab; }
  private currentTool: DraftTool = "ballpen";
  private currentColor = "#FF5252";
  private onToolChange?: (tool: DraftTool) => void;
  private onColorChange?: (color: string) => void;

  constructor() {
    this.el = document.getElementById("draft-toolbox")!;
    this.bindTabs();
    this.bindTools();
    this.bindColors();
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

  show() {
    this.el.classList.add("active");
  }

  hide() {
    this.el.classList.remove("active");
  }
}

// ========== 草稿画布 ==========

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export class DraftCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: DraftData = { strokes: [], shapes: [], notes: [], screenshots: [] };
  private currentTool: DraftTool = "ballpen";
  private currentColor = "#FF5252";
  private isDrawing = false;
  private currentStroke: Stroke | null = null;
  private currentShape: Shape | null = null;
  private shapeStart = { x: 0, y: 0 };
  private notesContainer: HTMLElement;
  private viewport: Viewport = { x: 0, y: 0, scale: 1 };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private projectName: string = "";
  private isActive = false;

  private eraserIndices: number[] = [];
  public getEraserIndices() { return this.eraserIndices; }

  constructor() {
    this.canvas = document.getElementById("draft-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d")!;
    this.notesContainer = document.getElementById("canvas-container")!;

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.bindEvents();
  }

  private resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.render();
  }

  setViewport(viewport: Viewport) {
    this.viewport = viewport;
    this.render();
  }

  setTool(tool: DraftTool) {
    this.currentTool = tool;
    this.updateCursor();
  }

  setColor(color: string) {
    this.currentColor = color;
  }

  private updateCursor() {
    const cursors: Record<DraftTool, string> = {
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

  private bindEvents() {
    // mousedown
    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.isActive) return;
      const pos = this.getCanvasPos(e);
      const worldPos = this.screenToWorld(pos.x, pos.y);

      switch (this.currentTool) {
        case "ballpen":
        case "fountain":
        case "marker":
          this.startStroke(worldPos.x, worldPos.y);
          break;
        case "eraser":
          this.startErase(worldPos.x, worldPos.y);
          break;
        case "rect":
        case "circle":
        case "line":
        case "arrow":
          this.startShape(worldPos.x, worldPos.y);
          break;
        case "note":
          this.createNote(worldPos.x, worldPos.y);
          break;
        case "screenshot":
          this.startScreenshot(worldPos.x, worldPos.y);
          break;
      }
    });

    // mousemove
    this.canvas.addEventListener("mousemove", (e) => {
      if (!this.isActive) return;
      const pos = this.getCanvasPos(e);
      const worldPos = this.screenToWorld(pos.x, pos.y);

      if (this.isDrawing && this.currentStroke) {
        this.currentStroke.points.push({ x: worldPos.x, y: worldPos.y });
        this.render();
      } else if (this.isDrawing && this.currentShape) {
        this.updateShape(worldPos.x, worldPos.y);
        this.render();
      }
    });

    // mouseup
    window.addEventListener("mouseup", () => {
      if (!this.isActive) return;
      if (this.isDrawing) {
        this.finishDrawing();
      }
    });
  }

  private getCanvasPos(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewport.x) / this.viewport.scale,
      y: (sy - this.viewport.y) / this.viewport.scale,
    };
  }

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: wx * this.viewport.scale + this.viewport.x,
      y: wy * this.viewport.scale + this.viewport.y,
    };
  }
  public convertWorldToScreen(wx: number, wy: number) { return this.worldToScreen(wx, wy); }

  // ========== 画笔工具 ==========

  private startStroke(x: number, y: number) {
    this.isDrawing = true;
    const widths: Record<string, number> = {
      ballpen: 2,
      fountain: 2,
      marker: 6,
    };
    this.currentStroke = {
      id: `stroke_${Date.now()}`,
      tool: this.currentTool as "ballpen" | "fountain" | "marker",
      color: this.currentColor,
      width: widths[this.currentTool] || 2,
      points: [{ x, y }],
    };
  }

  // ========== 橡皮擦 ==========

  private startErase(x: number, y: number) {
    this.isDrawing = true;
    this.eraseAt(x, y);
  }

  private eraseAt(x: number, y: number) {
    const eraseRadius = 15;
    const toRemove: number[] = [];

    this.data.strokes.forEach((stroke, si) => {
      for (const p of stroke.points) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (Math.sqrt(dx * dx + dy * dy) < eraseRadius) {
          toRemove.push(si);
          break;
        }
      }
    });

    if (toRemove.length > 0) {
      // 去重并降序删除
      const unique = [...new Set(toRemove)].sort((a, b) => b - a);
      unique.forEach((idx) => {
        this.data.strokes.splice(idx, 1);
      });
      this.render();
      this.debouncedSave();
    }
  }

  // ========== 形状工具 ==========

  private startShape(x: number, y: number) {
    this.isDrawing = true;
    this.shapeStart = { x, y };
    this.currentShape = {
      id: `shape_${Date.now()}`,
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

  // ========== 便签 ==========

  private createNote(x: number, y: number) {
    const note: Note = {
      id: `note_${Date.now()}`,
      x,
      y,
      text: "点击编辑便签...",
      color: "#fff9c4",
      width: 160,
      height: 100,
    };
    this.data.notes.push(note);
    this.renderNoteElement(note);
    this.debouncedSave();
  }

  private renderNoteElement(note: Note) {
    const el = document.createElement("div");
    el.className = "draft-note";
    el.id = note.id;
    el.contentEditable = "true";
    el.textContent = note.text;
    el.style.left = `${note.x}px`;
    el.style.top = `${note.y}px`;
    el.style.width = `${note.width}px`;
    el.style.height = `${note.height}px`;
    el.style.background = note.color;

    // 更新数据
    el.addEventListener("input", () => {
      note.text = el.textContent || "";
      this.debouncedSave();
    });

    // 拖拽移动
    let dragging = false;
    let dragOffset = { x: 0, y: 0 };
    el.addEventListener("mousedown", (e) => {
      if (this.currentTool !== "cursor") return;
      dragging = true;
      dragOffset.x = e.clientX - el.offsetLeft;
      dragOffset.y = e.clientY - el.offsetTop;
      e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const nx = e.clientX - dragOffset.x;
      const ny = e.clientY - dragOffset.y;
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
      note.x = nx;
      note.y = ny;
    });
    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        this.debouncedSave();
      }
    });

    this.notesContainer.appendChild(el);
  }

  // ========== 截图 ==========

  private screenshotStart = { x: 0, y: 0 };
  private screenshotRect: HTMLElement | null = null;

  private startScreenshot(x: number, y: number) {
    this.isDrawing = true;
    this.screenshotStart = { x, y };
    this.screenshotRect = document.createElement("div");
    this.screenshotRect.style.position = "absolute";
    this.screenshotRect.style.border = "2px dashed #5B8DEF";
    this.screenshotRect.style.background = "rgba(91, 141, 239, 0.1)";
    this.screenshotRect.style.pointerEvents = "none";
    this.screenshotRect.style.zIndex = "10";
    this.notesContainer.appendChild(this.screenshotRect);
  }

  // updateScreenshot 在 mousemove 中通过 updateShape 间接调用
  private updateScreenshot(x: number, y: number) {
    if (!this.screenshotRect) return;
    const left = Math.min(this.screenshotStart.x, x);
    const top = Math.min(this.screenshotStart.y, y);
    const w = Math.abs(x - this.screenshotStart.x);
    const h = Math.abs(y - this.screenshotStart.y);
    this.screenshotRect.style.left = `${left}px`;
    this.screenshotRect.style.top = `${top}px`;
    this.screenshotRect.style.width = `${w}px`;
    this.screenshotRect.style.height = `${h}px`;
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
      id: `screenshot_${Date.now()}`,
      x,
      y,
      w,
      h,
      dataUrl,
    };
    this.data.screenshots.push(screenshot);
    this.renderScreenshotElement(screenshot);
    this.debouncedSave();
  }

  private renderScreenshotElement(sc: Screenshot) {
    const el = document.createElement("div");
    el.className = "draft-screenshot";
    el.id = sc.id;
    el.style.left = `${sc.x}px`;
    el.style.top = `${sc.y}px`;
    el.style.width = `${sc.w}px`;
    el.style.height = `${sc.h}px`;

    const img = document.createElement("img");
    img.src = sc.dataUrl;
    el.appendChild(img);

    // 拖拽
    let dragging = false;
    let dragOffset = { x: 0, y: 0 };
    el.addEventListener("mousedown", (e) => {
      if (this.currentTool !== "cursor") return;
      dragging = true;
      dragOffset.x = e.clientX - el.offsetLeft;
      dragOffset.y = e.clientY - el.offsetTop;
      e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = `${e.clientX - dragOffset.x}px`;
      el.style.top = `${e.clientY - dragOffset.y}px`;
      sc.x = e.clientX - dragOffset.x;
      sc.y = e.clientY - dragOffset.y;
    });
    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        this.debouncedSave();
      }
    });

    this.notesContainer.appendChild(el);
  }

  // ========== 绘制完成 ==========

  private finishDrawing() {
    this.isDrawing = false;

    if (this.currentStroke) {
      this.data.strokes.push(this.currentStroke);
      this.currentStroke = null;
      this.debouncedSave();
    }

    if (this.currentShape) {
      this.data.shapes.push(this.currentShape);
      this.currentShape = null;
      this.debouncedSave();
    }

    if (this.currentTool === "screenshot" && this.screenshotRect) {
      this.finishScreenshot();
    }
  }

  // ========== 渲染 ==========

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.translate(this.viewport.x, this.viewport.y);
    ctx.scale(this.viewport.scale, this.viewport.scale);

    // 绘制所有 strokes
    for (const stroke of this.data.strokes) {
      this.drawStroke(stroke);
    }

    // 绘制当前 stroke
    if (this.currentStroke) {
      this.drawStroke(this.currentStroke);
    }

    // 绘制所有 shapes
    for (const shape of this.data.shapes) {
      this.drawShape(shape);
    }

    // 绘制当前 shape
    if (this.currentShape) {
      this.drawShape(this.currentShape);
    }

    ctx.restore();
  }

  private drawStroke(stroke: Stroke) {
    if (stroke.points.length < 2) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width / this.viewport.scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (stroke.tool === "marker") {
      ctx.globalAlpha = 0.5;
    } else {
      ctx.globalAlpha = 1;
    }

    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawShape(shape: Shape) {
    const ctx = this.ctx;
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
      shape.x2 !== undefined &&
      shape.y2 !== undefined
    ) {
      ctx.beginPath();
      ctx.moveTo(shape.x, shape.y);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();

      if (shape.type === "arrow") {
        this.drawArrowHead(shape.x, shape.y, shape.x2, shape.y2);
      }
    }
  }

  private drawArrowHead(x1: number, y1: number, x2: number, y2: number) {
    const ctx = this.ctx;
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

  // ========== 数据管理 ==========

  setData(data: DraftData) {
    this.clear();
    this.data = data;
    this.render();
    this.renderNotes();
    this.renderScreenshots();
  }

  getData(): DraftData {
    return JSON.parse(JSON.stringify(this.data));
  }

  clear() {
    this.data = { strokes: [], shapes: [], notes: [], screenshots: [] };
    this.currentStroke = null;
    this.currentShape = null;
    this.isDrawing = false;

    // 清除DOM元素
    this.notesContainer.querySelectorAll(".draft-note, .draft-screenshot, .draft-mini-canvas").forEach((el) => el.remove());

    this.render();
  }

  private renderNotes() {
    this.notesContainer.querySelectorAll(".draft-note").forEach((el) => el.remove());
    for (const note of this.data.notes) {
      this.renderNoteElement(note);
    }
  }

  private renderScreenshots() {
    this.notesContainer.querySelectorAll(".draft-screenshot").forEach((el) => el.remove());
    for (const sc of this.data.screenshots) {
      this.renderScreenshotElement(sc);
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
        data: JSON.stringify(this.data),
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
    this.render();
  }

  deactivate() {
    this.isActive = false;
    this.canvas.classList.remove("active");
  }

  isActivated(): boolean {
    return this.isActive;
  }
}
