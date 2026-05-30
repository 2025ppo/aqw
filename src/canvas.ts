// ========== 无限画布核心逻辑 ==========

export interface CanvasNode {
  id: string;
  type: "folder" | "file";
  name: string;
  x: number;
  y: number;
}

export interface CanvasEdge {
  from: string;
  to: string;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const NODE_COLORS: Record<string, string> = {
  folder: "#FF8C42",
  file: "#4CAF50",
};

const NODE_RADIUS = 16;

export class InfiniteCanvas {
  private svg: SVGSVGElement;
  private viewport: SVGGElement;
  private scaleEl: HTMLElement;

  private view: Viewport = { x: 0, y: 0, scale: 1 };
  private nodes: CanvasNode[] = [];
  private edges: CanvasEdge[] = [];

  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private isDraggingNode = false;
  private draggedNode: CanvasNode | null = null;
  private dragOffset = { x: 0, y: 0 };

  constructor() {
    this.svg = document.getElementById("workspace-canvas") as unknown as SVGSVGElement;
    this.viewport = document.getElementById("canvas-viewport") as unknown as SVGGElement;
    this.scaleEl = document.getElementById("canvas-scale") as HTMLElement;

    this.bindEvents();
    this.updateTransform();
  }

  // 绑定事件
  private bindEvents() {
    // 滚轮缩放
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.1, Math.min(5, this.view.scale * zoomFactor));

      // 以鼠标位置为中心缩放
      this.view.x = mouseX - (mouseX - this.view.x) * (newScale / this.view.scale);
      this.view.y = mouseY - (mouseY - this.view.y) * (newScale / this.view.scale);
      this.view.scale = newScale;

