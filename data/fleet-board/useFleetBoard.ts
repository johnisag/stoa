"use client";

import { useMemo } from "react";
import { useInbox } from "@/data/verdict-inbox/queries";
import {
  useBoardQuery,
  usePendingQuery,
  useDispatchReposQuery,
} from "@/data/dispatch/queries";
import { composeFleetCards, bucketByLane } from "@/lib/fleet-board/lanes";
import { countNeedsMe } from "@/lib/verdict-inbox-selectors";

/**
 * The fleet board's data: composes the three EXISTING read models (verdict inbox +
 * dispatch board + pending backlog) into the six lifecycle lanes. Reuses the
 * inbox's normalization so the board stays verdict-identical with it. All three
 * already poll while open (5–8s), which is the board's live-refresh — there is no
 * dispatch/ceremony WS push, so we don't pretend otherwise.
 */
export function useFleetBoard(open: boolean) {
  const inbox = useInbox(open);
  const board = useBoardQuery(open);
  const pending = usePendingQuery(open);
  const repos = useDispatchReposQuery(open);

  const lanes = useMemo(
    () =>
      bucketByLane(
        composeFleetCards(
          board.data ?? [],
          pending.data ?? [],
          inbox.data ?? []
        )
      ),
    [board.data, pending.data, inbox.data]
  );

  const repoById = useMemo(
    () => new Map((repos.data ?? []).map((r) => [r.id, r])),
    [repos.data]
  );

  const total = useMemo(
    () => Object.values(lanes).reduce((n, cards) => n + cards.length, 0),
    [lanes]
  );

  // The board's "needs me" count, derived from the SAME inbox + `needsMe` selector
  // the nav badge uses — so the ambient badge and the board's header pill always
  // agree (the badge can't say "3" while the board it opens reads "1").
  const needsMeCount = useMemo(
    () => countNeedsMe(inbox.data ?? []),
    [inbox.data]
  );

  return {
    lanes,
    repoById,
    total,
    needsMeCount,
    isLoading: inbox.isLoading || board.isLoading || pending.isLoading,
    isError: inbox.isError || board.isError || pending.isError,
    isFetching:
      inbox.isFetching ||
      board.isFetching ||
      pending.isFetching ||
      repos.isFetching,
    // Re-fetch every read model behind the board on a manual Retry.
    refetch: () => {
      void inbox.refetch();
      void board.refetch();
      void pending.refetch();
      void repos.refetch();
    },
  };
}
