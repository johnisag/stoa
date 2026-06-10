// React-query cache keys for the Verdict Inbox (fleet review queue).
export const inboxKeys = {
  all: ["verdict-inbox"] as const,
  list: () => [...inboxKeys.all, "list"] as const,
  findings: (type: string, id: string) =>
    [...inboxKeys.all, "findings", type, id] as const,
};
