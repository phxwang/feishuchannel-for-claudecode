/**
 * OpenCode model selection. The prompt_async request body accepts
 * `model: {providerID, modelID}` (verified in the `/doc` OpenAPI schema of a
 * real `opencode serve` v1.18.15; both fields required, no extra keys).
 */
export interface OpenCodeModel {
  providerID: string
  modelID: string
}

/**
 * Parses "provider/model" into an OpenCode model selection. Empty or missing
 * input means "server default" (undefined). The model part may itself contain
 * slashes (e.g. "openrouter/anthropic/claude"); only the first one splits.
 */
export function parseModel(value?: string | null): OpenCodeModel | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`model "${trimmed}" is invalid; expected providerID/modelID`)
  }
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) }
}
