import type { FrameworkDefinition } from './types.js';

const NEXT_WORKERS_RULES = [
  '- Generate a Next.js project configured for Cloudflare Workers using OpenNext.',
  '- You MUST include:',
  '  - package.json with dependencies: next@latest, react@latest, react-dom@latest, @opennextjs/cloudflare@latest',
  '  - open-next.config.ts exporting defineCloudflareConfig()',
  '  - next.config.ts with output: "standalone" (do not use experimental.runtime or eslint config)',
  '  - nimbus.config.json with {"framework":"next","target":"workers"}',
  '  - scripts: "build": "next build", "preview": "opennextjs-cloudflare preview", "deploy": "opennextjs-cloudflare deploy"',
  '  - packageManager: "bun@1.2.19"',
  '- Prefer the App Router with TypeScript unless the user asks for Pages Router or JavaScript.',
  '- Do NOT set output: "export" or otherwise force static-only output for Next.js SSR.',
].join('\n');

export const nextDefinition: FrameworkDefinition = {
  id: 'next',
  defaultTarget: 'workers',
  supportedTargets: ['workers'],
  dependencies: {
    next: 'latest',
    react: 'latest',
    'react-dom': 'latest',
    '@opennextjs/cloudflare': 'latest',
  },
  outputs: {
    workers: {},
    static: {},
  },
  detect: ({ files, packageJson }) => {
    if (packageJson?.dependencies?.next || packageJson?.devDependencies?.next) {
      return true;
    }
    return files.some((file) => /(^|\/)next\.config\.(js|mjs|cjs|ts|mts)$/.test(file.path));
  },
  promptRules: {
    workers: NEXT_WORKERS_RULES,
  },
  promptKeywords: ['next.js', 'nextjs', 'next js', 'app router', 'pages router', 'full-stack react'],
};
