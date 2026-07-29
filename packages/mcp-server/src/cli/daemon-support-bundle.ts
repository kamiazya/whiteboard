// `whiteboard daemon support-bundle --json` helper.
//
// Funnels the redacted v0 support bundle through the existing status
// / doctor / logs helpers and the side-effect-free
// `buildSupportBundle` + `writeSupportBundle` pair. The CLI never
// stringifies raw status / doctor / log objects directly; everything
// goes through the funnel so the manifest / sections inherit the
// allow-list, redaction, and ISO-timestamp validation contracts.

import { dirname, resolve } from 'node:path'
import { type DaemonLogEntryInput, daemonLogEntrySchema } from '../shared/diagnostics/log-jsonl.js'
import {
  buildSupportBundle,
  SupportBundleError,
  type SupportBundleInput,
} from '../shared/diagnostics/support-bundle.js'
import { writeSupportBundle } from '../shared/diagnostics/support-bundle-writer.js'
import { runDaemonDoctor } from './daemon-doctor.js'
import { runDaemonLogs } from './daemon-logs.js'
import { runDaemonStatus } from './daemon-status.js'

export interface DaemonSupportBundleOptions {
  dataDir: string
  outputDir: string
  // Test seam: pin the createdAt timestamp so the bundle is
  // deterministic in regression tests. Production callers leave it
  // undefined and get `new Date().toISOString()`.
  now?: () => string
  // Test seam: substitute `package.json#version`. Production reads
  // it through a bundler-injected constant (passed in by callers
  // that have access; the CLI dispatcher passes a fixed string).
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

interface SupportBundleResultJson {
  schemaVersion: 1
  ok: true
  outputDir: string
  files: string[]
}

function fail(message: string): DaemonSupportBundleOutcome {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}

export async function runDaemonSupportBundle(
  options: DaemonSupportBundleOptions,
): Promise<DaemonSupportBundleOutcome> {
  const { dataDir, outputDir } = options
  const now = options.now ?? (() => new Date().toISOString())
  const packageVersion = options.packageVersion ?? '0.0.0'
  const platform = options.platform ?? { os: process.platform, nodeVersion: process.version }

  // Source: daemon status + doctor + logs. Each upstream helper
  // already runs its own redaction gate; this wrapper takes their
  // typed results and copies allow-listed fields into the bundle
  // input. No raw object spread.
  const status = (await runDaemonStatus({ dataDir })).result
  const doctor = (await runDaemonDoctor({ dataDir })).result

  // Daemon logs source: surface a minimal deterministic input by
  // re-using runDaemonLogs's JSONL stream. Parse it back through the
  // schema so the support-bundle builder sees a typed array, not
  // hand-built strings.
  const logsOutcome = await runDaemonLogs({ dataDir, now })
  const logsEntries: DaemonLogEntryInput[] = []
  if (logsOutcome.stdout) {
    for (const line of logsOutcome.stdout.split('\n').filter((l) => l.length > 0)) {
      const parsed = daemonLogEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) {
        const e = parsed.data
        logsEntries.push({
          timestamp: e.timestamp,
          level: e.level,
          source: e.source,
          message: e.message,
          fields: e.fields,
        })
      }
    }
  }

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
            port: status.record.port,
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
    logs: logsEntries,
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

  const result: SupportBundleResultJson = {
    schemaVersion: 1,
    ok: true,
    outputDir: writeResult.outputDir,
    files: writeResult.files,
  }
  return { stdout: `${JSON.stringify(result)}\n`, stderr: '', exitCode: 0 }
}
