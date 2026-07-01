/** React-query keys for Playbooks (#13). */
export const playbookKeys = {
  all: ["playbooks"] as const,
  list: (projectId: string | null) =>
    [...playbookKeys.all, "list", projectId] as const,
};
