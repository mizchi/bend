import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/webgpu",
  testMatch: "**/*.spec.mjs",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    launchOptions: { args: ["--enable-gpu"] },
  },
  webServer: {
    command: "just build-webgpu-browser && python3 -m http.server 4174 --bind 127.0.0.1 --directory build/webgpu",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
  },
});
