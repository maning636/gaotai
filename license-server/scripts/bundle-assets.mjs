import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// 资源源目录在 license-server 的上一级 resources/
const RESOURCES_DIR = resolve(ROOT, '..', 'resources');
// 产物输出到 license-server/assets/packs/
const PACKS_DIR = resolve(ROOT, 'assets', 'packs');

// 协议 §4.5：4 个资产包
const PACKS = ['skills', 'prompts', 'topics', 'layout-packs'];

// 版本 = 当天日期 + 内容指纹。
//
// 只用日期会出事：同一天改了提示词，版本号不变，客户端以为「已是最新」不重新拉，
// 装着旧提示词的人永远拿不到新内容。加上内容指纹，任何改动都会自动换版本。
function contentVersion(entries) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(entry);
  return `${y}-${m}-${day}-${hash.digest('hex').slice(0, 6)}`;
}

// 递归收集目录下所有文件，返回相对路径数组
function walkFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (s.isFile()) {
      // 用相对路径作为 key，统一用正斜杠（跨平台一致）
      const rel = relative(base, full).split(sep).join('/');
      out.push({ rel, full });
    }
  }
  return out;
}

export function main() {
  if (!existsSync(PACKS_DIR)) {
    mkdirSync(PACKS_DIR, { recursive: true });
  }

  const manifestAssets = [];
  // 先收集所有包的指纹，最后统一算版本（版本要在所有包写完后才知道）。
  const fingerprints = [];

  for (const name of PACKS) {
    const srcDir = resolve(RESOURCES_DIR, name);
    if (!existsSync(srcDir)) {
      console.error(`警告：资源目录不存在，跳过 ${name}：${srcDir}`);
      continue;
    }
    const files = walkFiles(srcDir);
    if (files.length === 0) {
      console.error(`警告：资源目录为空，跳过 ${name}`);
      continue;
    }

    // 协议 §4.5：files 的 value 是 base64 编码的文件内容
    const filesObj = {};
    for (const f of files) {
      const buf = readFileSync(f.full);
      filesObj[`${name}/${f.rel}`] = buf.toString('base64');
    }

    // 版本先占位，算出总指纹后统一回填（见下面第二遍写入）。
    const filesJson = JSON.stringify({ version: '', files: filesObj });
    fingerprints.push(`${name}:${createHash('sha256').update(filesJson).digest('hex')}`);
    manifestAssets.push({ name, files, filesObj, filesJson });
  }

  const version = contentVersion(fingerprints);

  for (const asset of manifestAssets) {
    const pack = { version, files: asset.filesObj };
    const packJson = JSON.stringify(pack);
    const packBuf = Buffer.from(packJson, 'utf8');
    const sha256 = createHash('sha256').update(packBuf).digest('hex');

    writeFileSync(resolve(PACKS_DIR, asset.name + '.json'), packJson, 'utf8');

    asset.version = version;
    asset.bytes = packBuf.length;
    asset.sha256 = sha256;
    console.log(
      `打包 ${asset.name}：${asset.files.length} 个文件，${packBuf.length} 字节，sha256 ${sha256.slice(0, 12)}…`,
    );
  }

  const manifest = {
    version,
    assets: manifestAssets.map(a => ({
      name: a.name,
      version: a.version,
      bytes: a.bytes,
      sha256: a.sha256,
      url: `/v1/assets/${a.name}?version=${a.version}`,
    })),
  };
  const manifestPath = resolve(PACKS_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('');
  console.log(`manifest 已写入：${manifestPath}`);
  console.log(`共 ${manifestAssets.length} 个资产包，版本 ${version}`);
}

main();
