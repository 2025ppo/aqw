import { invoke } from "@tauri-apps/api/core";
import {
  buildPromptModuleTraceSignature,
  extractPromptModuleTracesFromSessions,
  normalizePromptModuleTrace,
  normalizePromptModuleTraces,
  suggestPromptModuleHintsFromHistory,
  type PromptModuleId,
  type PromptModuleTrace,
  type PromptScene,
} from "./prompt-modules";

const promptModuleTraceCache = new Map<string, PromptModuleTrace[]>();

function dedupePromptModuleTraces(traces: PromptModuleTrace[]): PromptModuleTrace[] {
  const traceMap = new Map<string, PromptModuleTrace>();
  for (const trace of traces) {
    const signature = buildPromptModuleTraceSignature(trace);
    const existing = traceMap.get(signature);
    if (!existing || trace.createdAt >= existing.createdAt) {
      traceMap.set(signature, trace);
    }
  }
  return [...traceMap.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-500);
}

async function savePromptModuleTraces(
  projectName: string,
  traces: PromptModuleTrace[]
): Promise<void> {
  const normalized = dedupePromptModuleTraces(normalizePromptModuleTraces(traces));
  await invoke("save_prompt_module_traces", {
    projectName,
    data: JSON.stringify(normalized),
  });
  promptModuleTraceCache.set(projectName, normalized);
}

export async function loadPromptModuleTraces(projectName: string): Promise<PromptModuleTrace[]> {
  if (promptModuleTraceCache.has(projectName)) {
    return promptModuleTraceCache.get(projectName)!;
  }

  try {
    const raw = await invoke<string>("load_prompt_module_traces", { projectName });
    const parsed = dedupePromptModuleTraces(normalizePromptModuleTraces(JSON.parse(raw)));
    promptModuleTraceCache.set(projectName, parsed);
    return parsed;
  } catch {
    promptModuleTraceCache.set(projectName, []);
    return [];
  }
}

export async function appendPromptModuleTrace(
  projectName: string,
  trace: PromptModuleTrace
): Promise<void> {
  const normalized = normalizePromptModuleTrace(trace);
  if (!normalized) return;

  const cached = await loadPromptModuleTraces(projectName);
  const signature = buildPromptModuleTraceSignature(normalized);
  if (cached.some((item) => buildPromptModuleTraceSignature(item) === signature)) {
    return;
  }

  await invoke("append_prompt_module_trace", {
    projectName,
    trace: normalized,
  });

  const next = dedupePromptModuleTraces([...cached, normalized]);
  promptModuleTraceCache.set(projectName, next);
}

export async function loadPromptModuleHistoryHints(
  projectName: string,
  expertId: string,
  scene: PromptScene,
  taskDescription: string
): Promise<PromptModuleId[]> {
  const traces = await loadPromptModuleTraces(projectName);
  return suggestPromptModuleHintsFromHistory(traces, expertId, scene, taskDescription);
}

export async function bootstrapPromptModuleHistoryFromSessions(
  projectName: string,
  rawSessions: unknown
): Promise<{ existing: number; derived: number; imported: number; total: number }> {
  const existing = await loadPromptModuleTraces(projectName);
  const existingDeduped = dedupePromptModuleTraces(existing);
  const existingSignatures = new Set(existingDeduped.map((trace) => buildPromptModuleTraceSignature(trace)));
  const derived = dedupePromptModuleTraces(extractPromptModuleTracesFromSessions(rawSessions));

  let imported = 0;
  for (const trace of derived) {
    const signature = buildPromptModuleTraceSignature(trace);
    if (!existingSignatures.has(signature)) {
      existingSignatures.add(signature);
      imported++;
    }
  }

  const merged = dedupePromptModuleTraces([...existingDeduped, ...derived]);
  if (imported > 0 || merged.length !== existing.length) {
    await savePromptModuleTraces(projectName, merged);
  } else {
    promptModuleTraceCache.set(projectName, merged);
  }

  return {
    existing: existingDeduped.length,
    derived: derived.length,
    imported,
    total: merged.length,
  };
}
