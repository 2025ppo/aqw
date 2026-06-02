export type PromptScene =
  | "code-development"
  | "code-review"
  | "technical-research"
  | "design"
  | "quick-answer"
  | "translation"
  | "writing"
  | "office"
  | "data-analysis"
  | "document-processing"
  | "media-creation"
  | "video-production"
  | "research-with-search";

export type PromptModuleId =
  | "code-tool-primer"
  | "web-search-guidance"
  | "command-guidance"
  | "document-tool-primer"
  | "media-tool-primer"
  | "video-workflow"
  | "approval-guidance"
  | "patch-guidance";

export type PromptModuleHintMap = Partial<Record<string, PromptModuleId[]>>;

export interface PromptModuleTrace {
  expertId: string;
  scene: PromptScene;
  taskDescription: string;
  moduleIds: PromptModuleId[];
  triggerSources: string[];
  createdAt: number;
}

interface PromptModuleDefinition {
  id: PromptModuleId;
  text: string;
}

// 新增工具说明时，优先放进按需模块，而不是回填到专家常驻 prompt。
export const PROMPT_MODULES: Record<PromptModuleId, PromptModuleDefinition> = {
  "code-tool-primer": {
    id: "code-tool-primer",
    text: `【按需工具总则】
- 只有在结论依赖外部最新信息或本地验证时才调用工具，不需要就不要主动提工具。
- 一旦确定需要工具，不要只给建议，直接输出标准动作。
- 所有工具动作都必须带 reason，系统会把发起专家和理由展示给用户。

最小动作格式：
- 网络搜索：[ACTION:WEB_SEARCH query="搜索关键词" reason="为什么必须搜索"]
- 命令执行：[ACTION:EXECUTE_CMD command="具体命令" dir="工作目录" reason="为什么必须执行"]`,
  },
  "web-search-guidance": {
    id: "web-search-guidance",
    text: `【网络搜索细则】
- 仅在需要最新信息、外部事实、官方文档、版本兼容性或互联网资料时使用。
- 先想清楚最小必要查询，再搜索；关键词尽量具体，优先“产品/框架名 + 目标问题”。
- 搜索结果会自动注入你的后续推理，你应基于结果继续完成任务。`,
  },
  "command-guidance": {
    id: "command-guidance",
    text: `【命令执行细则】
- 适用于测试、构建、lint、依赖检查、日志排查、环境确认、版本核验与复现问题。
- dir 填最小必要工作目录；命令可能涉及受限或管理员授权，系统会拦截，你只需如实提出。
- 收到执行结果后，要把结果转化为结论，不要只复述输出。`,
  },
  "document-tool-primer": {
    id: "document-tool-primer",
    text: `【文档工具模块】
- 读取文档：[ACTION:READ_DOCUMENT path="文档路径"]
- 写入文档：[ACTION:WRITE_DOCUMENT path="文档路径" format="md|txt|docx" content="正文内容"]
- 仅在确实需要读取或生成文档文件时使用。`,
  },
  "media-tool-primer": {
    id: "media-tool-primer",
    text: `【媒体工具模块】
- 生成图像：[ACTION:GENERATE_IMAGE prompt="图像提示词" size="1024x1024"]
- 画布加节点：[ACTION:CANVAS_ADD_NODE type="file|note|image" src="说明或路径"]
- 画布连线：[ACTION:CANVAS_CONNECT from="节点ID" to="节点ID"]
- 只有在确实需要生成媒体或组织画布时使用。`,
  },
  "video-workflow": {
    id: "video-workflow",
    text: `【视频工作流模块】
当收到视频创作任务时，按以下流程执行：

### 第一步：镜头分段规划
基于调研报告和用户需求，将视频拆分为多个 5-10 秒的镜头段。输出结构：
\`\`\`
## 镜头分段计划
1. [镜头1名称]（预估X秒）：[描述画面内容、风格、转场]
2. [镜头2名称]（预估X秒）：[描述画面内容、风格、转场]
...
总计：约XX秒
\`\`\`
同时调用 [ACTION:VIDEO_SET_SEGMENTS] 将镜头分段同步到视频面板：
\`\`\`json
[{"label":"镜头1: 名称","description":"画面描述"},{"label":"镜头2: 名称","description":"画面描述"}]
\`\`\`

### 第二步：逐段生成
为每个镜头段编写详细的生成提示词，调用 [ACTION:VIDEO_UPDATE_SEGMENT] 更新生成状态：
\`\`\`json
{"id":"vseg-xxx","status":"generating"}
\`\`\`

### 第三步：拼接输出
所有镜头生成完成后，输出最终拼接方案。`,
  },
  "approval-guidance": {
    id: "approval-guidance",
    text: `【审批流程指南】
## 命令审批机制

你可以使用工具执行命令，但需要了解审批规则：
- **自动执行**: ls, dir, cat, git status, cargo check, npm run 等只读命令无需确认
- **需要确认**: 涉及文件写入、安装包、网络请求的命令会请求用户确认
- **被拦截**: rm -rf /, format c: 等危险命令将被系统拦截

当工具返回“需要用户确认”时，等待确认结果后再继续。不要重复尝试被拦截的命令。`,
  },
  "patch-guidance": {
    id: "patch-guidance",
    text: `## File Patch Format Instructions

You have access to a \`file_patch\` tool that can create, modify, delete, and move files using a structured patch format.

### Patch Format Syntax

\`\`\`
*** Begin Patch
[operations...]
*** End Patch
\`\`\`

### Operations

#### Create a new file:
\`\`\`
*** Add File: path/to/new/file.ts
+line 1 of new content
+line 2 of new content
+line 3 of new content
\`\`\`

#### Modify an existing file:
\`\`\`
*** Update File: path/to/existing/file.ts
@@ context_line_to_locate_position
 unchanged line (context, prefix with space)
-old line to remove
+new line to add
 another unchanged line
\`\`\`

#### Delete a file:
\`\`\`
*** Delete File: path/to/file.ts
\`\`\`

#### Move/Rename a file:
\`\`\`
*** Move to: path/to/new/location.ts
*** Update File: path/to/old/location.ts
\`\`\`

### Critical Rules

1. **Always use relative paths** — never use absolute paths like \`C:\\...\` or \`/home/...\`
2. **Every new/added line MUST have a \`+\` prefix** — even when creating a brand new file
3. **Context lines MUST have a space prefix** — not no prefix
4. **Provide exactly 3 lines of context** before and after each change for accurate positioning
5. **Use multiple \`@@\` sections** when the same file has changes in different locations
6. **For repeated/similar code blocks**, include enough unique context lines so the system can unambiguously locate the correct position
7. **Do NOT wrap the patch in JSON or markdown code fences** — output it directly as plain text
8. **End of file operations**: Use \`*** End of File\` marker when changes are at the very end

### Multiple Changes in One File

When a file needs changes in multiple locations, use multiple @@ sections:
\`\`\`
*** Update File: src/main.ts
@@ import { something } from
 import { something } from './module';
+import { newThing } from './new-module';

@@ function handleRequest
 function handleRequest(req: Request) {
-  const result = oldMethod(req);
+  const result = newMethod(req);
   return result;
 }
\`\`\`

### Important Tips
- If your patch fails, you will receive an error message with the actual file content near the target area. Use this to correct your context lines and retry.
- When editing large files, ensure your @@ context line is unique enough to avoid matching the wrong location.
- Prefer small, focused patches over large ones — split complex changes into multiple patches if needed.`,
  },
};

