#!/usr/bin/env node
// ts-build-tsc [tsc arguments]: runs tsc of the project, then rewrites the "paths" aliases in the
// emitted files (see rewrite.js). With -w / --watch tsc watches and every emitted file is rewritten
// as soon as tsc writes it
import { spawn } from 'node:child_process'
import { mkdirSync, watch } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { init, isDirectory, isEmitted, PathRewriter } from './rewrite.js'

const args = process.argv.slice(2)
const watch_mode = args.includes('-w') || args.includes('--watch')
const project_index = args.findIndex(arg => arg === '-p' || arg === '--project')
let tsconfig = project_index >= 0 ? path.resolve(args[project_index + 1]) : path.resolve('tsconfig.json')
if (isDirectory(tsconfig)) {
    tsconfig = path.join(tsconfig, 'tsconfig.json')
}

function tscBin() {
    const require = createRequire(path.join(process.cwd(), 'package.json'))
    return require.resolve('typescript/bin/tsc')
}

await init
const rewriter = new PathRewriter(tsconfig)

if (watch_mode) {
    // a file is rewritten after tsc stops writing it; the write of the rewriter changes nothing
    // on the next pass
    const pending = new Map()
    for (const dir of rewriter.out_dirs) {
        // the watcher is set before tsc starts: it sees every file of the first compilation
        mkdirSync(dir, { recursive: true })
        watch(dir, { recursive: true }, (_event, name) => {
            if (!name || !isEmitted(name)) {
                return
            }
            const file = path.join(dir, name)
            clearTimeout(pending.get(file))
            pending.set(file, setTimeout(() => {
                pending.delete(file)
                rewriter.rewriteFile(file)
            }, 30))
        })
    }
}

const tsc = spawn(process.execPath, [tscBin(), ...args], { stdio: 'inherit' })
tsc.on('exit', (code) => {
    // type errors do not stop the emit (noEmitOnError: false): the files are rewritten anyway
    const changed = rewriter.rewriteAll()
    if (changed > 0) {
        console.log(`ts-build-tsc: paths rewritten in ${changed} files`)
    }
    process.exit(code ?? 1)
})
