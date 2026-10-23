import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FsDirEntry } from '@deepseek-ai/dsh-fs'
import { Config } from '../src/index.ts'
import { listWorkspace, planPreload, planWorkspacePreload } from '../src/file-preload.ts'
import type { DirectoryLister, FilePreloadConfig } from '../src/file-preload.ts'

const config: FilePreloadConfig = Object.assign(structuredClone(new Config({}).filePreload!), {
  maxFiles: 2,
  maxFileBytes: 100,
  maxTotalBytes: 150,
  maxListedFiles: 4,
  skipDirectories: ['node_modules'],
})
const env = { TYPESAFE_BASE_URL: 'http://jev.test/', TYPESAFE_API_KEY: 'key' }

function answering(answers: unknown, status = 200) {
  const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(JSON.stringify({ answers }), { status })))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** A directory lister over a path → entries tree whose targets are relative paths. */
function treeFs(tree: Record<string, { name: string; type: FsDirEntry['type']; size?: number }[]>): DirectoryLister<string> {
  return {
    listDir: dir => Promise.resolve((tree[dir] ?? []).map(entry => ({
      ...entry,
      target: dir === '' ? entry.name : `dir/{entry.name}`,
    }))),
  }
}
const root = ''

describe('file preload', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('lists breadth-first without dot entries or skipped directories, and gives up past the bound', async () => {
    const fs = treeFs({
      '': [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file', size: 10 }, { name: '.git', type: 'directory' }, { name: 'node_modules', type: 'directory' }],
      src: [{ name: 'b.py', type: 'file', size: 20 }, { name: 'a.py', type: 'file', size: 30 }],
      'node_modules': [{ name: 'x.js', type: 'file', size: 1 }],
    })
    await expect(listWorkspace(fs, root, config)).resolves.toEqual([
      { path: 'README.md', size: 10 }, { path: 'src/a.py', size: 30 }, { path: 'src/b.py', size: 20 },
    ])
    await expect(listWorkspace(fs, root, Object.assign(structuredClone(config), { maxListedFiles: 2 }))).resolves.toBeUndefined()
  })

  it('reads the likeliest files within the count and byte bounds', async () => {
    const fetch = answering({ f0: { noul: 0.9 }, f1: { noul: 0.95 }, f2: { noul: 0.7 }, f3: { noul: 0.99 }, f4: { noul: 0.3 } })
    const files = [
      { path: 'a.py', size: 60 }, { path: 'b.py', size: 80 }, { path: 'c.py', size: 10 },
      { path: 'big.py', size: 500 }, { path: 'd.py', size: 5 },
    ]
    await expect(planPreload(config, 'fix a', files, env)).resolves.toEqual({ kind: 'preload', files, read: ['b.py', 'a.py'] })
    type Body = { state: { workspace_files: string[] }; questions: Record<string, unknown> }
    const body = JSON.parse(fetch.mock.calls[0]![1].body as string) as Body
    expect(body.state.workspace_files[0]).toBe('a.py (60 bytes)')
    expect(Object.keys(body.questions)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
  })

  it('skips without a request when the endpoint is unset, and on failure or no likely file', async () => {
    const fetch = answering({ f0: { noul: 0.1 } })
    const fs = treeFs({ '': [{ name: 'a.py', type: 'file', size: 5 }] })
    await expect(planWorkspacePreload(fs, root, config, 'task', {})).resolves.toEqual({ kind: 'skip' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(planWorkspacePreload(fs, root, config, 'task', env)).resolves.toEqual({ kind: 'skip' })
    answering({}, 503)
    await expect(planWorkspacePreload(fs, root, config, 'task', env)).resolves.toEqual({ kind: 'skip', reason: 'HTTP 503' })
    const failing: DirectoryLister<string> = { listDir: () => Promise.reject(new Error('denied')) }
    await expect(planWorkspacePreload(failing, root, config, 'task', env)).resolves.toEqual({ kind: 'skip', reason: 'denied' })
  })
})
