/**
 * Tests for local runtime process supervision.
 */
import { describe, expect, it } from "bun:test";
import { RuntimeSupervisor } from "./runtime-supervisor.js";

const nodeCommand = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;

describe("RuntimeSupervisor", () => {
  it("waits for a process to exit before allowing a clean restart", async () => {
    const supervisor = new RuntimeSupervisor();
    const first = supervisor.start("hermes", nodeCommand, "http://localhost:8645");
    expect(first.running).toBe(true);
    expect(typeof first.pid).toBe("number");

    const stopped = await supervisor.stopAndWait("hermes", "SIGTERM", 2000);
    expect(stopped.running).toBe(false);
    expect(stopped.pid).toBeNull();

    const second = supervisor.start("hermes", nodeCommand, "http://localhost:8645");
    expect(second.running).toBe(true);
    expect(typeof second.pid).toBe("number");
    expect(second.pid).not.toBe(first.pid);

    const stoppedAgain = await supervisor.stopAndWait("hermes", "SIGTERM", 2000);
    expect(stoppedAgain.running).toBe(false);
  });
});
