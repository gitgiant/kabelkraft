import { describe, expect, it, vi } from 'vitest';

// passes.ts references GPUTextureUsage at module scope — stub before import.
vi.stubGlobal('GPUTextureUsage', {
  RENDER_ATTACHMENT: 0x10,
  TEXTURE_BINDING: 0x04,
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
});
vi.stubGlobal('GPUBufferUsage', { UNIFORM: 0x40, COPY_DST: 0x08 });
const { TexturePool } = await import('./passes');

interface FakeTexture {
  destroyed: boolean;
  destroy(): void;
}

function fakeDevice(): { device: GPUDevice; created: FakeTexture[] } {
  const created: FakeTexture[] = [];
  const device = {
    createTexture() {
      const tex: FakeTexture = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      created.push(tex);
      return tex;
    },
  } as unknown as GPUDevice;
  return { device, created };
}

describe('TexturePool', () => {
  it('reuses freed textures across frames instead of allocating', () => {
    const { device, created } = fakeDevice();
    const pool = new TexturePool(device);
    const a = pool.acquire(256, 256);
    const b = pool.acquire(256, 256);
    expect(created.length).toBe(2);
    pool.endFrame();
    // Steady state: same sizes come back from the free list.
    for (let frame = 0; frame < 10; frame++) {
      const c = pool.acquire(256, 256);
      const d = pool.acquire(256, 256);
      expect([a, b]).toContain(c);
      expect([a, b]).toContain(d);
      pool.endFrame();
    }
    expect(created.length).toBe(2);
  });

  it('keys the free list by size', () => {
    const { device, created } = fakeDevice();
    const pool = new TexturePool(device);
    pool.acquire(256, 256);
    pool.endFrame();
    pool.acquire(512, 256);
    expect(created.length).toBe(2);
  });

  it('destroy releases everything, including in-flight textures', () => {
    const { device, created } = fakeDevice();
    const pool = new TexturePool(device);
    pool.acquire(64, 64);
    pool.endFrame();
    pool.acquire(64, 64); // in flight at destroy time (canvas resize path)
    pool.destroy();
    expect(created.every((t) => t.destroyed)).toBe(true);
    // After destroy the pool starts fresh.
    pool.acquire(64, 64);
    expect(created.length).toBe(2);
  });
});
