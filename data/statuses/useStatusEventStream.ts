"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionStatus } from "@/components/views/types";
import { statusKeys } from "../sessions/keys";

interface StatusResponse {
  statuses: Record<string, SessionStatus>;
}

interface StatusDelta {
  id: string;
  name: string;
  status: SessionStatus["status"];
  lastLine: string;
}

/**
 * Subscribe to the server's /ws/events channel and merge pushed status deltas
 * into the SAME react-query cache the 5s poll fills — so the board reflects
 * transitions (and live preview lines) instantly. Purely additive: the poll
 * still runs as a backstop, so a dropped socket or missed frame self-heals, and
 * a closed socket reconnects after a short delay.
 */
export function useStatusEventStream() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof window === "undefined") return;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws/events`);

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type !== "status" || !Array.isArray(msg.deltas)) return;
          queryClient.setQueryData<StatusResponse>(statusKeys.all, (old) => {
            const statuses = { ...(old?.statuses ?? {}) };
            for (const d of msg.deltas as StatusDelta[]) {
              statuses[d.id] = {
                sessionName: d.name,
                status: d.status,
                lastLine: d.lastLine,
                claudeSessionId: statuses[d.id]?.claudeSessionId ?? null,
              };
            }
            return { statuses };
          });
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        if (closed) return;
        reconnect = setTimeout(connect, 3000); // poll backstops the gap
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, [queryClient]);
}
