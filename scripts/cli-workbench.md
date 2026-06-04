# CLI Workbench

运行：

```bash
node scripts/cli-workbench.mjs test-scenario
```

它会：

1. 在桌面确保存在 `新建文件夹二`
2. 将其同步为项目记录
3. 以命令行方式调用 AI 专家团执行多轮真实文件操作
4. 持续写入 `.xt/logs/cli-e2e-*.log`
