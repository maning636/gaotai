import http from "node:http";
import { createCipheriv, createHash, generateKeyPairSync, hkdfSync } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, suite } from "./harness";
import { ensureAssets, readAssetState, assetRootDir } from "../lib/assets/sync";
import { writeTokenCache, deleteTokenCache } from "../lib/license/store";
import { machineCacheFile } from "../lib/license/machine";
import { resetLicenseCache } from "../lib/license/gate";
import { signToken } from "../lib/license/token";
import type { LicensePayload } from "../lib/license/types";

/**
 * 资产同步（协议 §4.4 / §4.5 / §5）。
 *
 * 用 node:http 起假授权服务器，按契约用 `createCipheriv` 反着加密资产包，
 * 覆盖：未激活跳过、正常下发落盘、sha256 不匹配保留旧缓存、恶意路径拒绝、
 * 并发只打一次 manifest、二次命中缓存不再请求。
 */

const ASSET_SALT = "gaotai-asset-v1";
const MACHINE = "c".repeat(64);
const CODE = "GT-7F3K-9QW2-M4XB-8HZP";
const VERSION = "2026-10-28";

// 密钥对 + 真实 token（gate 用内置公钥，这里注入临时公钥）
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

let tokenStr = "";

function buildValidPayload(): LicensePayload {
  const now = Date.now();
  return {
    v: 1,
    code: CODE,
    machine: MACHINE,
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    features: ["core", "skills", "prompts", "topics", "layout-packs"],
    plan: "free",
  };
}

/** 协议 §5：派生资产密钥（与客户端/服务端一致）。 */
function deriveKey(name: string, version: string): Buffer {
  const ikm = Buffer.from(tokenStr, "utf8");
  const salt = Buffer.from(ASSET_SALT, "utf8");
  const info = Buffer.from(`${name}:${version}`, "utf8");
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
}

/** 造一个资产包明文：`{ version, files }`，files value 为 base64（入参是原始内容）。 */
function buildPack(name: string, version: string, files: Record<string, string>): { version: string; files: Record<string, string> } {
  const obj: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    obj[`${name}/${rel}`] = Buffer.from(content, "utf8").toString("base64");
  }
  return { version, files: obj };
}

/** 按协议 §4.5 加密资产包，返回 `{ iv, tag, data, plainSha256 }`。 */
function encryptPack(name: string, version: string, pack: object): { iv: string; tag: string; data: string; plainSha256: string } {
  const plain = Buffer.from(JSON.stringify(pack), "utf8");
  const key = deriveKey(name, version);
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
    plainSha256: createHash("sha256").update(plain).digest("hex"),
  };
}

/** 起一个假授权服务器。handler 里 res 可直接写。 */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    try {
      handler(req, res);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "bad_response", message: String(e) } }));
    }
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/** 准备一个激活态环境：临时数据目录 + 机器码缓存 + 公钥注入 + 已写 token 缓存。 */
function freshActivated(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gaotai-assets-"));
  process.env.GAOTAI_DATA_DIR = dir;
  const cacheFile = machineCacheFile();
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, MACHINE, "utf8");
  process.env.GAOTAI_LICENSE_PUBKEY = publicPem;
  delete process.env.GAOTAI_LICENSE_BYPASS;
  return dir;
}

/** 写入合法 token 缓存。 */
async function writeValidToken(): Promise<void> {
  const payload = buildValidPayload();
  tokenStr = signToken(payload, privatePem);
  await writeTokenCache({
    token: tokenStr,
    expiresAt: payload.expiresAt,
    machine: MACHINE,
    code: CODE,
    features: payload.features,
    plan: payload.plan,
  });
}

/** 用例结束清理。 */
function cleanup(dir: string, prevData?: string): void {
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
  delete process.env.GAOTAI_LICENSE_SERVER;
}

