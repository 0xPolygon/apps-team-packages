import type { Configuration } from 'markdownlint';

export const baseIgnores: readonly string[] = [
  '**/node_modules/**',
  '**/.claude/**',
  '**/CHANGELOG.md'
];

const baseConfig: Configuration = {
  default: true,
  MD013: false,
  MD041: false,
  MD024: { siblings_only: true },
  MD060: false
};

export function markdownlint(options?: { config?: Configuration; ignores?: string[] }) {
  return {
    config: { ...baseConfig, ...options?.config },
    ignores: options?.ignores ?? [...baseIgnores]
  };
}
