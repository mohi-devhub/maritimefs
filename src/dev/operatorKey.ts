/** Development tools only. Never imported by the extension or persisted to disk. */
export function operatorKey(environment: Record<string, string | undefined>): string | undefined {
  const explicit = environment.MARITIME_API_KEY ?? environment.MARITIME_TOKEN;
  if (explicit) return explicit;
  const candidates = [
    ...new Set(Object.values(environment).filter((value) => value?.startsWith('mk_'))),
  ];
  return candidates.length === 1 ? candidates[0] : undefined;
}
