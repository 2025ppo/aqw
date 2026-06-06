#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const APP_DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "com.ai-experts.app");
const PROJECTS_JSON = path.join(APP_DATA_DIR, "projects.json");
const KEY_POOL_JSON = path.join(APP_DATA_DIR, "key_pool.json");
const EXPERTS_JSON = path.join(APP_DATA_DIR, "experts.json");
const CHAT_DB = path.join(APP_DATA_DIR, "chat_history.db");
const DESKTOP_DIR = path.join(os.homedir(), "Desktop");
const DEFAULT_PROJECT_NAME = "新建文件夹二";
const DEFAULT_PROJECT_DIR = path.join(DESKTOP_DIR, DEFAULT_PROJECT_NAME);

const PROVIDERS = {
  deepseek: {
    url: "https://api.deepseek.com/v1/chat/completions",
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
  },
  aliyun: {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  },
};

function nowStamp() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

class Logger {
  constructor(logFile) {
    this.logFile = logFile;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  write(level, message, extra) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    console.log(line);
    fs.appendFileSync(this.logFile, `${line}\n`, "utf8");
    if (extra !== undefined) {
      const formatted = typeof extra === "string" ? extra : JSON.stringify(extra, null, 2);
      console.log(formatted);
      fs.appendFileSync(this.logFile, `${formatted}\n`, "utf8");
    }
  }

  info(message, extra) {
    this.write("INFO", message, extra);
  }

  warn(message, extra) {
    this.write("WARN", message, extra);
  }

  error(message, extra) {
    this.write("ERROR", message, extra);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function ensureXtLayout(projectDir, projectName) {
  const xtDir = path.join(projectDir, ".xt");
  fs.mkdirSync(path.join(xtDir, "configs"), { recursive: true });
  fs.mkdirSync(path.join(xtDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(xtDir, "cache"), { recursive: true });

  const configFile = path.join(xtDir, "config.json");
  if (!fs.existsSync(configFile)) {
    writeJson(configFile, {
      project: projectName,
      version: "0.1.1",
      files: [],
      canvasDirectory: {
        nodes: [],
        edges: [],
        updatedAt: "",
      },
    });
  }
}

function ensureProject(projectName, projectDir, logger) {
  fs.mkdirSync(projectDir, { recursive: true });
  ensureXtLayout(projectDir, projectName);
  logger.info(`项目目录已就绪: ${projectDir}`);
}

function upsertProjectRecord(projectName, projectDir, logger) {
  const projects = readJson(PROJECTS_JSON, []);
  const existing = projects.find((item) => item.workspacePath === projectDir || item.name === projectName);
  let projectId;
  if (existing) {
    existing.name = projectName;
    existing.workspacePath = projectDir;
    projectId = existing.id;
  } else {
    projectId = projects.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    projects.push({
      id: projectId,
      name: projectName,
      iconColor: "#5B8DEF",
      workspacePath: projectDir,
    });
  }
  writeJson(PROJECTS_JSON, projects);
  logger.info("projects.json 已同步");
  return projectId;
}

function runPython(code, args = []) {
  return spawnSync("python", ["-c", code, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function syncProjectToDb(projectId, projectName, projectDir, logger) {
  if (!fs.existsSync(CHAT_DB)) {
    logger.warn("未找到 chat_history.db，跳过项目 DB 同步");
    return;
  }
  const py = `
import sqlite3, sys
db, pid, name, workspace = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute("INSERT OR REPLACE INTO projects (id, name, icon_color, workspace_path) VALUES (?, ?, ?, ?)", (pid, name, "#5B8DEF", workspace))
conn.commit()
conn.close()
`;
  const result = runPython(py, [CHAT_DB, String(projectId), projectName, projectDir]);
  if (result.status !== 0) {
    logger.warn("项目 DB 同步失败，继续执行", result.stderr || result.stdout);
    return;
  }
  logger.info("项目已同步到 chat_history.db");
}

function syncSessionsToDb(projectId, sessions, logger) {
  if (!fs.existsSync(CHAT_DB)) {
    logger.warn("未找到 chat_history.db，跳过会话 DB 同步");
    return;
  }
  const payload = JSON.stringify(sessions);
  const py = `
import json, sqlite3, sys
db, project_id, payload = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sessions = json.loads(payload)
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)", (project_id,))
cur.execute("DELETE FROM sessions WHERE project_id = ?", (project_id,))
for sess in sessions:
    cur.execute("INSERT INTO sessions (project_id, name) VALUES (?, ?)", (project_id, sess["name"]))
    session_id = cur.lastrowid
    for message in sess["messages"]:
        cur.execute("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)", (session_id, message["role"], message["content"]))
conn.commit()
conn.close()
`;
  const result = runPython(py, [CHAT_DB, String(projectId), payload]);
  if (result.status !== 0) {
    logger.warn("会话 DB 同步失败，继续执行", result.stderr || result.stdout);
    return;
  }
  logger.info("会话已同步到 chat_history.db");
}

function saveChatSessions(projectDir, sessions, logger) {
  const file = path.join(projectDir, ".xt", "chat_sessions.json");
  writeJson(file, sessions);
  logger.info("项目会话文件已写入", file);
}

function loadApiConfig() {
  const keyPool = readJson(KEY_POOL_JSON, { items: [] });
  const preset = Array.isArray(keyPool.items) ? keyPool.items.find((item) => item?.type === "preset" && item?.data?.apiKey) : null;
  if (!preset) {
    throw new Error("未找到可用的预设 API 密钥，请先在软件中配置密钥池");
  }
  const providerId = preset.data.providerId || "deepseek";
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`暂不支持的 provider: ${providerId}`);
  }
  return {
    providerId,
    apiKey: preset.data.apiKey,
    model: preset.data.model || "deepseek-chat",
    url: provider.url,
  };
}

function loadExperts() {
  return readJson(EXPERTS_JSON, []);
}

function makeToolSchemas() {
  return [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "列出项目中的文件或目录，可递归。",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "相对项目根目录的路径，默认 ." },
            recursive: { type: "boolean", description: "是否递归列出" },
            max_depth: { type: "integer", description: "递归最大深度，默认 3" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_repo",
        description: "在仓库中搜索关键字或正则，便于修改前定位文件。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            glob: { type: "string" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取文件真实内容。修改已有文件前应先调用。",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            start_line: { type: "integer" },
            end_line: { type: "integer" },
          },
          required: ["target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_folder",
        description: "创建目录。",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
          },
          required: ["target"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "创建或覆盖写入文件。",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            content: { type: "string" },
          },
          required: ["target", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "对已有文件做精确 search/replace 修改。search 必须来自真实文件内容。",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            search: { type: "string" },
            replace: { type: "string" },
          },
          required: ["target", "search", "replace"],
        },
      },
    },
  ];
}

