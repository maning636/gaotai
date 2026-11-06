import { assertEqual, assertTrue, suite } from "./harness";
import {
  MAX_WECHAT_ACCOUNTS,
  readAccountById,
  readWechatAccounts,
  saveWechatAccounts,
  toAccountViews,
} from "../lib/wechat-config";

/**
 * 公众号多账号测试。
 *
 * 账号清单存在 .env 的 WECHAT_ACCOUNTS 里（JSON 数组）。这里验证：
 * 读空、保存后能读回一致、最多 5 个上限、按 id 取账号、secret 不泄漏。
 */

suite("公众号多账号", ({ test }) => {
  test("没配置时返回空列表", () => {
    assertEqual(readWechatAccounts(), []);
  });

  test("保存后能按 id 读回，secret 一致", async () => {
    const saved = await saveWechatAccounts([
      { id: "", name: "主号", appId: "wx-main", appSecret: "main-secret" },
      { id: "", name: "次号", appId: "wx-sub", appSecret: "sub-secret" },
    ]);
    assertEqual(saved.length, 2);
    assertTrue(saved[0].id.length > 0, "新账号应该有生成好的 id");
    assertTrue(saved[0].id !== saved[1].id, "两个账号 id 不该相同");

    const loaded = readWechatAccounts();
    assertEqual(loaded.length, 2);
    assertEqual(loaded[0].name, "主号");
    assertEqual(loaded[0].appId, "wx-main");
    assertEqual(loaded[0].appSecret, "main-secret");
    assertEqual(loaded[1].name, "次号");
  });

  test("按 id 读账号；不存在的 id 返回 null", async () => {
    const [first] = await saveWechatAccounts([{ id: "", name: "甲", appId: "wx-a", appSecret: "s-a" }]);
    assertEqual(readAccountById(first.id)?.name, "甲");
    assertEqual(readAccountById("no-such-id"), null);
    assertEqual(readAccountById(""), null);
  });

  test("最多 5 个账号，超过就抛错", async () => {
    const five = Array.from({ length: MAX_WECHAT_ACCOUNTS }, (_, i) => ({
      id: "",
      name: `号${i + 1}`,
      appId: `wx-${i}`,
      appSecret: `s-${i}`,
    }));
    const saved = await saveWechatAccounts(five);
    assertEqual(saved.length, MAX_WECHAT_ACCOUNTS);

    const six = [...five, { id: "", name: "第六个", appId: "wx-9", appSecret: "s-9" }];
    let threw = false;
    try {
      await saveWechatAccounts(six);
    } catch (error) {
      threw = true;
      assertTrue(error instanceof Error, "应抛错");
      assertTrue((error as Error).message.includes(String(MAX_WECHAT_ACCOUNTS)), "提示里要有上限");
    }
    assertTrue(threw, "超过上限该抛错");
  });

  test("编辑已有账号留空字段沿用旧值，不抹掉 secret", async () => {
    const [first] = await saveWechatAccounts([{ id: "", name: "甲", appId: "wx-a", appSecret: "s-a" }]);
    // 前端拿不到 secret，只改名字，AppID/AppSecret 留空 → 沿用旧值
    const saved = await saveWechatAccounts([{ id: first.id, name: "甲（改名）", appId: "", appSecret: "" }]);
    assertEqual(saved.length, 1);
    assertEqual(saved[0].name, "甲（改名）");
    assertEqual(saved[0].appId, "wx-a", "AppID 留空该沿用旧值");
    assertEqual(saved[0].appSecret, "s-a", "AppSecret 留空该沿用旧值");
  });

  test("对外视图不泄漏 AppSecret，只回掩码", async () => {
    const [first] = await saveWechatAccounts([{ id: "", name: "甲", appId: "wx-abcdefg-hijk", appSecret: "super-secret" }]);
    const views = toAccountViews([first]);
    assertEqual(views.length, 1);
    assertEqual(views[0].id, first.id);
    assertEqual(views[0].name, "甲");
    assertTrue(views[0].appIdMasked.includes("****"), "AppID 应该掩码");
    assertTrue(!JSON.stringify(views).includes("super-secret"), "secret 不能进对外视图");
  });

  test("清空账号清单（整体覆盖为空）", async () => {
    await saveWechatAccounts([{ id: "", name: "甲", appId: "wx-a", appSecret: "s-a" }]);
    await saveWechatAccounts([]);
    assertEqual(readWechatAccounts(), []);
  });
});
