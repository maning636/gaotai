import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import {
  getLicenseState,
  requireLicense,
  licenseSnapshot,
  resetLicenseCache,
} from "../lib/license/gate";
import { writeTokenCache, deleteTokenCache } from "../lib/license/store";
import { machineCacheFile } from "../lib/license/machine";
import { signToken } from "../lib/license/token";
import type { LicensePayload } from "../lib/license/types";

/**
 * 进程内授权门禁（协议 §7）。
 *
 * gate 用内置公钥验签，测试通过 GAOTAI_LICENSE_PUBKEY 注入临时生成的公钥，
 * 用对应私钥签真实 token。机器码通过写 machine 缓存文件注入（不跑 PowerShell）。
 * 每个用例用独立的临时数据目录，结束后清理 + 复原环境变量。
 */

// 生成一份密钥对，整个测试文件共用
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const MACHINE = "c".repeat(64);
const CODE = "GT-7F3K-9QW2-M4XB-8HZP";

/** 建临时数据目录，写好机器码缓存，注入公钥环境变量，返回目录路径。 */
function freshGateEnv(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gaotai-gate-"));
  process.env.GAOTAI_DATA_DIR = dir;
  // 写机器码缓存，避免 getMachineId 跑 PowerShell
  const cacheFile = machineCacheFile();
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, MACHINE, "utf8");
  // 注入测试公钥
  process.env.GAOTAI_LICENSE_PUBKEY = publicPem;
  // 确保不走 bypass
  delete process.env.GAOTAI_LICENSE_BYPASS;
  return dir;
}

/** 用例结束清理：删临时目录、复原环境变量、清进程内缓存。 */
function cleanupGateEnv(dir: string, prevData?: string): void {
  resetLicenseCache();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (prevData === undefined) delete process.env.GAOTAI_DATA_DIR;
  else process.env.GAOTAI_DATA_DIR = prevData;
  delete process.env.GAOTAI_LICENSE_PUBKEY;
  delete process.env.GAOTAI_LICENSE_BYPASS;
}

/** 签一份合法 token 并写成缓存。 */
async function writeValidCache(over: Partial<LicensePayload> = {}): Promise<void> {
  const now = Date.now();
  const payload: LicensePayload = {
    v: 1,
    code: CODE,
    machine: MACHINE,
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    features: ["core", "skills", "prompts"],
    plan: "free",
    ...over,
  };
  const token = signToken(payload, privatePem);
  await writeTokenCache({
    token,
    expiresAt: payload.expiresAt,
    machine: MACHINE,
    code: CODE,
    features: payload.features,
    plan: payload.plan,
  });
}

