import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import { loadEnvIntoProcess } from "../lib/bootstrap";

suite("运行时环境变量装载", ({ test }) => {
  test(".env 里的键被读进 process.env", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gaotai-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(
      file,
      ["# 注释行", "APP_PASSWORD=abc123", "SESSION_SECRET=deadbeef", "EMPTY=", "QUOTED=\"有 空格\"", ""].join("\n"),
      "utf8",
    );
    const before = { ...process.env };
    try {
      delete process.env.APP_PASSWORD;
      delete process.env.SESSION_SECRET;
      delete process.env.EMPTY;
      delete process.env.QUOTED;

      loadEnvIntoProcess(file);

      assertEqual(process.env.APP_PASSWORD, "abc123");
      assertEqual(process.env.SESSION_SECRET, "deadbeef");
      assertEqual(process.env.EMPTY, "");
      assertEqual(process.env.QUOTED, "有 空格");
    } finally {
      process.env = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("已存在的环境变量不被覆盖", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gaotai-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(file, "APP_PASSWORD=from-file\n", "utf8");
    const before = process.env.APP_PASSWORD;
    try {
      process.env.APP_PASSWORD = "from-shell";
      loadEnvIntoProcess(file);
      assertEqual(process.env.APP_PASSWORD, "from-shell");
    } finally {
      if (before === undefined) delete process.env.APP_PASSWORD;
      else process.env.APP_PASSWORD = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件不存在时静默返回，不抛错", () => {
    let threw = false;
    try {
      loadEnvIntoProcess(path.join(tmpdir(), "gaotai-does-not-exist", ".env"));
    } catch {
      threw = true;
    }
    assertTrue(!threw);
  });
});
