/**
 * ADR-0046 decision 3: reads the sign-in configuration file and resolves each
 * provider's client secret from the environment variable or file it names.
 * A problem refuses the keeper's start rather than surfacing at the first
 * sign-in, and the message names the setting, never a secret's value.
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { defaultLoadersSync } from 'cosmiconfig'
import type { ResolvedProvider } from './oidc-relying-party.js'
import { type OidcProvider, signInConfigSchema } from './sign-in-config.js'

function parseFile(path: string): unknown {
  const content = readFileSync(path, 'utf8')
  // The file is data: JSON or YAML, never a module (the same refusal as the
  // daemon's own config file).
  return extname(path) === '.json'
    ? JSON.parse(content)
    : defaultLoadersSync['.yaml'](path, content)
}

function secretOf(provider: OidcProvider, env: NodeJS.ProcessEnv): string {
  const ref = provider.clientSecret
  const value = 'env' in ref ? env[ref.env] : readFileSync(ref.file, 'utf8').trim()
  if (value === undefined || value === '') {
    const where = 'env' in ref ? `environment variable ${ref.env}` : `file ${ref.file}`
    throw new Error(`sign-in provider "${provider.id}": its client secret (${where}) is empty`)
  }
  return value
}

export function loadSignInProviders(path: string, env: NodeJS.ProcessEnv): ResolvedProvider[] {
  const parsed = signInConfigSchema.safeParse(parseFile(path))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `sign-in configuration ${path}: ${issue?.path.join('.') ?? '(root)'} — ${issue?.message ?? 'invalid'}`,
    )
  }
  return parsed.data.providers.map((provider) => ({
    ...provider,
    clientSecretValue: secretOf(provider, env),
  }))
}
