import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertEqual, assertTrue, assertMatch, suite } from "./harness";
import {
  computeMachineId,
  getMachineId,
  machineCacheFile,
  resetMachineCache,
  type MachineReaders,
} from "../lib/license/machine";

/**
 * 机器码计算与缓存（协议 §2）。
 *
 * 全程注入假读数，绝不真的执行 PowerShell。
 * 每个用例的缓存测试用独立的临时目录，避免互相干扰。
 */

const MACHINE_RE = /^[0-9a-f]{64}$/;

/** 造一份假 readers，返回固定读数。 */
function fakeReaders(over: Partial<MachineReaders> = {}): MachineReaders {
  const base: MachineReaders = {
    readUuid: async () => "UUID-AAA-111",
    readMachineGuid: async () => "GUID-BBB-222",
    readDiskSerial: async () => "DISK-CCC-333",
    hostname: () => "test-host",
  };
  return { ...base, ...over };
}

/** 建一个临时目录并设为 GAOTAI_DATA_DIR，返回目录路径。 */
function freshDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gaotai-mach-"));
  process.env.GAOTAI_DATA_DIR = dir;
  return dir;
}

/** 清理临时目录并恢复环境变量。 */
function cleanupDataDir(dir: string, prev?: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清不掉不影响结论
  }
  if (prev === undefined) {
    delete process.env.GAOTAI_DATA_DIR;
  } else {
    process.env.GAOTAI_DATA_DIR = prev;
  }
}

suite("机器码计算", ({ test }) => {
  test("同样输入 → 同样机器码，且匹配 64 位 hex", async () => {
    const readers = fakeReaders();
    const a = await computeMachineId(readers);
    const b = await computeMachineId(readers);
    assertEqual(a, b, "同样输入应当得到同样机器码");
    assertMatch(a, MACHINE_RE, "机器码应是 64 位 hex");
  });

  test("换磁盘序列号 → 机器码变", async () => {
    const r1 = fakeReaders({ readDiskSerial: async () => "DISK-111" });
    const r2 = fakeReaders({ readDiskSerial: async () => "DISK-222" });
    const a = await computeMachineId(r1);
    const b = await computeMachineId(r2);
    assertTrue(a !== b, "换磁盘序列号后机器码应改变");
    assertMatch(a, MACHINE_RE);
    assertMatch(b, MACHINE_RE);
  });

  test("换 UUID → 机器码变", async () => {
    const r1 = fakeReaders({ readUuid: async () => "UUID-111" });
    const r2 = fakeReaders({ readUuid: async () => "UUID-222" });
    const a = await computeMachineId(r1);
    const b = await computeMachineId(r2);
    assertTrue(a !== b, "换 UUID 后机器码应改变");
  });

  test("UUID 取不到时降级到 MachineGuid，机器码仍稳定且为 64 位 hex", async () => {
    const readers = fakeReaders({ readUuid: async () => "" });
    const a = await computeMachineId(readers);
    const b = await computeMachineId(readers);
    assertEqual(a, b, "降级路径也应稳定");
    assertMatch(a, MACHINE_RE);
    // 确认与有 UUID 时不同
    const withUuid = await computeMachineId(fakeReaders({ readUuid: async () => "UUID-AAA-111" }));
    assertTrue(a !== withUuid, "降级后的机器码应与用 UUID 时不同");
  });

  test("UUID 与 MachineGuid 都取不到时降级到 hostname", async () => {
    const readers = fakeReaders({
      readUuid: async () => "",
      readMachineGuid: async () => "",
      hostname: () => "fallback-host",
    });
    const a = await computeMachineId(readers);
    const b = await computeMachineId(readers);
    assertEqual(a, b);
    assertMatch(a, MACHINE_RE);
  });
});

suite("机器码缓存", ({ test }) => {
  test("第一次写文件、第二次读缓存不再调用注入的读数", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshDataDir();
    try {
      resetMachineCache();
      let uuidCalls = 0;
      let diskCalls = 0;
      const readers: MachineReaders = {
        readUuid: async () => {
          uuidCalls++;
          return "UUID-CACHE-TEST";
        },
        readMachineGuid: async () => "GUID",
        readDiskSerial: async () => {
          diskCalls++;
          return "DISK-CACHE-TEST";
        },
        hostname: () => "cache-host",
      };

      const first = await getMachineId(readers);
      assertTrue(uuidCalls > 0, "首次应调 readUuid");
      assertTrue(diskCalls > 0, "首次应调 readDiskSerial");
      const callsAfterFirst = { uuid: uuidCalls, disk: diskCalls };

      const second = await getMachineId(readers);
      assertEqual(second, first, "缓存命中应返回同一机器码");
      assertEqual(uuidCalls, callsAfterFirst.uuid, "第二次不应再调 readUuid");
      assertEqual(diskCalls, callsAfterFirst.disk, "第二次不应再调 readDiskSerial");
    } finally {
      cleanupDataDir(dir, prev);
    }
  });

  test("缓存文件内容被写坏后能重算，不抛错", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshDataDir();
    try {
      resetMachineCache();
      const readers = fakeReaders();
      const first = await getMachineId(readers);
      assertMatch(first, MACHINE_RE);

      // 把缓存文件写坏
      const cacheFile = machineCacheFile();
      assertTrue(existsSync(cacheFile), "缓存文件应已存在");
      writeFileSync(cacheFile, "THIS-IS-NOT-A-VALID-MACHINE-CODE!!!", "utf8");

      // 再取：应重算，不抛错，返回合法机器码
      resetMachineCache();
      const second = await getMachineId(readers);
      assertMatch(second, MACHINE_RE, "缓存写坏后重算应返回合法机器码");
      assertEqual(second, first, "重算结果应与首次一致");
    } finally {
      cleanupDataDir(dir, prev);
    }
  });

  test("缓存目录不存在时不报错（首次运行）", async () => {
    const prev = process.env.GAOTAI_DATA_DIR;
    const dir = freshDataDir();
    try {
      resetMachineCache();
      assertTrue(!existsSync(machineCacheFile()), "新目录下不应有缓存文件");
      const machine = await getMachineId(fakeReaders());
      assertMatch(machine, MACHINE_RE);
      assertTrue(existsSync(machineCacheFile()), "计算后应写入缓存文件");
    } finally {
      cleanupDataDir(dir, prev);
    }
  });
});
