import { useQuery } from "@tanstack/react-query";

interface WebhookStatus {
  configured: boolean;
}

async function fetchWebhookStatus(): Promise<WebhookStatus> {
  const res = await fetch("/api/webhooks/status");
  if (!res.ok) throw new Error("Failed to fetch webhook status");
  return (await res.json()) as WebhookStatus;
}

/**
 * Whether STOA_WEBHOOK_SECRET is set on the server.
 * Only enabled while the panel is visible (avoids a background poll).
 */
export function useWebhookStatus(enabled = true) {
  return useQuery({
    queryKey: ["webhooks", "status"],
    queryFn: fetchWebhookStatus,
    enabled,
    staleTime: 30_000,
  });
}
