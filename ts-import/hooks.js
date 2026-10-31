import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findSource, findTsconfig, isFile, loadTsconfig, matchAlias, pathAliases } from './config.js'

const require = createRequire(import.meta.url)
const swc = require('@swc/core')

// TypeScript is transpiled file by file with swc, as ts-node did with "swc": true:
// target es2022 => useDefineForClassFields and keepClassNames, ES modules, import attributes
// kept as `with` (node 22+ does not parse `assert`). A const enum is emitted as an enum object:
// a module imports it like any other export, there is no program to inline it from
export const SWC_OPTIONS = {
    swcrc: false,
    sourceMaps: 'inline',
    module: { type: 'es6' },
    jsc: {
        parser: { syntax: 'typescript', tsx: false, decorators: true, dynamicImport: true, importAssertions: true },
        target: 'es2022',
        transform: { legacyDecorator: true, useDefineForClassFields: true, treatConstEnumAsEnum: true },
        keepClassNames: true,
        experimental: { keepImportAttributes: true, emitAssertForImportAttributes: false },
    },
}

const LOADER_VERSION = '2'

const tsconfig_file = findTsconfig()
const tsconfig = tsconfig_file ? loadTsconfig(tsconfig_file) : null
const aliases = tsconfig ? pathAliases(tsconfig) : []
// a bare specifier may be a module relative to baseUrl (import ... from 'block_lang.js')
const base_url = tsconfig?.compilerOptions.baseUrl ?? null

// transpiled code is cached on disk by the hash of the source
const cache_salt = `${LOADER_VERSION}\n${swc.version}\n${JSON.stringify(SWC_OPTIONS)}\n`
const cache_dir = cacheDir()

function cacheDir() {
    const project_dir = tsconfig?.dir ?? process.cwd()
    const node_modules = path.join(project_dir, 'node_modules')
    const dir = isFile(path.join(node_modules, '.package-lock.json')) || isFile(path.join(project_dir, 'package.json'))
        ? path.join(node_modules, '.cache', 'ts-build')
        : path.join(os.tmpdir(), 'ts-build-cache')
    try {
        mkdirSync(dir, { recursive: true })
        return dir
    } catch {
        return null
    }
}

function found(file) {
    return file ? { url: pathToFileURL(file).href, shortCircuit: true } : null
}

function isRelative(specifier) {
    return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..'
}

// the part of the resolution done before the default resolver; null - the default one decides
export function resolveTypeScript(specifier, context) {
    const parent_url = context.parentURL
    if (parent_url && parent_url.includes('/node_modules/')) {
        return null
    }
    const alias = matchAlias(aliases, specifier)
    if (alias) {
        return found(alias)
    }
    if (specifier.startsWith('file:')) {
        return found(findSource(fileURLToPath(specifier)))
    }
    if (isRelative(specifier)) {
        const parent_dir = parent_url?.startsWith('file:') ? path.dirname(fileURLToPath(parent_url)) : process.cwd()
        return found(findSource(path.resolve(parent_dir, specifier)))
    }
    return null
}

// a bare specifier the default resolver did not find
export function resolveBaseUrl(specifier, context) {
    if (!base_url || context.parentURL?.includes('/node_modules/') || /^(\.|\/|[a-z]+:)/i.test(specifier)) {
        return null
    }
    return found(findSource(path.join(base_url, specifier)))
}

export function isTypeScriptUrl(url) {
    return url.startsWith('file:') && (url.endsWith('.ts') || url.endsWith('.mts')) && !url.endsWith('.d.ts') && !url.includes('/node_modules/')
}

export function transpile(url) {
    const file = fileURLToPath(url)
    const source = readFileSync(file, 'utf-8')
    const key = createHash('sha1').update(cache_salt).update(url).update('\n').update(source).digest('hex')
    const cache_file = cache_dir ? path.join(cache_dir, `${key}.js`) : null
    if (cache_file) {
        try {
            return readFileSync(cache_file, 'utf-8')
        } catch {
            // not cached yet
        }
    }
    const code = swc.transformSync(source, { ...SWC_OPTIONS, filename: file }).code
    if (cache_file) {
        try {
            writeFileSync(cache_file, code)
        } catch (e) {
            // a failed cache write only costs the next run a transpilation
            console.warn(`ts-build: failed to write cache ${cache_file}: ${e}`)
        }
    }
    return code
}

// JSON modules of TypeScript sources are imported without the `with { type: 'json' }` attribute
export function jsonContext(url, context) {
    return url.endsWith('.json') && !context.importAttributes?.type
        ? { ...context, importAttributes: { ...context.importAttributes, type: 'json' } }
        : null
}

// synchronous hooks of module.registerHooks: they run in the thread that registered them
export function resolve(specifier, context, next) {
    const result = resolveTypeScript(specifier, context)
    if (result) {
        return result
    }
    try {
        return next(specifier, context)
    } catch (e) {
        const base = resolveBaseUrl(specifier, context)
        if (base) {
            return base
        }
        throw e
    }
}

export function load(url, context, next) {
    if (isTypeScriptUrl(url)) {
        return { format: 'module', source: transpile(url), shortCircuit: true }
    }
    return next(url, jsonContext(url, context) ?? context)
}
