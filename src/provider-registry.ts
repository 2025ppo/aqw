/**
 * 前端Provider注册与管理
 * 与后端 llm_provider.rs 对应，提供前端可用的Provider列表和切换能力
 */
import { invoke } from '@tauri-apps/api/core';
import { getConfig } from './config-cascade';

export interface ModelProvider {
  id: string;
  name: string;
  base_url: string;
  api_key_env: string;
  supports_streaming: boolean;
  supports_function_calling: boolean;
  max_context_window: number;
  default_model: string;
}

export class ProviderRegistry {
  private providers: ModelProvider[] = [];
  private currentProviderId: string = 'deepseek';

  /**
   * 从后端加载Provider列表
   */
  async load(): Promise<ModelProvider[]> {
    try {
      const result = await invoke<string>('list_llm_providers');
      this.providers = JSON.parse(result);
    } catch (e) {
      console.warn('Failed to load providers, using hardcoded fallback:', e);
      this.providers = this.getHardcodedProviders();
    }
    // 从配置读取当前选择
    this.currentProviderId = getConfig().getLLM().default_provider;
    return this.providers;
  }

  /**
   * 获取所有可用Provider
   */
  list(): ModelProvider[] {
    return this.providers;
  }

  /**
   * 获取当前活跃Provider
   */
  getCurrent(): ModelProvider | undefined {
    return this.providers.find(p => p.id === this.currentProviderId);
  }

  /**
   * 切换当前Provider
   */
  async switchProvider(providerId: string): Promise<void> {
    const provider = this.providers.find(p => p.id === providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    this.currentProviderId = providerId;
    // 同步到配置
    getConfig().setRuntimeOverride('llm.default_provider', providerId);
  }

  /**
   * 检查Provider的API Key是否已配置
   */
  async checkApiKey(providerId: string): Promise<boolean> {
    const provider = this.providers.find(p => p.id === providerId);
    if (!provider) return false;
    try {
      const result = await invoke<string>('check_env_var', { varName: provider.api_key_env });
      return result === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 获取Provider支持的模型列表（预设）
   */
  getModelsForProvider(providerId: string): string[] {
    const models: Record<string, string[]> = {
      'deepseek': ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
      'openai': ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
      'anthropic': ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
      'aliyun': ['qwen-plus', 'qwen-max', 'qwen-turbo'],
      'ollama': ['llama3', 'codellama', 'mistral', 'deepseek-coder-v2'],
    };
    return models[providerId] || [];
  }

  private getHardcodedProviders(): ModelProvider[] {
    return [
      { id: 'deepseek', name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', api_key_env: 'DEEPSEEK_API_KEY', supports_streaming: true, supports_function_calling: true, max_context_window: 64000, default_model: 'deepseek-chat' },
      { id: 'openai', name: 'OpenAI', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', supports_streaming: true, supports_function_calling: true, max_context_window: 128000, default_model: 'gpt-4o' },
      { id: 'anthropic', name: 'Anthropic', base_url: 'https://api.anthropic.com/v1', api_key_env: 'ANTHROPIC_API_KEY', supports_streaming: true, supports_function_calling: true, max_context_window: 200000, default_model: 'claude-sonnet-4-20250514' },
      { id: 'aliyun', name: '阿里云百炼', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key_env: 'DASHSCOPE_API_KEY', supports_streaming: true, supports_function_calling: true, max_context_window: 32000, default_model: 'qwen-plus' },
      { id: 'ollama', name: 'Ollama (本地)', base_url: 'http://localhost:11434/v1', api_key_env: '', supports_streaming: true, supports_function_calling: false, max_context_window: 8000, default_model: 'llama3' },
    ];
  }
}

// 全局单例
let _providerInstance: ProviderRegistry | null = null;
export function getProviderRegistry(): ProviderRegistry {
  if (!_providerInstance) {
    _providerInstance = new ProviderRegistry();
  }
  return _providerInstance;
}
