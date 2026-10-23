import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/index.ts'
import { selectTools } from '../src/tool-selection.ts'
import type { ToolSelectionConfig } from '../src/tool-selection.ts'

const config: ToolSelectionConfig = Object.assign(structuredClone(new Config({}).toolSelection!), {
  groups: [
    { name: 'delegation', question: 'Delegate?', tools: ['subagent', 'workflow'] },
    { name: 'web', question: 'Web?', tools: ['web_fetch'] },
  ],
})
const env = { TYPESAFE_BASE_URL: 'http://jev.test/', TYPESAFE_API_KEY: 'key' }

function answering(answers: unknown, status = 200) {
  const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(JSON.stringify({ answers }), { status })))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('selectTools', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('resolves documented defaults', () => {
    expect(config).toMatchObject({ enabled: true, baseUrlEnv: 'TYPESAFE_BASE_URL', timeoutMs: 2000, maxNeedProbability: 0.2 })
  })

  it('keeps every tool without a request when the endpoint is unset or selection is off', async () => {
    const fetch = answering({})
    await expect(selectTools(config, 'fix the bug', {})).resolves.toEqual({ kind: 'keep' })
    await expect(selectTools(Object.assign(structuredClone(config), { enabled: false }),'fix the bug', env)).resolves.toEqual({ kind: 'keep' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides only groups rated at or below the ceiling', async () => {
    const fetch = answering({ delegation: { type: 'noul', noul: 0.2 }, web: { type: 'noul', noul: 0.6 } })
    await expect(selectTools(config, 'x'.repeat(30_000), env)).resolves.toEqual({
      kind: 'hide', groups: ['delegation'], tools: ['subagent', 'workflow'],
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://jev.test/v1/systemone')
    expect(init.headers).toMatchObject({ authorization: 'Bearer key' })
    const body = JSON.parse(init.body as string) as { state: { task: string }; questions: Record<string, unknown> }
    expect(body.state.task).toHaveLength(20_000)
    expect(body.questions).toEqual({ delegation: { type: 'noul', instructions: 'Delegate?' }, web: { type: 'noul', instructions: 'Web?' } })
  })

  it('keeps every tool when the response fails or omits answers', async () => {
    answering({}, 503)
    await expect(selectTools(config, 'task', env)).resolves.toEqual({ kind: 'keep', reason: 'HTTP 503' })
    answering(undefined)
    await expect(selectTools(config, 'task', env)).resolves.toEqual({ kind: 'keep', reason: 'response has no answers' })
    answering({ delegation: { type: 'noul' }, web: { noul: 'low' } })
    await expect(selectTools(config, 'task', env)).resolves.toEqual({ kind: 'keep' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('timed out'))))
    await expect(selectTools(config, 'task', env)).resolves.toEqual({ kind: 'keep', reason: 'timed out' })
  })
})
