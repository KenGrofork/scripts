async function operator(proxies = [], targetPlatform, env) {
  const cacheEnabled = $arguments.cache;
  const cache = scriptResourceCache;
  const telegram_chat_id = $arguments.telegram_chat_id;
  const telegram_bot_token = $arguments.telegram_bot_token;
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1';
  const http_meta_port = $arguments.http_meta_port ?? 9876;
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http';
  const http_meta_authorization = $arguments.http_meta_authorization ?? '';
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`;

  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000);
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000);

  const method = $arguments.method || 'head';
  const keepIncompatible = $arguments.keep_incompatible;
  const validStatus = parseInt($arguments.status || 200);
  const url = decodeURIComponent($arguments.url || 'http://www.apple.com/library/test/success.html');

  const $ = $substore;
  const validProxies = [];
  const incompatibleProxies = [];
  const internalProxies = [];
  const failedProxies = [];
  const sub = env.source[proxies?.[0]?._subName || proxies?.[0]?.subName];
  const subName = sub?.displayName || sub?.name;

  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key];
          }
        }
        internalProxies.push({ ...node, _proxies_index: index });
      } else {
        if (keepIncompatible) {
          incompatibleProxies.push(proxy);
        }
      }
    } catch (e) {
      $.error(e);
    }
  });

  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`);
  if (!internalProxies.length) return proxies;

  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout;
  let http_meta_pid;
  let http_meta_ports = [];
  
  // 启动 HTTP META
  const res = await http({
    retries: 0,
    method: 'post',
    url: `${http_meta_api}/start`,
    headers: {
      'Content-type': 'application/json',
      Authorization: http_meta_authorization,
    },
    body: JSON.stringify({
      proxies: internalProxies,
      timeout: http_meta_timeout,
    }),
  });
  let body = res.body;
  try {
    body = JSON.parse(body);
  } catch (e) {}
  const { ports, pid } = body;
  if (!pid || !ports) {
    throw new Error(`======== HTTP META 启动失败 ====\n${body}`);
  }
  http_meta_pid = pid;
  http_meta_ports = ports;
  $.info(
    `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] 若未手动关闭 ${
      Math.round(http_meta_timeout / 60 / 10) / 100
    } 分钟后自动关闭\n`
  );
  $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始检测`);
  await $.wait(http_meta_start_delay);

  const concurrency = parseInt($arguments.concurrency || 10);
  await executeAsyncTasks(
    internalProxies.map(proxy => () => check(proxy)),
    { concurrency }
  );

  // stop http meta
  try {
    const res = await http({
      method: 'post',
      url: `${http_meta_api}/stop`,
      headers: {
        'Content-type': 'application/json',
        Authorization: http_meta_authorization,
      },
      body: JSON.stringify({
        pid: [http_meta_pid],
      }),
    });
    $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(res, null, 2)}`);
  } catch (e) {
    $.error(e);
  }

  if (telegram_chat_id && telegram_bot_token && failedProxies.length > 0) {
    const text = `\`${subName}\` 节点测试:\n${failedProxies
      .map(proxy => `❌ [${proxy.type}] \`${proxy.name}\``)
      .join('\n')}`;
    await http({
      method: 'post',
      url: `https://api.telegram.org/bot${telegram_bot_token}/sendMessage`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ chat_id: telegram_chat_id, text, parse_mode: 'MarkdownV2' }),
    });
  }

  return keepIncompatible ? [...validProxies, ...incompatibleProxies] : validProxies;

  async function check(proxy) {
    const id = cacheEnabled
      ? `http-meta:availability:${url}:${method}:${validStatus}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
          )
        )}`
      : undefined;
    
    try {
      const cached = cache.get(id);
      if (cacheEnabled && cached) {
        $.info(`[${proxy.name}] 使用缓存`);
        if (cached.latency) {
          validProxies.push({
            ...proxy,
            name: `${$arguments.show_latency ? `[${cached.latency}] ` : ''}${proxy.name}`,
          });
        }
        return;
      }

      const index = internalProxies.indexOf(proxy);
      const startedAt = Date.now();

      // 发起请求
      const res = await http({
        proxy: `http://${http_meta_host}:${http_meta_ports[index]}`,
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url,
      });

      const latency = Date.now() - startedAt;
      const status = parseInt(res.status || res.statusCode || 200);

      // 判断延迟是否高于1000毫秒
      if (latency > 1000) {
        $.info(`[${proxy.name}] 延迟 ${latency}ms 超过1000ms，被丢弃`);
        failedProxies.push(proxy);
        return;
      }

      // 判断响应状态
      if (status === validStatus) {
        validProxies.push({
          ...proxy,
          name: `${$arguments.show_latency ? `[${latency}] ` : ''}${proxy.name}`,
        });
        if (cacheEnabled) {
          cache.set(id, { latency });
        }
      } else {
        failedProxies.push(proxy);
        if (cacheEnabled) {
          cache.set(id, {});
        }
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`);
      failedProxies.push(proxy);
      if (cacheEnabled) {
        cache.set(id, {});
      }
    }
  }

  async function http(opt = {}) {
    const METHOD = opt.method || $arguments.method || 'get';
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000);
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1);
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000);
    let count = 0;

    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT });
      } catch (e) {
        if (count < RETRIES) {
          count++;
          const delay = RETRY_DELAY * count;
          await $.wait(delay);
          return await fn();
        } else {
          throw e;
        }
      }
    };
    return await fn();
  }

  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0;
        const results = [];

        let index = 0;

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++;
            const currentTask = tasks[taskIndex];
            running++;

            currentTask()
              .then(data => {
                if (result) {
                  results[taskIndex] = wrap ? { data } : data;
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error;
                }
              })
              .finally(() => {
                running--;
                executeNextTask();
              });
          }

          if (running === 0) {
            return resolve(result ? results : undefined);
          }
        }

        await
