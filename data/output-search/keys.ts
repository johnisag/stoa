export const outputSearchKeys = {
  all: ["output-search"] as const,
  search: (query: string) => [...outputSearchKeys.all, query] as const,
};
