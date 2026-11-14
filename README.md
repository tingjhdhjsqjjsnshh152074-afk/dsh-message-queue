# dsh-message-queue

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**每个对话独立的消息队列**：把想说的话先排进去，到时机再当作你自己的消息发出去。

## 它能做什么

输入框工具栏最右边（发送键左边）会多一个时钟按钮，按钮上带待发条数。点开是一块面板：

- **三种时机**
  - **本轮完成后**：现在这一轮跑完，就把这条发出去
  - **完成后间隔**：本轮跑完后再等 N 分钟
  - **指定时间**：自己画的日历 + 时可/分可手输（0–23 / 0–59），也可以点 `+10 分钟 / +30 分钟 / +1 小时 / 明早 9:00`
- **严格串行**：同一个对话里一次只发一条，前一条**真正跑完**才轮到下一条
- **循环**：`重复 N 轮` 或 `一直重复`，每轮跑完自动再发一次，行上显示「剩余 N 轮 / 循环中」
- **可管理**：暂停整个队列、上移调整顺序、取消单条；正在发送的那条不会再被打断
- **历史独立**：发出去的消息进「历史」页签，不占队列列表，可一键清空
- **不丢**：队列存在 `$DSH_HOME/storages/message-queue.json`，重启 Harness 后还在；重启期间错过执行窗口的「指定时间」条目不会偷偷补发，会标成「待确认」等你决定

## 安装

在市场里搜 `dsh-message-queue`，或直接：

```powershell
dsh plugin --profile <你的 profile> install dsh-message-queue
```

装完刷新页面（打包版里 Ctrl+R 没绑，按 F12 在 Console 里执行 `location.reload()`）。

## 说明与边界

- 队列跑在 Harness 进程里：Harness 关掉就不发，这跟内置定时任务一致。
- 队列按对话隔离，切换对话不会串。
- 浏览器与宿主之间走插件自己的 `POST /plugin/message-queue` 端点（`webServer.register`），只收发 JSON。
- 「一直重复」没有次数上限，靠你在队列里取消来停；每轮之间留了 2.5 秒下限，避免异常情况下连发。
- 界面文案目前是中文硬编码，没有走 Client 的 locale 服务。

## 开发

包结构：`index.js` 是宿主半边（队列状态、定时器、投递），`client.js` 是浏览器半边（按钮与面板，自绘 UI），`cordis.patch.yml` 插入插件行。

```powershell
npm pack --silent
# 然后在 Harness 里用 plugin_manager install_bundle，target 传：
# file:E:/path/to/dsh-message-queue-1.1.0.tgz
```

改动后重新 `npm pack` 再装。浏览器半边会在几秒内自动重载（面板每次轮询会比对宿主报告的构建戳）。

## License

MIT
