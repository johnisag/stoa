export const fleetKeys = {
  all: ["fleet"] as const,
  runs: () => [...fleetKeys.all, "runs"] as const,
  run: (id: string) => [...fleetKeys.all, "runs", id] as const,
};
