import { assertEqual, suite } from "./harness";
import { resolveConfirmedContent } from "../app/api/projects/[id]/stages/[stage]/confirm/route";

/**
 * 签字确认的正文取值。
 *
 * 踩过的坑：接口原本写的是 `content ?? ""`——空 body 的签字调用会把
 * 已经生成的稿子**存成空串**，而且不报错（字数 0、体检 0 条，看着都正常）。
 * 这个接口的语义是「签字确认」，不是「改内容」：不传内容就该只改状态。
 */
suite("签字确认 · 正文取值", ({ test }) => {
  test("没传内容时沿用现有产出，不抹掉", () => {
    assertEqual(resolveConfirmedContent("已经写好的正文", undefined), "已经写好的正文");
  });

  test("传了内容就用传的那份", () => {
    assertEqual(resolveConfirmedContent("旧正文", "改过的正文"), "改过的正文");
  });

  test("既没有现有产出也没传内容，才是空串", () => {
    assertEqual(resolveConfirmedContent(null, undefined), "");
    assertEqual(resolveConfirmedContent(undefined, undefined), "");
  });

  test("传了空串就是空串（显式清空是允许的）", () => {
    assertEqual(resolveConfirmedContent("旧正文", ""), "");
  });
});
