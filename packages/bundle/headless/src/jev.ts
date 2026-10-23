/**
 * One Jev (TypeSafe System One) request of Noul questions about a JSON state,
 * shared by the runner's session-start decisions. Every failure resolves as a
 * typed outcome so callers keep their default behavior.
 * @module @deepseek-ai/dsh-headless/jev
 */

/** Endpoint settings every Jev-backed decision row carries. */
export interface JevEndpoint {
  /** Environment variable holding the Jev base URL; unset or empty skips the request. */
  baseUrlEnv: string
  /** Environment variable holding the bearer token; unset sends no Authorization header. */
  apiKeyEnv: string
  /** Jev model identifier sent with the request. */
  model: string
  /** Request deadline in milliseconds. */
  timeoutMs: number
}

/** Outcome of one Noul request: probabilities by question key, an unconfigured endpoint, or a failure. */
export type NoulAnswers =
  | { kind: 'answers'; nouls: ReadonlyMap<string, number> }
  | { kind: 'unconfigured' }
  | { kind: 'failed'; reason: string }

/**
 * Ask Jev one Noul question per key about `state`.
 * @param endpoint - endpoint, token, model, and deadline settings.
 * @param state - JSON state the questions are about.
 * @param questions - question instructions by answer key.
 * @param env - process environment holding the endpoint and token.
 * @returns the valid probabilities in [0, 1] by key; malformed answers are omitted.
 */
export async function askNouls(
  endpoint: JevEndpoint,
  state: Record<string, unknown>,
  questions: Readonly<Record<string, string>>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<NoulAnswers> {
  const baseUrl = env[endpoint.baseUrlEnv]
  if (baseUrl === undefined || baseUrl === '') return { kind: 'unconfigured' }
  const apiKey = env[endpoint.apiKeyEnv]
  let body: unknown
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
      },
      body: JSON.stringify({
        model: endpoint.model,
        state,
        questions: Object.fromEntries(Object.entries(questions).map(([key, instructions]) => [key, { type: 'noul', instructions }])),
      }),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    })
    if (!response.ok) return { kind: 'failed', reason: `HTTP ${response.status}` }
    body = await response.json()
  } catch (error: unknown) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  const answers = typeof body === 'object' && body !== null ? (body as { answers?: unknown }).answers : undefined
  if (typeof answers !== 'object' || answers === null) return { kind: 'failed', reason: 'response has no answers' }
  const nouls = new Map<string, number>()
  for (const key of Object.keys(questions)) {
    const answer: unknown = (answers as Record<string, unknown>)[key]
    const noul = typeof answer === 'object' && answer !== null ? (answer as { noul?: unknown }).noul : undefined
    if (typeof noul === 'number' && noul >= 0 && noul <= 1) nouls.set(key, noul)
  }
  return { kind: 'answers', nouls }
}