      this.updateTransform();
    });

    // 鼠标按下
    this.svg.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      const nodeEl = target.closest(".canvas-node") as HTMLElement;

      if (nodeEl) {
        // 拖拽节点
        const nodeId = nodeEl.dataset.id;
        this.draggedNode = this.nodes.find((n) => n.id === nodeId) || null;
        if (this.draggedNode) {
          this.isDraggingNode = true;
          const rect = this.svg.getBoundingClientRect();
          const mouseX = (e.clientX - rect.left - this.view.x) / this.view.scale;
          const mouseY = (e.clientY - rect.top - this.view.y) / this.view.scale;
          this.dragOffset.x = mouseX - this.draggedNode.x;
          this.dragOffset.y = mouseY - this.draggedNode.y;
        }
      } else {
        // 平移画布
        this.isPanning = true;
        this.panStart.x = e.clientX - this.view.x;
        this.panStart.y = e.clientY - this.view.y;
      }
    });

    // 鼠标移动
    window.addEventListener("mousemove", (e) => {
      if (this.isPanning) {
        this.view.x = e.clientX - this.panStart.x;
        this.view.y = e.clientY - this.panStart.y;
        this.updateTransform();
      } else if (this.isDraggingNode && this.draggedNode) {
        const rect = this.svg.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left - this.view.x) / this.view.scale;
        const mouseY = (e.clientY - rect.top - this.view.y) / this.view.scale;
        this.draggedNode.x = mouseX - this.dragOffset.x;
        this.draggedNode.y = mouseY - this.dragOffset.y;
        this.render();
      }
    });

    // 鼠标抬起
    window.addEventListener("mouseup", () => {
      this.isPanning = false;
      this.isDraggingNode = false;
      this.draggedNode = null;
    });

      // 点击缩放比例重置并定位到可见区域（偏右，避开左侧对话区）
    this.scaleEl?.addEventListener("click", () => {
      this.focusOnContent();
    });

    // 回正按钮：一键定位到节点中心
    const resetBtn = document.getElementById("canvas-reset");
    resetBtn?.addEventListener("click", () => {
      this.focusOnContent();
    });
  }

  // 定位到内容区域（自动缩放适配，偏右避开左侧悬浮对话区）
  focusOnContent() {
    if (this.nodes.length === 0) {
      // 无节点时定位到默认偏右位置
      this.view = { x: 280, y: 0, scale: 1 };
      this.updateTransform();
      return;
    }

    // 计算所有节点的包围盒（含 padding）
    const PADDING = 80;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    this.nodes.forEach((node) => {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    });

    const nodeWidth = maxX - minX + PADDING * 2;
    const nodeHeight = maxY - minY + PADDING * 2;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // 获取画布可视区域尺寸
    const rect = this.svg.getBoundingClientRect();
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;

    // 左侧对话区占据约 437px，有效可视区域
    const visibleLeft = 437;
    const visibleWidth = canvasWidth - visibleLeft;
    const visibleHeight = canvasHeight;

    // 计算适配缩放
    const scaleX = visibleWidth / nodeWidth;
    const scaleY = visibleHeight / nodeHeight;
    let scale = Math.min(scaleX, scaleY, 1.0);
    scale = Math.max(0.3, Math.min(1.5, scale));

    // 用新 scale 计算 view 位置，使内容中心对齐可视区域中心
    const visibleCenterX = (canvasWidth + visibleLeft) / 2;
    const visibleCenterY = canvasHeight / 2;

    this.view = {
      x: visibleCenterX - centerX * scale,
      y: visibleCenterY - centerY * scale,
      scale,
    };
    this.updateTransform();
  }

  // 更新视口变换
  private updateTransform() {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.view.x}, ${this.view.y}) scale(${this.view.scale})`
    );
    if (this.scaleEl) {
      this.scaleEl.textContent = `${Math.round(this.view.scale * 100)}%`;
    }
    // 同步草稿画布视口
    window.dispatchEvent(new CustomEvent("canvas-viewport-changed", {
      detail: { x: this.view.x, y: this.view.y, scale: this.view.scale }
    }));
  }

  // 设置数据并渲染
  setData(nodes: CanvasNode[], edges: CanvasEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
    this.render();
    // 自动定位到内容区域
    this.focusOnContent();
  }

  // 添加单个节点
  addNode(node: CanvasNode) {
    this.nodes.push(node);
    this.render();
  }

  // 添加单个连线
  addEdge(edge: CanvasEdge) {
    this.edges.push(edge);
    this.render();
  }

  // 清空画布
  clear() {
    this.nodes = [];
    this.edges = [];
    this.render();
  }

  // 渲染画布
  private render() {
    this.viewport.innerHTML = "";

    // 渲染连线（在节点下方）
    this.edges.forEach((edge) => {
      const fromNode = this.nodes.find((n) => n.id === edge.from);
      const toNode = this.nodes.find((n) => n.id === edge.to);
      if (!fromNode || !toNode) return;

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(fromNode.x));
      line.setAttribute("y1", String(fromNode.y));
      line.setAttribute("x2", String(toNode.x));
      line.setAttribute("y2", String(toNode.y));
      line.setAttribute("class", "canvas-edge");
      this.viewport.appendChild(line);
    });

    // 渲染节点
    this.nodes.forEach((node) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "canvas-node");
      g.setAttribute("data-id", node.id);
      g.setAttribute("transform", `translate(${node.x}, ${node.y})`);

      // 圆形
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", String(NODE_RADIUS));
      circle.setAttribute("fill", NODE_COLORS[node.type] || "#999");
      circle.setAttribute("class", "node-circle");
      g.appendChild(circle);

      // 文字标签
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("y", String(NODE_RADIUS + 14));
      text.setAttribute("class", "node-label");
      // 截断过长文件名，避免标签重叠
      const displayName = node.name.length > 14 ? node.name.slice(0, 12) + "…" : node.name;
      text.textContent = displayName;
      g.appendChild(text);

      // 点击事件 - 文件节点打开预览
      if (node.type === "file") {
        g.style.cursor = "pointer";
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          (window as any).openFilePreview?.(node.name);
        });
      }

      this.viewport.appendChild(g);
    });
  }
}

// 全局实例
let canvasInstance: InfiniteCanvas | null = null;

export function initCanvas(): InfiniteCanvas {
  if (!canvasInstance) {
    canvasInstance = new InfiniteCanvas();
  }
  return canvasInstance;
}

export function getCanvas(): InfiniteCanvas | null {
  return canvasInstance;
}

// ========== 文件预览子画布 ==========

export interface DocBlock {
  id: string;
  title: string;
  level: number;
  content: string;
  children: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
}

interface FCViewport {
  x: number;
  y: number;
  scale: number;
}

const BLOCK_WIDTH = 280;
const BLOCK_MIN_HEIGHT = 100;
const BLOCK_COLLAPSED_HEIGHT = 80;
const BLOCK_GAP_X = 40;
const BLOCK_GAP_Y = 80;

export class FileCanvas {
  private svg: SVGSVGElement;
  private viewport: SVGGElement;
  private blocks: DocBlock[] = [];
  private edges: { from: string; to: string }[] = [];

  private view: FCViewport = { x: 0, y: 0, scale: 1 };
  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private isDragging = false;
  private draggedBlock: DocBlock | null = null;
  private dragOffset = { x: 0, y: 0 };

  constructor() {
    this.svg = document.getElementById("file-canvas-svg") as unknown as SVGSVGElement;
    this.viewport = document.getElementById("file-canvas-viewport") as unknown as SVGGElement;
    this.bindEvents();
  }

  private bindEvents() {
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.1, Math.min(3, this.view.scale * zoomFactor));
      this.view.x = mouseX - (mouseX - this.view.x) * (newScale / this.view.scale);
      this.view.y = mouseY - (mouseY - this.view.y) * (newScale / this.view.scale);
      this.view.scale = newScale;
      this.updateTransform();
    });

    this.svg.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      const blockEl = target.closest(".doc-block-wrap") as HTMLElement;
      if (blockEl) {
        const blockId = blockEl.dataset.blockId;
        const block = this.blocks.find((b) => b.id === blockId);
        if (block) {
          this.isDragging = true;
          this.draggedBlock = block;
          const rect = this.svg.getBoundingClientRect();
          const mx = (e.clientX - rect.left - this.view.x) / this.view.scale;
          const my = (e.clientY - rect.top - this.view.y) / this.view.scale;
          this.dragOffset.x = mx - block.x;
          this.dragOffset.y = my - block.y;
          return;
        }
      }
      this.isPanning = true;
      this.panStart.x = e.clientX - this.view.x;
      this.panStart.y = e.clientY - this.view.y;
    });

    window.addEventListener("mousemove", (e) => {
      if (this.isPanning) {
        this.view.x = e.clientX - this.panStart.x;
        this.view.y = e.clientY - this.panStart.y;
        this.updateTransform();
      } else if (this.isDragging && this.draggedBlock) {
        const rect = this.svg.getBoundingClientRect();
        this.draggedBlock.x = (e.clientX - rect.left - this.view.x) / this.view.scale - this.dragOffset.x;
        this.draggedBlock.y = (e.clientY - rect.top - this.view.y) / this.view.scale - this.dragOffset.y;
        this.render();
      }
    });

    window.addEventListener("mouseup", () => {
      this.isPanning = false;
      this.isDragging = false;
      this.draggedBlock = null;
    });
  }

  private updateTransform() {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.view.x}, ${this.view.y}) scale(${this.view.scale})`
    );
  }

  setData(blocks: DocBlock[], edges: { from: string; to: string }[]) {
    this.blocks = blocks;
    this.edges = edges;
    this.autoLayout();
    this.render();
  }

  private autoLayout() {
    const rootBlocks = this.blocks.filter((b) => b.level === 1);
    let maxH = 0;

    rootBlocks.forEach((root, ri) => {
      root.x = 40 + ri * (BLOCK_WIDTH + BLOCK_GAP_X);
      root.y = 20;
      root.w = BLOCK_WIDTH;
      root.h = root.collapsed ? BLOCK_COLLAPSED_HEIGHT : BLOCK_MIN_HEIGHT;

      const children = root.children
        .map((cid) => this.blocks.find((b) => b.id === cid))
        .filter(Boolean) as DocBlock[];

      const totalH = this.layoutChildren(children, root.x, root.y + root.h + BLOCK_GAP_Y);
      const blockH = root.h + BLOCK_GAP_Y + totalH;
      if (blockH > maxH) maxH = blockH;
    });
  }

  private layoutChildren(children: DocBlock[], parentX: number, startY: number): number {
    let y = startY;
    children.forEach((child) => {
      child.x = parentX + 30;
      child.y = y;
      child.w = BLOCK_WIDTH - 30;
      child.h = child.collapsed ? BLOCK_COLLAPSED_HEIGHT : BLOCK_MIN_HEIGHT;
      y += child.h + 16;

      const subs = child.children
        .map((cid) => this.blocks.find((b) => b.id === cid))
        .filter(Boolean) as DocBlock[];
      if (subs.length > 0) {
        y += this.layoutChildren(subs, child.x, y);
      }
    });
    return y - startY;
  }

  toggleBlock(id: string) {
    const block = this.blocks.find((b) => b.id === id);
    if (!block) return;
    block.collapsed = !block.collapsed;
    // 不重新布局，只更新方块高度
    block.h = block.collapsed ? BLOCK_COLLAPSED_HEIGHT : BLOCK_MIN_HEIGHT;
    this.render();
  }

  clear() {
    this.blocks = [];
    this.edges = [];
    this.render();
  }

  private render() {
    this.viewport.innerHTML = "";

    // 渲染连线
    this.edges.forEach((edge) => {
      const from = this.blocks.find((b) => b.id === edge.from);
      const to = this.blocks.find((b) => b.id === edge.to);
      if (!from || !to) return;

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(from.x + from.w / 2));
      line.setAttribute("y1", String(from.y + from.h));
      line.setAttribute("x2", String(to.x + to.w / 2));
      line.setAttribute("y2", String(to.y));
      line.setAttribute("class", "fc-edge");
      this.viewport.appendChild(line);
    });

    // 渲染方块
    this.blocks.forEach((block) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "doc-block-wrap");
      g.setAttribute("data-block-id", block.id);
      g.setAttribute("transform", `translate(${block.x}, ${block.y})`);

      const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
      fo.setAttribute("width", String(block.w));
      // 为展开态预留更大高度
      const renderH = block.collapsed ? BLOCK_COLLAPSED_HEIGHT : Math.max(block.h, 200);
      fo.setAttribute("height", String(renderH));

      const contentHtml = this.buildBlockHtml(block);
      fo.innerHTML = contentHtml;
      g.appendChild(fo);

      this.viewport.appendChild(g);

      // 绑定展开/折叠事件
      setTimeout(() => {
        const toggleBtn = this.svg.querySelector(`[data-toggle-id="${block.id}"]`);
        if (toggleBtn) {
          toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.toggleBlock(block.id);
          });
        }
      }, 0);
    });
  }

  private buildBlockHtml(block: DocBlock): string {
    // 渲染内容为 HTML
    const bodyHtml = this.renderMdInline(block.content);
    const hasContent = block.content.trim().length > 0;
    const bodyClass = block.collapsed ? "doc-block-body" : "doc-block-body expanded";

    let html = `<div class="doc-block" xmlns="http://www.w3.org/1999/xhtml">`;
    html += `<div class="doc-block-title">${this.escapeHtml(block.title)}</div>`;
    html += `<div class="${bodyClass}">${bodyHtml}</div>`;
    if (hasContent) {
      const toggleLabel = block.collapsed ? "展开" : "折叠";
      html += `<div class="doc-block-toggle" data-toggle-id="${block.id}">${toggleLabel}</div>`;
    }
    html += `</div>`;
    return html;
  }

  private renderMdInline(md: string): string {
    let html = md;
    html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
    html = html.replace(/((?:<li>.*?<\/li>)+)/g, "<ul>$1</ul>");
    html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, "<p>$1</p>");
    html = html.replace(/<p><\/p>/g, "");
    return html;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
