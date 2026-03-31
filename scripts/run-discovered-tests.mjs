import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function listTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function hasRunTestsExport(filePath) {
  const content = await readFile(filePath, 'utf8');
  return /export\s+(async\s+)?function\s+run[A-Za-z0-9_]*Tests\s*\(/.test(content);
}

function getTestExports(module) {
  return Object.entries(module)
    .filter(([name, value]) => /^run[A-Za-z0-9_]*Tests$/.test(name) && typeof value === 'function')
    .map(([name, run]) => ({ name, run }));
}

async function main() {
  const rootArg = process.argv[2] ?? '.test-dist';
  const rootDir = resolve(process.cwd(), rootArg);
  const files = (await listTestFiles(rootDir)).sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No compiled test files found under ${rootDir}`);
  }

  let passed = 0;
  let failed = 0;

  for (const filePath of files) {
    if (!(await hasRunTestsExport(filePath))) {
      continue;
    }

    const module = await import(pathToFileURL(filePath).href);
    const testExports = getTestExports(module);
    if (testExports.length === 0) {
      continue;
    }

    for (const testExport of testExports) {
      const label = `${filePath.replace(`${rootDir}/`, '')}:${testExport.name}`;
      try {
        await testExport.run();
        passed += 1;
        console.log(`PASS ${label}`);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`FAIL ${label}`);
        console.error(message);
      }
    }
  }

  if (passed === 0 && failed === 0) {
    throw new Error(`No run*Tests exports found under ${rootDir}`);
  }

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(`All tests passed (${passed})`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('Test discovery runner crashed');
  console.error(message);
  process.exit(1);
});
