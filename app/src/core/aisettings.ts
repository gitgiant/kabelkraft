/**
 * AI backend settings — shape, defaults, and sanitizer. Split from aiprovider
 * so the unified settings store (core/settings.ts) can own persistence without
 * a circular import (aiprovider → settings → aiprovider).
 */

export type ProviderKind = 'none' | 'claude' | 'openrouter' | 'custom';

export interface AiSettings {
  provider: ProviderKind;
  claude: { apiKey: string; model: string };
  openrouter: { apiKey: string; model: string };
  custom: { baseUrl: string; apiKey: string; model: string };
}

/** Claude models worth offering for patch generation (best JSON adherence first). */
export const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

/** Fill-in presets for the custom OpenAI-compatible backend. */
export const CUSTOM_PRESETS = [
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', needsKey: false },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: '', needsKey: false },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', needsKey: true },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', needsKey: true },
] as const;

export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'none',
  claude: { apiKey: '', model: 'claude-opus-4-8' },
  openrouter: { apiKey: '', model: 'anthropic/claude-sonnet-4.6' },
  custom: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' },
};

const PROVIDER_KINDS: ProviderKind[] = ['none', 'claude', 'openrouter', 'custom'];

/**
 * Normalize anything that claims to be AiSettings. Understands the v1 shape
 * (provider "local" with a { local: { baseUrl, model } } block — that backend
 * is now "custom", same endpoint with an optional key).
 */
export function sanitizeAiSettings(raw: unknown): AiSettings {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_SETTINGS);
  const saved = raw as Partial<AiSettings> & { local?: { baseUrl?: string; model?: string } };
  const provider =
    (saved.provider as string) === 'local'
      ? 'custom'
      : PROVIDER_KINDS.includes(saved.provider as ProviderKind)
        ? (saved.provider as ProviderKind)
        : DEFAULT_SETTINGS.provider;
  return {
    provider,
    claude: { ...DEFAULT_SETTINGS.claude, ...saved.claude },
    openrouter: { ...DEFAULT_SETTINGS.openrouter, ...saved.openrouter },
    custom: { ...DEFAULT_SETTINGS.custom, ...saved.local, ...saved.custom },
  };
}
