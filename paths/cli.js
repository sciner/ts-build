#!/usr/bin/env node
// ts-build-tsc [tsc arguments]: runs tsc of the project, then rewrites the "paths" aliases in the
// emitted files (see rewrite.js). With -w / --watch tsc watches, and after every compilation
// (tsc prints "Watching for file changes") the files emitted since the previous pass are rewritten
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { init, isDirectory, PathRewriter } from './rewrite.js'

const args = process.argv.slice(2)
const watch_mode = args.includes('-w') || args.includes('--watch')
const project_index = args.findIndex(arg => arg === '-p' || arg === '--project')
let tsconfig = project_index >= 0 ? path.resolve(args[project_index + 1]) : path.resolve('tsconfig.json')
if (isDirectory(tsconfig)) {
    tsconfig = path.join(tsconfig, 'tsconfig.json')
}

// the end of a compilation in the watch mode
const WATCH_CYCLE_END = /Watching for file changes/

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

if (!watch_mode) {
    const tsc = spawn(process.execPath, [tscBin(), ...args], { stdio: 'inherit' })
    tsc.on('exit', (code) => {
        // type errors do not stop the emit (noEmitOnError: false): the files are rewritten anyway
        const changed = rewriter.rewriteAll()
        if (changed > 0) {
            console.log(`ts-build-tsc: paths rewritten in ${changed} files`)
        }
        process.exit(code ?? 1)
    })
} else {
    // The files are rewritten when tsc reports the end of a compilation, not by file system
    // events: on Windows a compilation writes thousands of files at once, the change notification
    // buffer overflows and most events are lost (2905 of 3000 files were missed)
    let pass_since = 0
    const rewritePass = () => {
        const started = Date.now()
        const changed = rewriter.rewriteSince(pass_since)
        // a file tsc wrote during the pass is taken by the next one
        pass_since = started - 1000
        if (changed > 0) {
            console.log(`ts-build-tsc: paths rewritten in ${changed} files`)
        }
    }
    // tsc colors its output for a terminal only
    const tsc_args = process.stdout.isTTY && !args.some(arg => arg.startsWith('--pretty')) ? [...args, '--pretty'] : args
    const tsc = spawn(process.execPath, [tscBin(), ...tsc_args], { stdio: ['inherit', 'pipe', 'inherit'] })
    let line = ''
    tsc.stdout.on('data', (chunk) => {
        process.stdout.write(chunk)
        const lines = (line + chunk.toString()).split(/\r?\n/)
        line = lines.pop()
        if (lines.some(text => WATCH_CYCLE_END.test(text))) {
            rewritePass()
        }
    })
    tsc.on('exit', (code) => {
        rewritePass()
        process.exit(code ?? 1)
    })
}
