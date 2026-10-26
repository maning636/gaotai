import { randomUUID } from "node:crypto";

/**
 * 统一 ID 生成。
 *
 * 数据库主键用带前缀的 UUID：带前缀便于日志里一眼看出实体类型，
 * 也避免不同表的 ID 在排查问题时混淆。
 */
export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}
