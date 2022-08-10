import { promises as fsp } from 'fs'
import { relative, resolve, join, dirname, isAbsolute } from 'pathe'
import * as rollup from 'rollup'
import fse from 'fs-extra'
import { defu } from 'defu'
import { watch } from 'chokidar'
import { debounce } from 'perfect-debounce'
import type { TSConfig } from 'pkg-types'
import { printFSTree } from './utils/tree'
import { getRollupConfig, RollupConfig } from './rollup/config'
import { prettyPath, writeFile, isDirectory } from './utils'
import { GLOB_SCAN_PATTERN, scanHandlers } from './scan'
import type { Nitro } from './types'
import { runtimeDir } from './dirs'
import { snapshotStorage } from './storage'

export async function prepare (nitro: Nitro) {
  await prepareDir(nitro.options.output.dir)
  await prepareDir(nitro.options.output.publicDir)
  await prepareDir(nitro.options.output.serverDir)
}

async function prepareDir (dir: string) {
  await fsp.mkdir(dir, { recursive: true })
  await fse.emptyDir(dir)
}

export async function copyPublicAssets (nitro: Nitro) {
  for (const asset of nitro.options.publicAssets) {
    if (await isDirectory(asset.dir)) {
      await fse.copy(asset.dir, join(nitro.options.output.publicDir, asset.baseURL!))
    }
  }
  nitro.logger.success('Generated public ' + prettyPath(nitro.options.output.publicDir))
}

export async function build (nitro: Nitro) {
  const rollupConfig = getRollupConfig(nitro)
  await nitro.hooks.callHook('rollup:before', nitro)
  return nitro.options.dev ? _watch(nitro, rollupConfig) : _build(nitro, rollupConfig)
}

export async function writeTypes (nitro: Nitro) {
  const routeTypes: Record<string, string[]> = {}

  const middleware = [
    ...nitro.scannedHandlers,
    ...nitro.options.handlers
  ]

  for (const mw of middleware) {
    if (typeof mw.handler !== 'string' || !mw.route) { continue }
    const relativePath = relative(join(nitro.options.buildDir, 'types'), mw.handler).replace(/\.[a-z]+$/, '')
    routeTypes[mw.route] = routeTypes[mw.route] || []
    routeTypes[mw.route].push(`Awaited<ReturnType<typeof import('${relativePath}').default>>`)
  }

  let autoImportedTypes: string[] = []

  if (nitro.unimport) {
    autoImportedTypes = [
      nitro.unimport
        .generateTypeDeclarations({ exportHelper: false })
        .trim()
    ]
  }

  const lines = [
    '// Generated by nitro',
    'declare module \'nitropack\' {',
    '  type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T',
    '  interface InternalApi {',
    ...Object.entries(routeTypes).map(([path, types]) => `    '${path}': ${types.join(' | ')}`),
    '  }',
    '}',
    ...autoImportedTypes,
    // Makes this a module for augmentation purposes
    'export {}'
  ]

  await writeFile(join(nitro.options.buildDir, 'types/nitro.d.ts'), lines.join('\n'))

  if (nitro.options.typescript.generateTsConfig) {
    const tsConfig: TSConfig = {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Node',
        allowJs: true,
        resolveJsonModule: true,
        paths: nitro.options.typescript.internalPaths
          ? {
              '#internal/nitro': [
                join(runtimeDir, 'index')
              ],
              '#internal/nitro/*': [
                join(runtimeDir, '*')
              ]
            }
          : {}
      },
      include: [
        './nitro.d.ts',
        join(relative(join(nitro.options.buildDir, 'types'), nitro.options.rootDir), '**/*'),
        ...nitro.options.srcDir !== nitro.options.rootDir ? [join(relative(join(nitro.options.buildDir, 'types'), nitro.options.srcDir), '**/*')] : []
      ]
    }
    await writeFile(join(nitro.options.buildDir, 'types/tsconfig.json'), JSON.stringify(tsConfig, null, 2))
  }
}

async function _snapshot (nitro: Nitro) {
  if (!nitro.options.bundledStorage.length ||
    nitro.options.preset === 'nitro-prerender'
  ) {
    return
  }
  // TODO: Use virtual storage for server assets
  const storageDir = resolve(nitro.options.buildDir, 'snapshot')
  nitro.options.serverAssets.push({
    baseName: 'nitro:bundled',
    dir: storageDir
  })

  const data = await snapshotStorage(nitro)
  await Promise.all(Object.entries(data).map(async ([path, contents]) => {
    if (typeof contents !== 'string') { contents = JSON.stringify(contents) }
    const fsPath = join(storageDir, path.replace(/:/g, '/'))
    await fsp.mkdir(dirname(fsPath), { recursive: true })
    await fsp.writeFile(fsPath, contents, 'utf8')
  }))
}

