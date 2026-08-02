import { describe, expect, it } from "vitest";
import { fleetDeliveryTaskForContainer } from "@/lib/orchestration";

describe("Fleet host/container artifact contract", () => {
  it.each([
    {
      name: "POSIX",
      home: "/home/u",
      stoaHome: "/srv/stoa-custom",
      attemptRoot: "/srv/stoa-custom/fleet/run/task/1",
      hostPath: "/srv/stoa-custom/fleet/run/task/1/report.json",
      containerPath: "/root/stoa-custom/fleet/run/task/1/report.json",
    },
    {
      name: "Windows",
      home: "C:\\Users\\u",
      stoaHome: "D:\\stoa-custom",
      attemptRoot: "D:\\stoa-custom\\fleet\\run\\task\\1",
      hostPath: "D:\\stoa-custom\\fleet\\run\\task\\1\\report.json",
      containerPath: "/root/stoa-custom/fleet/run/task/1/report.json",
    },
  ])(
    "delivers the container-visible $name path while retaining the host collector path",
    ({ home, stoaHome, attemptRoot, hostPath, containerPath }) => {
      const contract = { reportPath: hostPath };
      const hostPrompt = `Exact report path: ${contract.reportPath}`;
      const delivered = fleetDeliveryTaskForContainer(
        hostPrompt,
        [contract.reportPath],
        [attemptRoot],
        stoaHome,
        home
      );

      expect(delivered).toBe(`Exact report path: ${containerPath}`);
      expect(delivered).not.toContain(hostPath);
      // The durable contract consumed by the host collector is never rewritten.
      expect(contract.reportPath).toBe(hostPath);
    }
  );

  it("fails closed rather than naming an artifact outside the mounted state root", () => {
    expect(() =>
      fleetDeliveryTaskForContainer(
        "Exact report path: /tmp/foreign.json",
        ["/tmp/foreign.json"],
        ["/srv/stoa/fleet/run/task/1"],
        "/srv/stoa",
        "/home/u"
      )
    ).toThrow(/outside the mounted Fleet attempt directories/);
  });

  it("requires an artifact file beneath, not equal to, the attempt directory", () => {
    const attemptRoot = "/srv/stoa/fleet/run/task/1";
    expect(() =>
      fleetDeliveryTaskForContainer(
        `Exact report path: ${attemptRoot}`,
        [attemptRoot],
        [attemptRoot],
        "/srv/stoa",
        "/home/u"
      )
    ).toThrow(/outside the mounted Fleet attempt directories/);
  });
});
