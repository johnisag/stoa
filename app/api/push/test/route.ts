import { NextResponse } from "next/server";
import { sendPushToAll, hasPushSubscriptions } from "@/lib/push";
import { actionsForKind } from "@/lib/notification-actions";

/**
 * POST /api/push/test — fire a known diagnostic Web Push to every subscription.
 *
 * Lets a user reproduce/confirm notification rendering ON DEMAND (instead of
 * waiting for a session to hit "waiting"): the body is a fixed English string
 * and it carries the same approve/reject/stop action buttons a real prompt push
 * does, so a single screenshot shows exactly how the toast — text AND buttons —
 * renders on the device. `test: true` tells the service worker to show it even
 * if a Stoa tab is open here.
 */
export async function POST() {
  if (!hasPushSubscriptions()) {
    return NextResponse.json(
      {
        error:
          'No push subscriptions. Turn on "Notify even when tab is closed" first.',
      },
      { status: 409 }
    );
  }
  await sendPushToAll({
    title: "Stoa test",
    body: "Test notification - if this reads as plain English, text is fine.",
    tag: "stoa-test",
    url: "/",
    test: true,
    actions: actionsForKind("waiting"),
  });
  return NextResponse.json({ success: true });
}
