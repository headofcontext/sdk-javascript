import { beforeEach, describe, expect, it } from "vitest";

import { ActionDenied, ApprovalPending, HeadOfContext, scope, ToolGuard } from "../../src/index.js";
import { DECISION, FakeService } from "./fake-service.js";

let service: FakeService;
let client: HeadOfContext;

beforeEach(() => {
  service = new FakeService();
  client = new HeadOfContext("http://hoc.test", { agentToken: "t", fetch: service.fetch });
});

const denied = {
  decision: { ...DECISION, outcome: "DENY", reason: "not_related" },
  approval: null,
};
const pending = {
  decision: { ...DECISION, outcome: "REQUIRE_APPROVAL", reason: "approval_required" },
  approval: {
    request_id: "req-9",
    subject: "user:alice",
    actor: "agent:assistant",
    tool: "tool:mail.send",
    status: "pending",
    created_at: null,
    expires_at: null,
  },
};

describe("ToolGuard", () => {
  it("gates the mapped resource with the exact arguments, then runs the tool", async () => {
    const session = await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    const guard = new ToolGuard(session, { toolMap: { send_mail: "mail.send" } });
    const sendMail = guard.wrap("send_mail", async ({ to }: { to: string }) => `sent to ${to}`);
    expect(await sendMail({ to: "bob" })).toBe("sent to bob");
    expect(service.requests.at(-1)?.body).toMatchObject({
      tool: "tool:mail.send",
      args: { to: "bob" },
    });
  });

  it("returns the refusal message on DENY and on REQUIRE_APPROVAL", async () => {
    const session = await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    let ran = 0;
    const guard = new ToolGuard(session);
    const exportHr = guard.wrap("hr.export", ({ year }: { year: number }) => {
      ran += 1;
      return `exported ${year}`;
    });

    service.responses.set("/v1/actions/gate", [200, denied]);
    const out = await exportHr({ year: 2026 });
    expect(out).toBe("HeadOfContext denied tool 'hr.export': not_related. Do not retry.");

    service.responses.set("/v1/actions/gate", [200, pending]);
    expect(await exportHr({ year: 2026 })).toBe(
      "HeadOfContext: tool 'hr.export' requires approval (request req-9). Do not retry until it is approved.",
    );
    expect(ran).toBe(0);
  });

  it("throws typed errors with onDeny: throw", async () => {
    const session = await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    const guard = new ToolGuard(session, { onDeny: "throw" });
    const tool = guard.wrap("tool:hr.export", async () => "never");

    service.responses.set("/v1/actions/gate", [200, denied]);
    await expect(tool({})).rejects.toBeInstanceOf(ActionDenied);

    service.responses.set("/v1/actions/gate", [200, pending]);
    const thrown = (await tool({}).catch((e: unknown) => e)) as ApprovalPending;
    expect(thrown).toBeInstanceOf(ApprovalPending);
    expect(thrown.requestId).toBe("req-9");
  });

  it("service failures are not turned into refusal messages", async () => {
    const session = await client.issue("user-jwt", scope({ act: ["tool:*"] }));
    const guard = new ToolGuard(session);
    service.responses.set("/v1/actions/gate", [
      503,
      { reason: "engine_unavailable", detail: "down" },
    ]);
    await expect(guard.wrap("x", async () => "never")({})).rejects.toMatchObject({
      reason: "engine_unavailable",
    });
  });
});
