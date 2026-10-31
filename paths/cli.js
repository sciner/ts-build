#!/usr/bin/env node
// ts-build-tsc [tsc arguments]: runs tsc of the project, then rewrites the "paths" aliases in the
// emitted files (see rewrite.js). With -w / --watch tsc watches and every emitted file is rewritten
// as soon as tsc writes it
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import path from 'node:path'
import { init, isDirectory, isEmitted, PathRewriter } from './rewrite.js'

const args = process.argv.slice(2)
const watch_mode = args.includes('-w') || args.includes('--watch')
const project_index = args.findIndex(arg => arg === '-p' || arg === '--project')
let tsconfig = project_index >= 0 ? path.resolve(args[project_index + 1]) : path.resolve('tsconfig.json')
if (isDirectory(tsconfig)) {
    tsconfig = path.join(tsconfig, 'tsconfig.json')
}

// tsc of the typescript package the current directory sees: by its package.json "bin", because
// typescript 7 does not export ./bin/tsc (require.resolve('typescript/bin/tsc') fails)
function tscBin() {
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
        const package_file = path.join(dir, 'node_modules', 'typescript', 'package.json')
        if (existsSync(package_file)) {
            const bin = JSON.parse(readFileSync(package_file, 'utf-8')).bin
            return path.join(path.dirname(package_file), (typeof bin === 'string' ? bin : bin?.tsc) ?? 'bin/tsc')
        }
        if (path.dirname(dir) === dir) {
            throw new Error('ts-build-tsc: the typescript package is not installed')
        }
    }
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
