# Link Board

用于快速收藏链接的自由画布网页，支持中文搜索、多标签筛选、置顶、编辑、删除、排序，以及 JSON 导入导出。无构建依赖。

线上地址：https://kazoottt.github.io/link-board/

## 本地运行

```sh
python3 -m http.server 5174 --bind 127.0.0.1
```

访问 http://127.0.0.1:5174 。收藏存储于当前域名的浏览器 localStorage，不自动跨设备同步。更换域名前请导出 JSON 备份，在新页面导入；导入会合并收藏并跳过重复 URL。无法读取的原始存储不会自动覆盖，可以通过导出取回。

## 部署（GitHub Pages）

本项目通过 GitHub Pages 发布：Settings → Pages → Source 选择 Deploy from a branch，分支 `main`、目录 `/`。仓库是纯静态文件，没有构建步骤，推送到 `main` 后自动重新构建，线上地址为 https://kazoottt.github.io/link-board/ 。也可以把仓库根目录放到任意静态服务器上，不需要后端。

部署不会迁移数据：收藏只存在当前域名对应的浏览器 localStorage 里，更换域名前请先导出 JSON，再在新页面导入。

标题、标签和笔记通过 textContent 渲染，只接受 HTTP/HTTPS 链接。字体无法加载时使用系统字体。

## 快速收藏与验证

在页面任意位置粘贴链接（⌘V / Ctrl+V）即自动收藏，无需回车；也可以在首页输入框粘贴或输入后按回车。默认以域名作为标题；可在卡片中编辑标题、标签和笔记。编辑表单的标题也可留空。所有样式使用本地文件和系统字体。

运行 `npm install && npm test`（等价于 `node --test tests/`）验证粘贴即收藏、快速收藏、重复链接、危险协议、损坏存储保护、批量导入、搜索和网页元信息解析。测试使用模拟 DOM，不代替浏览器视觉验收。

## 自由画布

拖动卡片调整位置，拖动空白处平移，滚轮缩放；底部提供缩放、适应画布和重置视图。聚焦卡片后可用方向键移动（Shift 加速）。新卡片出现在当前视野，旧版收藏自动分配初始位置。坐标随 JSON 备份导入导出，视图单独保存于当前浏览器。

## 源码仓库

左侧边栏底部有「GitHub 仓库」入口，点击在新标签页打开本项目源码（界面不展示完整 URL 文本）。

## Agent 任务 Issue

新建 Issue 时选择「Agent 任务」模板（`.github/ISSUE_TEMPLATE/agent-task.yml`），提交后自动带上 `agent-tasks` 标签，进入 Agent 任务队列。需求描述和验收标准为必填项。
