/**
 * Agent执行循环 — 每个专家调用时的核心引擎
 * 借鉴Codex的run_turn: 模型自主决定工具调用轮数，不再硬编码3轮
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ContextManager, ChatMessage, getContextManager } from './context-manager';
import { getConfig } from './config-cascade';
import { ToolRegistry, getToolRegistry } from './tool-registry';
import { ToolExecutor } from './tool-executor';

export interface AgentLoopConfig {
  maxTurns: number;              // 安全上限(默认20)
  tokenBudget: number;           // Token预算
  compactThreshold: number;      // 压缩触发比例(0.8)
  deadLoopDetection: number;     // 连续相同调用检测(3)
  streamingEnabled: boolean;     // 是否启用流式输出
  expertTimeout: number;         // 单次专家执行总超时ms
}

export interface AgentCallbacks {
  onToken?: (token: string) => void;           // 流式token回调
  onToolCall?: (name: string, args: any) => void;  // 工具调用开始
  onToolResult?: (name: string, result: any) => void;  // 工具调用完成
  onTurnComplete?: (turnIndex: number) => void;  // 一轮完成
  onError?: (error: string) => void;
  onCompact?: (beforeTokens: number, afterTokens: number) => void;
}

export interface AgentResult {
  finalOutput: string;
  toolCallHistory: ToolCallRecord[];
  totalTurns: number;
  totalTokensUsed: number;
  finishReason: 'complete' | 'max_turns' | 'token_exhausted' | 'timeout' | 'error';
}

export interface ToolCallRecord {
  turn: number;
  toolName: string;
  arguments: any;
  result: string;
  success: boolean;
  durationMs: number;
}

export class AgentLoop {
  private config: AgentLoopConfig;
  private contextManager: ContextManager;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private abortController: AbortController | null = null;

  // Patch重试追踪：文件路径 → 连续失败次数
  private patchRetryCount: Map<string, number> = new Map();
  private readonly MAX_PATCH_RETRIES = 3;

  constructor(config?: Partial<AgentLoopConfig>) {
    const appConfig = getConfig().get();
    this.config = {
      maxTurns: config?.maxTurns ?? appConfig.agent.max_turns,
      tokenBudget: config?.tokenBudget ?? appConfig.agent.token_budget,
      compactThreshold: config?.compactThreshold ?? appConfig.agent.compact_threshold,
      deadLoopDetection: config?.deadLoopDetection ?? appConfig.agent.dead_loop_detection,
      streamingEnabled: config?.streamingEnabled ?? appConfig.ui.streaming_enabled,
      expertTimeout: config?.expertTimeout ?? appConfig.pipeline.expert_timeout_ms,
    };
    this.contextManager = getContextManager({ tokenBudget: this.config.tokenBudget });
    this.toolRegistry = getToolRegistry();
    this.toolExecutor = new ToolExecutor();
  }

  /**
   * 核心执行循环 — 一个专家的完整交互
   */
  async runTurn(
    expertId: string,
    systemPrompt: string,
    initialMessages: ChatMessage[],
    callbacks: AgentCallbacks = {},
  ): Promise<AgentResult> {
    const toolCallHistory: ToolCallRecord[] = [];
    let messages = [...initialMessages];
    let turnCount = 0;
    let totalTokens = 0;
    let finishReason: AgentResult['finishReason'] = 'complete';
    const recentToolCalls: string[] = []; // 用于死循环检测

    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => this.abortController?.abort(), this.config.expertTimeout);

    try {
      while (turnCount < this.config.maxTurns) {
        // 检查是否被中止
        if (this.abortController.signal.aborted) {
          finishReason = 'timeout';
          break;
        }

        // 1. Token预算检查 → 自动压缩
        if (this.contextManager.exceedsBudget(messages)) {
          const beforeTokens = this.contextManager.estimateMessagesTokens(messages);
          messages = this.contextManager.compact(messages);
          const afterTokens = this.contextManager.estimateMessagesTokens(messages);
          callbacks.onCompact?.(beforeTokens, afterTokens);

          // 压缩后仍超预算 → 强制停止
          if (this.contextManager.exceedsBudget(messages)) {
            finishReason = 'token_exhausted';
            break;
          }
        }

        // 2. 获取此专家可用的工具Schema
        const toolSchemas = this.toolRegistry.getToolsForExpert(expertId);

        // 3. 调用LLM（流式或阻塞）
        const llmResponse = await this.callLLM(
          systemPrompt,
          messages,
          toolSchemas,
          callbacks,
        );

        totalTokens += llmResponse.usage?.total_tokens || 0;

        // 4. 判断响应类型
        if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
          // 模型要求调用工具

          // 死循环检测
          const callSignature = llmResponse.toolCalls.map(tc => `${tc.name}:${tc.arguments}`).join('|');
          recentToolCalls.push(callSignature);
          if (this.detectDeadLoop(recentToolCalls)) {
            // 注入提示让模型停止循环
            messages.push({
              role: 'assistant',
              content: llmResponse.content || '',
              toolCalls: llmResponse.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              })),
            });
            messages.push({
              role: 'system',
              content: '[系统检测到重复操作] 你已经连续执行了相同的操作多次。请基于已获得的信息直接给出最终答案，不要再调用工具。',
            });
            turnCount++;
            callbacks.onTurnComplete?.(turnCount);
            continue;
          }

          // 并行执行所有工具调用
          const toolResults = await this.executeToolCalls(
            llmResponse.toolCalls,
            expertId,
            turnCount,
            toolCallHistory,
            callbacks,
          );

          // 将assistant消息(含tool_calls)和工具结果追加到历史
          messages.push({
            role: 'assistant',
            content: llmResponse.content || '',
            toolCalls: llmResponse.toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          });

          for (const result of toolResults) {
            messages.push({
              role: 'tool',
              content: result.output,
              toolCallId: result.callId,
            });
          }

          turnCount++;
          callbacks.onTurnComplete?.(turnCount);
          // continue循环 → 将工具结果发回模型
        } else {
          // 模型返回最终文本 → 循环结束
          finishReason = 'complete';
          break;
        }
      }

      if (turnCount >= this.config.maxTurns) {
        finishReason = 'max_turns';
      }

      // 获取最终输出
      const lastAssistantMsg = messages.filter(m => m.role === 'assistant').pop();
      const finalOutput = lastAssistantMsg?.content || '';

      return {
        finalOutput,
        toolCallHistory,
        totalTurns: turnCount,
        totalTokensUsed: totalTokens,
        finishReason,
      };
    } finally {
      clearTimeout(timeoutId);
      this.abortController = null;
    }
  }

  /**
   * 中止当前执行
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * 调用LLM（支持流式和非流式）
   */
  private async callLLM(
    systemPrompt: string,
    messages: ChatMessage[],
    toolSchemas: any[],
    callbacks: AgentCallbacks,
  ): Promise<LLMCallResult> {
    const config = getConfig().getLLM();
    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // 构建请求
    const request = {
      provider_id: config.default_provider,
      model: config.default_model || null,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      tools: toolSchemas.length > 0 ? toolSchemas : null,
      stream: this.config.streamingEnabled,
    };

    if (this.config.streamingEnabled && callbacks.onToken) {
      // 流式调用
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<{ stream_id: string; token: string }>('llm-stream-token', (event) => {
          if (event.payload.stream_id === streamId) {
            callbacks.onToken!(event.payload.token);
          }
        });

        const resultJson = await invoke<string>('llm_call_streaming', {
          requestJson: JSON.stringify(request),
          streamId,
        });
        return JSON.parse(resultJson) as LLMCallResult;
      } finally {
        unlisten?.();
      }
    } else {
      // 非流式调用
      const resultJson = await invoke<string>('llm_call_blocking', {
        requestJson: JSON.stringify(request),
      });
      return JSON.parse(resultJson) as LLMCallResult;
    }
  }

  /**
   * 并行执行工具调用
   */
  private async executeToolCalls(
    toolCalls: ToolCallInfo[],
    expertId: string,
    turnIndex: number,
    history: ToolCallRecord[],
    callbacks: AgentCallbacks,
  ): Promise<ToolCallResult[]> {
    // 并行执行
    const promises = toolCalls.map(async (tc) => {
      callbacks.onToolCall?.(tc.name, tc.arguments);
      const startTime = Date.now();

      try {
        const result = await this.toolExecutor.execute(tc.name, tc.arguments, expertId);
        const duration = Date.now() - startTime;

        // file_patch 成功时重置该文件的重试计数
        if (tc.name === 'file_patch' && result.success) {
          this.resetPatchRetryCount(tc.arguments);
        }

        // file_patch 失败时检查重试上限
        let output = result.result;
        if (tc.name === 'file_patch' && !result.success) {
          output = this.checkPatchRetryLimit(tc.name, output);
        }

        const record: ToolCallRecord = {
          turn: turnIndex,
          toolName: tc.name,
          arguments: tc.arguments,
          result: output,
          success: result.success,
          durationMs: duration,
        };
        history.push(record);
        callbacks.onToolResult?.(tc.name, result);

        return { callId: tc.id, output };
      } catch (error: any) {
        const duration = Date.now() - startTime;
        const errorMsg = `工具执行失败: ${error.message || error}`;

        const record: ToolCallRecord = {
          turn: turnIndex,
          toolName: tc.name,
          arguments: tc.arguments,
          result: errorMsg,
          success: false,
          durationMs: duration,
        };
        history.push(record);

        return { callId: tc.id, output: errorMsg };
      }
    });

    return Promise.all(promises);
  }

  /**
   * 死循环检测：最近N次调用签名是否相同
   */
  private detectDeadLoop(recentCalls: string[]): boolean {
    const n = this.config.deadLoopDetection;
    if (recentCalls.length < n) return false;
    const last = recentCalls.slice(-n);
    return last.every(call => call === last[0]);
  }

  /**
   * 检查 file_patch 重试次数，超限时附加提示让模型改用 file_write
   */
  private checkPatchRetryLimit(toolName: string, result: string): string {
    if (toolName !== 'file_patch') return result;

    // 从结构化错误结果中提取失败的文件路径
    const failedFileMatch = result.match(/\*\*File\*\*: (.+)/);
    if (!failedFileMatch) return result; // 不是结构化错误结果

    const filePath = failedFileMatch[1].trim();
    const retries = (this.patchRetryCount.get(filePath) || 0) + 1;
    this.patchRetryCount.set(filePath, retries);

    if (retries >= this.MAX_PATCH_RETRIES) {
      return result + `\n\n\u26a0\ufe0f WARNING: This file has failed ${retries} times. Consider using file_write to overwrite the entire file instead of patching, or read the file first with file_read to get current content.`;
    }

    return result;
  }

  /**
   * file_patch 成功时重置对应文件的重试计数
   */
  private resetPatchRetryCount(argsJson: string): void {
    try {
      const args = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson;
      // patch 参数中可能包含文件路径信息
      if (args.path) {
        this.patchRetryCount.delete(args.path);
      } else if (args.file) {
        this.patchRetryCount.delete(args.file);
      } else {
        // 成功时清除所有计数（整个 patch 操作成功）
        this.patchRetryCount.clear();
      }
    } catch {
      // 解析失败时清除所有计数
      this.patchRetryCount.clear();
    }
  }
}

interface LLMCallResult {
  content: string | null;
  toolCalls: ToolCallInfo[] | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  model: string;
  finish_reason: string;
}

interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

interface ToolCallResult {
  callId: string;
  output: string;
}
