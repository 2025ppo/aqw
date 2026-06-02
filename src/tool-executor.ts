/**
 * 统一工具执行器 — 前后端桥接层
 * 负责：将工具调用请求发送给后端执行，处理审批流程
 */
import { invoke } from '@tauri-apps/api/core';

export interface ToolExecResult {
  success: boolean;
  result: string;
  metadata?: any;
}

export class ToolExecutor {
  private projectDir: string = '';

  setProjectDir(dir: string): void {
    this.projectDir = dir;
  }

  /**
   * 执行工具调用（统一入口）
   * 通过后端 dispatch_tool 命令路由到对应的工具实现
   */
  async execute(toolName: string, argsJson: string, expertId: string): Promise<ToolExecResult> {
    try {
      const resultJson = await invoke<string>('dispatch_tool', {
        toolName,
        argsJson: typeof argsJson === 'string' ? argsJson : JSON.stringify(argsJson),
        projectDir: this.projectDir,
        expertId,
      });
      const parsed = JSON.parse(resultJson) as ToolExecResult;

      // file_patch 特殊处理：构造结构化错误回传
      if (toolName === 'file_patch' && !parsed.success) {
        parsed.result = this.handlePatchResult(parsed);
      }

      return parsed;
    } catch (error: any) {
      // file_patch 的 invoke 级别异常也做结构化处理
      if (toolName === 'file_patch') {
        return {
          success: false,
          result: this.buildPatchErrorFromString(error.toString()),
        };
      }
      return {
        success: false,
        result: `工具执行错误: ${error.toString()}`,
      };
    }
  }

  /**
   * 处理 file_patch 工具的失败结果，构造结构化错误消息
   * 该消息作为工具调用 result 返回给模型，模型在下一轮循环中自主修正
   */
  private handlePatchResult(result: ToolExecResult): string {
    // 尝试从 result 或 metadata 中提取结构化字段
    const meta = result.metadata || {};
    const rawResult = result.result || '';

    // 后端可能返回 JSON 结构化信息，也可能是纯字符串
    let errorMsg = meta.error || rawResult;
    let failedFile = meta.failed_file || this.extractField(rawResult, 'file');
    let failedLine = meta.failed_line || this.extractLineNumber(rawResult);
    let fileSnippet = meta.file_snippet || this.extractSnippet(rawResult);
    let appliedFiles: string[] = meta.applied_files || [];

    let errorFeedback = `## Patch Application Failed\n\n`;
    errorFeedback += `**Error**: ${errorMsg}\n\n`;

    if (failedFile) {
      errorFeedback += `**File**: ${failedFile}\n`;
      errorFeedback += `**Location**: near line ${failedLine || 'unknown'}\n\n`;

      if (fileSnippet) {
        errorFeedback += `**Actual file content around that area**:\n\`\`\`\n${fileSnippet}\n\`\`\`\n\n`;
      }
    }

    if (appliedFiles.length > 0) {
      errorFeedback += `**Already applied to**: ${appliedFiles.join(', ')}\n\n`;
    }

    errorFeedback += `**Instructions**: Please review the error and the actual file content above, then output a corrected patch. Common issues:\n`;
    errorFeedback += `- Context lines don't match actual file content\n`;
    errorFeedback += `- The target location has changed since you last read the file\n`;
    errorFeedback += `- Missing or extra whitespace in context lines\n`;
    errorFeedback += `\nPlease retry with corrected patch.\n`;

    return errorFeedback;
  }

  /**
   * 从纯字符串错误中构建 patch 错误反馈（invoke 级别异常）
   */
  private buildPatchErrorFromString(errorStr: string): string {
    let errorFeedback = `## Patch Application Failed\n\n`;
    errorFeedback += `**Error**: ${errorStr}\n\n`;
    errorFeedback += `**Instructions**: Please review the error, then read the target file to get current content and retry with corrected patch.\n`;
    return errorFeedback;
  }

