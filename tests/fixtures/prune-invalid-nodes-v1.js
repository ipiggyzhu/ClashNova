// 去除名称里明显不是节点的项目，并同步清理策略组和订阅提供者引用。
function main(config) {
  const invalidNodeFilterBody = '过期|到期|失效|剩余|流量|官网|套餐|订阅|网址|重置|用量|群组|频道|traffic|expire|subscription|remaining|reset|used|total';
  const invalidNodeFilter = '(?i)(' + invalidNodeFilterBody + ')';
  const badName = new RegExp(invalidNodeFilterBody, 'i');
  const removed = {};
  const applyExcludeFilter = function(target) {
    if (!target || typeof target !== 'object') return;
    const current = String(target['exclude-filter'] || '').trim();
    if (!current) {
      target['exclude-filter'] = invalidNodeFilter;
    } else if (!/剩余|流量|remaining|traffic|expire/i.test(current)) {
      target['exclude-filter'] = '(?i)(?:' + current.replace(/^\(\?i\)/, '') + '|' + invalidNodeFilterBody + ')';
    }
  };

  config.proxies = (config.proxies || []).filter(function(proxy) {
    const name = String((proxy && proxy.name) || '');
    const drop = badName.test(name);
    if (drop) removed[name] = true;
    return !drop;
  });

  for (const provider of Object.values(config['proxy-providers'] || {})) {
    applyExcludeFilter(provider);
  }

  for (const group of config['proxy-groups'] || []) {
    if (group && group.use) applyExcludeFilter(group);
    if (Array.isArray(group.proxies)) {
      group.proxies = group.proxies.filter(function(name) {
        const text = String(name || '');
        return !removed[text] && !badName.test(text);
      });
    }
  }
  return config;
}
