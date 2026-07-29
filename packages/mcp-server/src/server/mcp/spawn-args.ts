// Pure helper that builds spawn commands for the Hono child process.
// Only WHITEBOARD_DEV=1 switches to node --watch + tsx/esm mode so code changes
// restart automatically. Requiring an explicit "1" avoids accidental opt-in
// from truthy values such as "true" or "yes".

export interface SpawnArgs {
  command: string
  args: string[]
}

export interface BuildSpawnArgsInput {
  env: NodeJS.ProcessEnv
  serverPath: string
  port: number
  tsxBin: string
}

export function buildSpawnArgs(input: BuildSpawnArgsInput): SpawnArgs {
  const { env, serverPath, port } = input
  const portArg = `--port=${port}`

  if (env.WHITEBOARD_DEV === '1') {
    return {
      command: 'node',
      args: ['--watch', '--import', 'tsx/esm', serverPath, portArg],
    }
  }

  return {
    command: 'node',
    args: ['--import', 'tsx/esm', serverPath, portArg],
  }
}
