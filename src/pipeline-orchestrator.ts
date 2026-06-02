/**
 * Pipeline编排器 — 从expert-router拆出的流水线执行引擎
 * 增强: Hook系统、超时保护、死循环检测、Tauri Event进度推送
 */
import { emit } from '@tauri-apps/api/event';
import { AgentLoop, AgentResult, AgentCallbacks } from './agent-loop';
import { getConfig } from './config-cascade';
import type { ChatMessage } from './context-manager';

// ===== Hook系统 =====
export type HookPhase = 'pre-expert' | 'post-expert' | 'pre-tool' | 'post-tool';

export interface HookContext {
  phase: HookPhase;
  expertId: string;
  stepIndex: number;
  totalSteps: number;
  blackboard: OrchestratorBlackboard;
  toolName?: string;
  toolArgs?: any;
  toolResult?: string;
  expertOutput?: string;
}

export type HookDecision =
  | { action: 'continue' }
  | { action: 'modify-input'; data: any }
  | { action: 'skip'; reason: string }
  | { action: 'inject-context'; content: string }
  | { action: 'retry'; reason: string };

export interface PipelineHook {
  id: string;
  phase: HookPhase;
  priority: number;
  handler: (ctx: HookContext) => Promise<HookDecision>;
}

// ===== 编排器黑板(精简版，与expert-router的BlackboardTask共存) =====
export interface OrchestratorBlackboard {
  goal: string;
  requiredFiles: string[];
  evidence: string[];
  assumptions: string[];
  openQuestions: string[];
  patchProposals: string[];
  validationRuns: string[];
  reviewDecisions: string[];
  blockers: string[];
  expertOutputs: Map<string, string>; // expertId → 最新输出
}

// ===== Pipeline定义 =====
export interface OrchestratorPipelineStep {
  expertId: string;
  role: string;
  optional?: boolean;
  parallel?: boolean; // 可与下一步并行
}

export interface PipelineDefinition {
  scene: string;
  steps: OrchestratorPipelineStep[];
}

// ===== 进度事件 =====
export interface PipelineProgress {
  pipelineScene: string;
  currentStep: number;
  totalSteps: number;
  currentExpertId: string;
  currentExpertName: string;
  currentToolRound: number;
  status: 'running' | 'tool-calling' | 'waiting-approval' | 'completed' | 'error';
}

// ===== 主管决策 =====
export type SupervisorDecision =
  | { action: 'continue' }
  | { action: 'retry'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string }
  | { action: 'add-step'; step: OrchestratorPipelineStep; reason: string }
  | { action: 'remove-step'; stepIndex: number; reason: string };

// ===== 步骤结果 =====
export interface StepResult {
  expertId: string;
  success: boolean;
  output: string;
  toolCalls: number;
}

// ===== Pipeline结果 =====
export interface PipelineResult {
  scene: string;
  steps: StepResult[];
  blackboard: OrchestratorBlackboard;
  success: boolean;
}

// ===== 回调接口 =====
export interface PipelineCallbacks {
  onStepStart?: (index: number, step: OrchestratorPipelineStep) => void;
  onStepComplete?: (index: number, step: OrchestratorPipelineStep, result: AgentResult) => void;
  onStepError?: (index: number, step: OrchestratorPipelineStep, error: string) => void;
  onToken?: (expertId: string, token: string) => void;
  onToolCall?: (expertId: string, name: string, args: any) => void;
  onToolResult?: (expertId: string, name: string, result: any) => void;
  supervisorCheck?: (blackboard: OrchestratorBlackboard, results: StepResult[]) => Promise<SupervisorDecision>;
}

// ===== 编排器主类 =====
export class PipelineOrchestrator {
  private hooks: PipelineHook[] = [];
  private pipelineConfig = getConfig().getPipeline();

  constructor() {
    this.registerBuiltinHooks();
  }

  // Hook管理
  registerHook(hook: PipelineHook): void {
    this.hooks.push(hook);
    this.hooks.sort((a, b) => a.priority - b.priority);
  }

  removeHook(hookId: string): void {
    this.hooks = this.hooks.filter(h => h.id !== hookId);
  }