const ALL_PROMPT_MODULE_IDS = Object.keys(PROMPT_MODULES) as PromptModuleId[];

const EXPERT_STATIC_PROMPT_MODULES: Partial<Record<string, PromptModuleId[]>> = {
  "jiang-ruoxi": ["code-tool-primer"],
  "jiang-qinglan": ["code-tool-primer", "patch-guidance"],
  "jiang-yumo": ["code-tool-primer", "patch-guidance"],
  "jiang-subai": ["code-tool-primer", "patch-guidance"],
  "jiang-yingqiu": ["code-tool-primer"],
  "jiang-jianheng": ["code-tool-primer"],
  "jiang-cexun": ["code-tool-primer", "command-guidance"],
  "jiang-zhilan": ["document-tool-primer"],
  "jiang-huaying": ["media-tool-primer"],
};

const EXPERT_SUPPORTED_PROMPT_MODULES: Partial<Record<string, PromptModuleId[]>> = {
  "jiang-ruoxi": ["code-tool-primer", "web-search-guidance", "command-guidance"],
  "jiang-qinglan": ["code-tool-primer", "web-search-guidance", "command-guidance", "patch-guidance"],
  "jiang-yumo": ["code-tool-primer", "web-search-guidance", "command-guidance", "patch-guidance"],
  "jiang-subai": ["code-tool-primer", "web-search-guidance", "command-guidance", "patch-guidance"],
  "jiang-yingqiu": ["code-tool-primer", "web-search-guidance", "command-guidance"],
  "jiang-jianheng": ["code-tool-primer", "web-search-guidance", "command-guidance"],
  "jiang-cexun": ["code-tool-primer", "web-search-guidance", "command-guidance"],
  "jiang-zhilan": ["document-tool-primer"],
  "jiang-huaying": ["media-tool-primer", "video-workflow"],
};

