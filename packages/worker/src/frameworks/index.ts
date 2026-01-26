import { parseNimbusConfig, type NimbusConfig } from '../lib/nimbus-config.js';
import type { GeneratedFile } from '../types.js';
import { astroDefinition } from './astro.js';
import { nextDefinition } from './next.js';
import type { FrameworkDefinition, FrameworkNormalizeContext, FrameworkTarget, PackageJsonData } from './types.js';

const FRAMEWORKS: FrameworkDefinition[] = [astroDefinition, nextDefinition];

const FRAMEWORK_PROMPT_PRIORITY: FrameworkDefinition[] = [astroDefinition, nextDefinition];

const STATIC_TARGET_HINTS = [
  'static site',
  'static output',
  'static build',
  'ssg',
  'pre-render',
  'prerender',
];

const SSR_TARGET_HINTS = [
  'ssr',
  'server-side',
  'server side',
  'server rendered',
  'server-rendered',
  'full-stack',
];

const COMMON_PROMPT_RULES = '- Use real published versions or "latest" only. Never invent versions.';
const FALLBACK_PROMPT_RULES =
  '- Create a static site (HTML/CSS/JS) by default unless a framework is explicitly requested.';

const FRAMEWORK_MAP = new Map(FRAMEWORKS.map((framework) => [framework.id, framework]));

function readPackageJson(files: GeneratedFile[]): { index: number; data: PackageJsonData } | null {
  const index = files.findIndex((file) => file.path === 'package.json');
  if (index === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(files[index].content) as PackageJsonData;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return { index, data: parsed };
  } catch {
    return null;
  }
}

function writePackageJson(
  files: GeneratedFile[],
  index: number,
  data: PackageJsonData
): GeneratedFile[] {
  const nextFiles = [...files];
  nextFiles[index] = {
    ...nextFiles[index],
    content: `${JSON.stringify(data, null, 2)}\n`,
  };
  return nextFiles;
}

function upsertFile(files: GeneratedFile[], path: string, content: string): GeneratedFile[] {
  const index = files.findIndex((file) => file.path === path);
  if (index === -1) {
    return [...files, { path, content }];
  }
  const nextFiles = [...files];
  nextFiles[index] = { ...nextFiles[index], content };
  return nextFiles;
}

function resolveFramework(
  config: NimbusConfig | null,
  files: GeneratedFile[],
  packageJson: PackageJsonData | null
): FrameworkDefinition | null {
  if (config?.framework) {
    const directMatch = FRAMEWORK_MAP.get(config.framework);
    if (directMatch) {
      return directMatch;
    }
  }
  for (const framework of FRAMEWORKS) {
    if (framework.detect?.({ files, packageJson })) {
      return framework;
    }
  }
  return null;
}

function isTargetSupported(framework: FrameworkDefinition, target: FrameworkTarget): boolean {
  if (!framework.supportedTargets) {
    return true;
  }
  return framework.supportedTargets.includes(target);
}

function resolveTarget(config: NimbusConfig | null, framework: FrameworkDefinition): FrameworkTarget {
  if (config?.target === 'static' || config?.target === 'workers') {
    if (isTargetSupported(framework, config.target)) {
      return config.target;
    }
  }
  return framework.defaultTarget;
}

function resolvePromptTarget(
  framework: FrameworkDefinition,
  normalizedPrompt: string
): FrameworkTarget {
  if (framework.id === 'astro') {
    const wantsStatic = STATIC_TARGET_HINTS.some((hint) => normalizedPrompt.includes(hint));
    if (wantsStatic) {
      return 'static';
    }
  }
  return framework.defaultTarget;
}

function matchesPromptKeyword(framework: FrameworkDefinition, normalizedPrompt: string): boolean {
  if (!framework.promptKeywords || framework.promptKeywords.length === 0) {
    return false;
  }
  return framework.promptKeywords.some((keyword) => normalizedPrompt.includes(keyword));
}

function wantsSSRTarget(normalizedPrompt: string): boolean {
  return SSR_TARGET_HINTS.some((hint) => normalizedPrompt.includes(hint));
}

