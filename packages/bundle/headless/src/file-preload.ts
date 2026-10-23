/**
 * Session-start file preload for the one-shot runner. The runner lists a small
 * workspace, one Jev (TypeSafe System One) request rates for each listed file
 * the probability that the task needs its contents, and the runner reads the
 * files rated likely through the Agent's own `read` tool before the first
 * model request. The listing and the contents reach the model as one logged
 * `headless-preload` user message. A missing endpoint, a workspace over the
 * listing bound, a timeout, an HTTP or response failure, or no file above the
 * floor sends no message.
 * @module @deepseek-ai/dsh-headless/file-preload
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FsDirEntry } from '@deepseek-ai/dsh-fs'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { askNouls } from './jev.ts'
import type { JevEndpoint } from './jev.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Workspace listing and file contents the one-shot runner read before the first request. */
    'headless-preload': { kind: 'headless-preload' }
  }
}

/** Runner-row `filePreload` settings. */
export interface FilePreloadConfig extends JevEndpoint {
  /** Whether a fresh run rates and reads workspace files before its first model request. */
  enabled: boolean
  /** A file is read only when its probability of being needed is at least this value. */
  minNeedProbability: number
  /** Listing stops and nothing is preloaded once the workspace holds more files than this. */
  maxListedFiles: number
  /** Most files read. */
  maxFiles: number
  /** Files larger than this many bytes are listed but never read. */
  maxFileBytes: number
  /** Combined size bound of the files read, in bytes. */
  maxTotalBytes: number
  /** Task characters sent to Jev; longer tasks are truncated. */
  maxTaskChars: number
  /** Directory names never listed, in addition to every dot-prefixed entry. */
  skipDirectories: string[]
}

/** Validated `filePreload` settings. */
export const FilePreloadConfig: z<FilePreloadConfig> = z.object({
  enabled: z.boolean().default(true),
  baseUrlEnv: z.string().min(1).default('TYPESAFE_BASE_URL'),
  apiKeyEnv: z.string().min(1).default('TYPESAFE_API_KEY'),
  model: z.string().min(1).default('jev-latest'),
  timeoutMs: z.natural().min(1).max(2000).default(2000),
  minNeedProbability: z.number().min(0).max(1).default(0.6),
  maxListedFiles: z.natural().min(1).default(60),
  maxFiles: z.natural().min(1).default(4),
  maxFileBytes: z.natural().min(1).default(16_000),
  maxTotalBytes: z.natural().min(1).default(32_000),
  maxTaskChars: z.natural().min(1).default(20_000),
  skipDirectories: z.array(z.string().min(1)).default([]),
})

/** The directory listing the preload needs from a filesystem whose targets are `T`. */
export interface DirectoryLister<T> {
  /**
   * List one directory's children.
   * @param target - the directory.
   * @returns its entries.
   */
  listDir(target: T): Promise<(Pick<FsDirEntry, 'name' | 'type' | 'size'> & { target: T })[]>
}

/** One listed workspace file. */
export interface ListedFile {
  /** Path relative to the workspace root, `/`-separated. */
  path: string
  /** Byte size, when the filesystem reports it. */
  size: number | undefined
}

/** Outcome of one plan: the listing and the files to read, or why nothing is preloaded. */
export type FilePreloadPlan =
  | { kind: 'preload'; files: ListedFile[]; read: string[] }
  | { kind: 'skip'; reason?: string }

/**
 * List the workspace breadth-first, skipping dot-prefixed entries and the configured directories.
 * @param fs - the mounted filesystem.
 * @param root - the workspace root.
 * @param config - validated preload settings.
 * @returns the listed files in breadth-first order, or `undefined` once more than `maxListedFiles` exist.
 */
