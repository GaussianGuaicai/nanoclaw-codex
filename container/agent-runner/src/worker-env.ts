import { ContainerInput } from './runtime/types.js';

export function buildWorkerEnvironments(
  containerInput: ContainerInput,
  baseEnv: NodeJS.ProcessEnv = process.env,
): {
  sdkEnv: Record<string, string | undefined>;
  workerProcessEnv: Record<string, string>;
} {
  const sdkEnv: Record<string, string | undefined> = { ...baseEnv };
  const workerProcessEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(containerInput.sdkSecrets || {})) {
    sdkEnv[key] = value;
  }

  for (const [key, value] of Object.entries(containerInput.workerEnv || {})) {
    workerProcessEnv[key] = value;
    sdkEnv[key] = value;
  }

  return {
    sdkEnv,
    workerProcessEnv,
  };
}
