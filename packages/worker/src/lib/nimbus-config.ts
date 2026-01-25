import type { GeneratedFile } from '../types.js';

export interface NimbusConfig {
  framework?: string;
  target?: string;
  assetsDir?: string;
  workerEntry?: string;
}

const NIMBUS_CONFIG_BASENAME = 'nimbus.config.json';

export function parseNimbusConfig(files: GeneratedFile[]): NimbusConfig | null {
  const configFile = files.find(
    (file) => file.path === NIMBUS_CONFIG_BASENAME || file.path.endsWith(`/${NIMBUS_CONFIG_BASENAME}`)
  );
  if (!configFile) {
    return null;
  }

  try {
    const parsed = JSON.parse(configFile.content) as NimbusConfig;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isNextWorkersConfig(config: NimbusConfig | null): boolean {
  return Boolean(config && config.framework === 'next' && config.target === 'workers');
}

const NEXT_CONFIG_PATTERN = /(^|\/)next\.config\.(js|mjs|cjs|ts|mts)$/;

const DEFAULT_NEXT_CONFIG = `const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
`;

export function normalizeNextConfigFiles(files: GeneratedFile[]): GeneratedFile[] {
  const filtered = files.filter((file) => !NEXT_CONFIG_PATTERN.test(file.path));
  filtered.push({ path: 'next.config.ts', content: DEFAULT_NEXT_CONFIG });
  return filtered;
}
