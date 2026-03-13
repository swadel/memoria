import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_CDP_PORT = 9333;

export class DesktopHarness {
  private appProcess: ChildProcessWithoutNullStreams | null = null;
  private browser: Browser | null = null;
  private appLogs = "";
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
    const appBinary = resolveAppBinary();
    if (!existsSync(appBinary)) {
      const cargo = resolveCargoBinary();
      const buildResult = spawnSync(cargo, ["build", "--manifest-path", "src-tauri/Cargo.toml"], {
        cwd: process.cwd(),
        env: withCargoInPath({ ...process.env }),
        shell: process.platform === "win32",
        stdio: "pipe",
        encoding: "utf-8"
      });
      if (buildResult.status !== 0) {
        throw new Error(`Desktop binary build failed: ${buildResult.stderr || buildResult.stdout}`);
      }
    }
    const result = spawnSync(
      appBinary,
      [
        "--seed-fixture",
        profile,
        "--media-root",
        this.mediaRoot,
        "--output-root",
        this.outputRoot
      ],
      {
        cwd: process.cwd(),
        env: withCargoInPath({
          ...process.env,
          MEMORIA_APP_DIR: this.appDir
        }),
        shell: false,
        stdio: "pipe",
        encoding: "utf-8"
      }
    );
    if (result.status !== 0) {
      throw new Error(`Fixture seeding failed: ${result.stderr || result.stdout}`);
    }
  }

  async launch(): Promise<Page> {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    this.appProcess = spawn(npmBin, ["run", "tauri", "dev"], {
      cwd: process.cwd(),
      shell: true,
      env: withCargoInPath({
        ...process.env,
        MEMORIA_APP_DIR: this.appDir,
        VITE_E2E_DISABLE_POLLING: "1",
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${this.cdpPort}`
      }),
      stdio: "pipe"
    });
    this.appLogs = "";
    this.appProcess.stdout.on("data", (chunk) => {
      this.appLogs += chunk.toString();
    });
    this.appProcess.stderr.on("data", (chunk) => {
      this.appLogs += chunk.toString();
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
    throw new Error(`Timed out waiting for WebView2 CDP endpoint.\n${this.appLogs.slice(-4000)}`);
  }
}

function resolveCargoBinary(): string {
  if (process.env.CARGO_BIN) {
    return process.env.CARGO_BIN;
  }
  if (process.platform === "win32") {
    const userProfile = process.env.USERPROFILE;
    if (userProfile) {
      return `${userProfile}\\.cargo\\bin\\cargo.exe`;
    }
  }
  return "cargo";
}

function resolveAppBinary(): string {
  if (process.env.MEMORIA_E2E_BIN) {
    return process.env.MEMORIA_E2E_BIN;
  }
  if (process.platform === "win32") {
    return join(process.cwd(), "src-tauri", "target", "debug", "memoria.exe");
  }
  return join(process.cwd(), "src-tauri", "target", "debug", "memoria");
}

function withCargoInPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return env;
  }
  const userProfile = env.USERPROFILE ?? process.env.USERPROFILE;
  const cargoBin = userProfile ? `${userProfile}\\.cargo\\bin` : null;
  if (!cargoBin) {
    return env;
  }
  const pathKey = "Path" in env ? "Path" : "PATH";
  const currentPath = env[pathKey] ?? "";
  if (currentPath.toLowerCase().includes(cargoBin.toLowerCase())) {
    return env;
  }
  return {
    ...env,
    [pathKey]: `${cargoBin};${currentPath}`
  };
}
