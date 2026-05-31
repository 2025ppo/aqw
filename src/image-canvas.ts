// image-canvas.ts
// 图像处理视图 - 复用现有无限画布

// 复用现有画布的 #canvas-viewport SVG <g> 元素
// import { getCanvas } from "./canvas";

interface ImageNode {
  id: string;
  x: number;
  y: number;
  label: string;
  src: string;        // 图片路径或base64
  width: number;
  height: number;
}

interface ImageConnection {
  id: string;
  fromId: string;
  toId: string;
  label: string;
}

class ImageCanvasController {
  private nodes: ImageNode[] = [];
  private connections: ImageConnection[] = [];
  private svgElements: SVGElement[] = [];  // 当前渲染的SVG元素引用
  private active: boolean = false;

  constructor() {
    this.bindEvents();
  }

  private bindEvents(): void {
    // 监听视图切换
    window.addEventListener("view-changed", (e: any) => {
      if (e.detail?.view === "image") {
        this.activate();
      } else {
        this.deactivate();
      }
    });

    // 添加图片按钮
    document.getElementById("canvas-image-add-btn")?.addEventListener("click", () => {
      // 触发文件选择或等待AI添加
    });
  }

  private activate(): void {
    this.active = true;
    this.render();
    this.updateNodeList();
  }

  private deactivate(): void {
    this.active = false;
    this.clearRendered();
  }

  // 在现有 #canvas-viewport 中渲染图像节点
  private render(): void {
    this.clearRendered();
    const viewport = document.getElementById("canvas-viewport");
    if (!viewport) return;

    // 渲染连线
    for (const conn of this.connections) {
      const fromNode = this.nodes.find(n => n.id === conn.fromId);
      const toNode = this.nodes.find(n => n.id === conn.toId);
      if (!fromNode || !toNode) continue;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const x1 = fromNode.x + fromNode.width / 2;
      const y1 = fromNode.y + fromNode.height / 2;
      const x2 = toNode.x + toNode.width / 2;
      const y2 = toNode.y + toNode.height / 2;
      const mx = (x1 + x2) / 2;
      path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      path.setAttribute("stroke", "#666");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      path.setAttribute("marker-end", "url(#arrowhead)");
      path.classList.add("image-canvas-element");
      viewport.appendChild(path);
      this.svgElements.push(path);
    }

    // 渲染节点
    for (const node of this.nodes) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("transform", `translate(${node.x}, ${node.y})`);
      g.classList.add("image-canvas-element");
      g.style.cursor = "pointer";

      // 节点背景矩形
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("width", String(node.width));
      rect.setAttribute("height", String(node.height));
      rect.setAttribute("rx", "8");
      rect.setAttribute("fill", "#2a2a2a");
      rect.setAttribute("stroke", "#555");
      rect.setAttribute("stroke-width", "1.5");
      g.appendChild(rect);

      // 图片（如果有src）
      if (node.src) {
        const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
        img.setAttribute("x", "4");
        img.setAttribute("y", "4");
        img.setAttribute("width", String(node.width - 8));
        img.setAttribute("height", String(node.height - 28));
        img.setAttribute("href", node.src);
        img.setAttribute("preserveAspectRatio", "xMidYMid meet");
        g.appendChild(img);
      }

      // 标签
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(node.width / 2));
      text.setAttribute("y", String(node.height - 8));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", "#ccc");
      text.setAttribute("font-size", "11");
      text.textContent = node.label;
      g.appendChild(text);

      viewport.appendChild(g);
      this.svgElements.push(g);
    }
  }

  private clearRendered(): void {
    for (const el of this.svgElements) {
      el.remove();
    }
    this.svgElements = [];
  }

  // 更新右侧节点列表
  private updateNodeList(): void {
    const list = document.getElementById("image-node-list");
    if (!list) return;
    list.innerHTML = this.nodes.map(n => `
      <div class="repo-nav-item" data-id="${n.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>${n.label}</span>
      </div>
    `).join("");
  }

  // === 公共 API（供 ACTION 系统调用） ===

  public addNode(src: string, label: string, x?: number, y?: number): string {
    const id = "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    const node: ImageNode = {
      id,
      x: x ?? Math.random() * 400 + 50,
      y: y ?? Math.random() * 300 + 50,
      label,
      src,
      width: 160,
      height: 140,
    };
    this.nodes.push(node);
    if (this.active) {
      this.render();
      this.updateNodeList();
    }
    return id;
  }

  public connect(fromId: string, toId: string, label?: string): void {
    const id = "conn-" + Date.now();
    this.connections.push({ id, fromId, toId, label: label || "" });
    if (this.active) this.render();
  }

  public removeNode(id: string): void {
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.connections = this.connections.filter(c => c.fromId !== id && c.toId !== id);
    if (this.active) {
      this.render();
      this.updateNodeList();
    }
  }

  public getState(): { nodes: ImageNode[]; connections: ImageConnection[] } {
    return { nodes: [...this.nodes], connections: [...this.connections] };
  }

  public setSelection(rect: { x: number; y: number; width: number; height: number }): void {
    // 选区功能预留 - 后续编辑模式使用
    void rect;
  }

  public getSelection(): { x: number; y: number; width: number; height: number } | null {
    return null;
  }
}

// 初始化
const imageController = new ImageCanvasController();

// 暴露全局API
(window as any).__imageCanvas = {
  addNode: (src: string, label: string, x?: number, y?: number) => imageController.addNode(src, label, x, y),
  connect: (from: string, to: string, label?: string) => imageController.connect(from, to, label),
  removeNode: (id: string) => imageController.removeNode(id),
  getState: () => imageController.getState(),
  setSelection: (rect: any) => imageController.setSelection(rect),
  getSelection: () => imageController.getSelection(),
};
