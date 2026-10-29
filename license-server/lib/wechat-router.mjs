// 微信公众号消息路由：纯逻辑，不碰网络/存储。
//
// 输入 { message, config, openid, issue }，输出 Promise<{ reply: string } | { reply: null }>。
// 发码这一动作通过注入的 issue(openid, product) 回调完成（异步）——纯逻辑层不直接调用存储，
// 便于单测：传一个假的 issue 就能断言「发了哪个产品的码」，而不需要真的写盘。
//
// 所有文案来自 config（welcome/fallback/products/listKeywords/menu），代码不写死中文长句。

// 找最长匹配关键词的产品：包含即命中，关键词越长越优先。
// 返回命中的产品对象，未命中返回 null。
function matchProduct(products, text) {
  let best = null;
  let bestLen = 0;
  for (const p of products || []) {
    for (const kw of p.keywords || []) {
      const k = String(kw).trim().toLowerCase();
      if (k && text.includes(k) && k.length > bestLen) {
        best = p;
        bestLen = k.length;
      }
    }
  }
  return best;
}

// 找最长匹配关键词的 FAQ 条目：包含即命中，关键词越长越优先。
// 返回命中的 FAQ 条目对象，未命中返回 null。多条 FAQ 的「回复内容不同、关键词最长者胜」。
function matchFaq(faq, text) {
  let best = null;
  let bestLen = 0;
  for (const f of faq || []) {
    for (const kw of f.keywords || []) {
      const k = String(kw).trim().toLowerCase();
      if (k && text.includes(k) && k.length > bestLen) {
        best = f;
        bestLen = k.length;
      }
    }
  }
  return best;
}

// 产品清单文案：列出每个产品与各自的领取方式。
// 有 url 的给「发「关键词」领码」，否则给 url。
export function productListText(config) {
  const lines = ['现有产品：'];
  for (const p of config.products || []) {
    const kw = (p.keywords || [])[0] || p.name;
    if (p.issue) {
      lines.push(`· ${p.name}：发「${kw}」直接领码。`);
    } else if (p.url) {
      lines.push(`· ${p.name}：${p.url}`);
    } else {
      lines.push(`· ${p.name}`);
    }
  }
  return lines.join('\n');
}

export async function handleWechatMessage({ message, config, openid, issue }) {
  const cfg = config || {};
  const msg = message || {};
  const fromUser = msg.FromUserName || openid || '';

  const reply = (content) => ({ reply: content });

  // 事件类：关注 / 取关 / 菜单点击
  if (msg.MsgType === 'event') {
    if (msg.Event === 'subscribe') {
      // 欢迎语里列出所有产品与各自领取方式
      const welcome = cfg.welcome || '感谢关注。';
      return reply(welcome + '\n\n' + productListText(cfg));
    }
    if (msg.Event === 'unsubscribe') {
      // 取关不回话，微信也不接受被动回复
      return { reply: null };
    }
    if (msg.Event === 'CLICK') {
      const menuText = (cfg.menu || {})[msg.EventKey];
      if (typeof menuText === 'string' && menuText) return reply(menuText);
      return reply(cfg.fallback || '菜单项暂不可用。');
    }
    // 其它事件（scan、location、VIEW 等）不回，避免对未知事件乱回话
    return { reply: null };
  }

  // 文本类：去空白转小写后按关键词匹配
  if (msg.MsgType === 'text') {
    const text = String(msg.Content || '').replace(/\s+/g, '').toLowerCase();
    if (!text) return reply(cfg.fallback || '收到。');

    // 列表类关键词优先命中：列出全部产品
    for (const kw of cfg.listKeywords || []) {
      const k = String(kw).trim().toLowerCase();
      if (k && text.includes(k)) {
        return reply(productListText(cfg));
      }
    }

    const product = matchProduct(cfg.products, text);
    if (product) {
      if (product.issue) {
        // 发码：由路由层注入的 issue 回调执行（异步），返回码并拼上回复后缀。
        // issue(openid, product) 传整个产品对象，路由层需要读 product.name 记 note。
        // 发码抛错（如码碰撞）不冒泡，降级为提示，避免把整条回调打挂。
        let code;
        try {
          code = (typeof issue === 'function' && (await issue(fromUser, product))) || null;
        } catch {
          code = null;
        }
        if (!code) {
          return reply('暂时无法发码，请稍后再试。');
        }
        const suffix = product.replySuffix ? '\n' + product.replySuffix : '';
        return reply(`你的注册码：${code}${suffix}`);
      }
      if (product.url) return reply(product.url);
      return reply(product.name);
    }

    // FAQ 关键词：产品之后、fallback 之前命中，回配置好的回复。
    const faq = matchFaq(cfg.faq, text);
    if (faq) return reply(faq.reply);

    return reply(cfg.fallback || '发「领码」看全部产品。');
  }

  // 图片/语音/视频等：不回，避免对非文本消息乱回话
  return { reply: null };
}
