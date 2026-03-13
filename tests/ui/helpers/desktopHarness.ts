import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_CDP_PORT = 9333;

export class DesktopHarness {
  private appProcess: ChildProcessWithoutNullStreams | null = null;
  private browser: Browser | null = null;
  readonly appDir: string;
  readonly mediaRoot: string;
  readonly outputRoot: string;
  readonly cdpPort: number;

  constructor(cdpPort = DEFAULT_CDP_PORT) {
    const base = mkdtempSync(join(tmpdir(), "memoria-e2e-"));
    this.appDir = join(base, "appdata");
    this.mediaRoot = join(base, "media");
    this.outputRoot = join(base, "output");
    this.cdpPort = cdpPort;
  }

  seedFixture(profile: string) {
    const cargo = process.env.CARGO_BIN ?? (process.platform === "win32"
      ? `${process.env.USERPROFILE}\\.cargo\\bin\\cargo.exe`
      : "cargo");
    const result = spawnSync(
      cargo,
      [
        "run",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--",
        "--seed-fixture",
        profile,
        "--media-root",
        this.mediaRoot,
        "--output-root",
        this.outputRoot
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMORIA_APP_DIR: this.appDir
        },
        shell: process.platform === "win32",
        stdio: "pipe",
        encoding: "utf-8"
      }
    );
    if (result.status !== 0) {
      throw new Error(`Fixture seeding failed: ${result.stderr || result.stdout}`);
    }
  }

  async launch(): Promise<Page> {
    this.appProcess = spawn("npm", ["run", "tauri", "dev"], {
      cwd: process.cwd(),
      shell: true,
      env: {
        ...process.env,
        MEMORIA_APP_DIR: this.appDir,
        VITE_E2E_DISABLE_POLLING: "1",
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.cdpPort}`
      },
      stdio: "pipe"
    });

    await this.waitForCdp();
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext());

    for (let i = 0; i < 50; i += 1) {
      const page = context.pages()[0];
      if (page) {
        await page.bringToFront();
        return page;
      }
      await sleep(250);
    }
    throw new Error("Tauri window did not open in time.");
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.appProcess) {
      this.appProcess.kill();
      this.appProcess = null;
    }
  }

  private async waitForCdp() {
    for (let i = 0; i < 140; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`);
        if (response.ok) {
          return;
        }
      } catch {
        // keep retrying
      }
      await sleep(250);
    }
    throw new Error("Timed out waiting for WebView2 CDP endpoint.");
  }
}
