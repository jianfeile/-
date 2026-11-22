# 公民考试中文题库

法国公民考试（examen civique：多年居留卡、十年居留卡、入籍）的中文练习网页：法语原题，逐题中文翻译和讲解，
中文考点速记，考生回忆（机经），模拟考试，错题本，生词表。
纯静态网页，没有服务器，没有依赖，手机上直接打开（微信内置浏览器可用）。

本项目不是官方网站。知识题题干来自法国内政部公布的官方清单（formation-civique.interieur.gouv.fr，
Licence Ouverte 2.0）；选项、中文翻译、讲解和情景练习题为本项目编写。

## 目录

```
site/                 要上线的网页，整个文件夹直接部署
  index.html app.css app.js
  config.js           价格、付款链接、联系方式（卖家自己改）
  data/free.json      免费试用题（明文）
  data/bank.json      完整题库和考点速记（加密，需要解锁码才能打开）
  data/centres.json   考场名单（France Éducation International 官网公开的名单，免费页面“报名”使用）
  sw.js               离线缓存：打开过一次后，没有网络也能用
functions/api/unlock.js   付款后自动解锁的函数（Cloudflare Pages Functions）
server/unlock-core.mjs    函数的全部逻辑，测试时直接调用
tools/
  bank.mjs            生成题库、加解锁码、导出题库原文
  test.cjs            浏览器自动测试
  preview.mjs         把整个网页打成一个文件
  icons.cjs           生成图标
```

题库原文（`content/`）和解锁码不放进仓库。原文可以随时用任意一个有效解锁码从 `data/bank.json` 里导出。

## 本地运行

```
cd site && python3 -m http.server 8080      # 打开 http://localhost:8080
```

解锁功能需要 https 或 localhost（浏览器的加密接口只在安全环境下可用）。

## 上线

用 Cloudflare Pages（免费）。项目的根目录选 `civique-zh`，构建命令留空，输出目录是 `site`（`wrangler.toml` 里已经写好）。
`functions/` 里的函数会自动部署成 `/api/unlock`，只有它会消耗函数额度，其余都是静态文件。

没有函数的托管（或把整个网页打成一个文件时）也能用：把 `site/config.js` 里的 `api` 设为空字符串，此时只支持手动发放的解锁码。

## 网上收款，付款后自动解锁

1. 在 Stripe 建一个 Payment Link，“付款后”选跳转到自己的网站：`https://你的域名/?paid={CHECKOUT_SESSION_ID}`（花括号部分原样填写）。
2. 把 Payment Link 的地址填进 `site/config.js` 的 `payUrl`。
3. 在托管平台给函数设置两个密钥（不要写进仓库）：
   - `STRIPE_KEY`：Stripe 的受限密钥，只勾选 Checkout Sessions 的读取权限；
   - `CONTENT_KEY`：题库密钥，`node tools/bank.mjs key --code XXXX-XXXX-XXXX` 的输出。
   可选：`PAYMENT_LINK`（`plink_...`，只认这一个收款链接的付款）、`REVOKED`（作废的解锁码，逗号分隔）。

流程：买家付款后被带回网站，网页把这笔付款的编号交给 `/api/unlock`，函数向 Stripe 核实确已付款，
返回题库密钥和一个属于这位买家的解锁码，浏览器随即解锁。换设备时输入解锁码，或者填付款邮箱找回。
函数不保存任何数据：解锁码的前半段由付款编号算出，后半段是前半段的签名。

访问 `https://你的域名/api/unlock` 会返回 `{"ok":true,"configured":true}`，可以用来确认函数和密钥已经就位。

## 手动发放解锁码

不经过网上付款的买家（赠送、线下收款）可以直接发一个码。以下命令都需要用一个已有的有效解锁码来证明身份：

```
node tools/bank.mjs codes 50 --code XXXX-XXXX-XXXX     # 新增 50 个解锁码并打印
node tools/bank.mjs revoke <某个码> --code XXXX-XXXX-XXXX
node tools/bank.mjs check --code XXXX-XXXX-XXXX        # 检查题库能否正常打开
```

说明：题库在浏览器里解密，解锁码只能防君子，拿到码的人可以转给别人。发现某个码被传开：手动发放的码用 `revoke` 撤销，
付款后自动发放的码写进 `REVOKED`；如果要彻底换一把密钥，用 `build --new` 重新生成并更新 `CONTENT_KEY`（已购买的人需要重新解锁）。

## 修改题目

```
node tools/bank.mjs export --code XXXX-XXXX-XXXX       # 导出到 content/all.json
# 修改 content/all.json
node tools/bank.mjs build --code XXXX-XXXX-XXXX        # 重新生成 site/data/
CIVIQUE_CODE=XXXX-XXXX-XXXX node tools/test.cjs        # 跑一遍测试
```

每道题的格式：`id`、`theme`（principes / institutions / droits / histoire / societe）、`levels`（csp、cr）、
`kind`（connaissance / situation）、`q` 法语题干、`qz` 中文题干、`opts` 四个法语选项（**第一个永远是正确答案**，
显示时会打乱）、`optsz` 对应中文、`explain` 中文讲解、`vocab` 生词、`src` 对照的官方讲义。

### 考点速记和机经

除了题目，`content/` 里还可以放两个文件，`build` 时一起打包：

- `cards.json`：考点速记。每张卡片 `id`、`theme`、`title`、`lead`（一句话说明）、`points`（要点）、`terms`（生词）、`src`（对照的官方讲义）。
  每个主题的第一张免费（可用 `free_cards.json` 指定），其余在加密题库里，免费用户只看到标题。
- `recall.json`：机经，也就是考生在网上分享的考后回忆。每场考试一条：`when`（考试年月，如 `2026-10`）、`level`（csp / cr / nat，可省略）、
  `note`（一句话印象，可省略）、`items`。`items` 里每一项要么是 `{ "ref": "题目编号" }`（对应题库里的一道题），
  要么是 `{ "text": "中文描述", "kind": "situation", "theme": "droits" }`（题库里还没有的题）。
  **只记录考试时间和考了什么，不写任何账号、昵称或链接**（文件里出现 `@`、网址等内容时 `build` 会直接报错）。
  机经列表对所有人可见，题目的讲解仍然需要解锁。

免费试用题由 `content/free_ids.json` 决定（首次生成时自动挑选：每个主题每种居留卡 6 道知识题，外加每个有情景题的主题 3 道）。

## 报名页和考场名单

“报名”页写的是从报名到拿证明的流程，并可以按城市、省号、邮编或当前位置查考场。报名和交费只在两家官方考试机构的网站上进行，本站只给出链接。
`site/data/centres.json` 是 France Éducation International 官网考场地图上法国境内的考场：`asof` 是取数日期，`c` 里每一项是
`[名称, 街道, 邮编, 城市, 纬度, 经度, 电话, 网站]`（官网坐标明显有误的考场，经纬度留空，不显示距离）。考场会增减，应定期对照官网更新。
巴黎工商会的考场只能在它的网站上按城市查，没有收录。用户的位置只在浏览器里用来算距离，不上传。

## 测试

```
CIVIQUE_CODE=XXXX-XXXX-XXXX node tools/test.cjs
```

需要 Node 18+ 和 Playwright（Chromium）。覆盖：首次进入、练习、错题本、试考、倒计时到点自动交卷、
解锁（手动输入、付款后自动解锁、邮箱找回、付款处理中、伪造的付款编号）、40 题模拟考试的题量分布、
手机/桌面/深色模式下不出现横向滚动。付款相关的测试用的是真实的函数代码，只把它对 Stripe 的请求换成了测试数据。
