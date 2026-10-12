// 临时给 E2E 用：另起一个实例，数据落在临时目录，不碰真实 state.json（不属于交付物）
import { startServer } from '../server.mjs';
import { join } from 'node:path';

const dir = process.argv[2];
const port = Number(process.argv[3] || 8899);
const { server, token } = await startServer({
  port,
  host: '127.0.0.1',
  stateFile: join(dir, 'state.json'),
  authFile: join(dir, '.auth.txt'),
  authDisabled: true,
});
console.log(`E2E 实例已启动 http://127.0.0.1:${port}  数据=${join(dir, 'state.json')}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
