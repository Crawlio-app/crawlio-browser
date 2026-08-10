import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCodeModeTools } from "@/mcp-server/tools";
import { CrawlioClient } from "@/mcp-server/crawlio-client";
import { MAX_PHASE_HISTORY, MAX_PHASE_LABEL } from "@/shared/job-progress";

/**
 * End-to-end for reportPhase(): sandboxed code -> host-call channel -> job registry ->
 * get_job_result / list_jobs.
 *
 * The unit tests in job-progress.test.ts cover the folding logic in isolation. These drive the
 * real tools through the real Worker, because everything interesting here lives at the boundary:
 * whether a global exists inside the vm context, whether the channel is reachable, and whether an
 * advisory call can take a job down.
 */

function bridgeStub() {
  return {
    send: vi.fn(async (msg: { type: string }) => {
      switch (msg.type) {
        case "get_connection_status": return { connectedTab: { url: "" } };
        case "detect_framework": return { detections: [] };
        default: return { ok: true };
      }
    }),
    isConnected: true,
    push: vi.fn(),
  };
}

function tools() {
  const bridge = bridgeStub();
  const list = createCodeModeTools(bridge as never, new CrawlioClient("http://localhost:0"), {
    getActionPolicy: () => null,
  });
  const find = (n: string) => {
    const t = list.find((x) => x.name === n);
    if (!t) throw new Error(`${n} not registered`);
    return t;
  };
  return { execute: find("execute"), getJob: find("get_job_result"), listJobs: find("list_jobs"), cancel: find("cancel_job") };
}

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