/** 标准四包 manifest + 包文件，返回按请求分发的 handler。 */
function standardHandler(overrides?: { evilPath?: boolean; manifestCount?: () => void }) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "";
    if (url === "/v1/assets/manifest") {
      overrides?.manifestCount?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            version: VERSION,
            assets: [
              { name: "skills", version: VERSION, bytes: 1, sha256: "s", url: "/v1/assets/skills?version=" + VERSION },
              { name: "prompts", version: VERSION, bytes: 1, sha256: "p", url: "/v1/assets/prompts?version=" + VERSION },
              { name: "topics", version: VERSION, bytes: 1, sha256: "t", url: "/v1/assets/topics?version=" + VERSION },
              { name: "layout-packs", version: VERSION, bytes: 1, sha256: "l", url: "/v1/assets/layout-packs?version=" + VERSION },
            ],
          },
        }),
      );
      return;
    }
    const m = url.match(/^\/v1\/assets\/([^/]+)\?version=(.+)$/);
    if (m) {
      const name = m[1];
      const version = m[2];
      let files: Record<string, string>;
      if (overrides?.evilPath) {
        files = { "../evil.md": "x" };
      } else if (name === "skills") {
        files = { "human-writing/SKILL.md": "# hello skills" };
      } else if (name === "prompts") {
        files = { "article.md": "article prompt" };
      } else if (name === "topics") {
        files = { "general/topic.json": JSON.stringify({ id: "general" }) };
      } else {
        files = { "source.json": JSON.stringify({ name: "pack" }) };
      }
      const pack = buildPack(name, version, files);
      const enc = encryptPack(name, version, pack);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          data: { name, version, plainSha256: enc.plainSha256, iv: enc.iv, tag: enc.tag, data: enc.data },
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "not found" } }));
  };
}

/** 断言四类目录都落盘。 */
function assertRootFiles(): void {
  const root = assetRootDir();
  assertTrue(existsSync(path.join(root, "skills", "human-writing", "SKILL.md")), "skills 文件应落盘");
  assertTrue(existsSync(path.join(root, "prompts", "article.md")), "prompts 文件应落盘");
  assertTrue(existsSync(path.join(root, "topics", "general", "topic.json")), "topics 文件应落盘");
  assertTrue(existsSync(path.join(root, "layout-packs", "source.json")), "layout-packs 文件应落盘");
}

suite("资产同步 - 未激活", ({ test }) => {
  test("未激活 → skipped 且不发任何请求", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshActivated();
    // 清掉 token 缓存 → 未激活
    await deleteTokenCache();
    resetLicenseCache();
    let requests = 0;
    const { server, port } = await startServer((_req, res) => {
      requests += 1;
      res.writeHead(200);
      res.end("{}");
    });
    const prevServer = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
    try {
      const result = await ensureAssets();
      assertEqual(result.status, "skipped");
      assertEqual(requests, 0, "未激活不应发出任何请求");
    } finally {
      cleanup(dir, prev);
      await closeServer(server);
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
    }
  });
});

suite("资产同步 - 正常下发", ({ test }) => {
  test("激活后按契约下发，root 落盘、state.json 正确", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshActivated();
    await writeValidToken();
    resetLicenseCache();
    const { server, port } = await startServer(standardHandler());
    const prevServer = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
    try {
      const result = await ensureAssets();
      assertEqual(result.status, "updated");
      if (result.status === "updated") assertEqual(result.version, VERSION);
      assertRootFiles();
      const state = await readAssetState();
      assertTrue(state !== null);
      assertEqual(state!.version, VERSION);
      assertEqual(Object.keys(state!.packs).sort(), ["layout-packs", "prompts", "skills", "topics"]);
      assertEqual(state!.packs.skills.version, VERSION);
      // 内容一致性
      const skill = (await import("node:fs/promises")).readFile(
        path.join(assetRootDir(), "skills", "human-writing", "SKILL.md"),
        "utf8",
      );
      assertEqual(await skill, "# hello skills");
    } finally {
      cleanup(dir, prev);
      await closeServer(server);
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
    }
  });
});