  private async runHooks(ctx: HookContext): Promise<HookDecision[]> {
    const decisions: HookDecision[] = [];
    for (const hook of this.hooks.filter(h => h.phase === ctx.phase)) {
      decisions.push(await hook.handler(ctx));
    }
    return decisions;
  }

  // 内置Hook注册
  private registerBuiltinHooks(): void {
    // 1. PreExpert: 注入黑板摘要
    this.registerHook({
      id: 'inject-blackboard',
      phase: 'pre-expert',
      priority: 10,
      handler: async (ctx) => {
        const summary = this.formatBlackboardSummary(ctx.blackboard);
        return { action: 'inject-context', content: summary };
      },
    });

    // 2. PostExpert: 检测无进展
    this.registerHook({
      id: 'detect-no-progress',
      phase: 'post-expert',
      priority: 20,
      handler: async (ctx) => {
        const prevOutput = ctx.blackboard.expertOutputs.get(ctx.expertId);
        if (prevOutput && ctx.expertOutput && prevOutput === ctx.expertOutput) {
          return { action: 'retry', reason: '专家输出与上次相同，请尝试不同方法' };
        }
        return { action: 'continue' };
      },
    });

    // 3. PostTool: 命令失败提示
    this.registerHook({
      id: 'tool-failure-notice',
      phase: 'post-tool',
      priority: 10,
      handler: async (ctx) => {
        if (ctx.toolResult && ctx.toolResult.includes('Exit code:') && !ctx.toolResult.includes('Exit code: 0')) {
          return { action: 'inject-context', content: '上一个命令执行失败，请检查错误输出并调整策略。' };
        }
        return { action: 'continue' };
      },
    });
  }

