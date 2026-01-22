#!/usr/bin/env node

import * as p from '@clack/prompts';

// SSE Event types (matching worker)
type SSEEvent =
  | { type: 'generating' }
  | { type: 'generated'; fileCount: number }
  | { type: 'scaffolding' }
  | { type: 'writing' }
  | { type: 'installing' }
  | { type: 'building' }
  | { type: 'starting' }
  | { type: 'complete'; previewUrl: string }
  | { type: 'error'; message: string };

const WORKER_URL = process.env.NIMBUS_WORKER_URL;

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE messages
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || ''; // Keep incomplete message in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6)) as SSEEvent;
          yield data;
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const prompt = args.join(' ').trim();

  // Show help
  if (!prompt || prompt === '--help' || prompt === '-h') {
    console.log(`
Usage: npx @dayhaysoos/nimbus "<prompt>"

Example:
  NIMBUS_WORKER_URL=https://your-worker.com npx @dayhaysoos/nimbus "Build a landing page"

Environment Variables:
  NIMBUS_WORKER_URL  Worker URL (required) - Your self-hosted Nimbus worker

Self-hosting guide: https://github.com/dayhaysoos/nimbus#self-hosting-guide
`);
    process.exit(prompt ? 0 : 1);
  }

  // Require NIMBUS_WORKER_URL
  if (!WORKER_URL) {
    p.intro('@dayhaysoos/nimbus');
    p.log.error('NIMBUS_WORKER_URL environment variable is required.');
    p.log.info('Set it to your self-hosted Nimbus worker URL.');
    p.log.info('');
    p.log.info('Example:');
    p.log.info('  NIMBUS_WORKER_URL=https://your-worker.com npx @dayhaysoos/nimbus "your prompt"');
    p.log.info('');
    p.log.info('Self-hosting guide: https://github.com/dayhaysoos/nimbus#self-hosting-guide');
    process.exit(1);
  }

  p.intro('@dayhaysoos/nimbus');

  const spinner = p.spinner();

  try {
    spinner.start('Connecting to worker...');

    const response = await fetch(`${WORKER_URL}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body from worker');
    }

    const reader = response.body.getReader();

    for await (const event of parseSSE(reader)) {
      switch (event.type) {
        case 'generating':
          spinner.stop('Connected to worker');
          spinner.start('Sending to Claude...');
          break;

        case 'generated':
          spinner.stop(`Generated ${event.fileCount} files`);
          spinner.start('Building in sandbox...');
          break;

        case 'scaffolding':
          spinner.message('Scaffolding Astro project...');
          break;

        case 'writing':
          spinner.message('Writing generated files...');
          break;

        case 'installing':
          spinner.message('Running npm install...');
          break;

        case 'building':
          spinner.message('Running npm build...');
          break;

        case 'starting':
          spinner.stop('Build complete');
          spinner.start('Starting preview server...');
          break;

        case 'complete':
          spinner.stop('Preview server ready');
          p.outro(`Preview: ${event.previewUrl}`);
          p.log.info('Press Ctrl+C to stop the preview.');

          // Keep the process alive until Ctrl+C
          await new Promise(() => {});
          break;

        case 'error':
          spinner.stop('Failed');
          p.log.error(event.message);
          process.exit(1);
      }
    }
  } catch (error) {
    spinner.stop('Failed');
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exit(1);
  }
}

main();
