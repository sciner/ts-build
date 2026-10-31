import * as node_module from 'node:module'
import { load, resolve } from './hooks.js'

let registered = false

// Registers the TypeScript hooks in the current thread: node --import @sciner/ts-build does it
// for the main thread and, through the inherited execArgv, for every worker thread.
// Synchronous: a module imported right after register() already goes through the hooks
export function register() {
    if (registered) {
        return
    }
    registered = true
    // stack traces point to the TypeScript sources through the inline source maps
    process.setSourceMapsEnabled(true)
    if (typeof node_module.registerHooks === 'function') {
        // synchronous hooks in the same thread: no message round trip per import
        node_module.registerHooks({ resolve, load })
    } else {
        // node before 22.15 / 23.5: asynchronous hooks in a loader thread
        node_module.register('./hooks-async.js', import.meta.url)
    }
}
