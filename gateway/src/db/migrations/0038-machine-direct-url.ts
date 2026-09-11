/**
 * 席位机器的公网直连地址。
 *
 * 加这一列时桌面的像素全部经过 Gateway（当时的 gateway/src/desktop.ts），而实测
 * 它是整条链上最贵的一股流量。这一列填上之后，浏览器直接连这台机器的管家取桌面，
 * Gateway 不再中转那些字节。
 *
 * 和 `host` 分开两列，不是复用一列：
 *
 *   · `host` 是 **Gateway 打这台机器**的地址，可以是内网的、可以是纯 IP、可以是
 *     http——只要 Gateway 连得到就行。
 *   · 这一列是 **浏览器打这台机器**的地址，要求严得多：必须是公网可达、必须是
 *     https（Gateway 的页面是 https，混合内容会被浏览器直接拦掉），而且最好和
 *     Gateway 同一个可注册域，这样管家发的 SameSite=Lax cookie 在 iframe 里才带得上。
 *
 * 两者很多部署下根本不是同一个地址，合成一列会逼着内网管家也去搞公网证书。
 *
 * 加这一列时为空 = 桌面照旧从 Gateway 反代。那条反代后来删了（Gateway 上 Vercel，不能
 * 扛 WebSocket）：现在为空 = 这台机器没有桌面、对话流、名单流。
 */
export const SQL = `
  alter table machines
    add column if not exists "directUrl" text;
`