export async function listWorkspace<T>(fs: DirectoryLister<T>, root: T, config: FilePreloadConfig): Promise<ListedFile[] | undefined> {
  const skipped = new Set(config.skipDirectories)
  const files: ListedFile[] = []
  const queue: { target: T; prefix: string }[] = [{ target: root, prefix: '' }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const entries = (await fs.listDir(next.target)).toSorted((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = `next.prefix{entry.name}`
      if (entry.type === 'directory') {
        if (!skipped.has(entry.name)) queue.push({ target: entry.target, prefix: `${path}/` })
      } else if (entry.type === 'file') {
        files.push({ path, size: entry.size })
        if (files.length > config.maxListedFiles) return undefined
      }
    }
  }
  return files
}

/**
 * Ask Jev which listed files the task needs and choose the files to read.
 * @param config - validated preload settings.
 * @param task - the run's task text.
 * @param files - the workspace listing.
 * @param env - process environment holding the endpoint and token.
 * @returns the paths to read, most likely first, within the file-count and byte bounds; `skip` with a reason on failure.
 */
export async function planPreload(
  config: FilePreloadConfig,
  task: string,
  files: readonly ListedFile[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<FilePreloadPlan> {
  if (files.length === 0) return { kind: 'skip' }
  const questions = Object.fromEntries(files.map((file, index) => [
    `f${index}`,
    `Will completing the task require reading the current contents of the workspace file "${file.path}"?`,
  ]))
  const state = {
    task: task.slice(0, config.maxTaskChars),
    workspace_files: files.map(file => file.size === undefined ? file.path : `file.path({file.size} bytes)`),
  }
  const answers = await askNouls(config, state, questions, env)
  if (answers.kind === 'unconfigured') return { kind: 'skip' }
  if (answers.kind === 'failed') return { kind: 'skip', reason: answers.reason }
  const ranked = files.flatMap(({ path, size }, index) => {
    const noul = answers.nouls.get(`f${index}`)
    return noul !== undefined && noul >= config.minNeedProbability
      && size !== undefined && size > 0 && size <= config.maxFileBytes
      ? [{ path, size, noul }]
      : []
  }).toSorted((a, b) => b.noul - a.noul)
  const read: string[] = []
  let bytes = 0
  for (const { path, size } of ranked) {
    if (read.length === config.maxFiles) break
    if (bytes + size > config.maxTotalBytes) continue
    bytes += size
    read.push(path)
  }
  return read.length === 0 ? { kind: 'skip' } : { kind: 'preload', files: [...files], read }
}

/**
 * List the workspace and plan its preload; a listing failure skips the preload.
 * @param fs - the mounted filesystem.
 * @param root - the workspace root.
 * @param config - validated preload settings.
 * @param task - the run's task text.
 * @param env - process environment holding the endpoint and token.
 * @returns the settled plan.
 */
export async function planWorkspacePreload<T>(
  fs: DirectoryLister<T>,
  root: T,
  config: FilePreloadConfig,
  task: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<FilePreloadPlan> {
  const baseUrl = env[config.baseUrlEnv]
  if (baseUrl === undefined || baseUrl === '') return { kind: 'skip' }
  let files: ListedFile[] | undefined
  try {
    files = await listWorkspace(fs, root, config)
  } catch (error: unknown) {
    return { kind: 'skip', reason: error instanceof Error ? error.message : String(error) }
  }
  return files === undefined ? { kind: 'skip' } : await planPreload(config, task, files, env)
}

/**
 * Read the planned files through the Agent's `read` tool and build the preload message.
 * Each read runs the registry's full policy pipeline and records the observation that
 * later `write` and `edit` calls are guarded by; a failed read is left out.
 * @param agentCtx - the Agent's scoped context.
 * @param agent - the Agent the reads run for.
 * @param plan - the settled preload plan.
 * @param signal - cancellation for the reads.
 * @returns the preload message followed by any context the reads deferred, or nothing when every read failed.
 */
export async function readPreload(
  agentCtx: Context,
  agent: Agent,
  plan: Extract<FilePreloadPlan, { kind: 'preload' }>,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  const results = await Promise.all(plan.read.map(async (path, index) => ({
    path,
    result: await agentCtx.tools.execute({
      callId: ToolCallId(`headless-preload-${index}`),
      name: 'read',
      arguments: { file_path: path },
      agent,
      signal,
    }),
  })))
  const read = results.filter(({ result }) => !result.isError)
  if (read.length === 0) return []
  const sections = read.map(({ path, result }) => {
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    return `<file path="${path}">\n${text}\n</file>`
  })
  const text = [
    `Workspace files: ${plan.files.map(file => file.path).join(', ')}`,
    'The harness already read these files with the read tool for this task; the contents below are current, so do not read them again before editing them.',
    ...sections,
  ].join('\n\n')
  return [
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'headless-preload' },
    }),
    ...read.flatMap(({ result }) => result.additionalContexts ?? []),
  ]
}
