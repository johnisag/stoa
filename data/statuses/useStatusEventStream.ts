"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionStatus } from "@/components/views/types";
import { statusKeys } from "../sessions/keys";
import { reconnectBaseDelay } from "./reconnect-delay";

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
    let attempt = 0;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws/events`);

      ws.onopen = () => {
        attempt = 0; // a successful connect resets the backoff
      };

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
        // Exponential backoff with jitter (poll backstops the gap meanwhile), so
        // a downed server isn't hammered every 3s.
        const base = reconnectBaseDelay(attempt++);
        const delay = base / 2 + Math.random() * (base / 2);
        reconnect = setTimeout(connect, delay);
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