const WEB_SEARCH_TRIGGER_KEYWORDS = [
  "最新", "最近", "官网", "官方", "文档", "release", "changelog", "版本", "兼容", "api",
  "接口", "框架", "库", "标准", "规范", "搜索", "联网", "外部", "资料", "新闻", "cve", "漏洞",
];
const COMMAND_TRIGGER_KEYWORDS = [
  "测试", "test", "build", "lint", "运行", "run", "启动", "日志", "环境", "依赖", "版本",
  "编译", "打包", "安装", "npm", "pnpm", "yarn", "cargo", "python", "node", "git", "shell",
  "cmd", "powershell", "bash", "终端", "命令", "控制台", "迁移", "server", "复现", "验证",
];
const VIDEO_TRIGGER_KEYWORDS = ["视频", "分镜", "镜头", "片段", "segment", "timeline", "storyboard"];
const SEARCH_INTENT_PATTERNS = [
  /需要.*搜索/,
  /建议.*搜索/,
  /查一下/,
  /查找/,
  /官方文档/,
  /最新资料/,
  /联网/,
];
const COMMAND_INTENT_PATTERNS = [
  /需要.*(?:运行|执行)/,
  /建议.*(?:运行|执行)/,
  /通过命令/,
  /运行.*(?:测试|命令|npm|pnpm|yarn|cargo)/,
  /执行.*(?:测试|命令|npm|pnpm|yarn|cargo)/,
  /终端/,
];
const SEARCH_NEGATION_PATTERNS = [
  /不需要.*(?:联网|搜索|外部资料|官方文档|最新资料)/,
  /无需.*(?:联网|搜索|外部资料|官方文档|最新资料)/,
  /不用.*(?:联网|搜索|外部资料|官方文档|最新资料)/,
  /不必.*(?:联网|搜索|外部资料|官方文档|最新资料)/,
  /不要.*(?:联网|搜索|外部资料|官方文档|最新资料)/,
];
const COMMAND_NEGATION_PATTERNS = [
  /不需要.*(?:运行|执行|命令|测试|构建|build|lint)/,
  /无需.*(?:运行|执行|命令|测试|构建|build|lint)/,
  /不用.*(?:运行|执行|命令|测试|构建|build|lint)/,
  /不必.*(?:运行|执行|命令|测试|构建|build|lint)/,
  /不要.*(?:运行|执行|命令|测试|构建|build|lint)/,
];
const VIDEO_NEGATION_PATTERNS = [
  /不需要.*(?:视频|分镜|镜头|storyboard)/,
  /无需.*(?:视频|分镜|镜头|storyboard)/,
  /不要.*(?:视频|分镜|镜头|storyboard)/,
];
const CODE_REVIEW_TRIGGER_KEYWORDS = [
  "审查", "审阅", "review", "回归风险", "代码评审", "检查改动", "风险确认",
];
const CODE_DEVELOPMENT_TRIGGER_KEYWORDS = [
  "修复", "实现", "开发", "修改", "构建", "编译", "测试", "运行", "页面", "组件",
  "接口", "样式", "报错", "白屏", "功能", "bug",
];
const TECHNICAL_RESEARCH_TRIGGER_KEYWORDS = [
  "调研", "研究", "分析", "方案", "可行性", "评估", "核对", "复核", "对比",
];
const DOCUMENT_PROCESSING_TRIGGER_KEYWORDS = [
  "文档", "docx", "word", "报告", "写作", "合同", "简历",
];
const MEDIA_CREATION_TRIGGER_KEYWORDS = [
  "海报", "图片", "图像", "视觉", "封面", "插画", "配图",
];