  /**
   * 执行完整Pipeline
   */
  async execute(
    scene: string,
    steps: OrchestratorPipelineStep[],
    userGoal: string,
    systemPromptBuilder: (expertId: string, blackboard: OrchestratorBlackboard) => string,
    callbacks: PipelineCallbacks,
  ): Promise<PipelineResult> {
    const blackboard: OrchestratorBlackboard = {
      goal: userGoal,
      requiredFiles: [],
      evidence: [],
      assumptions: [],
      openQuestions: [],
      patchProposals: [],
      validationRuns: [],
      reviewDecisions: [],
      blockers: [],
      expertOutputs: new Map(),
    };

    const results: StepResult[] = [];
    let currentSteps = [...steps];

    const progress: PipelineProgress = {
      pipelineScene: scene,
      currentStep: 0,
      totalSteps: currentSteps.length,
      currentExpertId: '',
      currentExpertName: '',
      currentToolRound: 0,
      status: 'running',
    };

    for (let i = 0; i < currentSteps.length && i < this.pipelineConfig.max_pipeline_steps; i++) {
      const step = currentSteps[i];

      // 发送进度事件
      progress.currentStep = i + 1;
      progress.totalSteps = currentSteps.length;
      progress.currentExpertId = step.expertId;
      progress.currentExpertName = step.role;
      progress.currentToolRound = 0;
      progress.status = 'running';
      await emit('pipeline-progress', progress);
      callbacks.onStepStart?.(i, step);

      // Pre-Expert Hooks
      const hookCtx: HookContext = {
        phase: 'pre-expert',
        expertId: step.expertId,
        stepIndex: i,
        totalSteps: currentSteps.length,
        blackboard,
      };
      const preDecisions = await this.runHooks(hookCtx);

      // 处理hook决策
      let extraContext = '';
      let shouldSkip = false;
      for (const d of preDecisions) {
        if (d.action === 'skip') { shouldSkip = true; break; }
        if (d.action === 'inject-context') { extraContext += '\n' + d.content; }
      }
      if (shouldSkip) {
        results.push({ expertId: step.expertId, success: true, output: '[skipped by hook]', toolCalls: 0 });
        continue;
      }

      // 构建专家的system prompt
      const systemPrompt = systemPromptBuilder(step.expertId, blackboard) + extraContext;

      // 构建初始消息（含用户目标 + 黑板上下文）
      const initialMessages = this.buildInitialMessages(userGoal, blackboard, step.expertId);

      // 执行Agent Loop（带超时）
      const agentLoop = new AgentLoop();
      const agentCallbacks: AgentCallbacks = {
        onToken: (token) => callbacks.onToken?.(step.expertId, token),
        onToolCall: (name, args) => {
          progress.status = 'tool-calling';
          progress.currentToolRound++;
          emit('pipeline-progress', progress);
          callbacks.onToolCall?.(step.expertId, name, args);
        },
        onToolResult: (name, result) => {
          callbacks.onToolResult?.(step.expertId, name, result);
        },
      };

      let agentResult: AgentResult;
      try {
        agentResult = await agentLoop.runTurn(
          step.expertId,
          systemPrompt,
          initialMessages,
          agentCallbacks,
        );
      } catch (error: any) {
        results.push({ expertId: step.expertId, success: false, output: `执行错误: ${error.message}`, toolCalls: 0 });
        callbacks.onStepError?.(i, step, error.message);
        continue;
      }

      // 记录结果到黑板
      blackboard.expertOutputs.set(step.expertId, agentResult.finalOutput);
      blackboard.evidence.push(`[${step.role}] ${agentResult.finalOutput.slice(0, 200)}`);

      // Post-Expert Hooks
      const postCtx: HookContext = {
        phase: 'post-expert',
        expertId: step.expertId,
        stepIndex: i,
        totalSteps: currentSteps.length,
        blackboard,
        expertOutput: agentResult.finalOutput,
      };
      const postDecisions = await this.runHooks(postCtx);

      // 处理post-hook决策
      let shouldRetry = false;
      for (const d of postDecisions) {
        if (d.action === 'retry') {
          shouldRetry = true;
          break;
        }
        if (d.action === 'inject-context') {
          // 将额外上下文记录到黑板以供下一步使用
          blackboard.evidence.push(d.content);
        }
      }

      if (shouldRetry) {
        i--; // 回退重试当前步骤
        continue;
      }

      results.push({
        expertId: step.expertId,
        success: true,
        output: agentResult.finalOutput,
        toolCalls: agentResult.totalTurns,
      });

      callbacks.onStepComplete?.(i, step, agentResult);

      // 主管中途检查（每2步或关键步骤后）
      if (callbacks.supervisorCheck && (i % 2 === 1 || i === currentSteps.length - 1)) {
        const decision = await callbacks.supervisorCheck(blackboard, results);
        if (decision.action === 'abort') {
          break;
        } else if (decision.action === 'add-step') {
          currentSteps.splice(i + 1, 0, decision.step);
        } else if (decision.action === 'remove-step' && decision.stepIndex > i) {
          currentSteps.splice(decision.stepIndex, 1);
        }
      }
    }

    // 完成进度
    progress.status = 'completed';
    await emit('pipeline-progress', progress);

    return {
      scene,
      steps: results,
      blackboard,
      success: results.every(r => r.success),
    };
  }

  private buildInitialMessages(goal: string, blackboard: OrchestratorBlackboard, expertId: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'user', content: goal }];
    // 如果黑板有前序专家的输出，作为上下文注入
    if (blackboard.expertOutputs.size > 0) {
      const prevContext = Array.from(blackboard.expertOutputs.entries())
        .filter(([id]) => id !== expertId)
        .map(([id, output]) => `[${id}的分析结果]: ${output.slice(0, 500)}`)
        .join('\n\n');
      if (prevContext) {
        messages.unshift({ role: 'system', content: `## 前序专家分析\n${prevContext}` });
      }
    }
    return messages;
  }

  private formatBlackboardSummary(bb: OrchestratorBlackboard): string {
    const parts: string[] = [`目标: ${bb.goal}`];
    if (bb.evidence.length > 0) parts.push(`已有证据: ${bb.evidence.slice(-3).join('; ')}`);
    if (bb.blockers.length > 0) parts.push(`阻塞项: ${bb.blockers.join('; ')}`);
    if (bb.openQuestions.length > 0) parts.push(`待解决: ${bb.openQuestions.join('; ')}`);
    return parts.join('\n');
  }
}
