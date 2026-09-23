import { tenantRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { createPairingGrantStore, type PairingGrantStore } from './pairing-grant-store.js'
import {
  createWebAuthnCredentialStore,
  type WebAuthnCredentialStore,
} from './webauthn-credential-store.js'

/**
 * The two stores keyed by ORIGIN — which origins this tenant trusts, and which
 * passkeys it has pinned for them. They are built together because they are
 * one tenant's answer to one question, and because building one against a
 * different tenant's directory than the other is a mistake with no symptom
 * until a grant answers for somebody else.
 *
 * A many-tenant keeper resolves the tenant from the request's host (the
 * subdomain decision) and calls this per tenant; a self-host has one.
 */
export function createSelfHostOriginTrustStores(dataDir: string): {
  grants: PairingGrantStore
  credentials: WebAuthnCredentialStore
} {
  const home = tenantRoot(dataDir, SELF_HOST_TENANT_ID)
  return { grants: createPairingGrantStore(home), credentials: createWebAuthnCredentialStore(home) }
}
