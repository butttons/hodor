import { describe, it, expect, vi } from "vitest";
import { auditAdminCall, auditProxyCall, requestMeta } from "@/lib/analytics";

function mockDataset() {
  const points: unknown[] = [];
  return {
    points,
    binding: {
      writeDataPoint: (p: unknown) => void points.push(p),
    } as unknown as AnalyticsEngineDataset,
  };
}

describe("auditProxyCall()", () => {
  it("writes the fixed traffic layout", async () => {
    const { points, binding } = mockDataset();
    await auditProxyCall({
      analytics: binding,
      event: {
        itemId: "axiom",
        keyJti: "j1",
        keyName: "k",
        method: "POST",
        path: "/v1/x",
        status: 200,
        durationMs: 12,
      },
    });
    expect(points).toEqual([
      {
        indexes: ["axiom:j1"],
        doubles: [200, 12, 2],
        blobs: ["axiom", "j1", "k", "POST", "/v1/x", "200", "", ""],
      },
    ]);
  });

  it("stamps ip + user agent when provided", async () => {
    const { points, binding } = mockDataset();
    await auditProxyCall({
      analytics: binding,
      event: {
        itemId: "slack",
        keyJti: "j2",
        keyName: "bot",
        method: "GET",
        path: "/auth.test",
        status: 200,
        durationMs: 3,
        ip: "1.2.3.4",
        userAgent: "curl/8.0",
      },
    });
    expect((points[0] as { blobs: string[] }).blobs.slice(6)).toEqual(["1.2.3.4", "curl/8.0"]);
  });

  it("requestMeta prefers cf-connecting-ip, falls back to forwarded-for", () => {
    const h = (m: Record<string, string>) => (name: string) => m[name.toLowerCase()];
    expect(
      requestMeta({
        header: h({
          "cf-connecting-ip": "9.9.9.9",
          "x-forwarded-for": "1.1.1.1, 2.2.2.2",
          "user-agent": "pi/1.0",
        }),
      }),
    ).toEqual({ ip: "9.9.9.9", userAgent: "pi/1.0" });
    expect(requestMeta({ header: h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }) })).toEqual({
      ip: "1.1.1.1",
      userAgent: "",
    });
    expect(requestMeta({ header: h({}) })).toEqual({ ip: "", userAgent: "" });
  });

  it("no-ops without a binding", async () => {
    await auditProxyCall({
      analytics: undefined,
      event: {
        itemId: "x",
        keyJti: "",
        keyName: "",
        method: "GET",
        path: "/",
        status: 200,
        durationMs: 1,
      },
    });
  });
});

describe("auditAdminCall()", () => {
  it("writes the fixed audit layout", async () => {
    const { points, binding } = mockDataset();
    await auditAdminCall({
      analytics: binding,
      event: {
        keyJti: "j9",
        keyName: "admin",
        method: "PUT",
        path: "/_/admin/registry",
        status: 204,
        detail: "",
      },
    });
    expect(points).toEqual([
      {
        indexes: ["j9"],
        doubles: [204],
        blobs: ["/_/admin/registry", "PUT", "admin", "", "204", "", ""],
      },
    ]);
  });

  it("carries mint detail", async () => {
    const { points, binding } = mockDataset();
    await auditAdminCall({
      analytics: binding,
      event: {
        keyJti: "",
        keyName: "",
        method: "POST",
        path: "/_/keys",
        status: 201,
        detail: "zm-paseo",
      },
    });
    expect(points).toHaveLength(1);
    expect((points[0] as { blobs: string[] }).blobs[3]).toBe("zm-paseo");
  });

  it("no-ops without a binding", async () => {
    await auditAdminCall({
      analytics: undefined,
      event: { keyJti: "", keyName: "", method: "DELETE", path: "/x", status: 204 },
    });
  });
});