/** Poll until `done(job)` or the budget runs out; returns the last job body seen. */
async function pollUntil(
  getJob: ReturnType<typeof tools>["getJob"],
  jobId: string,
  done: (j: Record<string, unknown>) => boolean,
  budgetMs = 8000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - started < budgetMs) {
    last = body(await getJob.handler({ jobId }) as never);
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

describe("reportPhase — sandbox to poller", () => {
  let t: ReturnType<typeof tools>;
  beforeEach(() => { t = tools(); });

  it("should expose reportPhase to sandboxed code", async () => {
    const r = await t.execute.handler({ code: "return typeof reportPhase" });
    expect(r.isError).toBe(false);
    expect(body(r as never)).toBe("function");
  });

  it("should surface the reported phase to a poller while the job runs", async () => {
    const started = await t.execute.handler({
      background: true,
      code: `
        await reportPhase("crawling", 25);
        await sleep(400);
        return "finished";
      `,
    });
    const { jobId } = body(started as never);

    const running = await pollUntil(t.getJob, jobId, (j) => j.phase === "crawling");
    expect(running.phase).toBe("crawling");
    expect(running.percent).toBe(25);
    expect(running.status).toBe("running");

    const finished = await pollUntil(t.getJob, jobId, (j) => j.status === "done");
    expect(finished.status).toBe("done");
    expect(finished.value).toBe("finished");
  });

  it("should advance the phase as the job moves through it", async () => {
    const started = await t.execute.handler({
      background: true,
      code: `
        await reportPhase("one", 10);
        await sleep(200);
        await reportPhase("two", 60);
        await sleep(400);
        return "ok";
      `,
    });
    const { jobId } = body(started as never);

    const first = await pollUntil(t.getJob, jobId, (j) => j.phase === "one");
    expect(first.percent).toBe(10);
    const second = await pollUntil(t.getJob, jobId, (j) => j.phase === "two");
    expect(second.percent).toBe(60);
  });

  it("should carry a timeline while running and drop it once done", async () => {
    // Running: the poller wants shape. Done: the value is the answer and the history is noise
    // in the response the model reads.
    const started = await t.execute.handler({
      background: true,
      code: `
        for (const p of ["a", "b", "c"]) { await reportPhase(p); await sleep(60); }
        await sleep(300);
        return "ok";
      `,
    });
    const { jobId } = body(started as never);

    const mid = await pollUntil(t.getJob, jobId, (j) => Array.isArray(j.phases) && (j.phases as unknown[]).length >= 2);
    expect(Array.isArray(mid.phases)).toBe(true);
    expect((mid.phases as Array<{ phase: string }>).map((p) => p.phase)).toContain("a");

    const done = await pollUntil(t.getJob, jobId, (j) => j.status === "done");
    expect(done.status).toBe("done");
    expect(done.phases).toBeUndefined();
    expect(done.phase).toBe("c"); // the last phase it reached is still useful
  });

  it("should show the phase in list_jobs too", async () => {
    const started = await t.execute.handler({
      background: true,
      code: `await reportPhase("indexing", 80); await sleep(500); return 1;`,
    });
    const { jobId } = body(started as never);
    await pollUntil(t.getJob, jobId, (j) => j.phase === "indexing");

    const listed = body(await t.listJobs.handler({}) as never) as { jobs: Array<Record<string, unknown>> };
    const mine = listed.jobs.find((j) => j.jobId === jobId);
    expect(mine?.phase).toBe("indexing");
    expect(mine?.percent).toBe(80);
  });

  it("should omit phase entirely for a job that never reports one", async () => {
    // Every existing caller is this case; their response shape must not change.
    const started = await t.execute.handler({ background: true, code: `await sleep(50); return "quiet";` });
    const { jobId } = body(started as never);
    const done = await pollUntil(t.getJob, jobId, (j) => j.status === "done");
    expect(done).not.toHaveProperty("phase");
    expect(done).not.toHaveProperty("percent");
    expect(done).not.toHaveProperty("phases");
    expect(done.value).toBe("quiet");
  });

  describe("an advisory channel must never take the job down", () => {
    it("should complete a job that reports junk", async () => {
      const started = await t.execute.handler({
        background: true,
        code: `
          await reportPhase();
          await reportPhase(null);
          await reportPhase(123, "not a number");
          await reportPhase({ nested: true }, NaN);
          await reportPhase("");
          return "survived";
        `,
      });
      const { jobId } = body(started as never);
      const done = await pollUntil(t.getJob, jobId, (j) => j.status === "done");
      expect(done.status).toBe("done");
      expect(done.value).toBe("survived");
      expect(done).not.toHaveProperty("phase"); // nothing usable was reported
    });

    it("should complete a job that reports a huge label", async () => {
      const started = await t.execute.handler({
        background: true,
        code: `await reportPhase("x".repeat(100000), 50); return "survived";`,
      });
      const { jobId } = body(started as never);
      const done = await pollUntil(t.getJob, jobId, (j) => j.status === "done");
      expect(done.status).toBe("done");
      expect((done.phase as string).length).toBeLessThanOrEqual(MAX_PHASE_LABEL);
    });

    it("should bound memory against a job that reports in a tight loop", async () => {
      const started = await t.execute.handler({
        background: true,
        code: `for (let i = 0; i < 500; i++) await reportPhase("p" + i, i % 100); return "survived";`,
      });
      const { jobId } = body(started as never);
      const done = await pollUntil(t.getJob, jobId, (j) => j.status === "done", 20000);
      expect(done.status).toBe("done");
      expect(done.phase).toBe("p499");
    }, 30000);
  });

  it("should keep the phase a cancelled job had reached", async () => {
    // Knowing where it was when you killed it is the point of having cancelled it.
    const started = await t.execute.handler({
      background: true,
      code: `await reportPhase("long-phase", 5); await sleep(30000); return "never";`,
    });
    const { jobId } = body(started as never);
    await pollUntil(t.getJob, jobId, (j) => j.phase === "long-phase");

    await t.cancel.handler({ jobId });
    const after = body(await t.getJob.handler({ jobId }) as never);
    expect(after.status).toBe("cancelled");
    expect(after.phase).toBe("long-phase");
  }, 15000);

  it("should keep the phase an errored job had reached", async () => {
    const started = await t.execute.handler({
      background: true,
      code: `await reportPhase("about-to-fail", 90); throw new Error("boom");`,
    });
    const { jobId } = body(started as never);
    const done = await pollUntil(t.getJob, jobId, (j) => j.status === "error");
    expect(done.status).toBe("error");
    expect(String(done.error)).toContain("boom");
    expect(done.phase).toBe("about-to-fail");
  });

  it("should keep jobs' progress separate when several run at once", async () => {
    const mk = async (label: string) => {
      const s = await t.execute.handler({
        background: true,
        code: `await reportPhase(${JSON.stringify(label)}, 50); await sleep(600); return ${JSON.stringify(label)};`,
      });
      return body(s as never).jobId as string;
    };
    const [a, b, c] = await Promise.all([mk("alpha"), mk("beta"), mk("gamma")]);

    const [ja, jb, jc] = await Promise.all([
      pollUntil(t.getJob, a, (j) => j.phase === "alpha"),
      pollUntil(t.getJob, b, (j) => j.phase === "beta"),
      pollUntil(t.getJob, c, (j) => j.phase === "gamma"),
    ]);
    expect([ja.phase, jb.phase, jc.phase]).toEqual(["alpha", "beta", "gamma"]);
  }, 20000);

  it("should not let a foreground run pay for progress it cannot poll", async () => {
    // No onProgress is wired for foreground execute; the call must still be harmless.
    const r = await t.execute.handler({ code: `await reportPhase("fg", 50); return "ok";` });
    expect(r.isError).toBe(false);
    expect(body(r as never)).toBe("ok");
  });

  it("should cap retained history regardless of how many phases were reported", async () => {
    const started = await t.execute.handler({
      background: true,
      code: `for (let i = 0; i < ${MAX_PHASE_HISTORY + 15}; i++) await reportPhase("p" + i); await sleep(400); return "ok";`,
    });
    const { jobId } = body(started as never);
    const mid = await pollUntil(
      t.getJob, jobId,
      (j) => Array.isArray(j.phases) && (j.phases as unknown[]).length >= MAX_PHASE_HISTORY,
    );
    expect((mid.phases as unknown[]).length).toBeLessThanOrEqual(MAX_PHASE_HISTORY);
  }, 20000);
});