suite("授权门禁 - getLicenseState", ({ test }) => {
  test("无缓存 → missing", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      await deleteTokenCache();
      const state = await getLicenseState();
      assertEqual(state.status, "missing");
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("真实签名的缓存 → activated", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      await writeValidCache();
      const state = await getLicenseState();
      assertEqual(state.status, "activated");
      if (state.status === "activated") {
        assertEqual(state.code, CODE);
        assertEqual(state.machine, MACHINE);
        assertEqual(state.plan, "free");
        assertEqual(state.features, ["core", "skills", "prompts"]);
      }
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("缓存里 token 过期 → expired", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      // 禁用 refresh，避免 expired 触发联网刷新
      delete process.env.GAOTAI_LICENSE_SERVER;
      const past = Date.now() - 10_000;
      await writeValidCache({ issuedAt: past - 1000, expiresAt: past });
      // 写缓存时 expiresAt 要和 token 一致
      const token = signToken(
        { v: 1, code: CODE, machine: MACHINE, issuedAt: past - 1000, expiresAt: past, features: ["core"], plan: "free" },
        privatePem,
      );
      await writeTokenCache({
        token,
        expiresAt: past,
        machine: MACHINE,
        code: CODE,
        features: ["core"],
        plan: "free",
      });
      const state = await getLicenseState();
      assertEqual(state.status, "expired");
      if (state.status === "expired") {
        assertEqual(state.code, CODE);
        assertTrue(state.graceUntil > past, "应有宽限期");
      }
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("GAOTAI_LICENSE_BYPASS=1 → bypass", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      process.env.GAOTAI_LICENSE_BYPASS = "1";
      const state = await getLicenseState();
      assertEqual(state.status, "bypass");
      if (state.status === "bypass") {
        assertEqual(state.machine, MACHINE);
      }
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });
});

suite("授权门禁 - requireLicense", ({ test }) => {
  test("无缓存 → 返回 403 且 body 有 code:not_activated", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      await deleteTokenCache();
      const resp = await requireLicense();
      assertTrue(resp !== null, "未激活应返回 Response");
      if (resp) {
        assertEqual(resp.status, 403);
        const body = (await resp.json()) as { code?: string };
        assertEqual(body.code, "not_activated");
      }
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("已激活 → 返回 null（放行）", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      await writeValidCache();
      const resp = await requireLicense();
      assertEqual(resp, null, "已激活应放行返回 null");
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("缓存过期 → 仍然 403", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      delete process.env.GAOTAI_LICENSE_SERVER;
      const past = Date.now() - 10_000;
      const token = signToken(
        { v: 1, code: CODE, machine: MACHINE, issuedAt: past - 1000, expiresAt: past, features: ["core"], plan: "free" },
        privatePem,
      );
      await writeTokenCache({
        token,
        expiresAt: past,
        machine: MACHINE,
        code: CODE,
        features: ["core"],
        plan: "free",
      });
      const resp = await requireLicense();
      assertTrue(resp !== null, "过期应返回 403");
      if (resp) assertEqual(resp.status, 403);
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("bypass=1 → 放行返回 null", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      process.env.GAOTAI_LICENSE_BYPASS = "1";
      const resp = await requireLicense();
      assertEqual(resp, null, "bypass 应放行");
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });
});

suite("授权门禁 - licenseSnapshot", ({ test }) => {
  test("activated 时 code 打码、daysLeft 约 30", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      // 签一个 30 天有效的 token
      const now = Date.now();
      const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
      const payload: LicensePayload = {
        v: 1,
        code: CODE,
        machine: MACHINE,
        issuedAt: now,
        expiresAt,
        features: ["core", "skills"],
        plan: "free",
      };
      const token = signToken(payload, privatePem);
      await writeTokenCache({
        token,
        expiresAt,
        machine: MACHINE,
        code: CODE,
        features: payload.features,
        plan: "free",
      });
      const snap = await licenseSnapshot();
      assertEqual(snap.status, "activated");
      // code 打码：不含完整码
      assertTrue(!snap.code!.includes(CODE), "快照不应包含完整注册码");
      assertTrue(snap.code!.startsWith("GT-7"), "打码码应保留前缀");
      // daysLeft 约 30（允许 ±1 天的边界误差）
      assertTrue(snap.daysLeft! >= 29 && snap.daysLeft! <= 30, `daysLeft 应约 30，实际 ${snap.daysLeft}`);
      assertEqual(snap.plan, "free");
      assertEqual(snap.features, ["core", "skills"]);
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("missing 时 code/expiresAt/daysLeft 全为 null", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      await deleteTokenCache();
      const snap = await licenseSnapshot();
      assertEqual(snap.status, "missing");
      assertEqual(snap.code, null);
      assertEqual(snap.expiresAt, null);
      assertEqual(snap.daysLeft, null);
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });

  test("bypass 时 code/expiresAt/daysLeft 全为 null，features 含 core", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshGateEnv();
    try {
      resetLicenseCache();
      process.env.GAOTAI_LICENSE_BYPASS = "1";
      const snap = await licenseSnapshot();
      assertEqual(snap.status, "bypass");
      assertEqual(snap.code, null);
      assertEqual(snap.expiresAt, null);
      assertEqual(snap.daysLeft, null);
      assertEqual(snap.features, ["core"]);
    } finally {
      cleanupGateEnv(dir, prev);
    }
  });
});