function includesAnyKeyword(text: string, keywords: string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function matchesAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function tokenizePromptText(text: string): string[] {
  const normalized = text.toLowerCase();
  const asciiTokens = normalized.match(/[a-z0-9_.#-]{2,}/g) || [];
  const chineseBlocks = normalized.match(/[\u4e00-\u9fff]{1,}/g) || [];
  const chineseTokens: string[] = [];
  for (const block of chineseBlocks) {
    for (let index = 0; index < block.length; index++) {
      chineseTokens.push(block[index]);
      if (index + 1 < block.length) chineseTokens.push(block.slice(index, index + 2));
      if (index + 2 < block.length) chineseTokens.push(block.slice(index, index + 3));
    }
  }
  return [...asciiTokens, ...chineseTokens].slice(0, 120);
}

export function isPromptModuleId(value: string): value is PromptModuleId {
  return (ALL_PROMPT_MODULE_IDS as string[]).includes(value);
}

export function normalizePromptModuleIds(values: unknown): PromptModuleId[] {
  if (!Array.isArray(values)) return [];
  const unique = new Set<PromptModuleId>();
  for (const value of values) {
    if (typeof value === "string" && isPromptModuleId(value)) {
      unique.add(value);
    }
  }
  return [...unique];
}

export function normalizePromptModuleHintMap(raw: unknown): PromptModuleHintMap {
  if (!raw || typeof raw !== "object") return {};
  const result: PromptModuleHintMap = {};
  for (const [expertId, moduleIds] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizePromptModuleIds(moduleIds);
    if (normalized.length > 0) {
      result[expertId] = normalized;
    }
  }
  return result;
}

export function normalizePromptModuleTrace(raw: unknown): PromptModuleTrace | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const expertId = typeof data.expertId === "string" ? data.expertId : "";
  const scene = typeof data.scene === "string" ? data.scene as PromptScene : "quick-answer";
  const taskDescription = typeof data.taskDescription === "string" ? data.taskDescription : "";
  const moduleIds = normalizePromptModuleIds(data.moduleIds);
  const triggerSources = Array.isArray(data.triggerSources)
    ? data.triggerSources.filter((value): value is string => typeof value === "string")
    : [];
  const createdAt = typeof data.createdAt === "number" ? data.createdAt : Date.now();

  if (!expertId || !taskDescription || moduleIds.length === 0) return null;
  return {
    expertId,
    scene,
    taskDescription,
    moduleIds,
    triggerSources,
    createdAt,
  };
}

export function normalizePromptModuleTraces(raw: unknown): PromptModuleTrace[] {
  if (!Array.isArray(raw)) return [];
  const traces: PromptModuleTrace[] = [];
  for (const item of raw) {
    const normalized = normalizePromptModuleTrace(item);
    if (normalized) traces.push(normalized);
  }
  return traces;
}

export function getSupportedPromptModulesForExpert(expertId: string): PromptModuleId[] {
  return [...(EXPERT_SUPPORTED_PROMPT_MODULES[expertId] || EXPERT_STATIC_PROMPT_MODULES[expertId] || [])];
}

export function sanitizePromptModuleTaskDescription(taskDescription: string): string {
  return taskDescription
    .split("【共享黑板")[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function selectPromptModules(
  expertId: string,
  scene: PromptScene,
  taskDescription: string
): PromptModuleId[] {
  const modules = new Set<PromptModuleId>(EXPERT_STATIC_PROMPT_MODULES[expertId] || []);
  const hasCodeToolPrimer = modules.has("code-tool-primer");

  if (hasCodeToolPrimer) {
    const searchKeywordHit =
      includesAnyKeyword(taskDescription, WEB_SEARCH_TRIGGER_KEYWORDS)
      && !matchesAnyPattern(taskDescription, SEARCH_NEGATION_PATTERNS);
    const commandKeywordHit =
      includesAnyKeyword(taskDescription, COMMAND_TRIGGER_KEYWORDS)
      && !matchesAnyPattern(taskDescription, COMMAND_NEGATION_PATTERNS);
    const needsSearchGuidance = scene === "research-with-search" || searchKeywordHit;
    const needsCommandGuidance = scene === "code-review" || commandKeywordHit;

    if (needsSearchGuidance) modules.add("web-search-guidance");
    if (needsCommandGuidance) modules.add("command-guidance");
  }

  if (expertId === "jiang-huaying") {
    const needsVideoWorkflow =
      scene === "video-production"
      || (
        includesAnyKeyword(taskDescription, VIDEO_TRIGGER_KEYWORDS)
        && !matchesAnyPattern(taskDescription, VIDEO_NEGATION_PATTERNS)
      );
    if (needsVideoWorkflow) modules.add("video-workflow");
  }

  return [...modules];
}

export function assemblePromptFromModules(basePrompt: string, moduleIds: PromptModuleId[]): string {
  const moduleTexts = moduleIds.map((id) => PROMPT_MODULES[id]?.text).filter(Boolean);
  return [basePrompt.trim(), ...moduleTexts].join("\n\n");
}

export function buildExpertPromptPlan(
  expertId: string,
  basePrompt: string,
  scene: PromptScene,
  taskDescription: string,
  hintModuleIds: PromptModuleId[] = []
): { prompt: string; moduleIds: PromptModuleId[] } {
  const supportedModuleIds = new Set(getSupportedPromptModulesForExpert(expertId));
  const filteredHintModuleIds = normalizePromptModuleIds(hintModuleIds)
    .filter((moduleId) => supportedModuleIds.has(moduleId));
  const moduleIds = [...new Set([
    ...selectPromptModules(expertId, scene, taskDescription),
    ...filteredHintModuleIds,
  ])];
  return {
    prompt: assemblePromptFromModules(basePrompt, moduleIds),
    moduleIds,
  };
}

export function inferPromptSceneFromTaskText(
  taskDescription: string,
  moduleIds: PromptModuleId[] = []
): PromptScene {
  const normalizedTask = sanitizePromptModuleTaskDescription(taskDescription);
  const hasWebSearchGuidance = moduleIds.includes("web-search-guidance");
  const hasCommandGuidance = moduleIds.includes("command-guidance");
  const hasVideoWorkflow = moduleIds.includes("video-workflow");

  if (
    hasVideoWorkflow
    || (
      includesAnyKeyword(normalizedTask, VIDEO_TRIGGER_KEYWORDS)
      && !matchesAnyPattern(normalizedTask, VIDEO_NEGATION_PATTERNS)
    )
  ) {
    return "video-production";
  }

  if (includesAnyKeyword(normalizedTask, DOCUMENT_PROCESSING_TRIGGER_KEYWORDS)) {
    return "document-processing";
  }

  if (includesAnyKeyword(normalizedTask, MEDIA_CREATION_TRIGGER_KEYWORDS)) {
    return "media-creation";
  }

  if (includesAnyKeyword(normalizedTask, CODE_REVIEW_TRIGGER_KEYWORDS)) {
    return "code-review";
  }

  const searchKeywordHit =
    includesAnyKeyword(normalizedTask, WEB_SEARCH_TRIGGER_KEYWORDS)
    && !matchesAnyPattern(normalizedTask, SEARCH_NEGATION_PATTERNS);
  const commandKeywordHit =
    includesAnyKeyword(normalizedTask, COMMAND_TRIGGER_KEYWORDS)
    && !matchesAnyPattern(normalizedTask, COMMAND_NEGATION_PATTERNS);
  const researchKeywordHit = includesAnyKeyword(normalizedTask, TECHNICAL_RESEARCH_TRIGGER_KEYWORDS);
  const developmentKeywordHit = includesAnyKeyword(normalizedTask, CODE_DEVELOPMENT_TRIGGER_KEYWORDS);

  if ((hasWebSearchGuidance || searchKeywordHit) && (researchKeywordHit || !hasCommandGuidance && !commandKeywordHit)) {
    return "research-with-search";
  }

  if (hasCommandGuidance || commandKeywordHit || developmentKeywordHit) {
    return "code-development";
  }

  if (researchKeywordHit) {
    return hasWebSearchGuidance ? "research-with-search" : "technical-research";
  }

  return "quick-answer";
}

export function buildPromptModuleTraceSignature(trace: PromptModuleTrace): string {
  const normalizedTaskDescription = sanitizePromptModuleTaskDescription(trace.taskDescription).toLowerCase();
  const moduleIds = [...normalizePromptModuleIds(trace.moduleIds)].sort().join(",");
  const triggerSources = [...new Set(trace.triggerSources.filter((value): value is string => typeof value === "string"))]
    .sort()
    .join(",");
  return [
    trace.expertId,
    trace.scene,
    normalizedTaskDescription,
    moduleIds,
    triggerSources,
  ].join("||");
}

export function suggestPromptModuleHintsFromHistory(
  traces: PromptModuleTrace[],
  expertId: string,
  scene: PromptScene,
  taskDescription: string,
  maxModules = 2
): PromptModuleId[] {
  const relevantTraces = traces.filter((trace) => trace.expertId === expertId);
  if (relevantTraces.length === 0) return [];

  const currentTokens = new Set(tokenizePromptText(taskDescription));
  const moduleScores = new Map<PromptModuleId, number>();

  for (const trace of relevantTraces) {
    const traceTokens = new Set(tokenizePromptText(trace.taskDescription));
    let overlapCount = 0;
    for (const token of currentTokens) {
      if (traceTokens.has(token)) overlapCount++;
    }

    const sceneScore =
      trace.scene === scene
        ? 1
        : trace.scene.startsWith("code") && scene.startsWith("code")
          ? 0.35
          : 0;
    const overlapScore = overlapCount === 0
      ? 0
      : overlapCount / Math.max(4, Math.min(currentTokens.size + traceTokens.size, 18));
    const totalScore = sceneScore + overlapScore * 4;

    if (totalScore < 0.9) continue;

    for (const moduleId of trace.moduleIds) {
      moduleScores.set(moduleId, (moduleScores.get(moduleId) || 0) + totalScore);
    }
  }

  return [...moduleScores.entries()]
    .sort((left, right) => right[1] - left[1])
    .filter(([, score]) => score >= 0.9)
    .slice(0, maxModules)
    .map(([moduleId]) => moduleId);
}

function normalizeHistoricalToolEvent(raw: unknown): {
  expertId: string;
  moduleId: PromptModuleId;
  triggerSource: string;
  createdAt: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  const kind = typeof event.kind === "string" ? event.kind : "";
  const initiator = event.initiator && typeof event.initiator === "object"
    ? event.initiator as Record<string, unknown>
    : null;
  const expertId = initiator && typeof initiator.expertId === "string"
    ? initiator.expertId
    : "";
  const createdAt = typeof event.createdAt === "number" ? event.createdAt : Date.now();

  if (!expertId) return null;
  if (kind === "web-search") {
    return {
      expertId,
      moduleId: "web-search-guidance",
      triggerSource: "web-search",
      createdAt,
    };
  }
  if (kind === "command") {
    return {
      expertId,
      moduleId: "command-guidance",
      triggerSource: "command",
      createdAt,
    };
  }
  return null;
}

function normalizeHistoricalExpertTasks(raw: unknown): Array<{
  expertId: string;
  taskDescription: string;
  createdAt: number;
}> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((task) => {
      if (!task || typeof task !== "object") return null;
      const data = task as Record<string, unknown>;
      const expertId = typeof data.expertId === "string" ? data.expertId : "";
      const taskDescription = typeof data.input === "string" ? data.input : "";
      const createdAt = typeof data.startTime === "number"
        ? data.startTime
        : typeof data.endTime === "number"
          ? data.endTime
          : Date.now();
      if (!expertId || !taskDescription) return null;
      return {
        expertId,
        taskDescription,
        createdAt,
      };
    })
    .filter((value): value is { expertId: string; taskDescription: string; createdAt: number } => value !== null);
}

export function extractPromptModuleTracesFromSessions(rawSessions: unknown): PromptModuleTrace[] {
  if (!Array.isArray(rawSessions)) return [];

  const seenSignatures = new Set<string>();
  const traces: PromptModuleTrace[] = [];

  for (const rawSession of rawSessions as Array<Record<string, unknown>>) {
    const messages = Array.isArray(rawSession?.messages)
      ? rawSession.messages as Array<Record<string, unknown>>
      : [];
    const pendingEventsByExpert = new Map<string, Array<{
      moduleId: PromptModuleId;
      triggerSource: string;
      createdAt: number;
    }>>();
    const latestTaskByExpert = new Map<string, {
      taskDescription: string;
      createdAt: number;
    }>();

    const flushExpertTrace = (
      expertId: string,
      fallbackTaskDescription?: string,
      fallbackCreatedAt?: number
    ) => {
      const pendingEvents = pendingEventsByExpert.get(expertId);
      if (!pendingEvents || pendingEvents.length === 0) return;

      const latestTask = latestTaskByExpert.get(expertId);
      const normalizedTaskDescription = sanitizePromptModuleTaskDescription(
        fallbackTaskDescription || latestTask?.taskDescription || ""
      );
      if (!normalizedTaskDescription) return;

      const moduleIds = [...new Set(pendingEvents.map((event) => event.moduleId))];
      const triggerSources = [...new Set(pendingEvents.map((event) => event.triggerSource))];
      const createdAtCandidates = pendingEvents.map((event) => event.createdAt);
      if (latestTask?.createdAt) createdAtCandidates.push(latestTask.createdAt);
      if (typeof fallbackCreatedAt === "number") createdAtCandidates.push(fallbackCreatedAt);

      const trace = normalizePromptModuleTrace({
        expertId,
        scene: inferPromptSceneFromTaskText(normalizedTaskDescription, moduleIds),
        taskDescription: normalizedTaskDescription,
        moduleIds,
        triggerSources,
        createdAt: createdAtCandidates.length > 0 ? Math.min(...createdAtCandidates) : Date.now(),
      });
      if (!trace) return;

      const signature = buildPromptModuleTraceSignature(trace);
      if (!seenSignatures.has(signature)) {
        traces.push(trace);
        seenSignatures.add(signature);
      }

      pendingEventsByExpert.delete(expertId);
    };

    for (const message of messages) {
      const role = typeof message?.role === "string" ? message.role : "";
      const content = typeof message?.content === "string" ? message.content : "";
      if (!role || !content) continue;

      if (role === "tool-event") {
        try {
          const normalizedEvent = normalizeHistoricalToolEvent(JSON.parse(content));
          if (!normalizedEvent) continue;
          const currentEvents = pendingEventsByExpert.get(normalizedEvent.expertId) || [];
          currentEvents.push(normalizedEvent);
          pendingEventsByExpert.set(normalizedEvent.expertId, currentEvents);
        } catch {
          // 忽略损坏的旧消息，不阻断后续回灌
        }
        continue;
      }

      if (role === "expert-tasks") {
        try {
          const normalizedTasks = normalizeHistoricalExpertTasks(JSON.parse(content));
          for (const task of normalizedTasks) {
            latestTaskByExpert.set(task.expertId, {
              taskDescription: task.taskDescription,
              createdAt: task.createdAt,
            });
            flushExpertTrace(task.expertId, task.taskDescription, task.createdAt);
          }
        } catch {
          // 忽略损坏的旧消息，不阻断后续回灌
        }
      }
    }

    for (const expertId of pendingEventsByExpert.keys()) {
      const latestTask = latestTaskByExpert.get(expertId);
      flushExpertTrace(expertId, latestTask?.taskDescription, latestTask?.createdAt);
    }
  }

  return traces.sort((left, right) => left.createdAt - right.createdAt);
}

export function detectToolIntentWithoutAction(text: string): {
  needsWebSearch: boolean;
  needsCommand: boolean;
  needsVideoWorkflow: boolean;
} {
  return {
    needsWebSearch:
      matchesAnyPattern(text, SEARCH_INTENT_PATTERNS)
      && !matchesAnyPattern(text, SEARCH_NEGATION_PATTERNS),
    needsCommand:
      matchesAnyPattern(text, COMMAND_INTENT_PATTERNS)
      && !matchesAnyPattern(text, COMMAND_NEGATION_PATTERNS),
    needsVideoWorkflow:
      includesAnyKeyword(text, VIDEO_TRIGGER_KEYWORDS)
      && !matchesAnyPattern(text, VIDEO_NEGATION_PATTERNS),
  };
}

// ========== 工具Schema动态注入 ==========

export interface ToolDefinitionForPrompt {
  name: string;
  description: string;
  parameters: { properties?: Record<string, any>; required?: string[] };
}

/**
 * 根据专家角色生成工具Schema模块内容
 * 动态生成而非静态定义
 *
 * 调用时机说明：在 Agent Loop 组装 prompt 时，
 * 若专家拥有工具调用能力，应调用此函数生成工具描述并注入到最终 prompt 中。
 */
export function buildToolSchemaModule(_expertId: string, availableTools: ToolDefinitionForPrompt[]): string {
  const header = '## 可用工具\n\n你可以通过以下工具与系统交互。调用工具时使用 [ACTION:TOOL_CALL name="工具名" args=\'{"参数JSON"}\'\']\n\n';

  const toolDocs = availableTools.map(tool => {
    const params = Object.entries(tool.parameters.properties || {}).map(([key, schema]: [string, any]) => {
      const required = (tool.parameters.required || []).includes(key) ? '必填' : '可选';
      return `  - \`${key}\` (${required}): ${schema.description || ''}`;
    }).join('\n');
    return `### ${tool.name}\n${tool.description}\n\n参数:\n${params}`;
  }).join('\n\n');

  return header + toolDocs;
}
