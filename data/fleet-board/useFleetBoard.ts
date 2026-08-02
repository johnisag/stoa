"use client";

import { useCallback, useMemo } from "react";
import { useInbox } from "@/data/verdict-inbox/queries";
import {
  useBoardQuery,
  usePendingQuery,
  useDispatchReposQuery,
} from "@/data/dispatch/queries";
import {
  composeFleetCards,
  bucketByLane,
  cardNeedsMe,
} from "@/lib/fleet-board/lanes";
import { useFleetRunsQuery } from "@/data/fleet/queries";
import { useElicitations } from "@/data/mcp-elicitations/queries";

/**
 * The fleet board's data: composes the existing verdict inbox, dispatch board,
 * pending backlog, and durable Fleet Management list into six lifecycle lanes.
 * Reuses the inbox's normalization so verdict-driven attention stays identical.
 * These read models already poll while open; there is no dispatch/ceremony WS
 * push, so the board does not pretend otherwise.
 */
export function useFleetBoard(open: boolean) {
  const inbox = useInbox(open);
  const board = useBoardQuery(open);
  const pending = usePendingQuery(open);
  const repos = useDispatchReposQuery(open);
  const fleetRuns = useFleetRunsQuery(open);
  const elicitations = useElicitations(open);

  const lanes = useMemo(
    () =>
      bucketByLane(
        composeFleetCards(
          board.data ?? [],
          pending.data ?? [],
          inbox.data ?? [],
          fleetRuns.data ?? []
        )
      ),
    [board.data, pending.data, inbox.data, fleetRuns.data]
  );

  const repoById = useMemo(
    () => new Map((repos.data ?? []).map((r) => [r.id, r])),
    [repos.data]
  );

  const total = useMemo(
    () => Object.values(lanes).reduce((n, cards) => n + cards.length, 0),
    [lanes]
  );

  // Count composed attention cards, not underlying signals. One Fleet run
  // contributes one card even when several of its tasks/workers need help; its
  // card exposes that per-run signal count. Pending elicitations are separate
  // operator-attention items surfaced above the lanes, matching the nav badge.
  const boardNeedsMeCount = useMemo(
    () =>
      Object.values(lanes).reduce(
        (count, cards) => count + cards.filter(cardNeedsMe).length,
        0
      ),
    [lanes]
  );
  const elicitationCount = elicitations.data?.length ?? 0;
  const needsMeCount = boardNeedsMeCount + elicitationCount;

  return {
    lanes,
    repoById,
    total,
    needsMeCount,
    elicitationCount,
    elicitationError: elicitations.isError,
    elicitationFetching: elicitations.isFetching,
    fleetError: fleetRuns.isError,
    fleetFetching: fleetRuns.isFetching,
    isLoading:
      inbox.isLoading ||
      board.isLoading ||
      pending.isLoading ||
      repos.isLoading,
    isError: inbox.isError || board.isError || pending.isError || repos.isError,
    isFetching:
      inbox.isFetching ||
      board.isFetching ||
      pending.isFetching ||
      repos.isFetching,
    refetchFleetRuns: useCallback(() => {
      void fleetRuns.refetch();
    }, [fleetRuns.refetch]),
    refetchElicitations: useCallback(() => {
      void elicitations.refetch();
    }, [elicitations.refetch]),
    // Re-fetch every read model behind the board on a manual Retry.
    refetch: useCallback(() => {
      void inbox.refetch();
      void board.refetch();
      void pending.refetch();
      void repos.refetch();
      void fleetRuns.refetch();
      void elicitations.refetch();
    }, [
      inbox.refetch,
      board.refetch,
      pending.refetch,
      repos.refetch,
      fleetRuns.refetch,
      elicitations.refetch,
    ]),
  };
}
