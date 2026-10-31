# @sciner/ts-build

TypeScript helpers of the Tesera project. No TypeScript compiler API inside: works with TypeScript 7.

## Running TypeScript sources

```
node --import @sciner/ts-build index.ts
```

- Every `.ts` file is transpiled by swc (file by file, target es2022, ES modules, const enums
  as enum objects) and cached on disk in `node_modules/.cache/ts-build` of the project.
- Specifiers are resolved by `compilerOptions.paths` of `tsconfig.json` in the current directory
  (or `TS_BUILD_PROJECT`), `extends` included; a `.js` specifier finds its `.ts` source.
- The hooks are synchronous (`module.registerHooks`, node 22.15+ / 23.5+) and run in the thread
  that registered them; older node gets asynchronous hooks in a loader thread (`module.register`).
- Worker threads inherit `--import`. For a worker started with `eval`:

```js
import('@sciner/ts-build/api').then(({ register }) => { register(); import(file) })
```

## Rewriting the path aliases after tsc

tsc 7 has no transformer plugins. `ts-build-tsc` runs tsc of the project with the given arguments,
then rewrites the `paths` aliases in the emitted `.js` / `.d.ts` files to relative paths, with the
rules of the former `ts-transform-paths` plugin:

```
ts-build-tsc -p www/tsconfig.json
ts-build-tsc -w -p www/tsconfig.json
```

The same from code: `import { rewriteProject } from '@sciner/ts-build/paths'`.
