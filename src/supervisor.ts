/**
 * 主管(江星图)逻辑模块
 * 职责: 场景分类、流水线选择、中途决策、最终总结
 */
import { AgentLoop } from './agent-loop';
import type { OrchestratorBlackboard, SupervisorDecision, StepResult } from './pipeline-orchestrator';

export class Supervisor {
  private agentLoop: AgentLoop;

  constructor() {
    this.agentLoop = new AgentLoop({ maxTurns: 3 }); // 主管只做短交互
  }

  /**
   * 场景分类 — 分析用户意图，选择Pipeline
   */
  async classifyScene(userInput: string): Promise<string> {
    const systemPrompt = `你是星图专家团的主管(江星图)。你的唯一任务是分析用户意图并返回场景类型。

可选场景:
- code-development: 编写代码、实现功能、修复bug
- code-review: 审查代码、分析质量
- technical-research: 技术调研、方案对比
- design: UI/UX设计、架构设计
- translation: 翻译任务
- writing: 创意写作、文案
- office: 办公事务
- data-analysis: 数据分析、可视化
- document-processing: 文档格式转换
- media-creation: 图像/视频相关
- video-production: 视频创作
- research-with-search: 需要网络搜索的调研

仅返回场景ID，不要解释。`;

    const result = await this.agentLoop.runTurn(
      'jiang-xingtu',
      systemPrompt,
      [{ role: 'user', content: userInput }],
    );

    return result.finalOutput.trim().replace(/['"]/g, '');
  }

  /**
   * 中途检查 — 根据当前进展决定是否调整Pipeline
   */
  async midCheck(blackboard: OrchestratorBlackboard, results: StepResult[]): Promise<SupervisorDecision> {
    // 如果有阻塞项，尝试调整
    if (blackboard.blockers.length > 0) {
      return { action: 'abort', reason: `遇到无法解决的阻塞: ${blackboard.blockers[0]}` };
    }

    // 如果连续失败，终止
    const recentFailures = results.slice(-2).filter(r => !r.success);
    if (recentFailures.length >= 2) {
      return { action: 'abort', reason: '连续两个步骤失败' };
    }

    return { action: 'continue' };
  }

  /**
   * 最终总结 — 基于黑板内容生成最终回复
   */
  async summarize(blackboard: OrchestratorBlackboard, userGoal: string): Promise<string> {
    const allOutputs = Array.from(blackboard.expertOutputs.values()).join('\n---\n');

    const systemPrompt = `你是星图专家团主管(江星图)。根据团队各专家的工作成果，给用户一个简洁的最终回复。
不要重复专家的完整输出，而是总结关键结论和最终结果。
如果有代码变更，只提供变更摘要。`;

    const result = await this.agentLoop.runTurn(
      'jiang-xingtu',
      systemPrompt,
      [
        { role: 'user', content: userGoal },
        { role: 'system', content: `团队工作成果:\n${allOutputs.slice(0, 3000)}` },
      ],
    );

    return result.finalOutput;
  }
}