suite("资产同步 - sha256 不匹配", ({ test }) => {
  test("校验失败 → failed 且旧缓存仍在", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshActivated();
    await writeValidToken();
    resetLicenseCache();
    // 先正常下一次，建立旧缓存
    const okServer = await startServer(standardHandler());
    const prevServer = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${okServer.port}`;
    try {
      const first = await ensureAssets();
      assertEqual(first.status, "updated");
      const oldSkillPath = path.join(assetRootDir(), "skills", "human-writing", "SKILL.md");
      assertTrue(existsSync(oldSkillPath), "首次下发应成功");
    } finally {
      await closeServer(okServer.server);
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
    }

    // 再起一个返回坏 sha 的服务器：用**不同的 manifest 版本**（否则版本一致会命中缓存、
    // 直接 ready 不下发，永远测不到 sha 校验分支），force 重新下发。
    const BAD_VERSION = "2026-11-01";
    const badServer = await startServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/v1/assets/manifest") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            data: {
              version: BAD_VERSION,
              assets: [
                { name: "skills", version: BAD_VERSION, bytes: 1, sha256: "s", url: "/v1/assets/skills?version=" + BAD_VERSION },
                { name: "prompts", version: BAD_VERSION, bytes: 1, sha256: "p", url: "/v1/assets/prompts?version=" + BAD_VERSION },
                { name: "topics", version: BAD_VERSION, bytes: 1, sha256: "t", url: "/v1/assets/topics?version=" + BAD_VERSION },
                { name: "layout-packs", version: BAD_VERSION, bytes: 1, sha256: "l", url: "/v1/assets/layout-packs?version=" + BAD_VERSION },
              ],
            },
          }),
        );
        return;
      }
      const m = url.match(/^\/v1\/assets\/([^/]+)\?version=(.+)$/);
      if (m) {
        const name = m[1];
        const version = m[2];
        const files: Record<string, string> =
          name === "skills" ? { "human-writing/SKILL.md": "# bad skills" } : { "a.txt": "b" };
        const pack = buildPack(name, version, files);
        const enc = encryptPack(name, version, pack);
        if (name === "skills") enc.plainSha256 = "0".repeat(64); // 破坏 sha
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            data: { name, version, plainSha256: enc.plainSha256, iv: enc.iv, tag: enc.tag, data: enc.data },
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "nf" } }));
    });
    const prevServer2 = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${badServer.port}`;
    try {
      const second = await ensureAssets({ force: true });
      assertEqual(second.status, "failed");
      if (second.status === "failed") {
        assertTrue(second.error.includes("sha256"), "错误信息应包含 sha256");
      }
      // 旧缓存仍在（版本是旧 VERSION，内容未变）
      const oldSkillPath = path.join(assetRootDir(), "skills", "human-writing", "SKILL.md");
      assertTrue(existsSync(oldSkillPath), "校验失败不应删除旧缓存");
      const content = (await import("node:fs/promises")).readFile(oldSkillPath, "utf8");
      assertEqual(await content, "# hello skills");
    } finally {
      cleanup(dir, prev);
      await closeServer(badServer.server);
      if (prevServer2 === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer2;
    }
  });
});

suite("资产同步 - 恶意路径", ({ test }) => {
  test("`../evil.md` → 拒绝，不写出目录外", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshActivated();
    await writeValidToken();
    resetLicenseCache();
    const { server, port } = await startServer(standardHandler({ evilPath: true }));
    const prevServer = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
    try {
      const result = await ensureAssets();
      assertEqual(result.status, "failed");
      if (result.status === "failed") {
        assertTrue(result.error.includes("非法资源路径"), "错误信息应包含非法资源路径");
      }
      // 目录外不能有 evil.md（assets 的父目录是 dataDir）
      const outside = path.join(dir, "evil.md");
      assertTrue(!existsSync(outside), "不应写出目录外");
      assertTrue(!existsSync(path.join(assetRootDir(), "..", "evil.md")), "assets 外不应有 evil.md");
    } finally {
      cleanup(dir, prev);
      await closeServer(server);
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
    }
  });
});

suite("资产同步 - 并发", ({ test }) => {
  test("并发两次 ensureAssets 只打一次 manifest", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshActivated();
    await writeValidToken();
    resetLicenseCache();
    let manifestCalls = 0;
    const { server, port } = await startServer(standardHandler({ manifestCount: () => (manifestCalls += 1) }));
    const prevServer = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
    try {
      const [a, b] = await Promise.all([ensureAssets(), ensureAssets()]);
      assertEqual(a.status, "updated");
      assertEqual(b.status, "updated");
      assertEqual(manifestCalls, 1, "并发应只打一次 manifest");
    } finally {
      cleanup(dir, prev);
      await closeServer(server);
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
    }
  });
});

suite("资产同步 - 缓存命中", ({ test }) => {
  test("二次调用命中缓存 → ready 且不再请求", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshActivated();
    await writeValidToken();
    resetLicenseCache();
    let requests = 0;
    const { server, port } = await startServer((req, res) => {
      requests += 1;
      standardHandler()(req, res);
    });
    const prevServer = process.env.GAOTAI_LICENSE_SERVER;
    process.env.GAOTAI_LICENSE_SERVER = `http://127.0.0.1:${port}`;
    try {
      const first = await ensureAssets();
      assertEqual(first.status, "updated");
      const afterFirst = requests;
      assertTrue(afterFirst >= 5, "首次应打 manifest + 4 包");
      // 二次非 force → 命中缓存，不再请求
      const second = await ensureAssets();
      assertEqual(second.status, "ready");
      if (second.status === "ready") assertEqual(second.version, VERSION);
      assertEqual(requests, afterFirst, "二次命中缓存不应再发请求");
    } finally {
      cleanup(dir, prev);
      await closeServer(server);
      if (prevServer === undefined) delete process.env.GAOTAI_LICENSE_SERVER;
      else process.env.GAOTAI_LICENSE_SERVER = prevServer;
    }
  });
});
