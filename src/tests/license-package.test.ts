import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assertEqual, assertTrue, suite } from "./harness";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const AGPL_SHA256 = "8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef";
const PRESERVED_LICENSES = {
  "THIRD_PARTY_LICENSES/GPL-3.0.txt": "bacde7ad832868ab28781ff5f0eaeab78f87d465d979275851f575768f4c2e25",
  "THIRD_PARTY_LICENSES/human-writing-MIT.txt": "32ca81a9ae10dda7d18963c9eae733477073906b15ee498d02033c8966dbdcaa",
  "THIRD_PARTY_LICENSES/rico-md-MIT.txt": "229a213cada668b326c65d242892626f0e7d3575deaa19963baff22a13e9a1c1",
  "THIRD_PARTY_LICENSES/WeDraft-MIT.txt": "00e5119c0c27aae2620634ed97e5a9f79510521498010d9074c582f777e97398",
  "THIRD_PARTY_LICENSES/gaotai-longform-MIT.txt": "63b8a987ab431fdd296339ef0870eeed103c3f46172f90835796574df5e4e356",
} as const;
const BUNDLED_LICENSES = [
  "LICENSE",
  "NOTICE.txt",
  "SOURCE.txt",
  ...Object.keys(PRESERVED_LICENSES),
] as const;

function read(relativePath: string) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function sha256(content: string | Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedHash(relativePath: string) {
  return sha256(read(relativePath).replace(/\r\n/g, "\n"));
}

function runPackageVerifier(outputDir: string) {
  return spawnSync(process.execPath, ["scripts/verify-package.mjs", outputDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

suite("许可与打包契约", ({ test }) => {
  test("根 LICENSE 是规范 LF AGPL-3.0 原文", () => {
    const license = read("LICENSE");
    assertEqual(sha256(license), AGPL_SHA256);
    assertTrue(license.startsWith("                    GNU AFFERO GENERAL PUBLIC LICENSE\n"));
    assertTrue(!license.includes("\r"));
  });

  test("GPL 与 MIT 组件许可原文保持不变", () => {
    for (const [relativePath, expectedHash] of Object.entries(PRESERVED_LICENSES)) {
      assertEqual(normalizedHash(relativePath), expectedHash, relativePath);
    }
    assertEqual(
      normalizedHash("resources/skills/human-writing/LICENSE"),
      normalizedHash("THIRD_PARTY_LICENSES/human-writing-MIT.txt"),
    );
    assertEqual(
      normalizedHash("resources/layout-packs/LICENSE-rico-md"),
      normalizedHash("THIRD_PARTY_LICENSES/rico-md-MIT.txt"),
    );
    assertEqual(
      normalizedHash("resources/layout-packs/LICENSE-wedraft"),
      normalizedHash("THIRD_PARTY_LICENSES/WeDraft-MIT.txt"),
    );
    assertEqual(
      normalizedHash("resources/skills/gaotai-longform/LICENSE"),
      normalizedHash("THIRD_PARTY_LICENSES/gaotai-longform-MIT.txt"),
    );
  });

  test("当前声明明确 AGPL 主体与 GPL 组件边界", () => {
    const notice = read("NOTICE.txt");
    const source = read("SOURCE.txt");
    const readme = read("README.md");
    for (const text of [notice, source, readme]) {
      assertTrue(text.includes("AGPL-3.0-only"));
      assertTrue(text.includes("Wechatsync"));
      assertTrue(text.includes("GPL-3.0"));
    }
    assertTrue(notice.includes("human-writing"));
    assertTrue(notice.includes("rico-md"));
    assertTrue(notice.includes("WeDraft"));
    assertTrue(notice.includes("MIT"));
    assertTrue(!notice.includes("主体以**专有许可**"));
  });

  test("npm 根元数据使用 AGPL-3.0-only", () => {
    const manifest = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    assertEqual(manifest.license, "AGPL-3.0-only");
    assertEqual(lock.packages[""].license, "AGPL-3.0-only");
  });

  test("electron-builder 随包携带全部许可声明", () => {
    const config = parse(read("electron-builder.yml"));
    const resources = config.extraResources.map((entry: { from: string }) => entry.from);
    for (const required of ["LICENSE", "NOTICE.txt", "SOURCE.txt", "THIRD_PARTY_LICENSES"]) {
      assertTrue(resources.includes(required), `缺少 extraResources: ${required}`);
    }
  });

  test("verify-package 拒绝缺少许可文件的安装包", () => {
    mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
    const outputDir = mkdtempSync(path.join(ROOT, ".tmp", "license-package-"));
    try {
      mkdirSync(path.join(outputDir, "win-unpacked"), { recursive: true });
      const result = runPackageVerifier(path.relative(ROOT, outputDir));
      assertEqual(result.status, 1, result.stderr);
      assertTrue(result.stderr.includes("LICENSE"), result.stderr);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("verify-package 接受许可文件齐全的安装包", () => {
    mkdirSync(path.join(ROOT, ".tmp"), { recursive: true });
    const outputDir = mkdtempSync(path.join(ROOT, ".tmp", "license-package-"));
    try {
      const appDir = path.join(outputDir, "win-unpacked");
      for (const relativePath of BUNDLED_LICENSES) {
        const target = path.join(appDir, "resources", relativePath);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(path.join(ROOT, relativePath), target);
      }
      const result = runPackageVerifier(path.relative(ROOT, outputDir));
      assertEqual(result.status, 0, result.stderr);
      assertTrue(result.stdout.includes("通过"), result.stdout);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
