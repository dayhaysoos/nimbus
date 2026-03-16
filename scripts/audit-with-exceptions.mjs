import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HIGH_OR_CRITICAL = new Set(['high', 'critical']);

function runAuditJson() {
  try {
    return execSync('pnpm audit --audit-level high --json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
      return error.stdout;
    }
    throw error;
  }
}

function readExceptions() {
  const raw = readFileSync('.audit-exceptions.json', 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('.audit-exceptions.json must be an array');
  }
  return parsed;
}

function main() {
  const report = JSON.parse(runAuditJson());
  const advisories = report?.advisories ?? {};
  const exceptions = readExceptions();
  const allowed = new Set(exceptions.map((entry) => String(entry.ghsa)));

  const failures = [];
  const suppressed = [];

  for (const advisory of Object.values(advisories)) {
    if (!advisory || typeof advisory !== 'object') {
      continue;
    }

    const severity = String(advisory.severity ?? '').toLowerCase();
    if (!HIGH_OR_CRITICAL.has(severity)) {
      continue;
    }

    const ghsa = String(advisory.github_advisory_id ?? '');
    const record = {
      ghsa,
      title: String(advisory.title ?? 'Unknown advisory'),
      module: String(advisory.module_name ?? 'unknown'),
      severity,
    };

    if (allowed.has(ghsa)) {
      suppressed.push(record);
    } else {
      failures.push(record);
    }
  }

  if (suppressed.length > 0) {
    console.log('Suppressed advisories from .audit-exceptions.json:');
    for (const advisory of suppressed) {
      console.log(`- ${advisory.ghsa} (${advisory.module}): ${advisory.title}`);
    }
  }

  if (failures.length > 0) {
    console.error('Unapproved high/critical advisories found:');
    for (const advisory of failures) {
      console.error(`- ${advisory.ghsa} (${advisory.module}, ${advisory.severity}): ${advisory.title}`);
    }
    process.exit(1);
  }

  console.log('No unapproved high/critical advisories found.');
}

main();
