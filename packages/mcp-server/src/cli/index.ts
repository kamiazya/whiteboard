#!/usr/bin/env node
import { main } from './dispatcher.js'

process.exit(await main(process.argv.slice(2)))
