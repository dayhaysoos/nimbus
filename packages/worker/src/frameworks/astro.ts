import type { GeneratedFile } from '../types.js';
import type { FrameworkDefinition, FrameworkNormalizeContext } from './types.js';

const ASTRO_WORKERS_RULES = [
  '- Generate an Astro project configured for Cloudflare Workers SSR.',
  '- Default to SSR unless the user explicitly asks for static output.',
  '- Include dependencies: astro@5.16.15 and @astrojs/cloudflare@12.6.12.',
  '- Add astro.config.mjs with output: "server" and adapter cloudflare().',
  '- Include nimbus.config.json with {"framework":"astro","target":"workers","assetsDir":"dist","workerEntry":"dist/_worker.js/index.js"}.',
  '- Include scripts: "dev": "astro dev", "build": "astro build", "preview": "astro preview".',
].join('\n');

const ASTRO_STATIC_RULES = [
  '- Generate an Astro project configured for static output.',
  '- Set output: "static" in astro.config.mjs.',
  '- Include nimbus.config.json with {"framework":"astro","target":"static","assetsDir":"dist"}.',
  '- If using dynamic routes in static output, you MUST add getStaticPaths.',
].join('\n');

const ASTRO_CONFIG_PATTERN = /(^|\/)astro\.config\.(js|mjs|cjs|ts|mts)$/;

const ADAPTER_IMPORT_PATTERN = /import\s+(\w+)\s+from\s+['"]@astrojs\/node['"];?/;

const RENDERER_INTEGRATIONS = [
  { packageName: '@astrojs/preact', importName: 'preact' },
  { packageName: '@astrojs/react', importName: 'react' },
  { packageName: '@astrojs/solid-js', importName: 'solid' },
  { packageName: '@astrojs/svelte', importName: 'svelte' },
  { packageName: '@astrojs/vue', importName: 'vue' },
];

function getRendererImports(packageJson: FrameworkNormalizeContext['packageJson']): {
  importLines: string[];
  integrationCalls: string[];
} {
  if (!packageJson) {
    return { importLines: [], integrationCalls: [] };
  }
  const deps = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  const importLines: string[] = [];
  const integrationCalls: string[] = [];
  for (const renderer of RENDERER_INTEGRATIONS) {
    if (deps[renderer.packageName]) {
      importLines.push(`import ${renderer.importName} from '${renderer.packageName}';`);
      integrationCalls.push(`${renderer.importName}()`);
    }
  }
  return { importLines, integrationCalls };
}

function buildDefaultAstroConfig(context: FrameworkNormalizeContext): string {
  const { importLines, integrationCalls } = getRendererImports(context.packageJson);
  const integrationsLine = integrationCalls.length
    ? `  integrations: [${integrationCalls.join(', ')}],\n`
    : '';
  const imports = [
    "import { defineConfig } from 'astro/config';",
    "import cloudflare from '@astrojs/cloudflare';",
    ...importLines,
    '',
  ].join('\n');
  return `${imports}export default defineConfig({\n  output: 'server',\n  adapter: cloudflare(),\n${integrationsLine}});\n`;
}

function ensureOutputServer(content: string): string {
  if (/output\s*:\s*['"]server['"]/.test(content)) {
    return content;
  }
  if (/output\s*:\s*['"][^'"]+['"]/.test(content)) {
    return content.replace(/output\s*:\s*['"][^'"]+['"]/, "output: 'server'");
  }
  return content.replace(/defineConfig\(\s*\{/, "defineConfig({\n  output: 'server',");
}

function ensureCloudflareAdapter(content: string): string {
  if (content.includes("@astrojs/cloudflare") && /adapter\s*:\s*cloudflare\b/.test(content)) {
    return content;
  }

  let updated = content;
  const adapterImport = updated.match(ADAPTER_IMPORT_PATTERN);
  if (adapterImport) {
    const identifier = adapterImport[1];
    updated = updated.replace(ADAPTER_IMPORT_PATTERN, "import cloudflare from '@astrojs/cloudflare';");
    if (identifier && identifier !== 'cloudflare') {
      updated = updated.replace(new RegExp(`\\b${identifier}\\s*\\(`, 'g'), 'cloudflare(');
      updated = updated.replace(new RegExp(`adapter\\s*:\\s*${identifier}\\b`, 'g'), 'adapter: cloudflare');
    }
  } else if (!updated.includes("@astrojs/cloudflare")) {
    if (updated.includes("from 'astro/config'")) {
      updated = updated.replace(
        /import\s+\{\s*defineConfig\s*\}\s+from\s+['"]astro\/config['"];?/,
        "import { defineConfig } from 'astro/config';\nimport cloudflare from '@astrojs/cloudflare';"
      );
    } else {
      updated = `import cloudflare from '@astrojs/cloudflare';\n${updated}`;
    }
  }

  if (!/adapter\s*:\s*cloudflare\b/.test(updated)) {
    updated = updated.replace(/defineConfig\(\s*\{/, "defineConfig({\n  adapter: cloudflare(),");
  }
  return updated;
}

function normalizeAstroConfigFiles(context: FrameworkNormalizeContext): GeneratedFile[] {
  if (context.target !== 'workers') {
    return context.files;
  }

  const index = context.files.findIndex((file) => ASTRO_CONFIG_PATTERN.test(file.path));
  if (index === -1) {
    return [
      ...context.files,
      {
        path: 'astro.config.mjs',
        content: buildDefaultAstroConfig(context),
      },
    ];
  }

  const file = context.files[index];
  let content = file.content;
  content = ensureCloudflareAdapter(content);
  content = ensureOutputServer(content);

  const nextFiles = [...context.files];
  nextFiles[index] = { ...file, content };
  return nextFiles;
}

export const astroDefinition: FrameworkDefinition = {
  id: 'astro',
  defaultTarget: 'workers',
  dependencies: {
    astro: '5.16.15',
    '@astrojs/cloudflare': '12.6.12',
  },
  outputs: {
    workers: {
      assetsDir: 'dist',
      workerEntry: 'dist/_worker.js/index.js',
    },
    static: {
      assetsDir: 'dist',
    },
  },
  detect: ({ files, packageJson }) => {
    if (packageJson?.dependencies?.astro || packageJson?.devDependencies?.astro) {
      return true;
    }
    return files.some((file) => /(^|\/)astro\.config\.(js|mjs|cjs|ts|mts)$/.test(file.path));
  },
  promptRules: {
    workers: ASTRO_WORKERS_RULES,
    static: ASTRO_STATIC_RULES,
  },
  promptKeywords: ['astro'],
  normalizeFiles: normalizeAstroConfigFiles,
};
