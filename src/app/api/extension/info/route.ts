import { NextResponse } from "next/server";
import { guard } from "../../../../lib/license/guard";
import { readExtensionInfo } from "../../../../lib/bridge/extension-info";
import { isBridgeStateFresh, readBridgeState } from "../../../../lib/bridge/state";
import { getAllPlatforms } from "../../../../lib/bridge/platform-registry";

export const runtime = "nodejs";

/**
 * 浏览器扩展信息。
 *
 * 安装指导页靠它回答三个问题：
 *   1. 扩展文件在不在本机（不在就等于包装坏了，要让用户找客服而不是瞎折腾）；
 *   2. 在哪个目录（Chrome「加载已解压的扩展程序」要选的就是它）；
 *   3. 现在到底连上没有（连上才能发稿）。
 *
 * 注意 `available` 与 `connected` 是两件事：文件存在说明「能装」，
 * 连上说明「装了并且正在和稿台通信」。用户最容易卡在中间——
 * 装完了但没刷新页面、或者装到了另一个浏览器。
 */
export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;

  const info = readExtensionInfo();
  const state = readBridgeState();
  const fresh = isBridgeStateFresh(state);

  // 适配器 id → 中文名，让指导页能直接列出「这个插件能发到哪些平台」。
  // feishu 不在注册表里（面板单独补的元信息），这里给个兜底名字，
  // 否则界面上会直接露出英文 id。
  const EXTRA_NAMES: Record<string, string> = { feishu: "飞书" };
  const names = new Map(getAllPlatforms().map((platform) => [platform.id, platform.name]));
  const platforms = info.adapters.map((id) => ({ id, name: names.get(id) ?? EXTRA_NAMES[id] ?? id }));

  return NextResponse.json({
    available: info.available,
    dir: info.dir,
    version: info.version,
    name: info.name,
    platforms,
    connected: fresh && state.extensions > 0,
    extensions: fresh ? state.extensions : 0,
    port: fresh ? state.port : 0,
  });
}
