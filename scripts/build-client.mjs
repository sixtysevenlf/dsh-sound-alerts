/**
 * Build the browser half (lib/client.js) with esbuild.
 *
 * 本环境无 tsdown 工具链（其 @deepseek-ai/dsh-compact 依赖在私有 registry），
 * 因此直接用 esbuild 复刻 tsdown 配置的产物形态：
 * window.__ModuleLoader__.load({ id, factory: (require) => { ... } })。
 * react 等 shell 自有模块保持 external（浏览器模块表在运行时提供）。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN_ID = '@dsh-external/dsh-sound-alerts'

await build({
  entryPoints: [root + 'src/client/index.ts'],
  outfile: root + 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis'],
  sourcemap: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

console.log('client bundle written to lib/client.js')
