import { runHybrid } from "./backend/hybrid.mjs";
const run = document.querySelector("#run"),
  cancel = document.querySelector("#cancel");
const status = document.querySelector('[role="status"]'),
  stdout = document.querySelector("#stdout"),
  details = document.querySelector("#details");
let controller;
cancel.addEventListener("click", () => controller?.abort());
run.addEventListener("click", async () => {
  controller = new AbortController();
  run.disabled = true;
  cancel.disabled = false;
  stdout.textContent = "";
  details.textContent = "";
  status.textContent = "Running";
  try {
    const responses = await Promise.all(
      ["program.json", "host.wasm"].map((path) =>
        fetch(path, { signal: controller.signal }),
      ),
    );
    for (const response of responses)
      if (!response.ok)
        throw new Error(`Cannot load program: HTTP ${response.status}`);
    const result = await runHybrid(
      await responses[0].json(),
      await responses[1].arrayBuffer(),
      {
        signal: controller.signal,
        io: {
          onOutput: (event) => {
            if (event.stream === "stdout") stdout.textContent += event.text;
          },
        },
      },
    );
    details.textContent = JSON.stringify(
      { ...result.stats, stderr: result.stderr, exitCode: result.exitCode },
      null,
      2,
    );
    status.textContent = result.exitCode
      ? `Exited (${result.exitCode})`
      : "Completed";
  } catch (error) {
    status.textContent = error.name === "AbortError" ? "Cancelled" : "Failed";
    details.textContent = error.message;
  } finally {
    run.disabled = false;
    cancel.disabled = true;
    controller = undefined;
  }
});
