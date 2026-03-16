import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HIGH_OR_CRITICAL = new Set(['high', 'critical']);

function normalizeDependencyPath(path) {
  return String(path)
    .split('>')
    .map((segment) => segment.trim().replace(/@[^@\s]+$/, ''))
    .join(' > ');
}

function advisoryPaths(advisory) {
  const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
  const paths = [];
  for (const finding of findings) {
    const findingPaths = Array.isArray(finding?.paths) ? finding.paths : [];
    for (const path of findingPaths) {
      paths.push(normalizeDependencyPath(path));
    }
  }
  return [...new Set(paths)];
}

function scopeMatches(exceptionScope, path) {
  return path === exceptionScope || path.startsWith(`${exceptionScope} > `);
}

function matchesExceptionMetadata(advisory, severity, exception) {
  const exceptionGhsa = String(exception.ghsa ?? '');
  const advisoryGhsa = String(advisory.github_advisory_id ?? '');
  if (!exceptionGhsa || exceptionGhsa !== advisoryGhsa) {
    return false;
  }

  if (typeof exception.package === 'string') {
    const advisoryModule = String(advisory.module_name ?? '');
    if (!advisoryModule || advisoryModule !== exception.package) {
      return false;
    }
  }

  if (typeof exception.severity === 'string') {
    if (exception.severity.toLowerCase() !== severity) {
      return false;
    }
  }

  return true;
}

function exceptionCoversPath(exception, path) {
  if (Array.isArray(exception.scope) && exception.scope.length > 0) {
    const normalizedScope = exception.scope.map((entry) => normalizeDependencyPath(entry));
    return normalizedScope.some((scopeEntry) => scopeMatches(scopeEntry, path));
  }

  return true;
}

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
    const paths = advisoryPaths(advisory);
    const record = {
      ghsa,
      title: String(advisory.title ?? 'Unknown advisory'),
      module: String(advisory.module_name ?? 'unknown'),
      severity,
      paths,
    };

    const metadataMatches = exceptions.filter((exception) => matchesExceptionMetadata(advisory, severity, exception));
    const uncoveredPaths = paths.filter(
      (path) => !metadataMatches.some((exception) => exceptionCoversPath(exception, path))
    );

    if (metadataMatches.length > 0 && uncoveredPaths.length === 0) {
      suppressed.push(record);
    } else {
      failures.push({
        ...record,
        uncoveredPaths,
      });
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
      for (const path of advisory.uncoveredPaths.length > 0 ? advisory.uncoveredPaths : advisory.paths) {
        console.error(`  path: ${path}`);
      }
    }
    process.exit(1);
  }

  console.log('No unapproved high/critical advisories found.');
}

main();
