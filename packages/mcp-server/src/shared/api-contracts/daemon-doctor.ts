import { z } from 'zod'

const doctorCheckStatusSchema = z.enum(['ok', 'warning', 'error', 'skipped'])

export type DaemonDoctorOverallStatus = z.infer<typeof doctorCheckStatusSchema>

const daemonDoctorCheckSchema = z.object({
  id: z.string(),
  status: doctorCheckStatusSchema,
  summary: z.string(),
  detail: z.string().optional(),
  remediation: z.string().optional(),
})

export type DaemonDoctorCheck = z.infer<typeof daemonDoctorCheckSchema>

export const daemonDoctorResultSchema = z.object({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  status: doctorCheckStatusSchema,
  checks: z.array(daemonDoctorCheckSchema),
})

export type DaemonDoctorResult = z.infer<typeof daemonDoctorResultSchema>
