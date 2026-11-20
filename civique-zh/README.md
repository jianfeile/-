# 公民考试中文题库

法国居留公民考试（examen civique）的中文练习网页：法语原题，逐题中文翻译和讲解，模拟考试，错题本，生词表。
纯静态网页，没有服务器，没有依赖，手机上直接打开（微信内置浏览器可用）。

本项目不是官方网站。知识题题干来自法国内政部公布的官方清单（formation-civique.interieur.gouv.fr，
Licence Ouverte 2.0）；选项、中文翻译、讲解和情景练习题为本项目编写。

## 目录

```
site/                 要上线的网页，整个文件夹直接部署
  index.html app.css app.js
  config.js           价格、付款链接、联系方式（卖家自己改）
  data/free.json      免费试用题（明文）
  data/bank.json      完整题库（加密，需要解锁码才能打开）
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

把 `site/` 文件夹部署到任意静态托管（Cloudflare Pages、Netlify 等），构建命令留空，输出目录填 `civique-zh/site`。

## 收款和解锁

1. 在 Stripe 建一个 Payment Link，付款成功后的跳转地址填 `https://你的域名/?code=解锁码`。
2. 把这个 Payment Link 填进 `site/config.js` 的 `payUrl`。
3. 买家付款后被带回网站，自动解锁；也可以手动输入解锁码。直接收款（转账）的买家，发一个解锁码即可。

解锁码管理（都需要用一个已有的有效解锁码来证明身份）：

```
node tools/bank.mjs codes 50 --code XXXX-XXXX-XXXX     # 新增 50 个解锁码并打印
node tools/bank.mjs revoke <某个码> --code XXXX-XXXX-XXXX
node tools/bank.mjs check --code XXXX-XXXX-XXXX        # 检查题库能否正常打开
```

说明：题库在浏览器里解密，解锁码只能防君子。拿到解锁码的人可以转给别人；发现某个码被传开，
撤销它并用 `build --new` 换一把密钥（其余买家需要重新输入自己的码）。

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

免费试用题由 `content/free_ids.json` 决定（首次生成时自动挑选：每个主题每种居留卡 6 道知识题，外加每个有情景题的主题 3 道）。

## 测试

```
CIVIQUE_CODE=XXXX-XXXX-XXXX node tools/test.cjs
```

需要 Node 18+ 和 Playwright（Chromium）。覆盖：首次进入、练习、错题本、试考、倒计时到点自动交卷、
解锁（手动输入和付款跳转）、40 题模拟考试的题量分布、手机/桌面/深色模式下不出现横向滚动。
