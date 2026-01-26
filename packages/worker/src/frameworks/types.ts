import type { NimbusConfig } from '../lib/nimbus-config.js';
import type { GeneratedFile } from '../types.js';

export type FrameworkTarget = 'static' | 'workers';

export interface FrameworkOutput {
  assetsDir?: string;
  workerEntry?: string;
}

export interface PackageJsonData {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

export interface FrameworkDetectContext {
  files: GeneratedFile[];
  packageJson: PackageJsonData | null;
}

export interface FrameworkDefinition {
  id: string;
  defaultTarget: FrameworkTarget;
  supportedTargets?: FrameworkTarget[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  outputs: Record<FrameworkTarget, FrameworkOutput>;
  detect?: (context: FrameworkDetectContext) => boolean;
  promptRules?: Partial<Record<FrameworkTarget, string>>;
  promptKeywords?: string[];
  normalizeFiles?: (context: FrameworkNormalizeContext) => GeneratedFile[];
}

export interface FrameworkNormalizeContext {
  files: GeneratedFile[];
  config: NimbusConfig | null;
  target: FrameworkTarget;
  packageJson: PackageJsonData | null;
}