function safeJoin(projectDir, target) {
  const resolved = path.resolve(projectDir, target || ".");
  const normalizedProject = path.resolve(projectDir);
  if (!resolved.startsWith(normalizedProject)) {
    throw new Error(`越界路径: ${target}`);
  }
  return resolved;
}

function listFilesRecursive(baseDir, relativeDir, recursive, maxDepth, depth = 0, output = []) {
  const currentDir = safeJoin(baseDir, relativeDir);
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".xt" || entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = path.posix.join(relativeDir === "." ? "" : relativeDir.replaceAll("\\", "/"), entry.name).replace(/^$/, ".");
    output.push({
      path: rel,
      type: entry.isDirectory() ? "folder" : "file",
    });
    if (recursive && entry.isDirectory() && depth < maxDepth) {
      listFilesRecursive(baseDir, rel, recursive, maxDepth, depth + 1, output);
    }
  }
  return output;
}

function runRg(projectDir, args) {
  return spawnSync("rg", args, {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true,
  });
}

function executeTool(projectDir, call, logger) {
  const name = call.function.name;
  const args = JSON.parse(call.function.arguments || "{}");
  logger.info(`工具调用: ${name}`, args);

  if (name === "list_files") {
    const target = args.target || ".";
    const recursive = Boolean(args.recursive);
    const maxDepth = Number.isInteger(args.max_depth) ? args.max_depth : 3;
    const items = listFilesRecursive(projectDir, target, recursive, maxDepth);
    return { ok: true, result: JSON.stringify(items, null, 2), name, args };
  }

  if (name === "search_repo") {
    const rgArgs = ["-n", args.query];
    if (args.glob) {
      rgArgs.push("-g", args.glob);
    }
    rgArgs.push(".");
    const result = runRg(projectDir, rgArgs);
    const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return { ok: result.status === 0 || result.status === 1, result: text || "(无结果)", name, args };
  }

  if (name === "read_file") {
    const file = safeJoin(projectDir, args.target);
    const content = fs.readFileSync(file, "utf8");
    if (args.start_line || args.end_line) {
      const lines = content.split(/\r?\n/);
      const start = Math.max((args.start_line || 1) - 1, 0);
      const end = args.end_line ? Math.min(args.end_line, lines.length) : lines.length;
      return { ok: true, result: lines.slice(start, end).join("\n"), name, args };
    }
    return { ok: true, result: content, name, args };
  }

  if (name === "create_folder") {
    const dir = safeJoin(projectDir, args.target);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, result: `已创建目录 ${args.target}`, name, args };
  }

  if (name === "write_file") {
    const file = safeJoin(projectDir, args.target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, args.content, "utf8");
    return { ok: true, result: `已写入文件 ${args.target}`, name, args };
  }

  if (name === "edit_file") {
    const file = safeJoin(projectDir, args.target);
    const original = fs.readFileSync(file, "utf8");
    if (!original.includes(args.search)) {
      throw new Error(`search 文本未命中: ${args.target}`);
    }
    const next = original.replace(args.search, args.replace);
    fs.writeFileSync(file, next, "utf8");
    return { ok: true, result: `已修改文件 ${args.target}`, name, args };
  }

  throw new Error(`未知工具: ${name}`);
}

