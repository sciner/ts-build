import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { init, parse } from 'es-module-lexer'
import { loadTsconfig } from '../ts-import/config.js'

// Rewrites the tsconfig "paths" aliases in the files tsc emitted to relative paths: the part of
// the former ts-patch transformer (a clone of ts-transform-paths), tsc 7 has no transformer
// plugins. The rules are those of the transformer, the output is the same:
// - an alias is the first path segment of a specifier ("@vendors" of "@vendors/x.js") and maps
//   to the first target of its pattern, relative to the directory of the source file;
// - a relative specifier of a .js file that exists among the sources (not transpiled) points
//   from the output back to that file

const SEPARATORS = ['\\', '/']

function stripWildcard(value) {
    return value.endsWith('/*') || value.endsWith('\\*') ? value.slice(0, -2) : value
}

function firstSegment(specifier) {
    for (let i = 0; i < specifier.length; i++) {
        if (SEPARATORS.includes(specifier[i])) {
            return specifier.slice(0, i)
        }
    }
    return specifier
}

export class PathRewriter {
    constructor(tsconfig_file) {
        const config = loadTsconfig(path.resolve(tsconfig_file))
        const options = config.compilerOptions
        this.config = config
        this.paths_base = config.paths_base ?? config.dir
        this.aliases = new Map()
        for (const [pattern, targets] of Object.entries(config.paths ?? {})) {
            const alias = stripWildcard(pattern)
            if (!this.aliases.has(alias)) {
                this.aliases.set(alias, stripWildcard(targets[0]))
            }
        }
        // the sources: rootDir (baseUrl of the former configs), the output: outDir or declarationDir
        this.src_dir = path.normalize(options.rootDir ?? options.baseUrl ?? config.dir)
        this.out_dirs = [...new Set([options.outDir, options.declarationDir].filter(Boolean).map(dir => path.normalize(dir)))]
    }

    // the source of an emitted file, null - not emitted from this project (a stale file)
    sourceOf(out_file) {
        for (const out_dir of this.out_dirs) {
            const rel = path.relative(out_dir, out_file)
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                continue
            }
            const base = rel.replace(/\.d\.ts$|\.js$|\.mjs$/, '')
            const ext = rel.endsWith('.mjs') ? '.mts' : '.ts'
            const source = path.join(this.src_dir, base + ext)
            if (existsSync(source)) {
                return { source, out_dir }
            }
        }
        return null
    }

    resolve(source, out_dir, specifier) {
        const alias = firstSegment(specifier)
        const mapping = this.aliases.get(alias)
        if (mapping !== undefined) {
            let target = path.normalize(specifier.replace(alias, mapping))
            if (!SEPARATORS.includes(target[target.length - 1])) {
                target += path.sep
            }
            let relative = path.relative(path.dirname(source), path.join(this.paths_base, target))
            if (relative[0] !== '.') {
                relative = '.' + path.sep + relative
            }
            return relative.replace(/\\/g, '/')
        }
        if (this.src_dir !== out_dir && specifier[0] === '.') {
            const rel_source = source.replace(this.src_dir, '')
            const lookup = specifier.endsWith('.js') ? specifier : `${specifier}.js`
            const src_module = path.join(this.src_dir, path.dirname(rel_source), lookup)
            if (existsSync(src_module)) {
                // a source .js is not transpiled: the output points to it
                return path.relative(source.replace(this.src_dir, out_dir), src_module)
                    .replace(/\\/g, '/')
                    .replace(/^\.\.\//g, '')
            }
        }
        return specifier
    }

    // rewrites one emitted file; true - changed
    rewriteFile(out_file) {
        const origin = this.sourceOf(out_file)
        if (!origin) {
            return false
        }
        let code
        try {
            code = readFileSync(out_file, 'utf-8')
        } catch {
            return false
        }
        let imports
        try {
            [imports] = parse(code, out_file)
        } catch (e) {
            console.warn(`ts-build-tsc: cannot parse ${out_file}: ${e.message}`)
            return false
        }
        let result = ''
        let last = 0
        for (const imp of imports) {
            // import.meta and dynamic imports of a non-literal expression are kept
            if (imp.d === -2 || imp.n === undefined) {
                continue
            }
            // the range of the literal with its quotes: a static import gives it without them,
            // a dynamic one with them
            let start = imp.s
            let end = imp.e
            if (code[start] === '`') {
                continue
            }
            if (code[start] !== '"' && code[start] !== "'") {
                start--
                end++
            }
            const replaced = this.resolve(origin.source, origin.out_dir, imp.n)
            if (replaced === imp.n) {
                continue
            }
            // a new literal is printed in double quotes, as tsc printed the transformer's one
            result += code.slice(last, start) + JSON.stringify(replaced)
            last = end
        }
        if (last === 0) {
            return false
        }
        result += code.slice(last)
        writeFileSync(out_file, result)
        return true
    }

    emittedFiles() {
        const files = []
        const walk = (dir) => {
            let entries
            try {
                entries = readdirSync(dir, { withFileTypes: true })
            } catch {
                return
            }
            for (const entry of entries) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    walk(full)
                } else if (isEmitted(entry.name)) {
                    files.push(full)
                }
            }
        }
        for (const dir of this.out_dirs) {
            walk(dir)
        }
        return files
    }

    rewriteAll() {
        let changed = 0
        for (const file of this.emittedFiles()) {
            if (this.rewriteFile(file)) {
                changed++
            }
        }
        return changed
    }
}

export function isEmitted(name) {
    return name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.d.ts')
}

export async function rewriteProject(tsconfig_file) {
    await init
    return new PathRewriter(tsconfig_file).rewriteAll()
}

export { init }
export const isDirectory = (dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false
