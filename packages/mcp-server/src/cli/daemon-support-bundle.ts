// `whiteboard daemon support-bundle --json` helper.
//
// Funnels the redacted v0 support bundle through the existing status
// / doctor helpers and the side-effect-free
// `buildSupportBundle` + `writeSupportBundle` pair. The CLI never
// stringifies raw status / doctor objects directly; everything
// goes through the funnel so the manifest / sections inherit the
// allow-list, redaction, and ISO-timestamp validation contracts. There is no
// log section: the daemon writes its records to stderr and keeps no file.

import { dirname, resolve } from 'node:path'
import {
  buildSupportBundle,
  SupportBundleError,
  type SupportBundleInput,
} from '../shared/diagnostics/support-bundle.js'
import { writeSupportBundle } from '../shared/diagnostics/support-bundle-writer.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { runDaemonDoctor } from './daemon-doctor.js'
import { runDaemonStatus } from './daemon-status.js'
import {
  daemonSupportBundleOutputSchema,
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
} from './operator-json.js'

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

function succeeded(written: { outputDir: string; files: string[] }): DaemonSupportBundleOutcome {
  const stdout = operatorJsonLine(daemonSupportBundleOutputSchema, {
    schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
    ok: true,
    outputDir: written.outputDir,
    files: written.files,
  })
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(message: string): DaemonSupportBundleOutcome {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}

export async function runDaemonSupportBundle(
  options: DaemonSupportBundleOptions,
): Promise<DaemonSupportBundleOutcome> {
  const { dataDir, outputDir } = options
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

  let bundle: ReturnType<typeof buildSupportBundle>
  try {
    bundle = buildSupportBundle(input)
  } catch (err) {
    if (err instanceof SupportBundleError) {
      // Generic copy: the helper has already stripped the input
      // value from its own message.
      return fail('Support bundle could not be built. Check the data directory.')
    }
    throw err
  }

  // The CLI deliberately allows callers to write into any local
  // path they choose — `--output-dir` is self-authorising, NOT a
  // sandbox. We pass `dirname(resolvedOutput)` as the writer's
  // `allowedRoots` entry so the writer's own contract still kicks
  // in: ancestor symlinks are rejected (the writer canonicalises
  // through `realpath` before the containment check), the target
  // must be empty / missing, the target itself must not be a
  // symlink or a regular file, and writes are validate-then-write
  // with `wx` race protection. A real per-user sandbox would
  // require a separate `--output-root=<path>` flag; that is not a
  // v0 goal.
  const resolvedOutput = resolve(outputDir)
  const allowedRoot = dirname(resolvedOutput)

  let writeResult: Awaited<ReturnType<typeof writeSupportBundle>>
  try {
    writeResult = await writeSupportBundle(bundle, resolvedOutput, {
      allowedRoots: [allowedRoot],
    })
  } catch (err) {
    if (err instanceof SupportBundleError) {
      // Map to a generic failure — never echo the resolved path or
      // the wrapped error message; both could carry the local path
      // back through stderr.
      return fail('Could not write support bundle. The output directory must be empty.')
    }
    throw err
  }

  return succeeded(writeResult)
}
