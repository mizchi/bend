import { runProgram } from "./backend/runtime.mjs";

const button = document.querySelector("#run");
const status = document.querySelector('[role="status"]');
const stdout = document.querySelector("#stdout");
const details = document.querySelector("#details");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Running";
  stdout.textContent = "";
  details.textContent = "";
  try {
    const response = await fetch("./program.json");
    if (!response.ok)
      throw new Error(`Cannot load program: HTTP ${response.status}`);
    const result = await runProgram(await response.json());
    stdout.textContent = result.output.length
      ? result.output
          .filter((event) => event.stream === "stdout")
          .map((event) => event.text)
          .join("")
      : result.stdout.join("\n");
    details.textContent =
      `${result.stats.tasks} tasks, ${result.stats.rounds} rounds\n` +
      JSON.stringify(
        { ...result.adapter, stderr: result.stderr, exitCode: result.exitCode },
        null,
        2,
      );
    status.textContent = result.exitCode
      ? `Exited (${result.exitCode})`
      : "Completed";
  } catch (error) {
    status.textContent = "Failed";
    details.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
});
