# 持仓助手 — 容器镜像
#
# 零依赖（只用 Node 内置模块），所以不需要 npm install：
# 直接把代码拷进去就能跑。镜像很小、构建很快。
FROM node:22-alpine

WORKDIR /app

# 复制整个项目（.dockerignore 会排掉 state.json / .auth.txt 等本地数据）
COPY . .

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# 云端的数据目录：fly.toml 里把持久卷挂到 /data
# 挂载会覆盖这里的权限，所以预先给 node 用户（uid 1000）写权限
RUN mkdir -p /data && chown node:node /data

# 健康检查：容器自己会去看 /api/health，异常时平台能自动重启
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 8080

# 不用 root 跑（node 镜像自带 uid 1000 的 node 用户）
USER node

CMD ["node", "server.mjs"]
