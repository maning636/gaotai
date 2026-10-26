import { checkProse, type ProseCheckResult } from "./prose-check";
import type { LengthTarget } from "./length-target";

/**
 * 成稿体检（只读报告）。
 *
 * 这一层是**量**，不是**闸门**。
 *
 * 原来的做法是量完不过就退回让模型改一轮：去重、按句改写、按节补写、再两版挑一版。
 * 那条链已经被砍掉，因为它在真模型上是负收益：
 *
 * 1. 整篇重写和按节补写极不可靠——额度全被思考吃光，正文一个字交不出来，
 *    等一圈下来什么也没改成（真模型实测 2026-10-23）。
 * 2. 改写会顺手把稿子改短、改钝（真模型实测：冒号少了但字数更短了）。
 *    改坏比不改更麻烦。
 * 3. 用户要的是一份能自己判断的稿子，不是一份被机器来回搓过的稿子。
 *
 * 所以这里只负责把问题摆出来：命中几条硬禁令、哪几行、差多少字。
 * 怎么处理由人决定。
 */

/** 一次量出来的结果。 */
export type ArticleReview = {
  /** 正文汉字数。 */
  hanCount: number;
  /** 硬禁令条数。 */
  failCount: number;
  /** 需要人工判断的条数。 */
  warnCount: number;
  /** 差多少字（相对目标下限，正数表示短）。 */
  missing: number;
  /** 给人看的原因。 */
  reasons: string[];
  /** 完整体检结果，界面要逐条显示。 */
  prose: ProseCheckResult;
  /** 目标区间（没有目标时为 0–0）。 */
  targetMin: number;
  targetMax: number;
};

/**
 * 量一遍稿子。
 *
 * 只报告，不判定合不合格，也不触发任何自动修改。
 *
 * 「差多少字」仍然算出来给用户看，但它不再是退回的理由——
 * 材料撑不起就写短，写短是合法的；短本身不是错误。
 */
export function reportArticle(content: string, target: LengthTarget | null): ArticleReview {
  const prose = checkProse(content);
  const failCount = prose.findings.filter(item => item.level === "fail").length;
  const warnCount = prose.findings.filter(item => item.level === "warn").length;

  const targetMin = target?.min ?? 0;
  const targetMax = target?.max ?? 0;
  const missing = targetMin > 0 ? Math.max(0, targetMin - prose.hanCount) : 0;

  const reasons: string[] = [];
  if (failCount > 0) {
    reasons.push(`成稿体检有 ${failCount} 条硬禁令`);
  }
  if (missing > 0) {
    reasons.push(`正文 ${prose.hanCount} 字，比目标下限少 ${missing} 字`);
  }

  return {
    hanCount: prose.hanCount,
    failCount,
    warnCount,
    missing,
    reasons,
    prose,
    targetMin,
    targetMax,
  };
}
