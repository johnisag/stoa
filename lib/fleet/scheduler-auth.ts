import { timingSafeEqual } from "crypto";

export function hasFleetSchedulerIdentity(
  presentedToken: string | null,
  expectedToken: string | undefined = process.env.STOA_FLEET_SCHEDULER_TOKEN
): boolean {
  const presented = presentedToken?.trim();
  const expected = expectedToken?.trim();
  if (!presented || !expected) return false;
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return (
    presentedBytes.length === expectedBytes.length &&
    timingSafeEqual(presentedBytes, expectedBytes)
  );
}
