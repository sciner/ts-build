// Asynchronous hooks of module.register for node without module.registerHooks (before 22.15 / 23.5):
// they run in a separate loader thread, the logic is the one of the synchronous hooks
import { isTypeScriptUrl, jsonContext, resolveBaseUrl, resolveTypeScript, transpile } from './hooks.js'

export async function resolve(specifier, context, next) {
    const result = resolveTypeScript(specifier, context)
    if (result) {
        return result
    }
    try {
        return await next(specifier, context)
    } catch (e) {
        const base = resolveBaseUrl(specifier, context)
        if (base) {
            return base
        }
        throw e
    }
}

export async function load(url, context, next) {
    if (isTypeScriptUrl(url)) {
        return { format: 'module', source: transpile(url), shortCircuit: true }
    }
    return next(url, jsonContext(url, context) ?? context)
}
