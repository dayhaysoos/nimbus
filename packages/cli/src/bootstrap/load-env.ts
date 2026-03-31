import { existsSync } from 'fs';
import { resolve } from 'path';
import { config } from 'dotenv';

export function loadNimbusEnv(): void {
  const envPaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '..', '.env'),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      config({ path: envPath });
      break;
    }
  }
}
