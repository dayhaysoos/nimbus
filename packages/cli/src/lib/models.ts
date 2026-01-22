import * as p from '@clack/prompts';
import { validateModel } from './api.js';

export interface ModelOption {
  value: string;
  label: string;
  hint?: string;
}

// Curated list of recommended models
export const MODELS: ModelOption[] = [
  {
    value: 'anthropic/claude-sonnet-4',
    label: 'Claude Sonnet 4',
    hint: 'Recommended - Great at code generation',
  },
  {
    value: 'anthropic/claude-opus-4',
    label: 'Claude Opus 4',
    hint: 'More capable, slower, pricier',
  },
  {
    value: 'openai/gpt-4o',
    label: 'GPT-4o',
    hint: "OpenAI's flagship multimodal",
  },
  {
    value: 'openai/gpt-4.1',
    label: 'GPT-4.1',
    hint: 'Latest OpenAI model',
  },
  {
    value: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    hint: "Google's latest",
  },
  {
    value: 'deepseek/deepseek-r1',
    label: 'DeepSeek R1',
    hint: 'Strong reasoning model',
  },
  {
    value: 'meta-llama/llama-4-maverick',
    label: 'Llama 4 Maverick',
    hint: "Meta's open model",
  },
];

// Special value for custom model option
const CUSTOM_MODEL_VALUE = '__custom__';

/**
 * Show model picker and return selected model
 */
export async function showModelPicker(): Promise<string> {
  const result = await p.select({
    message: 'Select a model:',
    initialValue: MODELS[0].value,
    options: [
      ...MODELS.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
      })),
      {
        value: CUSTOM_MODEL_VALUE,
        label: 'Other LLM',
        hint: 'Enter a custom OpenRouter model ID',
      },
    ],
  });

  if (p.isCancel(result)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  // Handle custom model input
  if (result === CUSTOM_MODEL_VALUE) {
    return await promptCustomModel();
  }

  return result;
}

/**
 * Prompt for custom model ID and validate
 */
async function promptCustomModel(): Promise<string> {
  p.log.info('Find model IDs at: https://openrouter.ai/models');
  p.log.info('Format: provider/model-name (e.g., anthropic/claude-3-haiku)');
  console.log('');

  const customModel = await p.text({
    message: 'Enter OpenRouter model ID:',
    placeholder: 'anthropic/claude-3-haiku',
    validate: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Model ID is required';
      }
      if (!value.includes('/')) {
        return 'Model ID should be in format: provider/model-name';
      }
      return undefined;
    },
  });

  if (p.isCancel(customModel)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  // Validate against OpenRouter API
  const spinner = p.spinner();
  spinner.start('Validating model...');

  const isValid = await validateModel(customModel);

  if (!isValid) {
    spinner.stop('Invalid model');
    p.log.error(`Model "${customModel}" not found on OpenRouter.`);
    p.log.info('Check available models at: https://openrouter.ai/models');

    // Ask if they want to try again or proceed anyway
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'retry', label: 'Try a different model' },
        { value: 'proceed', label: 'Use anyway (may fail later)' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });

    if (p.isCancel(action) || action === 'cancel') {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (action === 'retry') {
      return await promptCustomModel();
    }

    // action === 'proceed' - user explicitly chose to use unvalidated model
    p.log.warning(`Proceeding with unvalidated model: ${customModel}`);
  } else {
    spinner.stop('Model validated');
  }

  return customModel;
}

/**
 * Get the default model
 */
export function getDefaultModel(): string {
  return MODELS[0].value;
}

/**
 * Extract short model name for display (e.g., "claude-sonnet-4" from "anthropic/claude-sonnet-4")
 */
export function getShortModelName(model: string): string {
  return model.split('/').pop() || model;
}
