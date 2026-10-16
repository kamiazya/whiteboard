// `whiteboard daemon support-bundle --json` helper.
//
// Funnels the redacted v0 support bundle through the existing status
// / doctor helpers, the side-effect-free `buildSupportBundle`, and the
// writer both support-bundle commands share (`support-bundle-writer.ts`). The CLI never
// stringifies raw status / doctor objects directly; everything
// goes through the funnel so the manifest / sections inherit the
// allow-list, redaction, and ISO-timestamp validation contracts. There is no
// log section: the daemon writes its records to stderr and keeps no file.

import { resolve } from 'node:path'
import {
  buildSupportBundle,
  type SupportBundle,
  SupportBundleError,
  type SupportBundleInput,
} from '../shared/diagnostics/support-bundle.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { runDaemonDoctor } from './daemon-doctor.js'
import { runDaemonStatus } from './daemon-status.js'
import {
  daemonSupportBundleOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
} from './operator-json.js'
import { writeSupportBundle } from './support-bundle-writer.js'

export interface DaemonSupportBundleOptions {
  dataDir: string
  outputDir: string
  // Test seam: pin the createdAt timestamp so the bundle is
  // deterministic in regression tests. Production callers leave it
  // undefined and get `new Date().toISOString()`.
  now?: () => string
  // Test seam: substitute `package.json#version`. Production callers leave it
  // undefined and the bundle carries the version this package ships.
  packageVersion?: string
  // Test seam: substitute the platform summary so smoke + jsdom
  // tests don't depend on the host's actual `process.platform` /
  // `process.version`.
  platform?: { os: string; nodeVersion: string }
}

export interface DaemonSupportBundleOutcome {
  // Always exactly one JSON object terminated by '\n'.
  stdout: string
  // Generic, sentinel-friendly diagnostic copy on fail-closed.
  // Never echoes the offending input value (bad output dir, leaky
  // record fields, etc.).
  stderr: string
  exitCode: 0 | 1
}

function succeeded(outputDir: string, files: readonly string[]): DaemonSupportBundleOutcome {
  const stdout = operatorJsonLine(daemonSupportBundleOutputSchema, {
    schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
    ok: true,
    outputDir,
    files: [...files],
  })
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(message: string): DaemonSupportBundleOutcome {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}

export async function runDaemonSupportBundle(
  options: DaemonSupportBundleOptions,
): Promise<DaemonSupportBundleOutcome> {
  // `--output-dir` is self-authorising, NOT a sandbox: the writer refuses
  // only what is unsafe whoever chose it (a symlink in the path, a file, a
  // non-empty folder).
  const resolvedOutput = resolve(options.outputDir)
  try {
    const written = await writeSupportBundle(resolvedOutput, () => collectBundle(options))
    if (written.kind === 'not-written') return fail(written.message)
    return succeeded(resolvedOutput, written.files)
  } catch (err) {
    if (err instanceof SupportBundleError) {
      // Generic copy: the helper has already stripped the input
      // value from its own message.
      return fail('Support bundle could not be built. Check the data directory.')
    }
    throw err
  }
}

async function collectBundle(options: DaemonSupportBundleOptions): Promise<SupportBundle> {
  const { dataDir } = options
  const now = options.now ?? (() => new Date().toISOString())
  const packageVersion = options.packageVersion ?? PACKAGE_VERSION
  const platform = options.platform ?? { os: process.platform, nodeVersion: process.version }

  // Source: daemon status + doctor. Each upstream helper
  // already runs its own redaction gate; this wrapper takes their
  // typed results and copies allow-listed fields into the bundle
  // input. No raw object spread.
  const status = (await runDaemonStatus({ dataDir })).result
  const doctor = (await runDaemonDoctor({ dataDir })).result

  const input: SupportBundleInput = {
    createdAt: now(),
    packageVersion,
    platform,
    status: {
      ok: status.ok,
      reason: status.reason,
      recordFound: status.recordFound,
      recordFresh: status.recordFresh,
      pidAlive: status.pidAlive,
      pingOk: status.pingOk,
      statusOk: status.statusOk,
      record: status.record
        ? {
            pid: status.record.pid,
            version: status.record.version,
            startedAt: status.record.startedAt,
          }
        : undefined,
    },
    doctor: {
      ok: doctor.ok,
      status: doctor.status,
      checks: doctor.checks.map((c) => ({
        id: c.id,
        status: c.status,
        summary: c.summary,
        detail: c.detail,
        remediation: c.remediation,
      })),
    },
  }
  return buildSupportBundle(input)
}
