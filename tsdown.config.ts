/**
 * tsdown build for dsh-llm-capabilities, mirroring the official DSH
 * client-bundle preset (packages/client/tsdown.client.ts shape):
 *
 *  - node half: src/index.ts → dist/index.js (ESM)
 *  - shared detection: src/shared/detection.ts → dist/detection.js (ESM, tests)
 *  - browser client half: src/client.tsx → dist/client.js, a closure-factory
 *    artifact calling window.__ModuleLoader__.load({id, factory}); the web
 *    shell serves it as a classic script, so ESM import syntax cannot appear
 *    there.
 */
import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-llm-capabilities'

const EXTERNAL_PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
] as const

export default defineConfig([
  // Node half + shared detection — ESM.
  {
    entry: {
      index: 'src/index.ts',
      detection: 'src/shared/detection.ts',
      'session-headers': 'src/session-headers.ts',
    },
    format: ['esm'],
    platform: 'neutral',
    dts: true,
    clean: true,
    sourcemap: false,
    deps: {
      neverBundle: [/@deepseek-ai\//, /react/, /@earendil-works\//],
    },
  },
  // Browser client bundle — closure-factory ModuleLoader artifact.
  {
    entry: { client: 'src/client.tsx' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: false,
    fixedExtension: false,
    external: [...EXTERNAL_PLATFORM_MODULES],
    noExternal: (id: string) =>
      (EXTERNAL_PLATFORM_MODULES as readonly string[]).includes(id) ? undefined : true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [
      {
        name: 'dsh-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if ((EXTERNAL_PLATFORM_MODULES as readonly string[]).includes(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a platform module — ` +
              'cross-plugin value imports are forbidden; collaborate through cordis services',
          )
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
