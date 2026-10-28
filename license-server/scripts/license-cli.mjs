import { randomInt } from 'node:crypto';
import { parseConfig, selfCheck } from '../lib/config.mjs';
import { createStore, generateCode, normalizeContact } from '../lib/store.mjs';
import { derivePublicKeyPem } from '../lib/token.mjs';

// 管理 CLI：issue / list / revoke / unrevoke / unbind / show / stats / show-format
// 直接复用 store 层，不经 HTTP
const COMMANDS = ['issue', 'list', 'revoke', 'unrevoke', 'unbind', 'show', 'stats', 'show-format'];

function usage() {
  console.log(`用法：node scripts/license-cli.mjs <命令> [参数]

命令：
  issue   --contact <微信号/手机号> [--channel <wechat-mp|wechat-oa|direct>] [--plan free] [--max-devices 1] [--note "..."]
          发放一个新注册码（同 contact 重复发返回原码）
  list    [--all]  列出全部注册码（--all 含已吊销，默认只列未吊销）
  revoke  --code <GT-...>      吊销
  unrevoke --code <GT-...>     解除吊销
  unbind  --code <GT-...> [--machine <hex64>]   解绑设备（不传 machine 解全部）
  show    --code <GT-...>      查看详情（含设备列表与最后在线时间）
  stats   汇总统计
  show-format   打印当前生效的注册码格式（确认连的是哪个产品的实例）
`);
}

function arg(args, name) {
  const i = args.indexOf('--' + name);
  if (i < 0) return undefined;
  return args[i + 1];
}

// 用当前格式拼一个展示用的示例码（只取每组首字符，不用于真实发码）
function exampleCode(f) {
  const group = f.groupSize > 0 ? f.groupSize : f.bodyLength;
  const parts = [];
  let left = f.bodyLength;
  while (left > 0) {
    const n = Math.min(group, left);
    parts.push(f.alphabet[0].repeat(n));
    left -= n;
  }
  const body = parts.join('-');
  return f.prefix ? f.prefix + '-' + body : body;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || !COMMANDS.includes(cmd)) {
    usage();
    process.exit(1);
  }
  const rest = argv.slice(1);

  const config = parseConfig(process.env);
  // CLI 也走自检，确保私钥与 data 目录就绪
  const check = selfCheck(config);
  if (!check.ok) {
    console.error(check.errors.join('\n'));
    process.exit(1);
  }
  if (!config.publicKey) {
    config.publicKey = derivePublicKeyPem(config.privateKey);
  }

  const now = () => Date.now();
  const store = createStore({ dataDir: config.dataDir, now, codeFormat: config.codeFormat });

  switch (cmd) {
    case 'show-format':
    case '--show-format': {
      const f = config.codeFormat;
      console.log('当前注册码格式：');
      console.log('  prefix:       ' + (f.prefix || '（无前缀）'));
      console.log('  bodyLength:   ' + f.bodyLength);
      console.log('  groupSize:    ' + (f.groupSize === 0 ? '（不分段）' : f.groupSize));
      console.log('  alphabet:     ' + f.alphabet);
      console.log('  示例:         ' + exampleCode(f));
      break;
    }
    case 'issue': {
      const contact = normalizeContact(arg(rest, 'contact') || '');
      if (!contact) {
        console.error('缺少 --contact');
        process.exit(1);
      }
      const channel = arg(rest, 'channel') || 'direct';
      const plan = arg(rest, 'plan') || 'free';
      const maxDevices = parseInt(arg(rest, 'max-devices') || '1', 10);
      const note = arg(rest, 'note') || '';
      const code = generateCode(store, randomInt, config.codeFormat);
      const r = await store.issueCode({ code, contact, channel, plan, maxDevices, note });
      console.log('已发放注册码：');
      console.log('  code:        ' + r.code);
      console.log('  contact:     ' + r.contact);
      console.log('  channel:     ' + r.channel);
      console.log('  plan:        ' + r.plan);
      console.log('  maxDevices:  ' + r.maxDevices);
      console.log('  createdAt:   ' + new Date(r.createdAt).toISOString());
      break;
    }
    case 'list': {
      const all = rest.includes('--all');
      const list = await store.listCodes();
      const filtered = all ? list : list.filter((c) => !c.revoked);
      if (filtered.length === 0) {
        console.log('（无注册码）');
        break;
      }
      for (const c of filtered) {
        const flag = c.revoked ? '[已吊销]' : '';
        const devices = c.devices.length;
        const lastSeen = c.lastSeenAt ? new Date(c.lastSeenAt).toISOString() : '从未';
        console.log(`${c.code}  ${flag}  设备 ${devices}/${c.maxDevices}  plan=${c.plan}  最后在线 ${lastSeen}  contact=${c.contact}`);
      }
      console.log(`共 ${filtered.length} 条${all ? '（含已吊销）' : ''}`);
      break;
    }
    case 'revoke':
    case 'unrevoke': {
      const raw = arg(rest, 'code');
      const { code } = store.resolveCode(raw);
      if (!code) {
        console.error('注册码格式不正确：' + raw);
        process.exit(1);
      }
      const r = await store[cmd](code);
      if (!r) {
        console.error('注册码不存在：' + code);
        process.exit(1);
      }
      console.log(`${cmd === 'revoke' ? '已吊销' : '已解除吊销'}：${r.code}`);
      break;
    }
    case 'unbind': {
      const { code } = store.resolveCode(arg(rest, 'code'));
      if (!code) {
        console.error('注册码格式不正确');
        process.exit(1);
      }
      const machine = arg(rest, 'machine');
      const r = await store.unbind(code, machine);
      if (!r) {
        console.error('注册码不存在');
        process.exit(1);
      }
      console.log(`已解绑：${r.code}，剩余设备 ${r.devices.length}`);
      break;
    }
    case 'show': {
      const { record } = store.resolveCode(arg(rest, 'code'));
      if (!record) {
        console.error('注册码不存在');
        process.exit(1);
      }
      console.log(JSON.stringify(record, null, 2));
      break;
    }
    case 'stats': {
      const s = await store.stats();
      console.log(JSON.stringify(s, null, 2));
      break;
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