async function callModel(apiConfig, messages, tools) {
  const body = {
    model: apiConfig.model,
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.2,
    stream: false,
  };

  const response = await fetch(apiConfig.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LLM 请求失败 ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

function makeSystemPrompt(projectName, projectDir, sessionName) {
  return [
    "你是星图专家团的命令行执行代理，正在直接操作本地项目。",
    `当前项目名称：${projectName}`,
    `当前项目目录：${projectDir}`,
    `当前对话名称：${sessionName}`,
    "你的职责是像前端里的 AI 专家团一样完成任务，但现在你必须通过函数工具真实读取、检索、创建和修改仓库文件。",
    "规则：",
    "1. 修改已有文件前，必须先用 read_file 或 search_repo 获取真实内容。",
    "2. 新建项目文件时，请直接写入可运行的 HTML/CSS/JS，不要只给建议。",
    "3. 当用户要求继续改进时，优先在现有文件上 edit_file，而不是整文件重写。",
    "4. 当用户询问当前项目、当前目录、当前对话或你的实现原理时，必须直接依据上面的上下文回答，不要说不知道。",
    "5. 如果用户只是询问当前项目上下文或实现原理，禁止为了回答而修改任何仓库文件，也不要先去读取仓库再回答。",
    "6. 完成后给出简洁结果，说明做了什么、生成了哪些关键文件。",
  ].join("\n");
}

class CliWorkbench {
  constructor({ projectName, projectDir, logger }) {
    this.projectName = projectName;
    this.projectDir = projectDir;
    this.logger = logger;
    this.apiConfig = loadApiConfig();
    this.tools = makeToolSchemas();
    this.sessions = [];
    this.nextSessionId = 1;
    this.projectId = null;
  }

  bootstrap() {
    ensureProject(this.projectName, this.projectDir, this.logger);
    this.projectId = upsertProjectRecord(this.projectName, this.projectDir, this.logger);
    syncProjectToDb(this.projectId, this.projectName, this.projectDir, this.logger);
  }

  createSession(name) {
    const session = {
      id: this.nextSessionId++,
      name,
      messages: [],
      toolHistory: [],
    };
    this.sessions.push(session);
    this.logger.info(`新建会话: ${name}`);
    return session;
  }

  persistSessions() {
    const serializable = this.sessions.map((session) => ({
      id: session.id,
      name: session.name,
      messages: session.messages.map((item) => ({
        role: item.role,
        content: item.content,
      })),
    }));
    saveChatSessions(this.projectDir, serializable, this.logger);
    if (this.projectId !== null) {
      syncSessionsToDb(this.projectId, serializable, this.logger);
    }
  }

  async runTurn(session, userPrompt) {
    const toolHistoryStart = session.toolHistory.length;
    session.messages.push({ role: "user", content: userPrompt });
    const llmMessages = [
      { role: "system", content: makeSystemPrompt(this.projectName, this.projectDir, session.name) },
      ...session.messages.map((message) => ({ role: message.role, content: message.content })),
    ];

    for (let step = 0; step < 24; step++) {
      const raw = await callModel(this.apiConfig, llmMessages, this.tools);
      const choice = raw.choices?.[0]?.message;
      if (!choice) {
        throw new Error("模型未返回消息");
      }

      const assistantContent = choice.content || "";
      const toolCalls = choice.tool_calls || [];
      this.logger.info(`模型回合 ${step + 1} 返回`, {
        contentPreview: assistantContent.slice(0, 300),
        toolCalls: toolCalls.map((call) => call.function?.name),
      });

      if (!toolCalls.length) {
        session.messages.push({ role: "assistant", content: assistantContent });
        this.persistSessions();
        return {
          reply: assistantContent,
          toolCalls: session.toolHistory.slice(toolHistoryStart),
        };
      }

      llmMessages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        let resultText;
        try {
          const toolResult = executeTool(this.projectDir, toolCall, this.logger);
          session.toolHistory.push(toolResult);
          resultText = toolResult.result;
        } catch (error) {
          resultText = `工具执行失败: ${String(error)}`;
          session.toolHistory.push({
            ok: false,
            name: toolCall.function?.name || "unknown",
            args: toolCall.function?.arguments || "{}",
            result: resultText,
          });
          this.logger.warn("工具执行失败", resultText);
        }

        llmMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: resultText,
        });
      }

      const currentTurnHistory = session.toolHistory.slice(toolHistoryStart);
      const hasMaterialEdits = currentTurnHistory.some((item) => ["write_file", "edit_file", "create_folder"].includes(item.name));
      const latestCallsAreReadOnly = toolCalls.every((call) => ["read_file", "list_files", "search_repo"].includes(call.function?.name || ""));
      if (step >= 10 && hasMaterialEdits && latestCallsAreReadOnly) {
        this.logger.info("检测到进入重复验证阶段，切换为强制收尾答复");
        llmMessages.push({
          role: "user",
          content: "核心修改应该已经完成。现在禁止继续调用工具，请直接给出最终结果总结，不要再读取或验证文件。",
        });
        const forced = await callModel(this.apiConfig, llmMessages, []);
        const forcedContent = forced.choices?.[0]?.message?.content || "已完成修改。";
        session.messages.push({ role: "assistant", content: forcedContent });
        this.persistSessions();
        return {
          reply: forcedContent,
          toolCalls: currentTurnHistory,
        };
      }
    }

    throw new Error("模型在 24 轮内未完成");
  }
}