async function _build (nitro: Nitro, rollupConfig: RollupConfig) {
  await scanHandlers(nitro)
  await writeTypes(nitro)
  await _snapshot(nitro)

  nitro.logger.start('Building server...')
  const build = await rollup.rollup(rollupConfig).catch((_error) => {
    try {
      for (const error of ('errors' in _error ? _error.errors : [_error])) {
        const id = error.id || _error.id
        let path = isAbsolute(id) ? relative(process.cwd(), id) : id
        const location = error.loc || error.location
        if (location) {
          path += `:${location.line}:${location.column}`
        }
        nitro.logger.error(`Rollup error while processing \`${path}\`` + '\n' + '\n' + (error.text || error.frame))
      }
    } catch {}
    throw _error
  })

  nitro.logger.start('Writing server bundle...')
  await build.write(rollupConfig.output)

  // Write build info
  const nitroConfigPath = resolve(nitro.options.output.dir, 'nitro.json')
  const buildInfo = {
    date: new Date(),
    preset: nitro.options.preset,
    commands: {
      preview: nitro.options.commands.preview,
      deploy: nitro.options.commands.deploy
    }
  }
  await writeFile(nitroConfigPath, JSON.stringify(buildInfo, null, 2))

  nitro.logger.success('Server built')
  if (nitro.options.logLevel > 1) {
    await printFSTree(nitro.options.output.serverDir)
  }
  await nitro.hooks.callHook('compiled', nitro)

  // Show deploy and preview hints
  const rOutput = relative(process.cwd(), nitro.options.output.dir)
  const rewriteRelativePaths = (input: string) => {
    return input.replace(/\s\.\/([^\s]*)/g, ` ${rOutput}/$1`)
  }
  if (buildInfo.commands.preview) {
    nitro.logger.success(`You can preview this build using \`${rewriteRelativePaths(buildInfo.commands.preview)}\``)
  }
  if (buildInfo.commands.deploy) {
    nitro.logger.success(`You can deploy this build using \`${rewriteRelativePaths(buildInfo.commands.deploy)}\``)
  }
}

function startRollupWatcher (nitro: Nitro, rollupConfig: RollupConfig) {
  type OT = rollup.RollupWatchOptions
  const watcher = rollup.watch(defu<OT, OT>(rollupConfig, {
    watch: {
      chokidar: nitro.options.watchOptions
    }
  }))
  let start: number

  watcher.on('event', (event) => {
    switch (event.code) {
      // The watcher is (re)starting
      case 'START':
        return

      // Building an individual bundle
      case 'BUNDLE_START':
        start = Date.now()
        return

      // Finished building all bundles
      case 'END':
        nitro.hooks.callHook('compiled', nitro)
        nitro.logger.success('Nitro built', start ? `in ${Date.now() - start} ms` : '')
        nitro.hooks.callHook('dev:reload')
        return

      // Encountered an error while bundling
      case 'ERROR':
        nitro.logger.error('Rollup error: ', event.error)
    }
  })
  return watcher
}

async function _watch (nitro: Nitro, rollupConfig: RollupConfig) {
  let rollupWatcher: rollup.RollupWatcher

  const reload = debounce(async () => {
    if (rollupWatcher) { await rollupWatcher.close() }
    await scanHandlers(nitro)
    rollupWatcher = startRollupWatcher(nitro, rollupConfig)
    await writeTypes(nitro)
  })

  const watchPatterns = nitro.options.scanDirs.flatMap(dir => [
    join(dir, 'api'),
    join(dir, 'routes'),
    join(dir, 'middleware', GLOB_SCAN_PATTERN)
  ])

  const watchReloadEvents = new Set(['add', 'addDir', 'unlink', 'unlinkDir'])
  const reloadWacher = watch(watchPatterns, { ignoreInitial: true }).on('all', (event) => {
    if (watchReloadEvents.has(event)) {
      reload()
    }
  })

  nitro.hooks.hook('close', () => {
    rollupWatcher.close()
    reloadWacher.close()
  })

  await reload()
}
