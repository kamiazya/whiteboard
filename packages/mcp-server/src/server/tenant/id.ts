/**
 * The one tenant a self-hosted keeper holds. Its row is created by the
 * migration that introduced tenants, so a self-host is a keeper with one row
 * in `tenants` and SaaS is the same shape with more.
 *
 * Here rather than under `store/` because a tenant's identity is not a
 * storage mechanic: an HTTP route needs it as much as a store does, and
 * ADR-0018 forbids the route reaching into `store/` for it.
 */
export const SELF_HOST_TENANT_ID = 'self-host'
