import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  generatePatch,
  loadSettings,
  providerLabel,
  providerReady,
  saveSettings,
  type AiSettings,
} from './aiprovider';

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
  provider: 'claude',
  claude: { apiKey: 'sk-test', model: 'claude-opus-4-8' },
  local: { ...DEFAULT_SETTINGS.local },
};

function claudeReply(text: string) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('AI provider settings', () => {
  beforeEach(() => localStorage.clear());

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

  it('calls the OpenAI-compatible endpoint for a local provider', async () => {
    const local: AiSettings = {
      provider: 'local',
      claude: { ...DEFAULT_SETTINGS.claude },
      local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: validPatch } }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const r = await generatePatch('a bass', local);
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
  });
});
