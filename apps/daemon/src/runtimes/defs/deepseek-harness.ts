import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL_OPTION, execAgentFile } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';
import { parseDshProfileModelsOutput } from '../../agent-protocol/dsh-profile/index.js';

export function parseModels(stdout: string) {
  const catalog = parseDshProfileModelsOutput(stdout);
  if (!catalog) return null;
  return [
    DEFAULT_MODEL_OPTION,
    ...catalog.map((model) => ({
      id: `${model.provider}/${model.id}`,
      label: `${model.name} · ${model.provider_name}`,
      ...(model.reasoning_options?.length
        ? {
            reasoningOptions: model.reasoning_options.map((effort) => ({
              id: effort.id,
              label: effort.name,
              ...(effort.default === true ? { default: true } : {}),
            })),
          }
        : {}),
    })),
  ];
}

// The `dsh --profile open-design --models` probe cold-boots the whole
// harness through tsx/esbuild (Windows: ~9-13.5s solo, 30s+ when the web's
// agent polling runs several detections at once and the daemon's own tsx
// transform competes for CPU). Every /api/agents call would otherwise
// re-pay that wall clock, so cache a successful catalog per (bin, DSH_HOME)
// for a short TTL — the first scan is slow, every scan after it is instant.
const MODELS_CACHE_TTL_MS = 10 * 60_000;
const modelsCache = new Map<
  string,
  { at: number; models: NonNullable<ReturnType<typeof parseModels>> }
>();

export function hasOpenDesignProfile(env: NodeJS.ProcessEnv): boolean {
  return existsSync(path.join(resolveOpenDesignProfileDir(env), 'package.json'));
}

export function resolveOpenDesignProfileDir(env: NodeJS.ProcessEnv): string {
  const configuredHome = env.DSH_HOME?.trim();
  const dshHome = configuredHome
    ? path.resolve(configuredHome)
    : path.join(homedir(), '.dsh');
  return path.join(dshHome, 'profiles', 'open-design');
}

const DSH_VERSION_RE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

export function parseDeepSeekHarnessVersion(raw: string): string | null {
  return DSH_VERSION_RE.exec(raw.trim())?.[1] ?? null;
}

export const deepseekHarnessAgentDef = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  bin: 'dsh',
  versionArgs: ['--version'],
  // dsh boots via tsx (cold esbuild service worker) on every invocation.
  // `--version` is a shallow boot (~1-3s solo), but under parallel agent
  // detection load it stretches well past the 3s default — mirror Pi's
  // Windows cold-start bump so detection doesn't abort before models.
  versionProbeTimeoutMs: 15_000,
  fetchModels: async (resolvedBin, env) => {
    const cacheKey = `${resolvedBin}|${(env.DSH_HOME ?? '').trim()}`;
    const cached = modelsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < MODELS_CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const { stdout } = await execAgentFile(
        resolvedBin,
        ['--profile', 'open-design', '--models'],
        {
          env,
          // Windows cold start measured ~9-13.5s solo and 30s+ under
          // parallel detection load; 60s keeps the real catalog available.
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      const parsed = parseModels(String(stdout));
      if (!parsed || parsed.length === 0) return null;
      modelsCache.set(cacheKey, { at: Date.now(), models: parsed });
      return parsed;
    } catch {
      return null;
    }
  },
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: () => ['--profile', 'open-design', '--stdio'],
  promptViaStdin: true,
  streamFormat: 'dsh-profile-jsonl',
  capturesSessionIdFromStream: true,
  supportsCustomModel: false,
} satisfies RuntimeAgentDef;
