/**
 * In-app AI patch generation (PRD §10.3, "Integrated AI v2"). Wraps the v1
 * spec-pack + validator so a configured backend can go prompt → API → validate
 * → repair → insert without the copy/paste round trip. Three backends share
 * one interface:
 *   - "claude":     Anthropic Messages API, called directly from the browser with
 *                   a user-supplied key (needs the dangerous-direct-browser-access
 *                   CORS header).
 *   - "openrouter": OpenRouter's OpenAI-compatible API. The key can be pasted or
 *                   obtained keyboard-free via the PKCE OAuth flow below.
 *   - "custom":     any OpenAI-compatible chat endpoint — local (Ollama,
 *                   LM Studio) or hosted (OpenAI, Groq, Mistral, …) with an
 *                   optional bearer key.
 * When the provider is "none" (nothing configured) the UI falls back to the
 * existing copy-spec / paste-reply flow; this module is never called.
 */

import { MODULE_DEFS } from './registry';
import { generateSpecPack } from './aispec';
import { parseKkGroup } from './aiimport';
import { MIDI_SPEC, parseKkMidi } from './aimidi';
import { generateLyricsSpecPack, parseKkLyrics, type LyricsSongContext } from './ailyrics';
import { generateFaceSpecPack, parseKkFace } from './aiface';
import { generateProjectSpecPack, parseKkProject } from './aiproject';
import { generateVisualSpecPack, parseKkVis } from './aivisual';
import { appSettings, updateSettings } from './settings';
import type { Graph } from './graph';
import { CUSTOM_PRESETS, type AiSettings } from './aisettings';

export {
  CLAUDE_MODELS,
  CUSTOM_PRESETS,
  DEFAULT_SETTINGS,
  sanitizeAiSettings,
  type AiSettings,
  type ProviderKind,
} from './aisettings';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** AI settings live in the unified store (core/settings); callers get a copy. */
export function loadSettings(): AiSettings {
  return structuredClone(appSettings().ai);
}

export function saveSettings(s: AiSettings): void {
  updateSettings((all) => {
    all.ai = structuredClone(s);
  });
}

/*
 * OpenRouter PKCE OAuth (https://openrouter.ai/docs/use-cases/oauth-pkce) —
 * a key without any copy/paste:
 *   1. startOpenRouterAuth() opens openrouter.ai/auth in a popup with a
 *      SHA-256 code challenge; the verifier waits in localStorage.
 *   2. OpenRouter redirects the popup to public/oauth-openrouter.html, which
 *      drops the one-time code into localStorage and closes itself.
 *   3. The opener's "storage" listener sees OPENROUTER_CODE_KEY appear and
 *      calls exchangeOpenRouterCode(code) → API key.
 */

const OPENROUTER_VERIFIER_KEY = 'kk-openrouter-verifier';
/** localStorage key the OAuth callback page writes the one-time code to. */
export const OPENROUTER_CODE_KEY = 'kk-openrouter-code';

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Open the OpenRouter consent popup. False = popup blocked. */
export async function startOpenRouterAuth(): Promise<boolean> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  localStorage.setItem(OPENROUTER_VERIFIER_KEY, verifier);
  localStorage.removeItem(OPENROUTER_CODE_KEY);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const callback = new URL('oauth-openrouter.html', window.location.href).toString();
  const url =
    `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  return window.open(url, 'kk-openrouter-auth', 'popup,width=480,height=720') != null;
}

/** Trade the callback's one-time code (+ stored verifier) for an API key. */
export async function exchangeOpenRouterCode(code: string): Promise<string> {
  const verifier = localStorage.getItem(OPENROUTER_VERIFIER_KEY) ?? '';
  const res = await fetch(`${OPENROUTER_BASE_URL}/auth/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenRouter key exchange ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  const data = await res.json();
  if (!data.key) throw new Error('OpenRouter returned no key.');
  localStorage.removeItem(OPENROUTER_VERIFIER_KEY);
  return data.key as string;
}

/** Is the selected provider actually usable (key / url present)? */
export function providerReady(s: AiSettings): boolean {
  if (s.provider === 'claude') return s.claude.apiKey.trim().length > 0;
  if (s.provider === 'openrouter') return s.openrouter.apiKey.trim().length > 0;
  if (s.provider === 'custom') return s.custom.baseUrl.trim().length > 0;
  return false;
}

/** Preset whose base URL matches, so labels read "Ollama" instead of "Custom". */
export function presetFor(baseUrl: string) {
  const url = baseUrl.trim().replace(/\/$/, '');
  return CUSTOM_PRESETS.find((p) => p.baseUrl === url);
}

