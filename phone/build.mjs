// Builds phone/out/ai-usage-bubble.apk with the bare SDK tools: no Gradle, no Android Studio. Needs a JDK
// (17+) on PATH, and build-tools plus a platform under ANDROID_HOME (default %LOCALAPPDATA%\Android\Sdk).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const newest = (dir) => path.join(dir, fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1));
const tools = newest(path.join(sdk, 'build-tools'));
const androidJar = path.join(newest(path.join(sdk, 'platforms')), 'android.jar');
const win = process.platform === 'win32';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: win && cmd.endsWith('.bat') });
const tool = (name) => path.join(tools, name + (win ? (['d8', 'apksigner'].includes(name) ? '.bat' : '.exe') : ''));

// The PC's tailnet name, offered as the app's default address. tailscale serve carries 8443 to the overlay.
let server = process.env.BUBBLE_SERVER || '';
if (!server) {
  const self = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' })).Self;
  server = 'https://' + self.DNSName.replace(/\.$/, '') + ':8443';
}

fs.rmSync(out, { recursive: true, force: true });
for (const dir of ['assets', 'classes', 'res/drawable-xxxhdpi']) fs.mkdirSync(path.join(out, dir), { recursive: true });
fs.copyFileSync(path.join(here, 'bubble.html'), path.join(out, 'assets', 'bubble.html'));
fs.writeFileSync(path.join(out, 'assets', 'server.txt'), server);
fs.copyFileSync(path.join(here, '..', 'build', 'icon.png'), path.join(out, 'res', 'drawable-xxxhdpi', 'icon.png'));

const unsigned = path.join(out, 'unsigned.apk');
run(tool('aapt2'), ['compile', '--dir', path.join(out, 'res'), '-o', path.join(out, 'res.zip')]);
run(tool('aapt2'), ['link', '-o', unsigned, '-I', androidJar, '--manifest', path.join(here, 'AndroidManifest.xml'),
  '-A', path.join(out, 'assets'), path.join(out, 'res.zip'), '--min-sdk-version', '34', '--target-sdk-version', '35',
  // Minutes since 1970: every build installs over the last without anyone bumping a number.
  '--version-code', String(Math.floor(Date.now() / 60000)), '--version-name', '1.0']);

const sources = fs.readdirSync(path.join(here, 'src', 'com', 'local', 'aiusage')).map((f) => path.join(here, 'src', 'com', 'local', 'aiusage', f));
run('javac', ['--release', '17', '-Xlint:-options', '-classpath', androidJar, '-d', path.join(out, 'classes'), ...sources]);
const classes = fs.readdirSync(path.join(out, 'classes'), { recursive: true }).filter((f) => f.endsWith('.class')).map((f) => path.join(out, 'classes', f));
run(tool('d8'), ['--release', '--min-api', '34', '--lib', androidJar, '--output', out, ...classes]);
// aapt (v1) adds a file under the name it is given, so run it from out/ to put classes.dex at the root.
execFileSync(tool('aapt'), ['add', 'unsigned.apk', 'classes.dex'], { cwd: out, stdio: 'ignore' });

// The standard debug key, made once and kept outside the repo: a new key per build would refuse to update.
const keystore = path.join(os.homedir(), '.android', 'debug.keystore');
if (!fs.existsSync(keystore)) {
  fs.mkdirSync(path.dirname(keystore), { recursive: true });
  run('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US']);
}
const aligned = path.join(out, 'aligned.apk');
const apk = path.join(out, 'ai-usage-bubble.apk');
run(tool('zipalign'), ['-f', '-p', '4', unsigned, aligned]);
run(tool('apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--out', apk, aligned]);
console.log(`${apk}\n  reads ${server}`);
