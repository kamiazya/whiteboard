import type { OutputPathError } from '../output-path.js'

export type CanvasOutputPathErrorBody = {
  status: 400 | 409
  body: { error: string; message: string }
}

export function toCanvasOutputPathErrorBody(err: OutputPathError): CanvasOutputPathErrorBody {
  if (err.code === 'output_exists') {
    return { status: 409, body: { error: err.code, message: 'Output file already exists.' } }
  }
  if (err.code === 'invalid_output_path') {
    return { status: 400, body: { error: err.code, message: 'Invalid output path.' } }
  }
  return { status: 400, body: { error: err.code, message: 'Export output path rejected.' } }
}
