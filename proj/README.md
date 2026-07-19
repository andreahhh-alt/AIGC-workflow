# AIGC 影视工作流

面向剧本开发、资产整理、分镜拆解和生成式制作的可审核工作台。原《四季之地》男主线提示词页面仍保留在 `/legacy`。

## 已实现

- 上传剧本、人物小传、参考图片及其他项目资料；支持提取 TXT、MD、JSON、CSV、PDF、DOCX 文本。
- 按需生成综合/角色时间线、人物关系、世界观、情感脉络和叙事结构，也可一键全选。
- 以稳定场次 ID 作为全站数据主轴；知识节点可跳转到场次与分镜，场次可反查所属知识图谱。
- 每场支持主要线路、多个次要线路、POV人物、出场人物和剧情事件；可筛选男主线、女主线、配角线、群像线等。
- 完整剧本先确定性建立场次索引，再按最多8场一批并发进行AI线路标注与15秒分镜拆分，避免长剧本被模型截断。
- 重复场次号不会错误合并：系统临时显示为 `21A/21B` 并标记编号冲突，等待人工处理。
- 从已确认资料提取角色、场景、道具、风格和音效资产。
- 按场次拆分剧本，再以约 15 秒为单位创建分镜组。
- 在单个分镜组内按需生成画面、动作、对白、声音、负向约束和色卡字段。
- 人工审核状态贯穿资料、分析、资产、分镜和 AI 任务。
- v3「影视创作桌面」以底部全剧场次轨道贯穿故事地图、视觉资产墙和导演剪辑台，切换模块时不会失去当前场次上下文。
- 故事地图以横向叙事节点呈现；资产墙使用视觉化卡片；剪辑台采用“场次列—15秒胶片条—分镜检查器”三层布局。
- 每个分镜组可记录绑定 `00:00—00:15` 时间码的导演、制片或客户反馈，并独立标记解决。
- AI 命令会随当前场次与分镜变化；仍由人决定何时生成、再生成、检查或锁定。
- PostgreSQL 优先持久化；未配置数据库时回退到本地 JSON。

## 本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

打开 <http://localhost:3000>。运行检查：

```bash
npm run check
npm test
npm run test:script -- "C:\path\to\最新剧本.docx"
```

## 环境变量

| 变量 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串；线上上传与工作流数据建议配置 |
| `DEEPSEEK_API_KEY` | DeepSeek 服务端密钥 |
| `DEEPSEEK_MODEL` | 默认 `deepseek-v4-flash` |
| `ANTHROPIC_API_KEY` | 可选的 Anthropic 服务端密钥 |
| `AI_PROVIDER` | `deepseek` 或 `anthropic` |
| `ADMIN_PASSWORD` | 管理配置和删除操作所需密码 |
| `CORS_ORIGIN` | 可选的跨域来源白名单 |
| `AI_RATE_LIMIT` | 每小时 AI 请求上限，默认 40 |
| `UPLOAD_RATE_LIMIT` | 每小时上传请求上限，默认 80 |

## 部署

Render Web Service 的 Root Directory 设为 `proj`，Build Command 为 `npm install`，Start Command 为 `npm start`。生产环境建议绑定 Render Postgres 并设置 `DATABASE_URL`，避免实例重启时丢失工作流数据。

AI 密钥仅由服务端读取；浏览器不会收到明文密钥。提示词生成约束基于 `aigc-film-prompts v4.7` 的结构化规范。
