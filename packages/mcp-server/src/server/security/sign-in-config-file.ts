/**
 * ADR-0046 decision 3: reads the sign-in configuration file and resolves each
 * provider's client secret from the environment variable or file it names.
 * A problem refuses the keeper's start rather than surfacing at the first
 * sign-in, and the message names the setting, never a secret's value.
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { defaultLoadersSync } from 'cosmiconfig'
import type { AuthenticatorBinding } from './member-profile-store.js'
import type { ConfiguredProvider } from './oidc-relying-party.js'
import {
  configuredAdministrators,
  type OidcProvider,
  type SignInConfig,
  type SignInProvider,
  signInConfigSchema,
} from './sign-in-config.js'

/** Where the sign-in configuration file is. Unset means no external sign-in. */
export const SIGN_IN_CONFIG_ENV = 'WHITEBOARD_SIGN_IN_CONFIG'

function parseFile(path: string): unknown {
  const content = readFileSync(path, 'utf8')
  // The file is data: JSON or YAML, never a module (the same refusal as the
  // daemon's own config file).
  return extname(path) === '.json'
    ? JSON.parse(content)
    : defaultLoadersSync['.yaml'](path, content)
}

function secretOf(
  provider: OidcProvider,
  ref: NonNullable<OidcProvider['clientSecret']>,
  env: NodeJS.ProcessEnv,
): string {
  const value = 'env' in ref ? env[ref.env] : readFileSync(ref.file, 'utf8').trim()
  if (value === undefined || value === '') {
    const where = 'env' in ref ? `environment variable ${ref.env}` : `file ${ref.file}`
    throw new Error(`sign-in provider "${provider.id}": its client secret (${where}) is empty`)
  }
  return value
}

function readSignInConfig(path: string): SignInConfig {
  const parsed = signInConfigSchema.safeParse(parseFile(path))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `sign-in configuration ${path}: ${issue?.path.join('.') ?? '(root)'} — ${issue?.message ?? 'invalid'}`,
    )
  }
  return parsed.data
}

/** The declared providers, validated, with no secret read: what an operator
 *  command needs to name a provider, on a host that may not hold its secrets. */
export function readSignInProviders(path: string): SignInProvider[] {
  return readSignInConfig(path).providers
}

/** What the keeper starts with: each provider with its secret resolved, and
 *  the administrators the file names (ADR-0049 decision 2). */
export function loadSignInConfig(
  path: string,
  env: NodeJS.ProcessEnv,
): { providers: ConfiguredProvider[]; administrators: AuthenticatorBinding[] } {
  const config = readSignInConfig(path)
  const providers = config.providers.map((provider): ConfiguredProvider => {
    if (provider.kind === 'trusted-header') return provider
    const { clientId, clientSecret } = provider
    if (clientId === undefined || clientSecret === undefined) return provider
    return { ...provider, clientId, clientSecretValue: secretOf(provider, clientSecret, env) }
  })
  return { providers, administrators: configuredAdministrators(config) }
}
