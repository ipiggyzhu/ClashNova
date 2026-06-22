// ClashNova / Clash Verge Rev profile script
// One script for Yunmeng-style subscription aggregation, chain proxy, rules,
// and DNS anti-leak defaults.
//
// How to use:
// 1. If you only use the current remote subscription profile, leave
//    providerInputs empty. The current profile nodes are already in
//    config.proxies when this script runs.
// 2. If you want to aggregate more subscriptions, fill p1/p2/etc with Clash
//    YAML or Mihomo-compatible provider URLs. Empty URLs are ignored.
// 3. The residential SS landing node is chained through the relay group by
//    dialer-proxy, so leak-test domains can go through the landing node.
function main(config, profileName) {
  // Used by provider health checks and the auto-select group to measure
  // whether a node is alive and roughly how much latency it has.
  const healthCheckUrl = 'http://cp.cloudflare.com/generate_204';
  const enableDnsLeakPreset = true;
  const invalidNodeFilterBody =
    '过期|到期|失效|剩余|流量|官网|套餐|订阅|网址|重置|用量|群组|频道|traffic|expire|subscription|remaining|reset|used|total';
  const invalidNodeFilter = `(?i)(${invalidNodeFilterBody})`;
  const invalidNodeName = new RegExp(invalidNodeFilterBody, 'i');

  // Add extra remote subscriptions here. The current ClashNova subscription
  // does not need to be repeated here because it is already loaded as
  // config.proxies before this script is executed.
  const providerInputs = {
    p1: {
      type: 'http',
      url: '',
      interval: 86400,
      prefix: 'p1 | ',
    },
    p2: {
      type: 'http',
      url: '',
      interval: 86400,
      prefix: 'p2 | ',
    },
    p3: {
      type: 'http',
      url: '',
      interval: 86400,
      prefix: 'p3 | ',
    },
  };

  const landingName = '[落地]ldc月卡-US';
  const relayGroup = '🇯🇵 日本中转';
  const landingGroup = '🛬 落地节点';
  const mainGroup = '🚀 节点选择';
  const autoGroup = '⚡ 自动选择';
  const adGroup = '🛑 广告拦截';
  const aiGroup = '🤖 AI 服务';
  const geminiGroup = '✨ Gemini';
  const youtubeGroup = '📺 油管视频';
  const googleGroup = '🔎 谷歌服务';
  const microsoftGroup = 'Ⓜ️ 微软服务';
  const appleGroup = '🍎 苹果服务';
  const telegramGroup = '💬 电报消息';
  const codeGroup = '🐙 代码托管';
  const cloudGroup = '☁️ 云服务';
  const devGroup = '🛠️ 开发工具';
  const paymentGroup = '💳 支付平台';
  const finalGroup = '🐟 漏网之鱼';
  const privateGroup = '🏠 私有网络';
  const cnGroup = '🇨🇳 国内服务';

  const uniq = (items) => [...new Set(items.filter(Boolean))];
  const providerId = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const applyExcludeFilter = (target) => {
    if (!target || typeof target !== 'object') return target;
    const current = String(target['exclude-filter'] || '').trim();
    if (!current) {
      target['exclude-filter'] = invalidNodeFilter;
    } else if (!/剩余|流量|remaining|traffic|expire/i.test(current)) {
      target['exclude-filter'] = `(?i)(?:${current.replace(/^\(\?i\)/, '')}|${invalidNodeFilterBody})`;
    }
    return target;
  };

  const generatedProviders = {};
  for (const [id, input] of Object.entries(providerInputs)) {
    const url = String(input.url || '').trim();
    if (!url) continue;

    generatedProviders[id] = {
      type: input.type || 'http',
      url,
      path: `./providers/${providerId(id)}.yaml`,
      interval: input.interval || 86400,
      'exclude-filter': invalidNodeFilter,
      override: {
        'additional-prefix': input.prefix || `${id} | `,
      },
      'health-check': {
        enable: true,
        url: healthCheckUrl,
        interval: 600,
      },
    };
  }

  config.mode = 'rule';
  config['unified-delay'] = true;
  config['tcp-concurrent'] = true;

  config['proxy-providers'] = {
    ...(config['proxy-providers'] || {}),
    ...generatedProviders,
  };
  for (const provider of Object.values(config['proxy-providers'] || {})) {
    applyExcludeFilter(provider);
  }
  const providerKeys = Object.keys(config['proxy-providers'] || {});

  config.proxies = Array.isArray(config.proxies) ? config.proxies : [];
  config.proxies = config.proxies.filter((proxy) => {
    const name = String((proxy && proxy.name) || '');
    return proxy && name !== landingName && !invalidNodeName.test(name);
  });
  config.proxies.push({
    name: landingName,
    type: 'ss',
    server: 'REPLACE_WITH_LANDING_SERVER',
    port: 443,
    cipher: 'aes-128-gcm',
    password: 'REPLACE_WITH_LANDING_PASSWORD',
    udp: true,
    'dialer-proxy': relayGroup,
  });

  const allNodes = config.proxies.map((proxy) => proxy && proxy.name).filter(Boolean);
  const normalNodes = allNodes.filter((name) => name !== landingName && !invalidNodeName.test(String(name || '')));
  const relayNodes = normalNodes.filter((name) =>
    /(JP|Japan|日本|SG|Singapore|新加坡|HK|Hong Kong|香港)/i.test(name),
  );
  if (relayNodes.length === 0 && normalNodes[0]) relayNodes.push(normalNodes[0]);

  const providerExtra = (extra = {}) =>
    providerKeys.length > 0 ? applyExcludeFilter({ ...extra, use: providerKeys }) : extra;
  const group = (name, type, proxies, extra = {}) => ({
    name,
    type,
    proxies: uniq(proxies),
    ...extra,
  });

  const normalChoices = uniq([autoGroup, 'DIRECT', 'REJECT', ...normalNodes]);
  const commonChoices = uniq([landingGroup, mainGroup, autoGroup, 'DIRECT', 'REJECT', ...normalNodes]);
  const directFirstChoices = uniq(['DIRECT', mainGroup, autoGroup, landingGroup, 'REJECT', ...normalNodes]);

  config['proxy-groups'] = [
    group(
      relayGroup,
      'select',
      relayNodes,
      providerExtra({
        filter: '(?i)(JP|Japan|日本|SG|Singapore|新加坡|HK|Hong Kong|香港)',
      }),
    ),
    group(landingGroup, 'select', [landingName]),
    group(
      autoGroup,
      'url-test',
      normalNodes,
      providerExtra({
        url: healthCheckUrl,
        interval: 600,
        tolerance: 80,
        lazy: true,
      }),
    ),
    group(mainGroup, 'select', normalChoices, providerExtra()),
    group(adGroup, 'select', ['REJECT', 'DIRECT', mainGroup]),
    group(aiGroup, 'select', commonChoices, providerExtra()),
    group(geminiGroup, 'select', commonChoices, providerExtra()),
    group(youtubeGroup, 'select', uniq([mainGroup, autoGroup, 'DIRECT', 'REJECT', ...normalNodes]), providerExtra()),
    group(googleGroup, 'select', commonChoices, providerExtra()),
    group(microsoftGroup, 'select', directFirstChoices, providerExtra()),
    group(appleGroup, 'select', uniq(['DIRECT', mainGroup, autoGroup, 'REJECT', ...normalNodes]), providerExtra()),
    group(telegramGroup, 'select', commonChoices, providerExtra()),
    group(codeGroup, 'select', commonChoices, providerExtra()),
    group(cloudGroup, 'select', commonChoices, providerExtra()),
    group(devGroup, 'select', commonChoices, providerExtra()),
    group(paymentGroup, 'select', commonChoices, providerExtra()),
    group(finalGroup, 'select', commonChoices, providerExtra()),
    group(privateGroup, 'select', uniq(['DIRECT', 'REJECT', mainGroup, autoGroup, ...normalNodes]), providerExtra()),
    group(cnGroup, 'select', uniq(['DIRECT', 'REJECT', mainGroup, autoGroup, ...normalNodes]), providerExtra()),
  ];

  const base = 'https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta';
  const domainSets = [
    'category-ads-all',
    'private',
    'geolocation-cn',
    'geolocation-!cn',
    'category-ai-chat-!cn',
    'openai',
    'anthropic',
    'google-gemini',
    'youtube',
    'google',
    'microsoft',
    'onedrive',
    'apple',
    'icloud',
    'telegram',
    'github',
    'gitlab',
    'atlassian',
    'aws',
    'azure',
    'cloudflare',
    'digitalocean',
    'vercel',
    'netlify',
    'docker',
    'npmjs',
    'jetbrains',
    'stackexchange',
    'paypal',
    'stripe',
    'wise',
    'cn',
  ];
  const ipSets = {
    'private-ip': 'private',
    'cn-ip': 'cn',
    'google-ip': 'google',
    'telegram-ip': 'telegram',
    'cloudflare-ip': 'cloudflare',
  };

  config['rule-providers'] = {
    ...(config['rule-providers'] || {}),
  };
  for (const name of domainSets) {
    config['rule-providers'][name] = {
      type: 'http',
      behavior: 'domain',
      url: `${base}/geo/geosite/${name}.mrs`,
      path: `./ruleset/${name}.mrs`,
      interval: 86400,
      format: 'mrs',
    };
  }
  for (const [name, file] of Object.entries(ipSets)) {
    config['rule-providers'][name] = {
      type: 'http',
      behavior: 'ipcidr',
      url: `${base}/geo/geoip/${file}.mrs`,
      path: `./ruleset/${name}.mrs`,
      interval: 86400,
      format: 'mrs',
    };
  }

  config.rules = [
    `DOMAIN-SUFFIX,ipip.la,${landingGroup}`,
    `DOMAIN-SUFFIX,ip.sb,${landingGroup}`,
    `DOMAIN-SUFFIX,ip-api.com,${landingGroup}`,
    `DOMAIN-SUFFIX,ipapi.co,${landingGroup}`,
    `DOMAIN-SUFFIX,ipinfo.io,${landingGroup}`,
    `DOMAIN-SUFFIX,icanhazip.com,${landingGroup}`,
    `DOMAIN-SUFFIX,ifconfig.me,${landingGroup}`,
    `DOMAIN-SUFFIX,browserscan.net,${landingGroup}`,
    `DOMAIN-SUFFIX,browserleaks.com,${landingGroup}`,
    `DOMAIN-SUFFIX,dnscheck.tools,${landingGroup}`,
    `DOMAIN-SUFFIX,dnsleaktest.com,${landingGroup}`,
    `DOMAIN-SUFFIX,ipleak.net,${landingGroup}`,
    `DOMAIN-SUFFIX,ipleak.org,${landingGroup}`,
    `DOMAIN-SUFFIX,whoer.net,${landingGroup}`,
    `DOMAIN-SUFFIX,challenges.cloudflare.com,${finalGroup}`,
    `RULE-SET,category-ads-all,${adGroup}`,
    `RULE-SET,google-gemini,${geminiGroup}`,
    `RULE-SET,category-ai-chat-!cn,${aiGroup}`,
    `RULE-SET,openai,${aiGroup}`,
    `RULE-SET,anthropic,${aiGroup}`,
    `RULE-SET,youtube,${youtubeGroup}`,
    `RULE-SET,aws,${cloudGroup}`,
    `RULE-SET,azure,${cloudGroup}`,
    `RULE-SET,cloudflare,${cloudGroup}`,
    `RULE-SET,digitalocean,${cloudGroup}`,
    `RULE-SET,vercel,${cloudGroup}`,
    `RULE-SET,netlify,${cloudGroup}`,
    `RULE-SET,cloudflare-ip,${finalGroup},no-resolve`,
    `RULE-SET,google,${googleGroup}`,
    `RULE-SET,google-ip,${googleGroup},no-resolve`,
    `RULE-SET,private,${privateGroup}`,
    `RULE-SET,private-ip,${privateGroup},no-resolve`,
    `RULE-SET,geolocation-cn,${cnGroup}`,
    `RULE-SET,cn-ip,${cnGroup},no-resolve`,
    `RULE-SET,telegram,${telegramGroup}`,
    `RULE-SET,telegram-ip,${telegramGroup},no-resolve`,
    `RULE-SET,github,${codeGroup}`,
    `RULE-SET,gitlab,${codeGroup}`,
    `RULE-SET,atlassian,${codeGroup}`,
    `RULE-SET,microsoft,${microsoftGroup}`,
    `RULE-SET,onedrive,${microsoftGroup}`,
    `RULE-SET,apple,${appleGroup}`,
    `RULE-SET,icloud,${appleGroup}`,
    `RULE-SET,docker,${devGroup}`,
    `RULE-SET,npmjs,${devGroup}`,
    `RULE-SET,jetbrains,${devGroup}`,
    `RULE-SET,stackexchange,${devGroup}`,
    `RULE-SET,paypal,${paymentGroup}`,
    `RULE-SET,stripe,${paymentGroup}`,
    `RULE-SET,wise,${paymentGroup}`,
    `RULE-SET,geolocation-!cn,${finalGroup}`,
    `RULE-SET,cn,${cnGroup}`,
    `MATCH,${finalGroup}`,
  ];

  if (enableDnsLeakPreset) {
    config.dns = {
      enable: true,
      listen: '127.0.0.1:5335',
      'prefer-h3': false,
      'respect-rules': true,
      'use-hosts': false,
      'use-system-hosts': false,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter-mode': 'blacklist',
      'default-nameserver': ['223.5.5.5', '223.6.6.6', '119.29.29.29'],
      nameserver: [
        'https://dns.alidns.com/dns-query',
        'https://doh.360.cn/dns-query',
        'https://sm2.doh.pub/dns-query',
        'tls://dns.alidns.com',
        'tls://dot.360.cn',
        'tls://dot.pub',
      ],
      fallback: [
        'https://dns.google/dns-query',
        'https://cloudflare-dns.com/dns-query',
        'https://security.cloudflare-dns.com/dns-query',
      ],
      'proxy-server-nameserver': [
        'https://dns.alidns.com/dns-query',
        'https://doh.360.cn/dns-query',
        'https://sm2.doh.pub/dns-query',
        'tls://dns.alidns.com',
        'tls://dot.360.cn',
        'tls://dot.pub',
      ],
      'direct-nameserver': [
        'https://dns.alidns.com/dns-query',
        'https://doh.360.cn/dns-query',
        'https://sm2.doh.pub/dns-query',
        'tls://dns.alidns.com',
        'tls://dot.360.cn',
        'tls://dot.pub',
      ],
      'direct-nameserver-follow-policy': false,
      'nameserver-policy': {
        'geosite:cn': ['https://dns.alidns.com/dns-query', 'https://doh.360.cn/dns-query'],
        'geosite:geolocation-!cn': ['https://dns.google/dns-query', 'https://cloudflare-dns.com/dns-query'],
        '+.challenges.cloudflare.com': ['https://dns.google/dns-query', 'https://cloudflare-dns.com/dns-query'],
      },
      'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['240.0.0.0/4', '0.0.0.0/32', '127.0.0.1/32'],
        domain: ['+.google.com', '+.facebook.com', '+.twitter.com', '+.youtube.com', '+.googleapis.com', '+.gstatic.com'],
      },
      'fake-ip-filter': [
        '*.lan',
        '*.local',
        'stun.*.*.*',
        'stun.*.*',
        'time.windows.com',
        'time.nist.gov',
        'time.apple.com',
        '*.ntp.org.cn',
        'pool.ntp.org',
        'ntp.aliyun.com',
        'music.163.com',
        '*.music.163.com',
        '*.msftconnecttest.com',
        '*.msftncsi.com',
        'localhost.ptlogin2.qq.com',
        '*.ipv6.microsoft.com',
        '*.*.xboxlive.com',
      ],
    };
  }

  return config;
}
