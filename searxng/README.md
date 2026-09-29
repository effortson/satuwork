# 自托管 SearXNG（可选）

给 `web_search` 的 `searxng` 后端用的搜索实例，见 [../docs/web-tools.md](../docs/web-tools.md)。
搜索后端是平台四选一（tavily / firecrawl / duckduckgo / searxng），**没选它的部署不用起这个容器**，
所以它在根 [docker-compose.yml](../docker-compose.yml) 里挂着 `profiles: ['searxng']`：
不带 profile 的 `docker compose up -d` 眼里根本没有这个服务。

配置照官方文档 <https://docs.searxng.org/admin/installation-docker.html>，只是没照抄那份
独立 compose——服务并进项目自己那份了，省得同一台机器上两套 compose 各管各的。

## 起 / 停

密钥（`server.secret_key`，签 cookie 用的）不用手配：`.env` 里没有 `SEARXNG_SECRET` 的话，
容器第一次启动时随机生成一把，写进 `searxng-data` 卷里的 `/var/cache/searxng/.secret_key`，
之后重启都读这把。compose 里不再带默认值——以前那个 `ultrasecretkey` 是公开的。

想自己定就在**仓库根目录**的 `.env` 里放一把（`.env` 不进 git），它优先于卷里那把：

```bash
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" >> .env
```

要换密钥：删掉 `.env` 里那行再 `docker compose --profile searxng down -v`（连卷一起删，
favicon 缓存也会跟着清掉，无所谓），或者直接在 `.env` 里填一把新的。

改了端口或地址的话再加一条 `SEARXNG_BASE_URL=http://<本机地址>:8888/`（默认 `localhost`，
opensearch 描述和 RSS 里的链接指的就是它，写错了那些链接会指到别处）。

```bash
docker compose --profile searxng up -d           # 连 PG、Gateway 一起起
docker compose --profile searxng up -d searxng   # 只起它
docker compose --profile searxng logs -f searxng
docker compose --profile searxng down            # 停；不带 --profile 是停不掉它的
```

宿主机 **127.0.0.1:8888** → 容器 8080，**只绑本机**，和 PG、Gateway 一样：

- 网页：<http://127.0.0.1:8888/>
- JSON：`http://127.0.0.1:8888/search?q=关键词&format=json&language=zh-CN`
- 控制台「工具配置 → 网页与搜索」里填的实例地址：Gateway 跑在这套 compose 里就填
  `http://searxng:8080`（容器之间直连，不绕宿主机）；Gateway 跑在本机别处就填上面那个。

换端口设 `SEARXNG_PORT`。**别把左边的 `127.0.0.1:` 去掉**：限流器是关的（见下），端口一对外
就是个谁都能用的搜索代理。Gateway 在别的机器上的话，前面挂一层带鉴权的反代再对外。

## 配置里只有三件事和默认不一样

`core-config/settings.yml`：

1. **`search.formats` 加了 `json`**。默认只有 `html`，不开这条就没有 API——
   [../gateway/src/web-tools.ts](../gateway/src/web-tools.ts) 的 searxng 后端打 `format=json`
   会拿回 HTML，报的是「实例没开 json」而不是「搜不到」。
2. `server.limiter: false`。限流器是给公开实例挡爬虫的，这台是自己人的 API 后端，
   开着会把不带浏览器指纹的直连请求判成机器人。**所以这个端口不要暴露到公网。**
3. `general.instance_name` 改了个名字，纯装饰。

## 三处和官方 compose 的出入

- **没有 valkey。** 它只在开限流器时才用得上，而限流器是关的；官方那份里的 valkey 其实
  也没接上——镜像默认 `valkey.url = false`，除非自己设 `SEARXNG_VALKEY_URL`。
- **端口在宿主机侧改**（`127.0.0.1:8888:8080`），不像官方那样用 `SEARXNG_PORT` 同时改容器内的
  监听口。容器内固定 8080，换端口只动 `8888` 那个数。
- **entrypoint 包了一层**：先补上密钥（见上），再 `exec` 镜像自己的
  `/usr/local/searxng/entrypoint.sh`。升级镜像时要是这个路径变了，容器会起不来，照着改一下。

## 一部分引擎会报错，这是正常的

启动日志里 wikidata 403、startpage / duckduckgo 撞验证码，都是上游按 IP 限的，
不影响整体结果——一次搜索是几十个引擎并发，brave、bing、wikipedia 这些照常回。
真要少一个引擎少一次报错，去 `settings.yml` 里 `engines: - name: xxx / disabled: true`。
