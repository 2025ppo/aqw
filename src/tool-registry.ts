import { buildExpertToolMap } from './expert-catalog';

/**
 * 前端工具注册表 - 定义每个工具的Schema(供注入LLM请求)和元信息
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  permission: 'auto' | 'confirm' | 'block';
}

// 专家角色与工具权限映射
const EXPERT_TOOL_MAP: Record<string, string[]> = buildExpertToolMap();

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    this.register({
      name: 'shell_exec',
      description: '在项目目录中执行shell命令。可用于运行构建、测试、git操作、安装依赖等。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的shell命令' },
          working_dir: { type: 'string', description: '工作目录(相对于项目根目录，可选)' },
          timeout_ms: { type: 'number', description: '超时毫秒数(默认60000)' },
        },
        required: ['command'],
      },
      permission: 'confirm',
    });

    this.register({
      name: 'file_read',
      description: '读取文件内容。支持指定行范围。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径(相对于项目根目录)' },
          start_line: { type: 'number', description: '起始行号(可选，从1开始)' },
          end_line: { type: 'number', description: '结束行号(可选)' },
        },
        required: ['path'],
      },
      permission: 'auto',
    });

    this.register({
      name: 'file_write',
      description: '写入文件内容。如果文件不存在则创建，如果存在则覆盖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径(相对于项目根目录)' },
          content: { type: 'string', description: '要写入的完整文件内容' },
        },
        required: ['path', 'content'],
      },
      permission: 'confirm',
    });

    this.register({
      name: 'file_patch',
      description: 'Apply structured file patches. Supports creating, modifying, deleting, and moving files. See system instructions for the exact patch format syntax. Output the patch directly as plain text within the tool call.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: '结构化Patch文本(*** Begin Patch ... *** End Patch)' },
        },
        required: ['patch'],
      },
      permission: 'confirm',
    });

    this.register({
      name: 'file_list',
      description: '列出目录中的文件和子目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径(相对于项目根目录，默认为根目录)' },
          pattern: { type: 'string', description: '文件名过滤模式(如 *.ts)' },
          recursive: { type: 'boolean', description: '是否递归子目录(默认false)' },
        },
        required: [],
      },
      permission: 'auto',
    });

    this.register({
      name: 'web_search',
      description: '搜索互联网获取信息。返回搜索结果列表(标题+URL+摘要)。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          max_results: { type: 'number', description: '最大结果数(默认5)' },
        },
        required: ['query'],
      },
      permission: 'auto',
    });

    this.register({
      name: 'memory_query',
      description: '搜索项目记忆库，获取历史经验、项目知识和上下文信息。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          memory_type: { type: 'string', description: '记忆类型: ephemeral/working/longterm(可选)' },
        },
        required: ['query'],
      },
      permission: 'auto',
    });

    this.register({
      name: 'index_search',
      description: '在项目代码索引中搜索，定位相关代码片段。支持函数名、类名、关键词搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词(函数名/类名/概念)' },
          max_results: { type: 'number', description: '最大结果数(默认5)' },
        },
        required: ['query'],
      },
      permission: 'auto',
    });
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 根据专家角色获取可用工具列表
   * 返回OpenAI function calling格式的tool定义
   */
  getToolsForExpert(expertId: string): any[] {
    const commonTools = EXPERT_TOOL_MAP['_common'] || [];
    const expertTools = EXPERT_TOOL_MAP[expertId] || [];
    const allowedNames = new Set([...commonTools, ...expertTools]);

    const result: any[] = [];
    for (const [name, def] of this.tools) {
      if (allowedNames.has(name)) {
        result.push({
          type: 'function',
          function: {
            name: def.name,
            description: def.description,
            parameters: def.parameters,
          },
        });
      }
    }
    return result;
  }

  /**
   * 获取所有工具定义（用于prompt注入）
   */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

// 全局单例
let _registryInstance: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!_registryInstance) {
    _registryInstance = new ToolRegistry();
  }
  return _registryInstance;
}
