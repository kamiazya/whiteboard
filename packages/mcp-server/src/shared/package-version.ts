// Package version source-of-truth. Read at runtime so release-please bumps to package.json
// propagate without source edits.
//
// The package.json path is derived from the resolved package root (walk up to
// package.json) rather than a fixed `../..` offset, so it stays correct even when
// the bundler hoists this module into a chunk at a different depth. See package-root.ts.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { findPackageRoot } from './package-root.js'

const require = createRequire(import.meta.url)
const pkg = require(resolve(findPackageRoot(import.meta.url), 'package.json')) as {
  version: string
}

export const PACKAGE_VERSION: string = pkg.version
