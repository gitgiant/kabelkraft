import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  exchangeOpenRouterCode,
  generatePatch,
  loadSettings,
  providerLabel,
  providerReady,
  saveSettings,
  type AiSettings,
} from './aiprovider';
import { resetSettingsCache } from './settings';

// Minimal in-memory localStorage (vitest runs under node, no DOM).
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const validPatch = JSON.stringify({
  kind: 'kkgroup',
  formatVersion: 1,
  name: 'Test',
  modules: [
    { id: 'a', type: 'smpl' },
    { id: 'b', type: 'audioOut' },
  ],
  wires: [{ from: { module: 'a', port: 'out' }, to: { module: 'b', port: 'in' } }],
});

// A structurally broken patch (unknown module) so the repair loop kicks in.
const brokenPatch = JSON.stringify({
  kind: 'kkgroup',
  modules: [{ id: 'a', type: 'superSaw' }],
  wires: [],
});

const claudeSettings: AiSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  provider: 'claude',
  claude: { apiKey: 'sk-test', model: 'claude-opus-4-8' },
};

function claudeReply(text: string) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetSettingsCache();
});

describe('AI provider settings', () => {
  beforeEach(() => {
    localStorage.clear();
    // AI settings live in the unified store now — drop its cache so each test
    // sees the localStorage it just prepared.
    resetSettingsCache();
  });

  it('round-trips settings through localStorage', () => {
    saveSettings(claudeSettings);
    const loaded = loadSettings();
    expect(loaded.provider).toBe('claude');
    expect(loaded.claude.apiKey).toBe('sk-test');
  });

  it('falls back to defaults when nothing is stored', () => {
    expect(loadSettings().provider).toBe('none');
  });

  it('reports readiness and a label per provider', () => {
    expect(providerReady(DEFAULT_SETTINGS)).toBe(false);
    expect(providerReady(claudeSettings)).toBe(true);
    expect(providerReady({ ...claudeSettings, claude: { apiKey: '  ', model: 'x' } })).toBe(false);
    expect(providerLabel(claudeSettings)).toContain('Claude');

    const or: AiSettings = { ...structuredClone(DEFAULT_SETTINGS), provider: 'openrouter' };
    expect(providerReady(or)).toBe(false);
    or.openrouter.apiKey = 'sk-or-test';
    expect(providerReady(or)).toBe(true);
    expect(providerLabel(or)).toContain('OpenRouter');

    const custom: AiSettings = { ...structuredClone(DEFAULT_SETTINGS), provider: 'custom' };
    expect(providerReady(custom)).toBe(true); // default Ollama URL, no key needed
    expect(providerLabel(custom)).toContain('Ollama'); // preset recognized from URL
  });

  it('migrates v1 "local" settings to the custom backend', () => {
    localStorage.setItem(
      'kk-ai-settings',
      JSON.stringify({
        provider: 'local',
        claude: { apiKey: '', model: 'claude-opus-4-8' },
        local: { baseUrl: 'http://localhost:1234/v1', model: 'qwen3' },
      }),
    );
    const loaded = loadSettings();
    expect(loaded.provider).toBe('custom');
    expect(loaded.custom.baseUrl).toBe('http://localhost:1234/v1');
    expect(loaded.custom.model).toBe('qwen3');
    expect(loaded.custom.apiKey).toBe('');
  });
});

describe('generatePatch repair loop', () => {
  it('returns on the first valid reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(claudeReply(validPatch));
    vi.stubGlobal('fetch', fetchMock);

    const r = await generatePatch('a bass', claudeSettings);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('feeds validation errors back and recovers on a later try', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(claudeReply(brokenPatch))
      .mockResolvedValueOnce(claudeReply(validPatch));
    vi.stubGlobal('fetch', fetchMock);

    const r = await generatePatch('a bass', claudeSettings);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    // The repair turn must carry the validation errors back to the model.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.messages.at(-1).content).toContain('failed validation');
  });

  it('gives up after maxAttempts but still returns the last text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(claudeReply(brokenPatch));
    vi.stubGlobal('fetch', fetchMock);

    const r = await generatePatch('a bass', claudeSettings, 2);
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the browser-access CORS header to the Anthropic endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(claudeReply(validPatch));
    vi.stubGlobal('fetch', fetchMock);

    await generatePatch('a bass', claudeSettings);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(init.headers['x-api-key']).toBe('sk-test');
  });

  it('surfaces a readable error on an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key' }));
    await expect(generatePatch('a bass', claudeSettings)).rejects.toThrow(/401/);
  });

  it('calls the OpenAI-compatible endpoint for the custom provider, no auth header without a key', async () => {
    const custom: AiSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      provider: 'custom',
      custom: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.1' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: validPatch } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const r = await generatePatch('a bass', custom);
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers.authorization).toBeUndefined();
  });

  it('sends a bearer key to a custom endpoint when configured', async () => {
    const custom: AiSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      provider: 'custom',
      custom: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk-test', model: 'llama-3.3-70b-versatile' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: validPatch } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    await generatePatch('a bass', custom);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer gsk-test');
  });

  it('routes the openrouter provider through openrouter.ai with bearer auth', async () => {
    const or: AiSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      provider: 'openrouter',
      openrouter: { apiKey: 'sk-or-test', model: 'anthropic/claude-sonnet-4.6' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: validPatch } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const r = await generatePatch('a bass', or);
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-or-test');
    expect(JSON.parse(init.body).model).toBe('anthropic/claude-sonnet-4.6');
  });
});

describe('OpenRouter OAuth key exchange', () => {
  it('posts the one-time code with the stored verifier and returns the key', async () => {
    localStorage.setItem('kk-openrouter-verifier', 'test-verifier');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'sk-or-new' }) });
    vi.stubGlobal('fetch', fetchMock);

    const key = await exchangeOpenRouterCode('one-time-code');
    expect(key).toBe('sk-or-new');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
    const body = JSON.parse(init.body);
    expect(body.code).toBe('one-time-code');
    expect(body.code_verifier).toBe('test-verifier');
    // The verifier is single-use; a successful exchange must clear it.
    expect(localStorage.getItem('kk-openrouter-verifier')).toBeNull();
  });

  it('surfaces a readable error when the exchange fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'bad code' }),
    );
    await expect(exchangeOpenRouterCode('stale')).rejects.toThrow(/403/);
  });
});
