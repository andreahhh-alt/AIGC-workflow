# 《四季之地》AIGC 提示词 · 反馈 + AI 分析后端

一个单文件 Node/Express 后端：**存反馈（JSON 文件，无需数据库）＋ 把 API Key 藏在服务器端转发 AI 请求**。
前端就是那份 场7–12 提示词与色卡工作表，每条提示词下可留 反馈1/2/3…，每条反馈可一键让 AI 分析未达标原因并给出修改方案。

---

## 目录

```
sijizhidi-feedback/
├─ server.js          后端（反馈存取 / AI 转发 / key 配置）
├─ package.json
├─ .env.example       环境变量样例
├─ public/
│  └─ index.html      前端工作表（已接好后端接口）
└─ data/              运行后自动生成 feedback.json / config.json
```

## 本地运行

需要 Node.js 18+（自带 fetch）。

```bash
cd sijizhidi-feedback
npm install
# 可选：cp .env.example .env 并填写 ADMIN_PASSWORD
ADMIN_PASSWORD=你的管理员密码 npm start
```

打开 http://localhost:3000 ，展开顶部「⚙ AI 接入设置」，填入 Anthropic API Key ＋ 管理员密码，保存即可。之后访客写反馈、点「AI 分析」就能用了。

## 部署到线上（任选其一）

- **Render / Railway / Fly.io / Zeabur** 等：新建 Web Service，指向本仓库，启动命令 `npm start`。在平台「环境变量」里设 `ADMIN_PASSWORD`（可选 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`）。多数平台会自动注入 `PORT`。
- **自有 VPS**：`npm install && ADMIN_PASSWORD=... node server.js`，前面挂 Nginx 反代 + HTTPS。建议用 pm2 守护：`pm2 start server.js`。

> 前后端同源部署（后端顺带托管 `public/`）时，网页里「后端地址」留空即可。
> 若前端单独托管在别处，在网页「⚙ AI 接入设置」里填后端地址（如 `https://your-app.onrender.com`）。

## API Key 存哪里？

两种方式，二选一：
1. **网页里填**（推荐给非技术同事）：管理员在「⚙ AI 接入设置」填 key＋管理员密码 → 保存到服务器 `data/config.json`。key **不会**下发给任何访客，网页只显示"已配置/未配置"。
2. **环境变量**：设 `ANTHROPIC_API_KEY`，连网页都不用填。

## 接口一览

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/api/feedback` / `?pid=7-1` | 取全部 / 某条提示词的反馈 | 无 |
| POST | `/api/feedback` `{pid,text}` | 提交反馈 | 无 |
| DELETE | `/api/feedback/:pid/:id` | 删除反馈 | `x-admin-password` |
| POST | `/api/analyze` `{pid,fid,prompt,feedback,context}` | AI 分析并回写结果 | 服务器需已配置 key |
| GET | `/api/config/status` | 是否已配置 key / 当前模型 | 无（不回传 key） |
| POST | `/api/config/key` `{key,model}` | 保存 key/模型到服务器 | `x-admin-password` |
| DELETE | `/api/config/key` | 清除已保存 key | `x-admin-password` |

## 安全与成本提醒

- **务必修改 `ADMIN_PASSWORD`**，否则任何人都能改 key、删反馈。
- AI 分析接口对访客开放（这样大家才能用）。若担心被刷高账单，建议：给 `/api/analyze` 也加一层口令或登录、或在平台层加速率限制、或用一个额度受限的独立 key。
- `data/` 是持久化数据，部署时记得挂持久卷（否则重启会丢反馈）。
- 模型名 `ANTHROPIC_MODEL` 请按你 key 能访问的模型填写。
