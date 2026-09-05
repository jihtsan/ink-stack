import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const workspace = process.cwd();
const upstream = join(workspace, '.tools', 'kndl-online-screensaver');
const stagingRoot = join(workspace, '.local', 'device-staging');
const extensionTarget = join(stagingRoot, 'onlinescreensaver-pw3');
const mrpackagesTarget = join(stagingRoot, 'mrpackages');
const privateUrlFile = join(workspace, '.local', 'browser-display-url.txt');
const linkssArchive = join(stagingRoot, 'kindle-linkss-0.25.N-r18981.tar.xz');
const linkssInstaller = join(
  stagingRoot,
  'linkss-package',
  'ScreenSavers',
  'Update_linkss_0.25.N_install_pw2_and_up.bin'
);
const displayOrigin = new URL(process.env.INKSTACK_DEVICE_ORIGIN ?? 'http://192.168.100.116:3210');

if (displayOrigin.protocol !== 'http:' || displayOrigin.pathname !== '/' || displayOrigin.search || displayOrigin.hash) {
  throw new Error('INKSTACK_DEVICE_ORIGIN must be an HTTP origin without a path, query, or fragment');
}

const privateUrl = new URL((await readFile(privateUrlFile, 'utf8')).trim());
if (
  privateUrl.protocol !== 'http:' ||
  privateUrl.username ||
  privateUrl.password ||
  privateUrl.search ||
  privateUrl.hash ||
  !/^\/display\/[A-Za-z0-9_-]+\.png$/.test(privateUrl.pathname)
) {
  throw new Error('The private display URL has an unexpected format');
}

const deviceDisplayUrl = new URL(privateUrl.pathname, displayOrigin).href;

function lf(text) {
  return text.replace(/\r\n?/g, '\n');
}

function replaceOne(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));
  if (matches?.length !== 1) throw new Error(`Expected exactly one ${label} setting`);
  return text.replace(pattern, replacement);
}

async function writeTextFrom(source, target) {
  await writeFile(target, lf(await readFile(source, 'utf8')), 'utf8');
}

async function digest(path, algorithm) {
  return createHash(algorithm).update(await readFile(path)).digest('hex');
}

await mkdir(join(extensionTarget, 'bin'), { recursive: true });
await mkdir(join(extensionTarget, 'log'), { recursive: true });
await mkdir(mrpackagesTarget, { recursive: true });

await writeTextFrom(join(upstream, 'kindle', 'config.xml'), join(extensionTarget, 'config.xml'));
await writeTextFrom(join(upstream, 'kindle', 'menu.json'), join(extensionTarget, 'menu.json'));
await writeTextFrom(join(upstream, 'LICENSE'), join(extensionTarget, 'LICENSE'));

for (const name of await readdir(join(upstream, 'kindle', 'bin'))) {
  const source = join(upstream, 'kindle', 'bin', name);
  const target = join(extensionTarget, 'bin', name);
  if (name === 'config.sh') continue;
  await writeTextFrom(source, target);
}

let config = lf(await readFile(join(upstream, 'kindle', 'bin', 'config.sh'), 'utf8'));
config = replaceOne(config, /^SCHEDULE=.*$/m, 'SCHEDULE="00:00-07:00=60 07:00-21:00=15 21:00-24:00=30"', 'SCHEDULE');
config = replaceOne(config, /^IMAGE_URI=.*$/m, `IMAGE_URI="${deviceDisplayUrl}"`, 'IMAGE_URI');
config = replaceOne(config, /^DISABLE_WIFI=.*$/m, 'DISABLE_WIFI=1', 'DISABLE_WIFI');
config = replaceOne(config, /^TEST_DOMAIN=.*$/m, `TEST_DOMAIN="${displayOrigin.hostname}"`, 'TEST_DOMAIN');
config = replaceOne(config, /^LOGGING=.*$/m, 'LOGGING=0', 'LOGGING');
config = replaceOne(config, /^WRITE_SCREENSAVER=.*$/m, 'WRITE_SCREENSAVER=0', 'WRITE_SCREENSAVER');
config = replaceOne(config, /^REQUEST_RESIZE=.*$/m, 'REQUEST_RESIZE=0', 'REQUEST_RESIZE');
await writeFile(join(extensionTarget, 'bin', 'config.sh'), config, 'utf8');

const sourceNote = [
  'kndl-online-screensaver source: https://codeberg.org/cryptomilk/kndl-online-screensaver.git',
  'commit: 3356a0d75d9a9094f91156f5e40173516db5cefb',
  'license: MIT (see LICENSE)',
  'target: Kindle Paperwhite 3, 1072x1448',
  'configuration: local private-network InkStack display URL; token intentionally omitted',
  ''
].join('\n');
await writeFile(join(extensionTarget, 'SOURCE.txt'), sourceNote, 'utf8');

const stagedInstaller = join(mrpackagesTarget, 'Update_linkss_0.25.N_install_pw2_and_up.bin');
await copyFile(linkssInstaller, stagedInstaller);

const scriptFiles = (await readdir(join(extensionTarget, 'bin'))).filter((name) => name.endsWith('.sh'));
for (const name of scriptFiles) {
  const bytes = await readFile(join(extensionTarget, 'bin', name));
  if (bytes.includes(Buffer.from('\r\n'))) throw new Error(`${name} still contains CRLF`);
}

const manifest = {
  target: { model: 'KindlePaperWhite3', serialPrefix: 'G090', width: 1072, height: 1448 },
  network: { origin: displayOrigin.origin, displayPathRedacted: '/display/<redacted>.png' },
  extension: {
    sourceCommit: '3356a0d75d9a9094f91156f5e40173516db5cefb',
    logging: false,
    writeScreensaver: false,
    requestResize: false,
    disableWifiAfterUpdate: true,
    schedule: '00:00-07:00=60 07:00-21:00=15 21:00-24:00=30',
    scriptLineEndings: 'LF'
  },
  linkss: {
    archiveMd5: await digest(linkssArchive, 'md5'),
    installerSha256: await digest(stagedInstaller, 'sha256')
  }
};
await writeFile(join(stagingRoot, 'kindle-pw3-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(manifest, null, 2));