  /**
   * 从错误文本中提取文件路径
   */
  private extractField(text: string, _field: string): string | null {
    // 尝试常见模式: "file: xxx" 或 "path: xxx" 或 "at xxx"
    const patterns = [
      /(?:file|path)[:\s]+([^\n,;]+)/i,
      /failed (?:at|for) (?:file )?['"]?([^'"\n,;]+)['"]?/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return null;
  }

  /**
   * 从错误文本中提取行号
   */
  private extractLineNumber(text: string): number | null {
    const m = text.match(/line\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * 从错误文本中提取代码片段（如果后端在错误中嵌入了内容）
   */
  private extractSnippet(text: string): string | null {
    // 查找被 ``` 包裹的代码块
    const m = text.match(/```[\s\S]*?\n([\s\S]*?)\n```/);
    if (m) return m[1];
    // 查找 "actual content:" 后面的多行内容
    const m2 = text.match(/actual (?:content|file)[:\s]*\n([\s\S]{20,}?)(?:\n\n|$)/i);
    return m2 ? m2[1].trim() : null;
  }

  /**
   * 从LLM响应中提取工具调用（双轨协议）
   * 支持两种格式：
   * 1. OpenAI function calling格式（tool_calls字段）
   * 2. ACTION标记格式（[ACTION:...] 正则解析）— 向后兼容
   */
  static extractToolCalls(response: any): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];

    // 方式1: function calling格式(优先)
    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const tc of response.tool_calls) {
        calls.push({
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: tc.function?.name || tc.name,
          arguments: tc.function?.arguments || tc.arguments,
          source: 'function_calling',
        });
      }
      return calls;
    }

    // 方式2: ACTION标记解析(兼容模式)
    const content = response.content || response.text || '';
    const actionRegex = /\[ACTION:(TOOL_CALL|WEB_SEARCH|EXECUTE_CMD|READ_DOCUMENT|WRITE_DOCUMENT|EDIT_FILE|GENERATE_IMAGE)((?:\s+\w+="[^"]*")*)\]/g;
    let match;
    while ((match = actionRegex.exec(content)) !== null) {
      const actionType = match[1];
      const paramsStr = match[2];
      const params = this.parseActionParams(paramsStr);

      const mapped = this.mapActionToTool(actionType, params);
      if (mapped) {
        calls.push({
          id: `action_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: mapped.name,
          arguments: JSON.stringify(mapped.args),
          source: 'action_tag',
        });
      }
    }

    return calls;
  }

  /**
   * 解析ACTION标记参数
   */
  private static parseActionParams(paramsStr: string): Record<string, string> {
    const params: Record<string, string> = {};
    const paramRegex = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = paramRegex.exec(paramsStr)) !== null) {
      params[m[1]] = m[2];
    }
    return params;
  }

  /**
   * 将旧ACTION映射到新工具系统
   */
  private static mapActionToTool(actionType: string, params: Record<string, string>): { name: string; args: any } | null {
    switch (actionType) {
      case 'TOOL_CALL':
        return { name: params['name'] || '', args: JSON.parse(params['args'] || '{}') };
      case 'WEB_SEARCH':
        return { name: 'web_search', args: { query: params['query'] } };
      case 'EXECUTE_CMD':
        return { name: 'shell_exec', args: { command: params['command'], working_dir: params['dir'] } };
      case 'READ_DOCUMENT':
        return { name: 'file_read', args: { path: params['path'] } };
      case 'WRITE_DOCUMENT':
        return { name: 'file_write', args: { path: params['path'], content: params['content'] } };
      case 'EDIT_FILE':
        return { name: 'file_patch', args: { patch: params['patch'] || params['content'] } };
      case 'GENERATE_IMAGE':
        return null; // 暂不映射
      default:
        return null;
    }
  }
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
  source: 'function_calling' | 'action_tag';
}
