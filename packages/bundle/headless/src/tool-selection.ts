/**
 * Session-start tool selection for the one-shot runner. One Jev (TypeSafe
 * System One) request rates, for each configured optional tool group, the
 * probability that the task needs it; the runner hides every group rated at or
 * below the configured ceiling before the first model request, so the tool
 * catalog stays fixed for the whole run. A missing endpoint, a timeout, an HTTP
 * or response failure, or a probability above the ceiling keeps the group.
 * @module @deepseek-ai/dsh-headless/tool-selection
 */

import z from '@deepseek-ai/schemastery'
import { askNouls } from './jev.ts'
import type { JevEndpoint } from './jev.ts'

/** One optional tool group that Jev may hide for a task. */
export interface ToolGroup {
  /** Question key in the Jev request; unique within the selection. */
  name: string
  /** Yes/no question Jev answers about the task: does the task need this group? */
  question: string
  /** Global tool names hidden together; names the Agent does not see are ignored. */
  tools: string[]
}

/** Runner-row `toolSelection` settings. */
export interface ToolSelectionConfig extends JevEndpoint {
  /** Whether a fresh run asks Jev before its first model request. */
  enabled: boolean
  /** A group is hidden only when its probability of being needed is at most this value. */
  maxNeedProbability: number
  /** Task characters sent to Jev; longer tasks are truncated. */
  maxTaskChars: number
  /** Optional groups Jev rates. */
  groups: ToolGroup[]
}

const ToolGroup: z<ToolGroup> = z.object({
  name: z.string().pattern(/^[a-z][a-z0-9_]*$/).required(),
  question: z.string().min(1).required(),
  tools: z.array(z.string().min(1)).min(1).required(),
})

/** Validated `toolSelection` settings. */
export const ToolSelectionConfig: z<ToolSelectionConfig> = z.object({
  enabled: z.boolean().default(true),
  baseUrlEnv: z.string().min(1).default('TYPESAFE_BASE_URL'),
  apiKeyEnv: z.string().min(1).default('TYPESAFE_API_KEY'),
  model: z.string().min(1).default('jev-latest'),
  timeoutMs: z.natural().min(1).max(2000).default(2000),
  maxNeedProbability: z.number().min(0).max(1).default(0.2),
  maxTaskChars: z.natural().min(1).default(20_000),
  groups: z.array(ToolGroup).default([]),
})

/** Outcome of one selection: tools to hide, or why the full catalog stays. */
export type ToolSelection =
  | { kind: 'hide'; groups: string[]; tools: string[] }
  | { kind: 'keep'; reason?: string }

/**
 * Ask Jev which optional groups the task needs.
 * @param config - validated selection settings.
 * @param task - the run's task text.
 * @param env - process environment holding the endpoint and token.
 * @returns the groups and tools to hide; `keep` with a reason on failure, without one when selection is off or unconfigured.
 */
export async function selectTools(
  config: ToolSelectionConfig,
  task: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ToolSelection> {
  if (!config.enabled || config.groups.length === 0) return { kind: 'keep' }
  const questions = Object.fromEntries(config.groups.map(group => [group.name, group.question]))
  const answers = await askNouls(config, { task: task.slice(0, config.maxTaskChars) }, questions, env)
  if (answers.kind === 'unconfigured') return { kind: 'keep' }
  if (answers.kind === 'failed') return { kind: 'keep', reason: answers.reason }
  const hidden = config.groups.filter((group) => {
    const noul = answers.nouls.get(group.name)
    return noul !== undefined && noul <= config.maxNeedProbability
  })
  if (hidden.length === 0) return { kind: 'keep' }
  return { kind: 'hide', groups: hidden.map(group => group.name), tools: [...new Set(hidden.flatMap(group => group.tools))] }
}
