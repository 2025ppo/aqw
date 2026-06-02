/**
 * 上下文管理器 - Token预算管理 + 自动压缩
 * 借鉴Codex的Fragment系统和auto_compact机制
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  timestamp?: number;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  result?: string;
}

export interface ContextFragment {
  id: string;
  type: 'system' | 'rag' | 'memory' | 'blackboard' | 'tool-schema' | 'user-instruction';
  content: string;
  priority: number;    // 越高越不容易被压缩移除
  maxTokens?: number;  // 此片段的最大token预算
}

export interface ContextManagerConfig {
  tokenBudget: number;         // 总Token预算 (默认100000)
  compactThreshold: number;    // 触发压缩的比例 (默认0.8)
  reserveRatio: number;        // 预留比例 (默认0.2)
  keepRecentTurns: number;     // 始终保留的最近轮数 (默认3)
  maxFragmentTokens: number;   // 单个Fragment最大token (默认10000)
}

export class ContextManager {
  private config: ContextManagerConfig;
  private fragments: ContextFragment[] = [];

  constructor(config?: Partial<ContextManagerConfig>) {
    this.config = {
      tokenBudget: config?.tokenBudget ?? 100000,
      compactThreshold: config?.compactThreshold ?? 0.8,
      reserveRatio: config?.reserveRatio ?? 0.2,
      keepRecentTurns: config?.keepRecentTurns ?? 3,
      maxFragmentTokens: config?.maxFragmentTokens ?? 10000,
    };
  }

  /**
   * 估算文本的Token数
   * 策略：中文约2.5 token/字, 英文约1.3 token/word, 代码约1.5 token/word
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    let tokens = 0;
    // 中文字符计数
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    tokens += chineseChars * 2.5;
    // 剩余部分按英文/代码处理
    const nonChinese = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, '');
    const words = nonChinese.split(/\s+/).filter(w => w.length > 0);
    tokens += words.length * 1.5;
    // 特殊token：换行、标点等
    tokens += (text.match(/\n/g) || []).length;
    return Math.ceil(tokens);
  }

  /**
   * 估算消息列表的总Token数
   */
  estimateMessagesTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.estimateTokens(msg.content);
      total += 4; // 每条消息的overhead (role, separator等)
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += this.estimateTokens(tc.arguments);
          if (tc.result) total += this.estimateTokens(tc.result);
          total += 10; // tool call overhead
        }
      }
    }
    return total;
  }

  /**
   * 检查是否超出预算
   */
  exceedsBudget(messages: ChatMessage[]): boolean {
    const used = this.estimateMessagesTokens(messages);
    const threshold = this.config.tokenBudget * this.config.compactThreshold;
    return used > threshold;
  }

  /**
   * 获取剩余Token预算
   */
  getRemainingBudget(messages: ChatMessage[]): number {
    const used = this.estimateMessagesTokens(messages);
    const available = this.config.tokenBudget * (1 - this.config.reserveRatio);
    return Math.max(0, available - used);
  }

  /**
   * 自动压缩上下文
   * 策略:
   * 1. 保留所有system消息
   * 2. 保留最近N轮完整对话
   * 3. 中间轮次的工具输出替换为摘要
   * 4. 早期的assistant消息压缩为要点
   */
  compact(messages: ChatMessage[]): ChatMessage[] {
    if (!this.exceedsBudget(messages)) return messages;

    const result: ChatMessage[] = [];
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    // 始终保留system消息
    result.push(...systemMsgs);

    // 识别对话轮次(user→assistant为一轮)
    const turns = this.splitIntoTurns(nonSystemMsgs);
    const keepCount = Math.min(this.config.keepRecentTurns, turns.length);
    const recentTurns = turns.slice(-keepCount);
    const oldTurns = turns.slice(0, -keepCount);

    // 压缩旧轮次
    if (oldTurns.length > 0) {
      const summary = this.summarizeOldTurns(oldTurns);
      result.push({
        role: 'system',
        content: `[前期对话摘要]\n${summary}`,
      });
    }

    // 保留最近轮次(但压缩工具输出)
    for (const turn of recentTurns) {
      for (const msg of turn) {
        if (msg.role === 'tool' && msg.content.length > 2000) {
          // 工具输出超长时截断
          result.push({
            ...msg,
            content: this.truncateToolOutput(msg.content),
          });
        } else {
          result.push(msg);
        }
      }
    }

    return result;
  }

  /**
   * 将消息分为对话轮次
   */
  private splitIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
    const turns: ChatMessage[][] = [];
    let current: ChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'user' && current.length > 0) {
        turns.push(current);
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) turns.push(current);
    return turns;
  }

  /**
   * 生成旧轮次摘要
   */
  private summarizeOldTurns(turns: ChatMessage[][]): string {
    const summaries: string[] = [];
    for (const turn of turns) {
      const userMsg = turn.find(m => m.role === 'user');
      const assistantMsg = turn.find(m => m.role === 'assistant');
      const toolMsgs = turn.filter(m => m.role === 'tool');

      let summary = '';
      if (userMsg) summary += `用户: ${userMsg.content.slice(0, 100)}...`;
      if (toolMsgs.length > 0) summary += ` [使用了${toolMsgs.length}个工具]`;
      if (assistantMsg) summary += ` → 回复: ${assistantMsg.content.slice(0, 100)}...`;
      summaries.push(summary);
    }
    return summaries.join('\n');
  }

  /**
   * 截断工具输出(保留头尾)
   */
  private truncateToolOutput(output: string): string {
    const lines = output.split('\n');
    if (lines.length <= 50) return output;
    const head = lines.slice(0, 20).join('\n');
    const tail = lines.slice(-20).join('\n');
    return `${head}\n\n[...省略 ${lines.length - 40} 行...]\n\n${tail}`;
  }

  // ===== Fragment管理 =====

  /**
   * 注册上下文片段
   */
  addFragment(fragment: ContextFragment): void {
    // 检查token限制
    const tokens = this.estimateTokens(fragment.content);
    if (fragment.maxTokens && tokens > fragment.maxTokens) {
      fragment.content = fragment.content.slice(0, fragment.maxTokens * 2); // 粗略截断
    }
    this.fragments.push(fragment);
    this.fragments.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 移除片段
   */
  removeFragment(id: string): void {
    this.fragments = this.fragments.filter(f => f.id !== id);
  }

  /**
   * 构建所有Fragment为上下文字符串
   * 按优先级排列，超出预算时从低优先级开始移除
   */
  buildFragmentsContext(budgetTokens: number): string {
    let totalTokens = 0;
    const included: ContextFragment[] = [];

    for (const fragment of this.fragments) {
      const tokens = this.estimateTokens(fragment.content);
      if (totalTokens + tokens <= budgetTokens) {
        included.push(fragment);
        totalTokens += tokens;
      }
    }

    return included.map(f => f.content).join('\n\n');
  }

  /**
   * 清空所有Fragment
   */
  clearFragments(): void {
    this.fragments = [];
  }

  /**
   * 获取当前配置
   */
  getConfig(): ContextManagerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(partial: Partial<ContextManagerConfig>): void {
    Object.assign(this.config, partial);
  }
}

// 导出单例（全局共享）
let _instance: ContextManager | null = null;
export function getContextManager(config?: Partial<ContextManagerConfig>): ContextManager {
  if (!_instance) {
    _instance = new ContextManager(config);
  }
  return _instance;
}
