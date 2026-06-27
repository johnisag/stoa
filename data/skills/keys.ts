// React-query cache keys for the per-provider slash commands ("skills", #8).
export const skillKeys = {
  all: ["skills"] as const,
  providers: () => [...skillKeys.all, "providers"] as const,
  list: (provider: string) => [...skillKeys.all, "list", provider] as const,
};
