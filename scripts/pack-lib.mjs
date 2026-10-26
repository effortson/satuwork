import { lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** pnpm legacy deploy leaves a self-alias pointing back to the CI checkout. It is
 * not a runtime dependency and must not escape a self-contained release archive. */
export function removeWorkspaceSelfLink(stage, name) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw Error('Invalid package name')
  const path = join(stage, 'node_modules', '.pnpm', 'node_modules', name)
  try {
    if (lstatSync(path).isSymbolicLink()) rmSync(path)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