export function selectFrameworkForPrompt(prompt: string): {
  framework: FrameworkDefinition | null;
  target: FrameworkTarget | null;
} {
  const normalizedPrompt = prompt.toLowerCase();
  for (const framework of FRAMEWORK_PROMPT_PRIORITY) {
    if (matchesPromptKeyword(framework, normalizedPrompt)) {
      const target = resolvePromptTarget(framework, normalizedPrompt);
      return { framework, target };
    }
  }

  if (wantsSSRTarget(normalizedPrompt)) {
    return { framework: nextDefinition, target: nextDefinition.defaultTarget };
  }

  return { framework: null, target: null };
}

export function buildFrameworkPrompt(prompt: string): string {
  const selection = selectFrameworkForPrompt(prompt);
  if (!selection.framework) {
    return [FALLBACK_PROMPT_RULES, COMMON_PROMPT_RULES].join('\n');
  }

  const target = selection.target ?? selection.framework.defaultTarget;
  const supportedTarget = isTargetSupported(selection.framework, target)
    ? target
    : selection.framework.defaultTarget;
  const frameworkRules = selection.framework.promptRules?.[supportedTarget];
  const rules = frameworkRules ? frameworkRules : FALLBACK_PROMPT_RULES;
  return [rules, COMMON_PROMPT_RULES].join('\n');
}

function applyDependencies(
  data: PackageJsonData,
  framework: FrameworkDefinition
): PackageJsonData {
  const nextData: PackageJsonData = { ...data };
  if (framework.dependencies) {
    nextData.dependencies = {
      ...(nextData.dependencies ?? {}),
      ...framework.dependencies,
    };
  }
  if (framework.devDependencies) {
    nextData.devDependencies = {
      ...(nextData.devDependencies ?? {}),
      ...framework.devDependencies,
    };
  }
  return nextData;
}

function normalizeNimbusConfig(
  config: NimbusConfig | null,
  framework: FrameworkDefinition,
  target: FrameworkTarget
): NimbusConfig {
  const output = framework.outputs[target] ?? framework.outputs[framework.defaultTarget];
  const normalized: NimbusConfig = { ...(config ?? {}) };
  normalized.framework = framework.id;
  normalized.target = target;
  if (output.assetsDir) {
    normalized.assetsDir = output.assetsDir;
  } else {
    delete normalized.assetsDir;
  }
  if (output.workerEntry) {
    normalized.workerEntry = output.workerEntry;
  } else {
    delete normalized.workerEntry;
  }
  return normalized;
}

export function normalizeGeneratedFiles(files: GeneratedFile[]): {
  files: GeneratedFile[];
  config: NimbusConfig | null;
  framework: FrameworkDefinition | null;
} {
  const config = parseNimbusConfig(files);
  const packageJson = readPackageJson(files);
  const framework = resolveFramework(config, files, packageJson?.data ?? null);
  if (!framework) {
    return { files, config, framework: null };
  }

  const target = resolveTarget(config, framework);
  let nextFiles = files;
  let updatedPackage = packageJson?.data ?? null;
  if (packageJson) {
    updatedPackage = applyDependencies(packageJson.data, framework);
    nextFiles = writePackageJson(nextFiles, packageJson.index, updatedPackage);
  }

  const normalizeContext: FrameworkNormalizeContext = {
    files: nextFiles,
    config,
    target,
    packageJson: updatedPackage,
  };
  if (framework.normalizeFiles) {
    nextFiles = framework.normalizeFiles(normalizeContext);
  }

  const normalizedConfig = normalizeNimbusConfig(config, framework, target);
  nextFiles = upsertFile(nextFiles, 'nimbus.config.json', `${JSON.stringify(normalizedConfig, null, 2)}\n`);

  return { files: nextFiles, config: normalizedConfig, framework };
}

export { astroDefinition, nextDefinition };
export type { FrameworkDefinition, FrameworkTarget, PackageJsonData } from './types.js';