export function providerLabel(s: AiSettings): string {
  if (s.provider === 'claude') return `Claude (${s.claude.model})`;
  if (s.provider === 'openrouter') return `OpenRouter (${s.openrouter.model})`;
  if (s.provider === 'custom') {
    const name = presetFor(s.custom.baseUrl)?.name ?? 'Custom';
    return s.custom.model ? `${name} (${s.custom.model})` : name;
  }
  return 'not configured';
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function callClaude(
  s: AiSettings,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
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
      max_tokens: maxTokens,
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

/** OpenAI-compatible chat endpoint — OpenRouter, Ollama, LM Studio, OpenAI, … */
async function callOpenAiCompatible(
  target: { baseUrl: string; apiKey: string; model: string; label: string },
  system: string,
  messages: ChatMessage[],
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const base = target.baseUrl.trim().replace(/\/$/, '');
  const key = target.apiKey.trim();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: target.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: false,
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${target.label} ${res.status}: ${detail.slice(0, 300) || res.statusText}`);
  }
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error(`${target.label} returned an empty response.`);
  return text;
}

function call(
  s: AiSettings,
  system: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string> {
  if (s.provider === 'claude') return callClaude(s, system, messages, maxTokens);
  if (s.provider === 'openrouter') {
    return callOpenAiCompatible(
      { baseUrl: OPENROUTER_BASE_URL, ...s.openrouter, label: 'OpenRouter' },
      system,
      messages,
      { 'x-title': 'KabelKraft' }, // app attribution on openrouter.ai
    );
  }
  if (s.provider === 'custom') {
    return callOpenAiCompatible({ ...s.custom, label: 'AI endpoint' }, system, messages);
  }
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
 * errors are fed back to the model up to `maxAttempts` times. Returns the best
 * text so the caller can insert it — or surface the errors — via the normal
 * import path. Shared by patch and MIDI-clip generation.
 */
async function generateWithSpec(
  system: string,
  noun: string,
  validate: (text: string) => { ok: boolean; errors: string[] },
  userPrompt: string,
  settings: AiSettings,
  maxAttempts: number,
  onProgress?: (status: string) => void,
  // A full project is much bigger than a patch; non-streaming requests should
  // stay ≤ ~16K output tokens (within every offered model's output cap).
  maxTokens = 8192,
): Promise<GenerateResult> {
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];

  let last = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onProgress?.(attempt === 1 ? `Generating ${noun}…` : `Fixing validation errors (try ${attempt})…`);
    last = await call(settings, system, messages, maxTokens);

    const result = validate(last);
    if (result.ok) return { text: last, ok: true, attempts: attempt };

    // Feed the structural errors back so the model can repair (PRD §10.3).
    if (attempt < maxAttempts) {
      messages.push({ role: 'assistant', content: last });
      messages.push({
        role: 'user',
        content:
          `That ${noun} failed validation:\n` +
          result.errors.map((e) => `- ${e}`).join('\n') +
          `\n\nReturn a corrected ${noun} as a single JSON code block.`,
      });
    }
  }
  return { text: last, ok: false, attempts: maxAttempts };
}

export function generatePatch(
  userPrompt: string,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  return generateWithSpec(
    generateSpecPack(),
    'patch',
    (text) => parseKkGroup(text, MODULE_DEFS),
    userPrompt,
    settings,
    maxAttempts,
    onProgress,
  );
}

/** Whole-project flavour: same providers and repair loop, .kkproject spec/validator. */
export function generateProject(
  userPrompt: string,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  return generateWithSpec(
    generateProjectSpecPack(),
    'project',
    (text) => parseKkProject(text, MODULE_DEFS),
    userPrompt,
    settings,
    maxAttempts,
    onProgress,
    16000,
  );
}

/** Visual-graph flavour: same providers and repair loop, .kkvis spec/validator. */
export function generateVisual(
  userPrompt: string,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  return generateWithSpec(
    generateVisualSpecPack(),
    'visual graph',
    (text) => {
      const r = parseKkVis(text);
      return { ok: r.ok, errors: r.errors };
    },
    userPrompt,
    settings,
    maxAttempts,
    onProgress,
  );
}

/** Face flavour: design a front panel for an existing group — the group's
 * live modules ride along in the spec, so bindings need no remap. */
export function generateFace(
  graph: Graph,
  groupId: string,
  userPrompt: string,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  return generateWithSpec(
    generateFaceSpecPack(graph, groupId),
    'module face',
    (text) => {
      const r = parseKkFace(text, graph, groupId);
      return { ok: r.ok, errors: r.errors };
    },
    userPrompt,
    settings,
    maxAttempts,
    onProgress,
  );
}

/** MIDI-clip flavour: same providers and repair loop, .kkmidi spec/validator. */
export function generateMidiClip(
  userPrompt: string,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  return generateWithSpec(
    MIDI_SPEC,
    'MIDI clip',
    parseKkMidi,
    userPrompt,
    settings,
    maxAttempts,
    onProgress,
  );
}

/** Lyrics flavour: timed .kklyrics sheet; live BPM + time signature ride in the spec. */
export function generateLyricsClip(
  userPrompt: string,
  ctx: LyricsSongContext,
  settings: AiSettings,
  maxAttempts = 3,
  onProgress?: (status: string) => void,
): Promise<GenerateResult> {
  return generateWithSpec(
    generateLyricsSpecPack(undefined, ctx),
    'lyrics',
    (text) => {
      const r = parseKkLyrics(text);
      return { ok: r.ok, errors: r.errors };
    },
    userPrompt,
    settings,
    maxAttempts,
    onProgress,
  );
}
