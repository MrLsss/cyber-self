import { defineConfig } from 'tsdown'

/**
 * The client half must arrive as a classic script that only registers a module
 * factory: the web shell's module table serves plugin bundles through
 * `window.__ModuleLoader__.load({ id, factory })`, and every dependency becomes a
 * call to the `require` handed to that factory.
 */
const CLIENT_ID = 'cyberself'

const CLIENT_HEAD =
  `window.__ModuleLoader__.load({id:${JSON.stringify(CLIENT_ID)},factory:(require)=>{`
  + 'var module={exports:{}};var exports=module.exports;'

const CLIENT_TAIL = 'return module.exports}})'

/**
 * Two independent outputs: the Host half runs in the DSH runtime, the client
 * half runs in the browser and imports only packages the client module system
 * already provides.
 */
export default defineConfig([
  {
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    dts: false,
    clean: true,
    external: [
      /^node:/,
      /^@deepseek-ai\//,
      'cheerio',
      'domhandler',
      'mammoth',
      'unpdf',
      '@napi-rs/canvas',
    ],
  },
  {
    name: 'client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    outExtensions: () => ({ js: '.js' }),
    dts: false,
    clean: false,
    banner: CLIENT_HEAD,
    footer: CLIENT_TAIL,
    external: [
      /^react(\/|$)/,
      /^react-dom(\/|$)/,
      /^@deepseek-ai\//,
    ],
  },
])