function ensureGeneratedFiles(projectDir) {
  const required = ["index.html", "styles.css", "app.js"];
  const missing = required.filter((file) => !fs.existsSync(path.join(projectDir, file)));
  return {
    ok: missing.length === 0,
    missing,
  };
}

function ensureToolUsage(turnResult, requiredNames) {
  const names = new Set(turnResult.toolCalls.map((item) => item.name));
  const missing = requiredNames.filter((name) => !names.has(name));
  return {
    ok: missing.length === 0,
    missing,
  };
}

function ensureReplyIncludes(reply, expectedSnippets) {
  const missing = expectedSnippets.filter((snippet) => !reply.includes(snippet));
  return {
    ok: missing.length === 0,
    missing,
  };
}

function ensureNoFileMutation(turnResult) {
  const mutated = turnResult.toolCalls
    .map((item) => item.name)
    .filter((name) => ["write_file", "edit_file", "create_folder"].includes(name));
  return {
    ok: mutated.length === 0,
    mutated,
  };
}

async function runTurnWithValidation(workbench, session, spec) {
  for (let attempt = 1; attempt <= spec.maxAttempts; attempt++) {
    workbench.logger.info(`开始执行测试回合: ${spec.name}，尝试 ${attempt}/${spec.maxAttempts}`);
    let result;
    try {
      result = await workbench.runTurn(session, spec.prompt);
    } catch (error) {
      workbench.logger.warn(`执行异常: ${spec.name}`, String(error));
      if (attempt === spec.maxAttempts) throw error;
      spec.prompt = `${spec.prompt}\n\n补充要求：你上一次执行时陷入了过长的编辑循环。请尽量合并修改，并在完成后立刻给出最终结果。`;
      continue;
    }
    const failures = [];
    for (const validator of spec.validators) {
      const check = validator(result);
      if (!check.ok) failures.push(check.message);
    }
    if (!failures.length) {
      workbench.logger.info(`测试回合通过: ${spec.name}`);
      return result;
    }
    workbench.logger.warn(`测试回合失败: ${spec.name}`, failures);
    if (attempt === spec.maxAttempts) {
      throw new Error(`${spec.name} 失败: ${failures.join(" | ")}`);
    }
    const repairPrompt = `${spec.prompt}\n\n补充要求：你上一次结果未通过验证，问题如下：\n- ${failures.join("\n- ")}\n请直接继续修复当前仓库，不要空谈。`;
    spec.prompt = repairPrompt;
  }
}

