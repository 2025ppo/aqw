import { invoke } from "@tauri-apps/api/core";

// ========== 类型定义 ==========

export interface MemoryEntry {
  id: string;
  project_id: number;
  expert_id: string;
  memory_type: "ephemeral" | "working" | "longterm";
  content: string;
  keywords: string[];
  context_summary: string;
  created_at: number;
  access_count: number;
  last_accessed: number;
}

export interface MemoryQuery {
  project_id: number;
  expert_id?: string;
  query_text: string;
  memory_type?: "ephemeral" | "working" | "longterm";
  limit?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface MemoryStats {
  ephemeral: number;
  working: number;
  longterm: number;
  total: number;
}

// ========== 核心 API ==========

/** 保存记忆条目 */
export async function saveMemory(
  projectName: string,
  entry: MemoryEntry
): Promise<void> {
  await invoke("memory_save", {
    req: { project_name: projectName, entry },
  });
}

/** 检索记忆 */
export async function searchMemory(
  projectName: string,
  query: MemoryQuery
): Promise<MemorySearchResult[]> {
  const raw = await invoke<string>("memory_search", {
    req: {
      project_name: projectName,
      query: {
        project_id: query.project_id,
        expert_id: query.expert_id,
        query_text: query.query_text,
        memory_type: query.memory_type,
        limit: query.limit ?? 5,
      },
    },
  });
  return JSON.parse(raw) as MemorySearchResult[];
}

/** 删除单条记忆 */
export async function deleteMemory(
  projectName: string,
  memoryType: string,
  id: string
): Promise<boolean> {
  return await invoke<boolean>("memory_delete", {
    projectName,
    memoryType,
    id,
  });
}

/** 清空指定类型的记忆 */
export async function clearMemoryType(
  projectName: string,
  memoryType: string
): Promise<void> {
  await invoke("memory_clear_type", { projectName, memoryType });
}

/** 运行记忆生命周期管理 */
export async function runMemoryLifecycle(projectName: string): Promise<string> {
  return await invoke<string>("memory_run_lifecycle", { projectName });
}

/** 获取记忆统计 */
export async function getMemoryStats(projectName: string): Promise<MemoryStats> {
  const raw = await invoke<string>("memory_get_stats", { projectName });
  return JSON.parse(raw) as MemoryStats;
}

// ========== 便捷函数 ==========

/** 从专家输出中提取关键结论并保存为记忆 */
export async function saveExpertMemory(
  projectName: string,
  projectId: number,
  expertId: string,
  expertName: string,
  taskDescription: string,
  expertOutput: string
): Promise<void> {
  // 提取关键内容：取输出的前 500 字符作为记忆内容
  const content = expertOutput.length > 500
    ? `${expertOutput.slice(0, 500)}...`
    : expertOutput;

  // 组合关键词：任务描述 + 专家名 + 内容关键词
  const keywordText = `${taskDescription} ${expertName} ${content}`;

  const entry: MemoryEntry = {
    id: generateMemoryId(),
    project_id: projectId,
    expert_id: expertId,
    memory_type: "ephemeral",
    content: `[${expertName}] ${taskDescription}\n\n${content}`,
    keywords: extractKeywords(keywordText),
    context_summary: taskDescription.slice(0, 100),
    created_at: Math.floor(Date.now() / 1000),
    access_count: 0,
    last_accessed: Math.floor(Date.now() / 1000),
  };

  await saveMemory(projectName, entry);
}

/** 保存用户意图到 Ephemeral 记忆 */
export async function saveUserIntentMemory(
  projectName: string,
  projectId: number,
  userMessage: string
): Promise<void> {
  const entry: MemoryEntry = {
    id: generateMemoryId(),
    project_id: projectId,
    expert_id: "user",
    memory_type: "ephemeral",
    content: `[用户意图] ${userMessage}`,
    keywords: extractKeywords(userMessage),
    context_summary: userMessage.slice(0, 100),
    created_at: Math.floor(Date.now() / 1000),
    access_count: 0,
    last_accessed: Math.floor(Date.now() / 1000),
  };

  await saveMemory(projectName, entry);
}

/** 组装记忆上下文文本（供 expert prompt 使用） */
export async function buildMemoryContext(
  projectName: string,
  projectId: number,
  expertId: string,
  taskDescription: string
): Promise<string> {
  try {
    const results = await searchMemory(projectName, {
      project_id: projectId,
      expert_id: expertId,
      query_text: taskDescription,
      limit: 3,
    });

    if (results.length === 0) {
      return "";
    }

    const lines = results.map((r, i) => {
      return `[历史记忆 ${i + 1}] ${r.entry.content.slice(0, 300)}${r.entry.content.length > 300 ? "..." : ""}`;
    });

    return `\n【相关历史记忆】\n${lines.join("\n\n")}\n`;
  } catch {
    return "";
  }
}

/** 组装通用记忆上下文（不限专家） */
export async function buildGeneralMemoryContext(
  projectName: string,
  projectId: number,
  taskDescription: string
): Promise<string> {
  try {
    const results = await searchMemory(projectName, {
      project_id: projectId,
      query_text: taskDescription,
      limit: 3,
    });

    if (results.length === 0) {
      return "";
    }

    const lines = results.map((r, i) => {
      return `[历史记忆 ${i + 1}] ${r.entry.content.slice(0, 300)}${r.entry.content.length > 300 ? "..." : ""}`;
    });

    return `\n【相关历史记忆】\n${lines.join("\n\n")}\n`;
  } catch {
    return "";
  }
}

// ========== 工具函数 ==========

function generateMemoryId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 简单关键词提取（与 Rust 侧保持一致） */
function extractKeywords(text: string): string[] {
  const tokens: string[] = [];
  const chars = Array.from(text);
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // 跳过标点（保留 . _ #）
    if (/[\p{P}]/u.test(ch) && ![".", "_", "#"].includes(ch)) {
      i++;
      continue;
    }

    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) {
      // 中文单字/双字/三字
      tokens.push(ch);
      if (i + 1 < chars.length && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(chars[i + 1])) {
        tokens.push(ch + chars[i + 1]);
      }
      if (i + 2 < chars.length && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(chars[i + 1]) && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(chars[i + 2])) {
        tokens.push(ch + chars[i + 1] + chars[i + 2]);
      }
      i++;
    } else if (/[a-zA-Z0-9_.#]/.test(ch)) {
      // 英文单词/标识符
      const start = i;
      while (i < chars.length && /[a-zA-Z0-9_.#]/.test(chars[i])) {
        i++;
      }
      const word = chars.slice(start, i).join("");
      const lower = word.toLowerCase();
      if (lower.length >= 2 && !/^\d+(\.\d+)?$/.test(lower)) {
        if (word !== lower) tokens.push(word);
        tokens.push(lower);
      }
    } else {
      i++;
    }
  }

  // 去重并过滤停用词
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!isStopWord(lower) && !seen.has(lower) && keywords.length < 30) {
      seen.add(lower);
      keywords.push(token);
    }
  }

  return keywords;
}

function isStopWord(word: string): boolean {
  const stopwords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
    "may", "might", "must", "shall", "can", "need", "dare", "ought", "used",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into",
    "through", "during", "before", "after", "above", "below", "between", "under",
    "and", "but", "or", "yet", "so", "if", "because", "although", "though",
    "while", "where", "when", "that", "which", "who", "whom", "whose", "what",
    "this", "these", "those", "i", "you", "he", "she", "it", "we", "they",
    "me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
    "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
    "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
    "自己", "这", "那", "个", "为", "之", "与", "及", "等", "或", "但", "而", "因",
    "于", "以", "所", "被", "把", "给", "让", "向", "从", "到", "对", "关于", "根据",
    "function", "const", "let", "var", "return", "if", "else", "for", "while",
    "import", "export", "from", "class", "interface", "type", "async", "await",
    "pub", "fn", "struct", "enum", "impl", "use", "mod", "mut",
  ]);
  return stopwords.has(word);
}
