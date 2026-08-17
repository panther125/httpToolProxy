# HTTP 调用工具

一个纯前端的 HTTP 请求调试工具，配套一个**零依赖的 Node.js 本地代理**，用来绕开浏览器跨域（CORS）限制。前端单文件 `index.html`，后端单文件 `server.js`（仅用 Node 内置模块，无需 `npm install`）。

![image-20260818011927464](E:\progame\Trae\http\image-20260818011927464.png)

## 功能

- **任意方法**：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS
- **请求头 / 查询参数**：键值对编辑（查询参数会从 URL 的 `?` 中解析并展示）
- **请求体**：单个可编辑文本框，支持三种类型
  - `JSON`：自动设置 `Content-Type: application/json`
  - `Text 文本`：自动设置 `Content-Type: text/plain`
  - `表单 (urlencoded)`：直接写 `key1=value1&key2=value2`，自动设置 `Content-Type: application/x-www-form-urlencoded`
  - `无`：不发送 body
- **导入 cURL**：粘贴 cURL 命令，自动解析出 方法 / URL / 查询参数 / 请求头 / 请求体 并填充界面
- **格式化 JSON**：请求体与响应区各有一个按钮，压缩 JSON 一键美化
- **响应查看**：JSON 视图 / Raw 视图、复制、下载，并显示状态码 / 耗时 / 大小
- **历史记录**：本地保存最近 50 条请求
- **跨域代理**：默认走本地代理 `http://localhost:8787`，公共代理（cors.lol / corsproxy.io / allorigins）作为兜底

## 目录结构

```
http/
├── index.html   # 前端工具（单文件，含全部 UI 与逻辑）
├── server.js    # 本地跨域代理 / 静态服务器（零依赖）
├── package.json # npm start 脚本
└── README.md
```

## 运行

需要 Node.js 17+（开发用 Node 22 验证）。

```bash
cd E:/progame/Trae/http
npm start          # 等价于 node server.js
```

启动后访问 **http://localhost:8787/** 即可使用（同源，无跨域问题）。
也可以直接用浏览器打开 `index.html`（此时 origin 为 `null`，本地代理仍可用，因为它返回 `Access-Control-Allow-Origin: *`）。

> 若提示 `EADDRINUSE`（端口被占用），先结束占用 8787 端口的进程再启动：
> ```bash
> for /f "tokens=5" %a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /PID %a /F
> ```

## 本地代理原理

浏览器直接请求第三方 API（如 `api.adviceslip.com`）会触发 CORS 预检失败。本代理在本地 8787 端口接收前端请求，**由服务端代替浏览器**去请求目标地址，再带上宽松的 CORS 响应头回传给前端，从而彻底规避浏览器拦截。

前端约定：

| 用途 | 地址 |
| --- | --- |
| 页面 | `http://localhost:8787/` |
| 代理接口 | `http://localhost:8787/?url=<编码后的目标地址>` |
| 健康检查 | `http://localhost:8787/ping` → 返回 `pong` |

代理行为：

- 透传 **方法 / 自定义请求头 / 请求体**
- 自动跟随 3xx 重定向（最多 5 跳）
- 覆盖上游自带的 CORS 头，统一下发 `Access-Control-Allow-Origin: *` 等
- 上游错误（如连接失败）返回 `502` + JSON 错误信息，不会让进程崩溃
- 仅允许 `http` / `https` 协议

## 使用提示

- **POST 请求体**：方法选 `POST`，类型选 `JSON`，在请求体框里写 `{"key": "value"}`；点「格式化 JSON」可美化。
- **导入 cURL**：点「导入 curl」→ 粘贴命令 → 「导入」。例如：
  ```bash
  curl -X POST https://api.example.com/data?foo=bar \
    -H "Content-Type: application/json" \
    -d '{"a":1}'
  ```
  导入后 URL、方法、请求头、查询参数、请求体会自动填充。
- **查询参数**：既可以在 URL 里写 `?k=v`，也可以导入 cURL 时自动从 URL 解析出来。
- **代理切换**：顶部「跨域代理」勾选后，可在「方案」里选择 本地代理 / 公共代理 / 自定义。本地代理不可用时自动回退到公共代理。

## 备注

- 本地代理仅用于本地开发调试，请勿暴露于公网。
- 公共代理为第三方服务，隐私与稳定性不保证，敏感请求建议使用本地代理。
