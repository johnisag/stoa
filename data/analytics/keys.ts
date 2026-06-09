/** react-query cache keys for the analytics / Insight layer. */
export const analyticsKeys = {
  all: ["analytics"] as const,
  report: (windowDays: number) =>
    [...analyticsKeys.all, "report", windowDays] as const,
};
