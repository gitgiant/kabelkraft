/**
 * In-app AI patch generation (PRD §10.3, "Integrated AI v2"). Wraps the v1
 * spec-pack + validator so a configured backend can go prompt → API → validate
 * → repair → insert without the copy/paste round trip. Two backends share one
 * interface:
 *   - "claude": Anthropic Messages API, called directly from the browser with a
 *     user-supplied key (needs the dangerous-direct-browser-access CORS header).
 *   - "local":  any OpenAI-compatible chat endpoint (Ollama, LM Studio, …) — a
 *     local llama or similar.
 * When the provider is "none" (nothing configured) the UI falls back to the
 * existing copy-spec / paste-reply flow; this module is never called.
 */

import { MODULE_DEFS } from './registry';
import { generateSpecPack } from './aispec';
import { parseKkGroup } from './aiimport';

export type ProviderKind = 'none' | 'claude' | 'local';

export interface AiSettings {
  provider: ProviderKind;
  claude: { apiKey: string; model: string };
  local: { baseUrl: string; model: string };
}

/** Claude models worth offering for patch generation (best JSON adherence first). */
export const CLAUDE_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

const STORAGE_KEY = 'kk-ai-settings';

export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'none',
  claude: { apiKey: '', model: 'claude-opus-4-8' },
  // Ollama's OpenAI-compatible endpoint; LM Studio is http://localhost:1234/v1.
  local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
};

export function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const saved = JSON.parse(raw) as Partial<AiSettings>;
    return {
      provider: saved.provider ?? DEFAULT_SETTINGS.provider,
      claude: { ...DEFAULT_SETTINGS.claude, ...saved.claude },
      local: { ...DEFAULT_SETTINGS.local, ...saved.local },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: AiSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

/** Is the selected provider actually usable (key / url present)? */
export function providerReady(s: AiSettings): boolean {
  if (s.provider === 'claude') return s.claude.apiKey.trim().length > 0;
  if (s.provider === 'local') return s.local.baseUrl.trim().length > 0;
  return false;
}

export function providerLabel(s: AiSettings): string {
  if (s.provider === 'claude') return `Claude (${s.claude.model})`;
  if (s.provider === 'local') return `Local (${s.local.model})`;
  return 'not configured';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function callClaude(s: AiSettings, system: string, messages: ChatMessage[]): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.claude.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      // Opt in to direct browser calls (otherwise the API rejects CORS).
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: s.claude.model,
      max_tokens: 8192,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
  if (!text) throw new Error('Claude returned an empty response.');
  return text;
}

async function callLocal(s: AiSettings, system: string, messages: ChatMessage[]): Promise<string> {
  const base = s.local.baseUrl.trim().replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: s.local.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: false,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Local LLM ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('Local LLM returned an empty response.');
  return text;
}

function call(s: AiSettings, system: string, messages: ChatMessage[]): Promise<string> {
  if (s.provider === 'claude') return callClaude(s, system, messages);
  if (s.provider === 'local') return callLocal(s, system, messages);
  return Promise.reject(new Error('No AI provider is configured.'));
}

export interface GenerateResult {
  /** Best reply text from the model (insert this via importAiPatch). */
  text: string;
  /** Whether the final text passed structural validation. */
  ok: boolean;
  /** How many model calls it took (1 = first try valid). */
  attempts: number;
}

/**
 * Prompt → API → validate → repair loop. On a validation failure the readable
 * errors (the same ones the v1 importer shows) are fed back to the model up to
 * `maxAttempts` times. Returns the best text so the caller can insert it — or
 * surface the errors — via the normal importAiPatch path.
 */
export async function generatePatch(
  userPrompt: string,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  const system = generateSpecPack();
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];

  let last = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress?.(attempt === 1 ? 'Generating patch…' : `Fixing validation errors (try ${attempt})…`);
    last = await call(settings, system, messages);

    const result = parseKkGroup(last, MODULE_DEFS);
    if (result.ok) return { text: last, ok: true, attempts: attempt };

    // Feed the structural errors back so the model can repair (PRD §10.3).
    if (attempt < maxAttempts) {
      messages.push({ role: 'assistant', content: last });
      messages.push({
        role: 'user',
        content:
          'That patch failed validation:\n' +
          result.errors.map((e) => `- ${e}`).join('\n') +
          '\n\nReturn a corrected patch as a single JSON code block.',
      });
    }
  }
  return { text: last, ok: false, attempts: maxAttempts };
}
