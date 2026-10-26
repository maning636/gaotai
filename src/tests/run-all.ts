import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { suite } from "./harness";
import "./auth.test";
import "./repo.test";
import "./bootstrap.test";
import "./markdown.test";
import "./layout-template.test";
import "./import-article.test";
import "./wechat-images.test";
import "./wechat-api.test";
import "./wechat-check.test";
import "./skills-pack.test";
import "./confirm-content.test";
import "./files-upload.test";
import "./style-memory.test";
import "./resources.test";
import "./stage-engine.test";
import "./skills.test";
import "./prose-check.test";
import "./length-target.test";
import "./article-review.test";
import "./repetition.test";
import "./section-writer.test";
import "./article-sections.test";
import "./llm-tools.test";
import "./agent-config.test";
import "./fetch-timeout.test";
import "./draft-idempotency.test";

/**
 * 测试入口。
 *
 * 关键：数据目录必须指向一次性临时目录，绝不能让测试写进用户的真实 data/。
 * 进程退出时清理。
 */

const sandbox = mkdtempSync(path.join(tmpdir(), "gaotai-test-"));
process.env.GAOTAI_DATA_DIR = sandbox;
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-session-secret-for-gaotai-only";

async function main() {
  const { runAll } = await import("./harness");
  const code = await runAll();
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉不影响测试结论
  }
  process.exit(code);
}

void main();
