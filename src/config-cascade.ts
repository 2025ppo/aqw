/**
 * 层叠配置系统 - 借鉴Codex的Config Layer Stack
 * 优先级: 内置默认 < 用户全局 < 项目级 < 运行时覆盖
 */
import { invoke } from '@tauri-apps/api/core';

export interface AppConfig {
  llm: LLMConfig;
  shell: ShellConfig;
  approval: ApprovalConfig;
  agent: AgentConfig;
  pipeline: PipelineConfig;
  ui: UIConfig;
}

export interface LLMConfig {
  default_provider: string;
  default_model?: string;
  retry: RetrySettings;
  temperature: number;
  max_tokens: number;
}

export interface RetrySettings {
  max_retries: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  backoff_multiplier: number;
}

export interface ShellConfig {
  default_timeout_ms: number;
  max_timeout_ms: number;
  max_output_bytes: number;
  max_output_lines: number;
}

export interface ApprovalConfig {
  cache_enabled: boolean;
  auto_patterns: string[];
  block_patterns: string[];
}

export interface AgentConfig {
  max_turns: number;
  token_budget: number;
  compact_threshold: number;
  dead_loop_detection: number;
}

export interface PipelineConfig {
  expert_timeout_ms: number;
  max_pipeline_steps: number;
  enable_parallel: boolean;
}

export interface UIConfig {
  streaming_enabled: boolean;
  show_tool_calls: boolean;
  show_progress_bar: boolean;
}

// 内置默认配置
const DEFAULT_CONFIG: AppConfig = {
  llm: {
    default_provider: 'deepseek',
    retry: {
      max_retries: 5,
      initial_backoff_ms: 1000,
      max_backoff_ms: 32000,
      backoff_multiplier: 2.0,
    },
    temperature: 0.7,
    max_tokens: 4096,
  },
  shell: {
    default_timeout_ms: 60000,
    max_timeout_ms: 300000,
    max_output_bytes: 1048576,
    max_output_lines: 5000,
  },
  approval: {
    cache_enabled: true,
    auto_patterns: ['ls', 'dir', 'cat', 'type', 'echo', 'pwd', 'git status', 'git log', 'git diff', 'cargo check', 'npm run'],
    block_patterns: ['rm -rf /', 'format c:', 'del /f /s /q'],
  },
  agent: {
    max_turns: 20,
    token_budget: 100000,
    compact_threshold: 0.8,
    dead_loop_detection: 3,
  },
  pipeline: {
    expert_timeout_ms: 120000,
    max_pipeline_steps: 10,
    enable_parallel: true,
  },
  ui: {
    streaming_enabled: true,
    show_tool_calls: true,
    show_progress_bar: true,
  },
};

/**
 * 配置管理器类
 */
export class ConfigCascade {
  private config: AppConfig;
  private runtimeOverrides: Partial<AppConfig> = {};
  private loaded: boolean = false;

  constructor() {
    this.config = structuredClone(DEFAULT_CONFIG);
  }

  /**
   * 从后端加载配置（层叠合并由后端完成）
   */
  async load(projectDir?: string): Promise<AppConfig> {
    try {
      const result = await invoke<string>('load_config', { projectDir: projectDir || null });
      const backendConfig = JSON.parse(result) as AppConfig;
      this.config = this.deepMerge(DEFAULT_CONFIG, backendConfig);
    } catch (e) {
      console.warn('Failed to load config from backend, using defaults:', e);
      this.config = structuredClone(DEFAULT_CONFIG);
    }

    // 应用运行时覆盖
    if (Object.keys(this.runtimeOverrides).length > 0) {
      this.config = this.deepMerge(this.config, this.runtimeOverrides as AppConfig);
    }

    this.loaded = true;
    return this.config;
  }

  /**
   * 获取当前配置（如未加载则返回默认）
   */
  get(): AppConfig {
    return this.config;
  }

  /**
   * 是否已加载
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * 获取指定配置段
   */
  getLLM(): LLMConfig { return this.config.llm; }
  getShell(): ShellConfig { return this.config.shell; }
  getApproval(): ApprovalConfig { return this.config.approval; }
  getAgent(): AgentConfig { return this.config.agent; }
  getPipeline(): PipelineConfig { return this.config.pipeline; }
  getUI(): UIConfig { return this.config.ui; }

  /**
   * 设置运行时覆盖（不持久化，仅当前会话有效）
   */
  setRuntimeOverride(path: string, value: unknown): void {
    const keys = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let obj: any = this.runtimeOverrides;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;

    // 同时更新当前config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let configObj: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      configObj = configObj[keys[i]];
    }
    configObj[keys[keys.length - 1]] = value;
  }

  /**
   * 保存配置到后端（持久化）
   */
  async save(scope: 'global' | 'project', projectDir?: string): Promise<void> {
    const configJson = JSON.stringify(this.config);
    await invoke<string>('save_config', {
      configJson,
      scope,
      projectDir: projectDir || null,
    });
  }

  /**
   * 重置为默认配置
   */
  reset(): void {
    this.config = structuredClone(DEFAULT_CONFIG);
    this.runtimeOverrides = {};
  }

  /**
   * 深度合并对象
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private deepMerge(base: any, overlay: any): any {
    const result = structuredClone(base);
    for (const key of Object.keys(overlay)) {
      if (overlay[key] !== undefined && overlay[key] !== null) {
        if (typeof overlay[key] === 'object' && !Array.isArray(overlay[key]) && typeof result[key] === 'object') {
          result[key] = this.deepMerge(result[key], overlay[key]);
        } else {
          result[key] = overlay[key];
        }
      }
    }
    return result;
  }

  /**
   * 获取默认配置（用于UI展示所有可配置项）
   */
  getDefaults(): AppConfig {
    return structuredClone(DEFAULT_CONFIG);
  }
}

// 全局单例
let _configInstance: ConfigCascade | null = null;
export function getConfig(): ConfigCascade {
  if (!_configInstance) {
    _configInstance = new ConfigCascade();
  }
  return _configInstance;
}
