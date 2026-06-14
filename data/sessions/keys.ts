export const sessionKeys = {
  all: ["sessions"] as const,
  list: () => [...sessionKeys.all, "list"] as const,
  ceremony: (id: string) => [...sessionKeys.all, "ceremony", id] as const,
  digest: (id: string) => [...sessionKeys.all, "digest", id] as const,
};

export const statusKeys = {
  all: ["session-statuses"] as const,
};
