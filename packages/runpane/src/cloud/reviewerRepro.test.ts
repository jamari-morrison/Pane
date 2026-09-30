// w2-reviewer repro for P1-2: a failed rename after a successful create leaks an unnamed sandbox.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBoatProvider } from './boat';

describe('reviewer repro P1-2', () => {
  it('create() throws after the sandbox exists when PATCH name fails once', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(url).replace('https://boat.dev/api/v1', '')}`);
      if (method === 'POST') return new Response(JSON.stringify({ sandbox: { id: 'bx_leak', state: 'init', name: '' } }), { status: 201 });
      if (method === 'PATCH') return new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 502 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const provider = createBoatProvider({ apiKey: 'k', fetchImpl, sleep: async () => undefined });
    await assert.rejects(provider.create({ name: 'rp-abcd1234', size: 'default', idempotencyKey: 'x' }), /PATCH .* 502/);
    console.log(`repro P1-2: calls=${JSON.stringify(calls)} -> sandbox bx_leak exists unnamed; runNew never writes a host record`);
    assert.deepEqual(calls, ['POST /sandboxes', 'PATCH /sandboxes/bx_leak']);
  });
});
