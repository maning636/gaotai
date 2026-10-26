import { strict as assert } from "node:assert";

/**
 * 极简测试运行器。
 *
 * 项目不引入测试框架：桌面客户端的依赖树越短越好，
 * 打包体积和安装失败面都更小。够用即可。
 *
 * 用法：
 *   import { suite } from "./harness";
 *   suite("分组名", ({ test }) => { test("用例名", () => { ... }); });
 */

export type TestFn = () => void | Promise<void>;
export type TestApi = { test: (name: string, fn: TestFn) => void };

type Suite = { name: string; tests: { name: string; fn: TestFn }[] };

const suites: Suite[] = [];

export function suite(name: string, body: (api: TestApi) => void) {
  const s: Suite = { name, tests: [] };
  suites.push(s);
  body({
    test(testName, fn) {
      s.tests.push({ name: testName, fn });
    },
  });
}

export function assertEqual<T>(actual: T, expected: T, message?: string) {
  assert.deepStrictEqual(actual, expected, message);
}

export function assertTrue(value: unknown, message?: string) {
  assert.ok(value, message);
}

export function assertMatch(value: string, pattern: RegExp, message?: string) {
  assert.ok(pattern.test(value), message ?? `期望匹配 ${pattern}，实际：${value.slice(0, 200)}`);
}

export async function runAll(): Promise<number> {
  let passed = 0;
  const failures: { suite: string; test: string; error: unknown }[] = [];

  for (const s of suites) {
    for (const t of s.tests) {
      try {
        await t.fn();
        passed += 1;
        process.stdout.write(".");
      } catch (error) {
        failures.push({ suite: s.name, test: t.name, error });
        process.stdout.write("F");
      }
    }
  }

  process.stdout.write("\n\n");
  for (const f of failures) {
    console.error(`✗ [${f.suite}] ${f.test}`);
    console.error(f.error instanceof Error ? (f.error.stack ?? f.error.message) : String(f.error));
    console.error("");
  }
  console.log(`通过 ${passed} / ${passed + failures.length}`);
  return failures.length === 0 ? 0 : 1;
}
