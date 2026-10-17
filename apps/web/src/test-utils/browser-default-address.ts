import { formatWorkspaceAddress, SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'

/**
 * The in-app address of the test seam's browser workspace: its segment in
 * the browser's one namespace (ADR-0053), the form `workspaceHandle` emits.
 */
export const BROWSER_DEFAULT_ADDRESS = formatWorkspaceAddress({
  form: 'qualified',
  namespace: SINGLE_PERSON_NAMESPACE,
  segment: BROWSER_DEFAULT_SEGMENT,
})
