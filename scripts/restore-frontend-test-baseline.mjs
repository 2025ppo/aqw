import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const projectName = process.argv[2] || "新建文件夹二";
const logFileName = process.argv[3] || "cli-e2e-20260602-184004.log";
const projectDir = path.join(os.homedir(), "Desktop", projectName);
const logPath = path.join(projectDir, ".xt", "logs", logFileName);

function ensureInsideProject(targetPath) {
  const resolvedProject = path.resolve(projectDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(resolvedProject) && resolvedTarget !== path.resolve(projectDir)) {
    throw new Error(`拒绝越界访问: ${resolvedTarget}`);
  }
}

function readToolOps() {
  const text = fs.readFileSync(logPath, "utf8");
  const lines = text.split(/\r?\n/);
  const ops = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/\[INFO\] 工具调用: (write_file|edit_file|create_folder)/);
    if (!match) continue;
    const op = match[1];
    const jsonLines = [];
    i += 1;
    while (i < lines.length && !/^\[\d{4}-\d{2}-\d{2}T/.test(lines[i])) {
      if (lines[i].trim().length > 0) {
        jsonLines.push(lines[i]);
      }
      i += 1;
    }
    i -= 1;
    if (jsonLines.length === 0) continue;
    const payload = JSON.parse(jsonLines.join("\n"));
    ops.push({ op, payload });
  }
  return ops;
}

function cleanWorkspaceRoot() {
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".xt") continue;
    const target = path.join(projectDir, entry.name);
    ensureInsideProject(target);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function applyOps(ops) {
  for (const { op, payload } of ops) {
    const relativePath = payload.target || payload.path;
    if (!relativePath) continue;
    const targetPath = path.join(projectDir, relativePath);
    ensureInsideProject(targetPath);
    if (op === "create_folder") {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (op === "write_file") {
      fs.writeFileSync(targetPath, payload.content || "", "utf8");
      continue;
    }
    if (op === "edit_file") {
      const current = fs.readFileSync(targetPath, "utf8");
      const search = payload.search || payload.searchText;
      const replace = payload.replace || payload.replaceText || "";
      if (!search || !current.includes(search)) {
        throw new Error(`恢复失败，未找到 edit_file 锚点: ${relativePath}`);
      }
      fs.writeFileSync(targetPath, current.replace(search, replace), "utf8");
    }
  }
}

if (!fs.existsSync(logPath)) {
  throw new Error(`未找到基线日志: ${logPath}`);
}
if (!fs.existsSync(projectDir)) {
  throw new Error(`未找到项目目录: ${projectDir}`);
}

const ops = readToolOps();
cleanWorkspaceRoot();
applyOps(ops);
console.log(`已根据 ${path.basename(logPath)} 恢复基线，共回放 ${ops.length} 个操作到 ${projectDir}`);
