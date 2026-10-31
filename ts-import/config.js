import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const JSON5 = require('json5')

// tsconfig.json of a project with its "extends" chain: compilerOptions are merged (a child
// overrides the keys of its parent), paths and baseUrl are resolved relative to the config
// that declares them, as tsc does. Without baseUrl the paths are relative to that config
export function loadTsconfig(file) {
    const config = JSON5.parse(readFileSync(file, 'utf-8'))
    const dir = path.dirname(file)
    let options = {}
    let paths_base = null
    let paths = null
    const parents = config.extends == null ? [] : Array.isArray(config.extends) ? config.extends : [config.extends]
    for (const parent of parents) {
        const parent_file = resolveExtends(parent, dir)
        if (!parent_file) {
            continue
        }
        const parent_config = loadTsconfig(parent_file)
        options = { ...options, ...parent_config.compilerOptions }
        if (parent_config.paths) {
            paths = parent_config.paths
            paths_base = parent_config.paths_base
        }
    }
    const own = config.compilerOptions ?? {}
    options = { ...options, ...own }
    for (const key of ['baseUrl', 'outDir', 'rootDir', 'declarationDir']) {
        if (own[key] != null) {
            options[key] = path.resolve(dir, own[key])
        }
    }
    if (own.paths) {
        paths = own.paths
        paths_base = options.baseUrl ?? dir
    } else if (own.baseUrl != null && paths) {
        paths_base = options.baseUrl
    }
    return { file, dir, compilerOptions: options, paths, paths_base }
}

function resolveExtends(spec, dir) {
    if (spec.startsWith('.') || path.isAbsolute(spec)) {
        const file = path.resolve(dir, spec)
        return isFile(file) ? file : isFile(file + '.json') ? file + '.json' : null
    }
    try {
        return createRequire(path.join(dir, 'tsconfig.json')).resolve(spec)
    } catch {
        return null
    }
}

// tsconfig.json of the current directory, as ts-node and tsconfig-paths found it
export function findTsconfig(cwd = process.cwd()) {
    const file = process.env.TS_BUILD_PROJECT ? path.resolve(cwd, process.env.TS_BUILD_PROJECT) : path.join(cwd, 'tsconfig.json')
    return isFile(file) ? file : null
}

export function isFile(file) {
    return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false
}

// compilerOptions.paths as a list: an exact pattern or a prefix with "*", targets absolute
export function pathAliases(config) {
    const aliases = []
    for (const [pattern, targets] of Object.entries(config.paths ?? {})) {
        const star = pattern.indexOf('*')
        aliases.push({
            pattern,
            prefix:  star < 0 ? pattern : pattern.slice(0, star),
            suffix:  star < 0 ? '' : pattern.slice(star + 1),
            wildcard: star >= 0,
            targets: targets.map(target => path.resolve(config.paths_base, target)),
        })
    }
    // as in tsc: an exact match first, then the longest prefix
    aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.prefix.length - a.prefix.length)
    return aliases
}

// A TypeScript source is imported by its .js name; extensionless and directory imports
// are allowed as with ts-node experimentalSpecifierResolution=node
export function findSource(file) {
    if (file.endsWith('.js')) {
        const ts_file = file.slice(0, -3) + '.ts'
        if (isFile(ts_file)) return ts_file
    } else if (file.endsWith('.mjs')) {
        const ts_file = file.slice(0, -4) + '.mts'
        if (isFile(ts_file)) return ts_file
    }
    if (isFile(file)) return file
    for (const candidate of [file + '.ts', path.join(file, 'index.ts')]) {
        if (isFile(candidate)) return candidate
    }
    return null
}

export function matchAlias(aliases, specifier) {
    for (const alias of aliases) {
        if (alias.wildcard) {
            if (specifier.length < alias.prefix.length + alias.suffix.length || !specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) {
                continue
            }
            const rest = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length)
            for (const target of alias.targets) {
                const file = findSource(target.replace('*', rest))
                if (file) return file
            }
        } else if (specifier === alias.prefix) {
            for (const target of alias.targets) {
                const file = findSource(target)
                if (file) return file
            }
        }
    }
    return null
}