async function runScenario() {
  const projectName = DEFAULT_PROJECT_NAME;
  const projectDir = DEFAULT_PROJECT_DIR;
  ensureProject(projectName, projectDir, { info() {}, warn() {}, error() {} });
  const logFile = path.join(projectDir, ".xt", "logs", `cli-e2e-${nowStamp()}.log`);
  const logger = new Logger(logFile);
  const workbench = new CliWorkbench({ projectName, projectDir, logger });
  workbench.bootstrap();

  const experts = loadExperts();
  logger.info("已加载专家配置", experts.map((item) => `${item.name}:${item.title}`));
  logger.info("开始测试题目", {
    projectDir,
    provider: workbench.apiConfig.providerId,
    model: workbench.apiConfig.model,
  });

  const session1 = workbench.createSession("对话一");
  await runTurnWithValidation(workbench, session1, {
    name: "回合一-创建网页版Linux仿真",
    maxAttempts: 2,
    prompt: [
      "请在当前项目中直接创建一个网页版 Linux 系统仿真。",
      "要求：",
      "1. 至少包含桌面、任务栏、开始菜单、终端窗口四部分。",
      "2. 使用纯前端实现，文件放在项目根目录。",
      "3. 最少生成 index.html、styles.css、app.js。",
      "4. 直接落文件，不要只给方案。",
    ].join("\n"),
    validators: [
      () => {
        const check = ensureGeneratedFiles(projectDir);
        return check.ok ? { ok: true } : { ok: false, message: `缺少文件: ${check.missing.join(", ")}` };
      },
    ],
  });

  await runTurnWithValidation(workbench, session1, {
    name: "回合二-检索后增强功能",
    maxAttempts: 2,
    prompt: [
      "请基于当前仓库现状继续增强这个网页版 Linux 仿真。",
      "要求：",
      "1. 先检索或读取现有文件，再修改，不要凭空重写。",
      "2. 新增桌面图标、开始菜单应用列表、终端 help 命令。",
      "3. 尽量通过 edit_file 修改已有文件。",
    ].join("\n"),
    validators: [
      (result) => {
        const check = ensureToolUsage(result, ["read_file", "edit_file"]);
        return check.ok ? { ok: true } : { ok: false, message: `缺少必要工具调用: ${check.missing.join(", ")}` };
      },
    ],
  });

  await runTurnWithValidation(workbench, session1, {
    name: "回合三-再次检索并修复移动端",
    maxAttempts: 2,
    prompt: [
      "这个现在手机上看着还有点挤，你顺手再调一下。",
      "顺便补一句界面提示，让人一眼知道窗口能拖、图标能点。",
      "别整套重写，基于现在这个项目直接改。",
    ].join("\n"),
    validators: [
      (result) => {
        const check = ensureToolUsage(result, ["search_repo", "edit_file"]);
        return check.ok ? { ok: true } : { ok: false, message: `缺少必要工具调用: ${check.missing.join(", ")}` };
      },
    ],
  });

  const session2 = workbench.createSession("对话二");
  await runTurnWithValidation(workbench, session2, {
    name: "新对话-确认当前项目上下文",
    maxAttempts: 2,
    prompt: [
      "当前项目是什么，和我解释一下你的实现原理吧。",
      "顺带说清楚你现在到底是在哪个目录、哪个对话里在回答我。",
    ].join("\n"),
    validators: [
      (result) => {
        const check = ensureReplyIncludes(result.reply, [projectName, projectDir, "对话二"]);
        return check.ok ? { ok: true } : { ok: false, message: `回复缺少项目上下文信息: ${check.missing.join(", ")}` };
      },
      (result) => {
        const check = ensureNoFileMutation(result);
        return check.ok ? { ok: true } : { ok: false, message: `回答项目上下文时不应改文件，但实际调用了: ${check.mutated.join(", ")}` };
      },
    ],
  });

  await runTurnWithValidation(workbench, session2, {
    name: "新对话-独立检索并补充README",
    maxAttempts: 2,
    prompt: [
      "这个项目你再顺手收个尾吧。",
      "说明文档该补就补，有哪里叫法不一致也一起收拾一下。",
      "别靠猜，按现在仓库里真实的东西来。",
    ].join("\n"),
    validators: [
      (result) => {
        const readme = fs.existsSync(path.join(projectDir, "README.md"));
        return readme ? { ok: true } : { ok: false, message: "README.md 未生成" };
      },
      (result) => {
        const check = ensureToolUsage(result, ["search_repo", "read_file"]);
        return check.ok ? { ok: true } : { ok: false, message: `缺少必要工具调用: ${check.missing.join(", ")}` };
      },
    ],
  });

  logger.info("测试全部通过", {
    projectDir,
    sessions: workbench.sessions.map((session) => ({
      name: session.name,
      messageCount: session.messages.length,
      toolCalls: session.toolHistory.length,
    })),
    logFile,
  });
  return { projectDir, logFile };
}

async function main() {
  const command = process.argv[2] || "test-scenario";
  if (command !== "test-scenario") {
    throw new Error(`未知命令: ${command}`);
  }
  const result = await runScenario();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
