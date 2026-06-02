import { assemblePromptFromModules, buildPromptModuleTraceSignature, buildExpertPromptPlan, detectToolIntentWithoutAction, extractPromptModuleTracesFromSessions, inferPromptSceneFromTaskText, suggestPromptModuleHintsFromHistory, } from "../src/prompt-modules.js";
const moduleScenarios = [
    {
        name: "调研员本地调研不额外加载联网细则",
        expertId: "jiang-ruoxi",
        scene: "technical-research",
        task: "梳理当前项目目录结构和相关代码，不需要联网。",
        basePrompt: "你是调研员。",
        expectedIncluded: ["code-tool-primer"],
        expectedExcluded: ["web-search-guidance", "command-guidance"],
    },
    {
        name: "调研员遇到最新资料场景加载搜索细则",
        expertId: "jiang-ruoxi",
        scene: "research-with-search",
        task: "调研 OpenAI Responses API 的最新官方文档和兼容性变化。",
        basePrompt: "你是调研员。",
        expectedIncluded: ["code-tool-primer", "web-search-guidance"],
        expectedExcluded: ["command-guidance"],
    },
    {
        name: "前端开发普通样式改动不额外加载命令细则",
        expertId: "jiang-yumo",
        scene: "code-development",
        task: "修复按钮圆角和文案错别字。",
        basePrompt: "你是前端工程师。",
        expectedIncluded: ["code-tool-primer"],
        expectedExcluded: ["web-search-guidance", "command-guidance"],
    },
    {
        name: "前端开发涉及构建验证时加载命令细则",
        expertId: "jiang-yumo",
        scene: "code-development",
        task: "修复构建失败并运行 pnpm build 验证结果。",
        basePrompt: "你是前端工程师。",
        expectedIncluded: ["code-tool-primer", "command-guidance"],
        expectedExcluded: ["web-search-guidance"],
    },
    {
        name: "审查场景默认保留命令验证细则",
        expertId: "jiang-yingqiu",
        scene: "code-review",
        task: "审查这次修复并确认是否存在回归风险。",
        basePrompt: "你是审查员。",
        expectedIncluded: ["code-tool-primer", "command-guidance"],
        expectedExcluded: ["web-search-guidance"],
    },
    {
        name: "测试专家默认携带命令细则",
        expertId: "jiang-cexun",
        scene: "code-development",
        task: "执行一次回归验证并给出是否可交付结论。",
        basePrompt: "你是测试专家。",
        expectedIncluded: ["code-tool-primer", "command-guidance"],
        expectedExcluded: ["video-workflow"],
    },
    {
        name: "媒体专家普通海报任务不加载视频工作流",
        expertId: "jiang-huaying",
        scene: "media-creation",
        task: "生成一张品牌海报。",
        basePrompt: "你是媒体专家。",
        expectedIncluded: ["media-tool-primer"],
        expectedExcluded: ["video-workflow"],
    },
    {
        name: "媒体专家视频制作任务加载完整视频工作流",
        expertId: "jiang-huaying",
        scene: "video-production",
        task: "制作一个产品介绍视频并拆分镜头 storyboard。",
        basePrompt: "你是媒体专家。",
        expectedIncluded: ["media-tool-primer", "video-workflow"],
    },
    {
        name: "主管提示可为隐式验证任务补充命令细则",
        expertId: "jiang-yumo",
        scene: "code-development",
        task: "修完后做一次完整验证，确保没有回归。",
        basePrompt: "你是前端工程师。",
        hintModuleIds: ["command-guidance"],
        expectedIncluded: ["code-tool-primer", "command-guidance"],
        expectedExcluded: ["web-search-guidance"],
    },
    {
        name: "主管提示可为隐式外部事实任务补充搜索细则",
        expertId: "jiang-ruoxi",
        scene: "technical-research",
        task: "核对供应商说法是否准确并形成结论。",
        basePrompt: "你是调研员。",
        hintModuleIds: ["web-search-guidance"],
        expectedIncluded: ["code-tool-primer", "web-search-guidance"],
        expectedExcluded: ["command-guidance"],
    },
    {
        name: "错误专家模块提示会被白名单过滤",
        expertId: "jiang-yumo",
        scene: "code-development",
        task: "修复一个普通前端样式问题。",
        basePrompt: "你是前端工程师。",
        hintModuleIds: ["video-workflow"],
        expectedIncluded: ["code-tool-primer"],
        expectedExcluded: ["video-workflow", "web-search-guidance", "command-guidance"],
    },
];
const intentScenarios = [
    {
        name: "最新资料表达触发搜索兜底",
        text: "我需要先查一下最新官方文档再判断。",
        expected: { needsWebSearch: true, needsCommand: false, needsVideoWorkflow: false },
    },
    {
        name: "构建验证表达触发命令兜底",
        text: "建议先运行 pnpm build 看一下具体报错。",
        expected: { needsWebSearch: false, needsCommand: true, needsVideoWorkflow: false },
    },
    {
        name: "分镜表达触发视频兜底",
        text: "先给出镜头拆分和 storyboard，再继续生成。",
        expected: { needsWebSearch: false, needsCommand: false, needsVideoWorkflow: true },
    },
    {
        name: "直接可回答内容不触发任何兜底",
        text: "可以直接给出最终总结，不需要额外工具。",
        expected: { needsWebSearch: false, needsCommand: false, needsVideoWorkflow: false },
    },
    {
        name: "否定命令表达不会误触发命令兜底",
        text: "这个问题不需要运行任何命令，直接解释原因即可。",
        expected: { needsWebSearch: false, needsCommand: false, needsVideoWorkflow: false },
    },
];
const historyScenarios = [
    {
        name: "历史命令使用可为相似问题补充命令细则",
        traces: [
            {
                expertId: "jiang-yumo",
                scene: "code-development",
                taskDescription: "修复登录页白屏并确认红屏报错是否消失",
                moduleIds: ["command-guidance"],
                triggerSources: ["command"],
                createdAt: Date.now(),
            },
        ],
        expertId: "jiang-yumo",
        scene: "code-development",
        task: "修好之后复查这次白屏现象有没有真正消失",
        expectedModules: ["command-guidance"],
    },
    {
        name: "历史联网调研可为相似核对任务补充搜索细则",
        traces: [
            {
                expertId: "jiang-ruoxi",
                scene: "technical-research",
                taskDescription: "核对供应商宣称的 API 兼容性是否准确",
                moduleIds: ["web-search-guidance"],
                triggerSources: ["web-search"],
                createdAt: Date.now(),
            },
        ],
        expertId: "jiang-ruoxi",
        scene: "technical-research",
        task: "复核这次供应商关于兼容性的说法能不能站住脚",
        expectedModules: ["web-search-guidance"],
    },
];
const sessionReplayScenarios = [
    {
        name: "命令工具卡片可从历史会话回灌为开发轨迹",
        sessions: [
            {
                id: 1,
                name: "对话 1",
                messages: [
                    {
                        role: "expert-tasks",
                        content: JSON.stringify([
                            {
                                expertId: "jiang-yumo",
                                expertName: "江雨墨",
                                expertTitle: "前端工程师",
                                input: "修复登录页白屏并运行 pnpm build 验证结果",
                                status: "running",
                                startTime: 100,
                            },
                        ]),
                    },
                    {
                        role: "tool-event",
                        content: JSON.stringify({
                            kind: "command",
                            createdAt: 120,
                            initiator: {
                                expertId: "jiang-yumo",
                                expertName: "江雨墨",
                                expertTitle: "前端工程师",
                            },
                            reason: "需要验证构建是否恢复",
                            command: "pnpm build",
                            workingDir: "/repo",
                            authMode: "auto",
                            status: "success",
                            output: { stdout: "ok", stderr: "", exitCode: 0 },
                        }),
                    },
                    {
                        role: "expert-tasks",
                        content: JSON.stringify([
                            {
                                expertId: "jiang-yumo",
                                expertName: "江雨墨",
                                expertTitle: "前端工程师",
                                input: "修复登录页白屏并运行 pnpm build 验证结果",
                                status: "done",
                                startTime: 100,
                                endTime: 180,
                            },
                        ]),
                    },
                ],
            },
        ],
        expectedTraces: [
            {
                expertId: "jiang-yumo",
                scene: "code-development",
                moduleIds: ["command-guidance"],
            },
        ],
    },
    {
        name: "搜索工具卡片会去重并在会话尾部补回灌",
        sessions: [
            {
                id: 2,
                name: "对话 2",
                messages: [
                    {
                        role: "expert-tasks",
                        content: JSON.stringify([
                            {
                                expertId: "jiang-ruoxi",
                                expertName: "江若溪",
                                expertTitle: "调研员",
                                input: "核对 OpenAI API 最新官方兼容性说明",
                                status: "running",
                                startTime: 200,
                            },
                        ]),
                    },
                    {
                        role: "tool-event",
                        content: JSON.stringify({
                            kind: "web-search",
                            createdAt: 220,
                            initiator: {
                                expertId: "jiang-ruoxi",
                                expertName: "江若溪",
                                expertTitle: "调研员",
                            },
                            reason: "需要核对最新官方资料",
                            query: "OpenAI API compatibility official docs",
                            status: "success",
                            results: [],
                        }),
                    },
                    {
                        role: "expert-tasks",
                        content: JSON.stringify([
                            {
                                expertId: "jiang-ruoxi",
                                expertName: "江若溪",
                                expertTitle: "调研员",
                                input: "核对 OpenAI API 最新官方兼容性说明",
                                status: "done",
                                startTime: 200,
                                endTime: 280,
                            },
                        ]),
                    },
                    {
                        role: "tool-event",
                        content: JSON.stringify({
                            kind: "web-search",
                            createdAt: 300,
                            initiator: {
                                expertId: "jiang-ruoxi",
                                expertName: "江若溪",
                                expertTitle: "调研员",
                            },
                            reason: "再次核对官网描述",
                            query: "OpenAI API official documentation",
                            status: "success",
                            results: [],
                        }),
                    },
                ],
            },
        ],
        expectedTraces: [
            {
                expertId: "jiang-ruoxi",
                scene: "research-with-search",
                moduleIds: ["web-search-guidance"],
            },
        ],
    },
];
let hasFailure = false;
let totalSavedChars = 0;
function assert(condition, message) {
    if (!condition) {
        hasFailure = true;
        console.error(`FAIL ${message}`);
    }
}
function getNaiveBaselineModules(expertId) {
    if (["jiang-ruoxi", "jiang-qinglan", "jiang-yumo", "jiang-subai", "jiang-yingqiu", "jiang-jianheng", "jiang-cexun"].includes(expertId)) {
        return ["code-tool-primer", "web-search-guidance", "command-guidance"];
    }
    if (expertId === "jiang-huaying") {
        return ["media-tool-primer", "video-workflow"];
    }
    if (expertId === "jiang-zhilan") {
        return ["document-tool-primer"];
    }
    return [];
}
console.log("Prompt Module Replay");
console.log("====================");
for (const scenario of moduleScenarios) {
    const plan = buildExpertPromptPlan(scenario.expertId, scenario.basePrompt, scenario.scene, scenario.task, scenario.hintModuleIds);
    const moduleSet = new Set(plan.moduleIds);
    const extraChars = Math.max(0, plan.prompt.length - scenario.basePrompt.length);
    const baselinePrompt = assemblePromptFromModules(scenario.basePrompt, getNaiveBaselineModules(scenario.expertId));
    const savedChars = Math.max(0, baselinePrompt.length - plan.prompt.length);
    totalSavedChars += savedChars;
    console.log(`CASE ${scenario.name}`);
    console.log(`  modules: ${plan.moduleIds.join(", ") || "(none)"}`);
    console.log(`  prompt chars: base=${scenario.basePrompt.length}, total=${plan.prompt.length}, extra=${extraChars}`);
    console.log(`  naive baseline chars: ${baselinePrompt.length}, saved=${savedChars}`);
    for (const moduleId of scenario.expectedIncluded) {
        assert(moduleSet.has(moduleId), `${scenario.name} 应加载 ${moduleId}`);
    }
    for (const moduleId of scenario.expectedExcluded || []) {
        assert(!moduleSet.has(moduleId), `${scenario.name} 不应加载 ${moduleId}`);
    }
}
console.log("");
console.log("Tool Intent Replay");
console.log("==================");
for (const scenario of intentScenarios) {
    const inferred = detectToolIntentWithoutAction(scenario.text);
    console.log(`CASE ${scenario.name}`);
    console.log(`  inferred: ${JSON.stringify(inferred)}`);
    assert(inferred.needsWebSearch === scenario.expected.needsWebSearch
        && inferred.needsCommand === scenario.expected.needsCommand
        && inferred.needsVideoWorkflow === scenario.expected.needsVideoWorkflow, `${scenario.name} 的兜底判断与预期不符`);
}
console.log("");
console.log("History Hint Replay");
console.log("===================");
for (const scenario of historyScenarios) {
    const inferredModules = suggestPromptModuleHintsFromHistory(scenario.traces, scenario.expertId, scenario.scene, scenario.task);
    console.log(`CASE ${scenario.name}`);
    console.log(`  inferred modules: ${inferredModules.join(", ") || "(none)"}`);
    for (const moduleId of scenario.expectedModules) {
        assert(inferredModules.includes(moduleId), `${scenario.name} 应命中 ${moduleId}`);
    }
}
console.log("");
console.log("Historical Session Replay");
console.log("=========================");
for (const scenario of sessionReplayScenarios) {
    const traces = extractPromptModuleTracesFromSessions(scenario.sessions);
    console.log(`CASE ${scenario.name}`);
    console.log(`  traces: ${traces.map((trace) => buildPromptModuleTraceSignature(trace)).join(" | ") || "(none)"}`);
    assert(traces.length === scenario.expectedTraces.length, `${scenario.name} 的轨迹数量不符合预期`);
    for (const expectedTrace of scenario.expectedTraces) {
        const matched = traces.find((trace) => trace.expertId === expectedTrace.expertId
            && trace.scene === expectedTrace.scene
            && expectedTrace.moduleIds.every((moduleId) => trace.moduleIds.includes(moduleId)));
        assert(!!matched, `${scenario.name} 未提取出 ${expectedTrace.expertId} 的预期轨迹`);
    }
}
console.log("");
console.log("Scene Inference Replay");
console.log("======================");
const inferredReviewScene = inferPromptSceneFromTaskText("审查这次修复并确认是否还有回归风险", ["command-guidance"]);
console.log(`CASE 代码审查场景推断 -> ${inferredReviewScene}`);
assert(inferredReviewScene === "code-review", "代码审查场景应推断为 code-review");
const inferredResearchScene = inferPromptSceneFromTaskText("核对 OpenAI API 最新官方兼容性说明", ["web-search-guidance"]);
console.log(`CASE 搜索调研场景推断 -> ${inferredResearchScene}`);
assert(inferredResearchScene === "research-with-search", "搜索调研场景应推断为 research-with-search");
if (hasFailure) {
    process.exitCode = 1;
    console.error("\nPrompt module replay failed.");
}
else {
    console.log(`\nAll prompt module replay checks passed. Total chars saved vs naive baseline: ${totalSavedChars}`);
}
