import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Clario\n  npm start [-- --port 3200]\n配置：runtime/clario/config/config.json\n数据：runtime/clario/data\n工作区：workspace/');
  process.exit(0);
}
let port = process.env.CLARIO_PORT || '3200';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) port = args[++i];
  else if (args[i].startsWith('--port=')) port = args[i].slice(7);
  else throw new Error(`Unknown option: ${args[i]}. Use --help.`);
}
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Port must be 1024–65535');
const entry = join(root, 'apps/clario/dist/server.js');
if (!existsSync(entry) || !existsSync(join(root, 'apps/clario/web/dist/index.html'))) {
  console.error('请先运行 npm run build，然后运行 npm start。');
  process.exit(1);
}
const home = join(root, 'runtime/clario');
const configDir = join(home, 'config');
const config = join(configDir, 'config.json');
const data = join(home, 'data');
const skills = join(home, 'skills');
const workspace = join(root, 'workspace');
for (const path of [configDir, data, skills, workspace]) mkdirSync(path, { recursive: true });
if (!existsSync(config)) {
  copyFileSync(join(root, 'config.example.json'), config);
  chmodSync(config, 0o600);
  console.log('已创建独立配置。首次使用请在页面的模型设置中填写接口、模型与密钥。');
}
const sdkSettings = join(configDir, 'settings.json');
if (!existsSync(sdkSettings)) writeFileSync(sdkSettings, JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never' }, null, 2) + '\n', { mode: 0o600 });
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(INNO_|PI_)/.test(key) || /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete env[key];
}
Object.assign(env, { INNO_HOME: home, INNO_CONFIG_DIR: configDir, INNO_CONFIG_FILE: config, INNO_DATA_DIR: data, INNO_SKILLS_DIR: skills, INNO_WORKSPACE_DIR: workspace, INNO_PORT: port, INNO_DESKTOP: '0', PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
console.log(`Clario · http://localhost:${port}/`);
const child = spawn(process.execPath, [entry, '--home', home, '--config', config, '--config-dir', configDir, '--data-dir', data, '--skills-dir', skills, '--workspace', workspace, '--port', port], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
